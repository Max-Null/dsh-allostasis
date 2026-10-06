#!/usr/bin/env node
/**
 * 统计判据在流上的标定 — 把「ratio 阈值在生成过程中会掐多少、掐得准不准」在全库会话上量一遍。
 *
 * **它存在的理由**：`REPETITION_THRESHOLD` 的注释写着「起点值，非标定值」。步骤边界的判据
 * 只在一步结束时判一次，而三期的掐断要**逐 chunk** 判——同一套 `measureRepetition` 口径，
 * 在流上的命中面与全量判定不是一回事：一行在某一刻可以是完整的表项、之后被续写成长句。
 * 改阈值、改 `MIN_UNITS`、或改切分口径之后，都要能重新量一遍，而不是靠回忆上次的数字。
 *
 * **判据与增量扫描器都直接从 `src/` import**（`src/repetition.ts` 的 `measureRepetition` /
 * `repetitionVerdict`，`src/cut/detect.ts` 的 `createStreamDetector`），本文件里没有第二份
 * 实现。跑之前仍有一次**前置自检**：把增量扫描器的读数与全文判定在几条探针文本的每个
 * chunk 位置上对照四元组（units / repeated / ratio / verdict）。它过去是防「工具复刻切分
 * 逻辑的漂移」，现在防的是另一件事——**增量与全量不等价**：一旦不等价，下面全库回放报出来
 * 的数字就是另一套口径的。不一致即退出 2。
 *
 * 输出四块：
 *   ① 对照表 —— 各阈值在流上的干预率、真阳性率、召回、误掐
 *   ② 长度分桶 —— 命中的消息有多长（判据该管的是长输出，短消息是误伤面）
 *   ③ 抖动分析 —— 命中之后剩余流里还有多少 chunk 在越线（区分「真在退化」与「抖一下」）
 *   ④ 命中点 —— 提前量、命中时的样本量、绝对收益
 *
 * 用法：
 *   node tools/audit-stream-firing.mjs
 *   node tools/audit-stream-firing.mjs --root <会话根> --thresholds 0.5,0.6,0.7
 *   node tools/audit-stream-firing.mjs --json <输出路径>
 *
 * 会话日志位置：SSiD = `~/.dsh/sessions-ssid/<工作区>/<会话 id>/session.v4.jsonl.zstd`。
 * 日志是**拼接的 zstd 帧**（每次追加一批事件写一帧），按普通压缩流解压会在第二帧就失败。
 *
 * 退出码：0 = 跑完；2 = 用法错误、读不到会话根，或探针自检不一致。
 *
 * 设计出处：`docs/设计/2026-10-07-应变三期-生成中掐断与重定向.md` §九.1 的第三条待验证项；
 * 实测数据与结论：`docs/排查/2026-10-07-统计判据在流上的误报面.md`。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const { measureRepetition, repetitionVerdict, MIN_UNITS, REPEAT_MIN_COUNT } =
  await import(pathToFileURL(join(SRC, 'repetition.ts')).href)

/** 流上的判据就是实现里那一个——工具不另有一份增量扫描器。 */
const { createStreamDetector } = await import(pathToFileURL(join(SRC, 'cut', 'detect.ts')).href)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const USAGE = `统计判据在流上的标定。

用法：
  node tools/audit-stream-firing.mjs [--root <会话根>] [--thresholds 0.5,0.6,0.7] [--json <路径>]

选项：
  --root <dir>          会话日志根，默认 ~/.dsh/sessions-ssid
  --thresholds <list>   逗号分隔的 ratio 阈值，默认 0.5,0.6,0.7
  --json <file>         把每条含思考消息的明细写成 JSON（交叉分析用）
退出码：0 = 跑完；2 = 用法错误或探针自检不一致。`

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0) }
const ROOT = opt('root', join(homedir(), '.dsh', 'sessions-ssid'))
const JSON_OUT = opt('json', null)
const THRESHOLDS = (opt('thresholds', '0.5,0.6,0.7')).split(',').map(Number)
if (THRESHOLDS.some(Number.isNaN)) { console.error(USAGE); process.exit(2) }

/** 切分单元用的分隔符——与 `src/repetition.ts` 的 `UNIT_SEPARATOR` 同形。 */
const UNIT_SEPARATOR = /[\n。！？]/

/** 与 `src/repetition.ts` 的私有 `isSemanticUnit` 同形；漂移由 `selfCheck` 兜住。 */
function isSemanticUnit(unit) {
  if (unit.startsWith('```')) return false
  return /[\p{Script=Han}]|[A-Za-z]{2}/u.test(unit)
}

/**
 * 增量流式判定器：维护 units / counts / repeated 三个量，每 push 只处理新增文本。
 *
 * `repeated` 的维护是关键：原口径是「count ≥ `REPEAT_MIN_COUNT` 的单元的 count 之和」，
 * 所以一个单元的 count 从 2 跨到 3 时要把**已有的 3 次**一次性补记，此后每次 +1；跨 3 之前
 * 一次都不记。
 */
class StreamRepetition {
  #counts = new Map()
  #units = 0
  #repeated = 0
  #buf = ''
  #maxBuffered = 0
  #threshold

  constructor(threshold) {
    this.#threshold = threshold
  }

  #settle(raw) {
    const unit = raw.trim()
    if (unit === '' || !isSemanticUnit(unit)) return
    const count = (this.#counts.get(unit) ?? 0) + 1
    this.#counts.set(unit, count)
    this.#units += 1
    if (count === REPEAT_MIN_COUNT) this.#repeated += count
    else if (count > REPEAT_MIN_COUNT) this.#repeated += 1
  }

  /** 喂一个 chunk，返回该位置的判定。 */
  push(chunk) {
    this.#buf += chunk
    if (this.#buf.length > this.#maxBuffered) this.#maxBuffered = this.#buf.length
    let at = this.#buf.search(UNIT_SEPARATOR)
    while (at !== -1) {
      this.#settle(this.#buf.slice(0, at))
      this.#buf = this.#buf.slice(at + 1)
      at = this.#buf.search(UNIT_SEPARATOR)
    }
    return this.metrics()
  }

  /**
   * 当前判定。未收尾的尾段用**临时值**参与计算——原实现每次调用都能看到它——但不写回状态：
   * 写回会让同一行被后续 chunk 重复计入。
   */
  metrics() {
    const tail = this.#buf.trim()
    let units = this.#units
    let repeated = this.#repeated
    if (tail !== '' && isSemanticUnit(tail)) {
      units += 1
      const count = (this.#counts.get(tail) ?? 0) + 1
      if (count === REPEAT_MIN_COUNT) repeated += count
      else if (count > REPEAT_MIN_COUNT) repeated += 1
    }
    const ratio = units === 0 ? 0 : repeated / units
    const metrics = { units, repeated, ratio }
    return { ...metrics, verdict: repetitionVerdict(metrics, this.#threshold) }
  }

  /** 未收尾缓冲区的峰值长度——「稳态 buf 很短」这个性能前提的证据。 */
  get maxBuffered() {
    return this.#maxBuffered
  }
}

/**
 * 前置自检：逐 chunk 对照增量扫描器与全文判定的四元组。
 *
 * 两者不等价的话，下面全库回放报出来的是另一套口径的数字——这条自检是数字可信度的前提，
 * 不是可选装饰。探针覆盖四类形状：稳定重复、重复里夹正常句、代码围栏与实义单元混排、
 * 未收尾的尾段（最后这一条正是 §九.2 点名的那个细节）。
 * @returns 不一致的位置数；0 表示口径一致。
 */
function selfCheck() {
  const probes = [
    'aa。aa。aa。bb。bb。bb。cc。',
    '好。\n好。\n好。\n不一样的一句\n好。\n好。',
    '```ts\nconst a = 1\n```\n汉字单元。汉字单元。汉字单元。英文 word 也算。',
    '未收尾的尾段',
  ]
  let bad = 0
  for (const text of probes) {
    for (const threshold of THRESHOLDS) {
      const scanner = createStreamDetector(threshold)
      let acc = ''
      for (const chunk of Array.from(text)) {
        acc += chunk
        const fired = scanner.push(chunk)
        const reading = scanner.reading()
        const whole = measureRepetition(acc)
        const verdict = repetitionVerdict(whole, threshold)
        if (reading.units !== whole.units || reading.repeated !== whole.repeated
          || reading.ratio !== whole.ratio || fired !== (verdict === 'loop')) bad += 1
      }
    }
  }
  return bad
}

const drift = selfCheck()
if (drift !== 0) {
  console.error(`前置自检不一致：${drift} 个位置。流上判定与全文判定已不等价（src/cut/detect.ts vs src/repetition.ts），先修它。`)
  process.exit(2)
}

// ── 全库回放 ────────────────────────────────────────────────────────────
/** 会话日志是多帧 zstd：按 magic 切帧逐段解。 */
function decompressAll(buf) {
  const offsets = []
  let at = buf.indexOf(ZSTD_MAGIC)
  while (at !== -1) { offsets.push(at); at = buf.indexOf(ZSTD_MAGIC, at + 4) }
  const out = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i]
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try { out.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8')) } catch { /* 尾部残帧 */ }
  }
  return out.join('')
}

const files = []
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.jsonl.zstd')) files.push(path)
  }
}
try { walk(ROOT) } catch { console.error(`读不到会话根：${ROOT}\n${USAGE}`); process.exit(2) }

const BUCKETS = ['<1k', '1k–5k', '5k–20k', '20k–100k', '>100k']
const bucketOf = c => (c < 1000 ? '<1k' : c < 5000 ? '1k–5k' : c < 20000 ? '5k–20k' : c < 100000 ? '20k–100k' : '>100k')
const emptyStat = () => ({
  cut: 0, atEnd: 0, sessions: new Set(), leadPcts: [], hitChars: [], hitUnits: [], hitRatios: [],
  loopChunks: [], longHits: 0, wholeLoop: 0, streamOnly: 0, fellBack: 0, atUnits12: 0,
  buckets: Object.fromEntries(BUCKETS.map(b => [b, 0])), savedChars: 0, savedChunks: 0, bufferedPeak: 0,
  leadByBucket: Object.fromEntries(BUCKETS.map(b => [b, []])),
  savedByBucket: Object.fromEntries(BUCKETS.map(b => [b, 0])),
  cutByBucket: Object.fromEntries(BUCKETS.map(b => [b, 0])),
})
const stat = Object.fromEntries(THRESHOLDS.map(t => [t, emptyStat()]))
const records = []
let thinkingMessages = 0
let filesRead = 0
const started = performance.now()

for (const [i, file] of files.entries()) {
  if (i % 100 === 0) process.stderr.write(`  …${i}/${files.length}\n`)
  let text
  try { text = decompressAll(readFileSync(file)) } catch { continue }
  filesRead += 1
  for (const rawLine of text.split('\n')) {
    if (!rawLine || !rawLine.includes('"assistant/message"')) continue
    let ev
    try { ev = JSON.parse(rawLine) } catch { continue }
    if (ev.type !== 'assistant/message') continue
    const rec = (ev.data?.stream ?? []).find(r => r.type === 'reasoning-chunks')
    if (!rec || !Array.isArray(rec.texts) || rec.texts.length === 0) continue
    thinkingMessages += 1

    const texts = rec.texts
    const totalChars = texts.reduce((sum, c) => sum + c.length, 0)
    const totalChunks = texts.length
    const whole = measureRepetition(texts.join(''))
    const wholeIsLoop = repetitionVerdict(whole) === 'loop'

    const hit = {}
    for (const threshold of THRESHOLDS) {
      const s = stat[threshold]
      const scanner = createStreamDetector(threshold)
      let firstLoop = null
      let loopChunks = 0
      let fellBack = false
      let chars = 0
      for (let k = 0; k < texts.length; k += 1) {
        chars += texts[k].length
        const fired = scanner.push(texts[k])
        const m = scanner.reading()
        if (fired) {
          loopChunks += 1
          if (firstLoop === null) firstLoop = { chunk: k + 1, chars, units: m.units, repeated: m.repeated, ratio: m.ratio }
        } else if (firstLoop !== null) fellBack = true
      }
      if (scanner.peakBuffer() > s.bufferedPeak) s.bufferedPeak = scanner.peakBuffer()
      if (firstLoop === null) { hit[threshold] = null; continue }
      const atEnd = totalChars - firstLoop.chars <= 0
      hit[threshold] = { ...firstLoop, atEnd, fellBack, loopChunks }
      if (atEnd) { s.atEnd += 1; continue }
      const bucket = bucketOf(totalChars)
      s.cut += 1
      s.sessions.add(file)
      s.leadPcts.push((firstLoop.chars / totalChars) * 100)
      s.leadByBucket[bucket].push((firstLoop.chars / totalChars) * 100)
      s.hitChars.push(firstLoop.chars)
      s.hitUnits.push(firstLoop.units)
      s.hitRatios.push(firstLoop.ratio)
      s.loopChunks.push(loopChunks)
      s.buckets[bucket] += 1
      s.cutByBucket[bucket] += 1
      s.savedChars += totalChars - firstLoop.chars
      s.savedByBucket[bucket] += totalChars - firstLoop.chars
      s.savedChunks += totalChunks - firstLoop.chunk
      if (totalChars > 20000) s.longHits += 1
      if (wholeIsLoop) s.wholeLoop += 1
      else s.streamOnly += 1
      if (fellBack) s.fellBack += 1
      if (firstLoop.units === MIN_UNITS) s.atUnits12 += 1
    }

    records.push({
      file: file.slice(ROOT.length + 1), turn: ev.data?.turn, step: ev.data?.step,
      totalChars, totalChunks,
      wholeUnits: whole.units, wholeRepeated: whole.repeated, wholeRatio: +whole.ratio.toFixed(4), wholeIsLoop,
      hit,
    })
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────
const cost = (performance.now() - started) / 1000
const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(2)}%`)
const quantile = (arr, q) => {
  if (arr.length === 0) return null
  const a = arr.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * q))]
}
const fmt = n => Math.round(n).toLocaleString('en-US')
const cut = t => records.filter(r => r.hit[t] && !r.hit[t].atEnd)
const truth = records.filter(r => r.wholeIsLoop)

console.log(`\n${'='.repeat(94)}`)
console.log(`全库回放：${filesRead}/${files.length} 个会话文件解出，含思考的助手消息 ${fmt(thinkingMessages)} 条`)
console.log(`阈值 ${THRESHOLDS.join(' / ')}；MIN_UNITS=${MIN_UNITS} REPEAT_MIN_COUNT=${REPEAT_MIN_COUNT}；探针自检 ✓`)
console.log('='.repeat(94))

console.log('\n== ① 对照表 ==')
console.log('阈值    会掐断   干预率   命中末尾   涉及会话   提前量中位   20k+长消息   真阳性(全量也越线)   召回')
for (const t of THRESHOLDS) {
  const s = stat[t]
  const recalled = truth.filter(r => r.hit[t]).length
  console.log(` ${t}   ${String(s.cut).padStart(6)}   ${pct(s.cut, thinkingMessages).padStart(6)}   ${String(s.atEnd).padStart(6)}     ${String(s.sessions.size).padStart(5)}`
    + `      ${(quantile(s.leadPcts, 0.5) ?? 0).toFixed(1).padStart(5)}%      ${String(s.longHits).padStart(4)}`
    + `         ${String(s.wholeLoop).padStart(5)} (${pct(s.wholeLoop, s.cut).padStart(6)})      ${fmt(recalled)}/${fmt(truth.length)} (${pct(recalled, truth.length)})`)
}
console.log(`\n  误掐（掐了但全量判定不越线）：` + THRESHOLDS.map(t => `${t} → ${fmt(stat[t].cut - stat[t].wholeLoop)} 次`).join('　'))
console.log(`  抓每条真退化要付的误掐：` + THRESHOLDS.map(t => `${t} → ${stat[t].wholeLoop === 0 ? '—' : ((stat[t].cut - stat[t].wholeLoop) / stat[t].wholeLoop).toFixed(2)} 次`).join('　'))

console.log('\n== ② 长度分桶（该管的是长输出，短消息是误伤面）==')
console.log(`  真退化语料 ${fmt(truth.length)} 条的长度分布：` + BUCKETS.map(b => `${b} ${fmt(truth.filter(r => bucketOf(r.totalChars) === b).length)}`).join('  '))
for (const t of THRESHOLDS) {
  const s = stat[t]
  const tp = b => cut(t).filter(r => bucketOf(r.totalChars) === b && r.wholeIsLoop).length
  console.log(`  掐断 th=${t}：` + BUCKETS.map(b => `${b} ${String(s.buckets[b]).padStart(5)}(真${String(tp(b)).padStart(4)})`).join('  '))
}
console.log('\n  同一批命中的提前量（命中点 / 全文长度，越小越早）与省下的字符：')
for (const t of THRESHOLDS) {
  const s = stat[t]
  console.log(`   th=${t}   ` + BUCKETS.map(b => `${b} ${s.leadByBucket[b].length === 0 ? '—' : `${quantile(s.leadByBucket[b], 0.5).toFixed(0)}%/省${fmt(s.savedByBucket[b])}`}`).join('  '))
}

console.log('\n== ③ 抖动（命中之后剩余流里的越线密度；1.0 = 命中后一路越线到结尾）==')
for (const t of THRESHOLDS) {
  const c = cut(t).map(r => ({ ...r, density: (r.hit[t].loopChunks - 1) / Math.max(1, r.totalChunks - r.hit[t].chunk) }))
  const fb = c.filter(x => x.hit[t].fellBack)
  console.log(`  th=${t}：密度 p10 ${quantile(c.map(x => x.density), 0.1).toFixed(3)}  p50 ${quantile(c.map(x => x.density), 0.5).toFixed(3)}`
    + `　密度≥0.9 ${fmt(c.filter(x => x.density >= 0.9).length)}(${pct(c.filter(x => x.density >= 0.9).length, c.length)})`
    + `　密度≤0.1 ${fmt(c.filter(x => x.density <= 0.1).length)}(${pct(c.filter(x => x.density <= 0.1).length, c.length)})`)
  console.log(`      「出现过 normal」的 ${fmt(fb.length)} 条里，密度≥0.9 ${fmt(fb.filter(x => x.density >= 0.9).length)}（抖一下又继续越线）、密度≤0.1 ${fmt(fb.filter(x => x.density <= 0.1).length)}（该怀疑的误杀）`)
}

console.log('\n== ④ 命中点与收益 ==')
console.log('阈值    命中字符 p10/p50/p90       命中时 units 中位   恰好=MIN_UNITS   单条省下 token p50/p90   合计省下字符    buf峰值')
for (const t of THRESHOLDS) {
  const s = stat[t]
  console.log(` ${t}   ${fmt(quantile(s.hitChars, 0.1))}/${fmt(quantile(s.hitChars, 0.5))}/${fmt(quantile(s.hitChars, 0.9))}`
    + `          ${String(quantile(s.hitUnits, 0.5)).padStart(4)}            ${String(s.atUnits12).padStart(4)} (${pct(s.atUnits12, s.cut).padStart(6)})`
    + `     ${fmt(quantile(cut(t).map(r => r.totalChunks - r.hit[t].chunk), 0.5))}/${fmt(quantile(cut(t).map(r => r.totalChunks - r.hit[t].chunk), 0.9))}`
    + `          ${fmt(s.savedChars).padStart(10)}    ${fmt(s.bufferedPeak).padStart(6)}`)
}
console.log(`\n总耗时 ${cost.toFixed(1)} 秒`)

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    root: ROOT, filesRead, filesTotal: files.length, thinkingMessages, thresholds: THRESHOLDS,
    costSeconds: cost, records,
  }), 'utf8')
  console.log(`明细写入 ${JSON_OUT}`)
}
