#!/usr/bin/env node
/**
 * 退化提醒「为什么没发」对账 — 拿插件自己的判据重算一份会话日志，跟实际注入的提醒逐条对齐。
 *
 * **它存在的理由**：`session-degeneration-scan.mjs` 的重复率口径与插件的**不是同一套**
 * （前者不滤纯标记单元，后者要求单元含汉字或两个连续拉丁字母，见 `src/repetition.ts`
 * 的 `isSemanticUnit`）。实测同一份日志同一个 step：外部脚本报 57%、插件判据算 45%（`normal`）。
 * 拿外部脚本的数字直接推「插件为什么没提醒」，会得出**反向结论**——它会让你以为判据漏了一大片，
 * 而真相往往是判据判对了、只是没达到触发条件。
 *
 * **判据直接从 `src/` import**，不在本文件里重新实现：插件的判据改了，本工具跟着变，
 * 不会出现「工具与实现各算一套」的漂移。
 *
 * 输出四块：
 *   ① 事件普查 —— 有多少 step 带推理
 *   ② 双口径对照 —— 本步在「外部脚本口径」与「插件口径」下各是多少
 *   ③ 插件判据的完整模拟 —— 应当触发提醒的步（含 `trackLoop` 窗口累计与 `admitPerTurn` 节流）
 *   ④ 实际注入的提醒 —— 从日志里按 `source.kind` 捞出真正发出去的那几条
 * ③ 与 ④ 的差集就是答案。
 *
 * 用法：
 *   node tools/audit-loop-detection.mjs <session.vN.jsonl.zstd>
 *   node tools/audit-loop-detection.mjs <session.vN.jsonl.zstd> --top 20
 *   node tools/audit-loop-detection.mjs <session.vN.jsonl.zstd> --json
 *
 * 会话日志位置：SSiD = `~/.dsh/sessions-ssid/<工作区>/<会话 id>/session.v4.jsonl.zstd`。
 *
 * 退出码：0 = 应当触发的提醒都发出来了；1 = 存在「该发未发」的步；2 = 用法错误或读不出推理。
 *
 * 运行环境：本工具 import 插件的 `.ts` 源码，依赖 Node 内置的类型剥离（type stripping）。
 *   · ≥ 22.18.0 或 ≥ 23.6.0：**默认启用**，直接 `node tools/…` 即可（本机 Node 26.2.0 实测）
 *   · 22.6.0–22.17.x / 23.0–23.5.x：需加 `--experimental-strip-types`
 *   · < 22.6.0：不支持
 *   （门槛出处：Node 官方文档 Modules: TypeScript 的 `changes` 表，v22.6.0 引入、
 *   v22.18.0 / v23.6.0 起默认启用、v24.12.0 / v25.2.0 起 stable。）
 *
 * **另注：Node 拒绝处理 `node_modules` 下的 `.ts`**（同上文档），所以本工具只在**源码仓库**
 * 里可用 —— 不能对着 `node_modules` 里装好的插件实体跑。
 *
 * 帧扫描逻辑复制自 DSH 自身（`packages/session/session-persistence-jsonl/src/zstd.ts` 的
 * `scanZstdFrames`）：会话日志是**拼接的 zstd 帧**，每次追加一批事件写一帧，按普通压缩流
 * 解压会在第二帧就报 `Unknown frame descriptor`。
 *
 * 实测案例与结论：`docs/排查/2026-10-05-单点崩溃绕过窗口门槛.md`
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const { measureRepetition, repetitionVerdict, trackLoop } = await import(pathToFileURL(join(SRC, 'repetition.ts')).href)
const { admitPerTurn } = await import(pathToFileURL(join(SRC, 'throttle.ts')).href)

const ZSTD_MAGIC = 0xfd2fb528

const USAGE = `退化提醒「为什么没发」对账。

用法：
  node tools/audit-loop-detection.mjs <session.vN.jsonl.zstd> [--top N] [--json]

退出码：0 = 提醒都已发出；1 = 存在「该发未发」；2 = 用法错误。`

/**
 * 定位拼接 zstd 流里的完整帧边界，不展开块内容。
 * 复制自 DSH 的 `scanZstdFrames`（见文件头注释的来源说明）。
 * @param {Buffer} buffer - 会话日志的全部字节。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}} 帧区间；尾部写入中的半帧由 `tornStart` 标出。
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`会话日志损坏：偏移 ${offset} 处不是 zstd 帧魔数`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`帧头保留位异常：偏移 ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`块类型保留值异常：偏移 ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 读一份会话日志并解析出事件数组。
 * @param {string} file - `session.vN.jsonl.zstd` 路径。
 * @returns {{events: object[], frames: number, torn: boolean}} 事件与帧统计。
 */
function readSession(file) {
  const buffer = readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buffer)
  const events = []
  for (const frame of frames) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        /* 写入中的半行，跳过 */
      }
    }
  }
  return { events, frames: frames.length, torn: tornStart !== undefined }
}

/**
 * 从一条 `assistant/message` 里取出推理文本。
 * 推理在 `data.stream[].texts`，`type` 为 `reasoning-chunks`——**字段名是 `texts` 不是 `chunks`**。
 * @param {object} event - 事件。
 * @returns {string|undefined} 拼接后的推理原文；无推理时 `undefined`。
 */
function reasoningOf(event) {
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  const parts = []
  for (const entry of stream) {
    if (entry?.type !== 'reasoning-chunks') continue
    for (const piece of entry.texts ?? []) if (typeof piece === 'string') parts.push(piece)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * **仅用于对照**的外部脚本口径：只滤空串，不过滤纯标记单元。
 *
 * 把它的数字当成插件的判定会误判——见文件头注释。放在这里是为了让「两个口径差多少」
 * 成为可复现的量，而不是一句印象。
 * @param {string} text - 推理原文。
 * @returns {{ratio: number, units: number}|null} 单元不足 20 时返回 `null`。
 */
function externalProfile(text) {
  const units = text.split(/[\n。！？!?]/).map(unit => unit.trim()).filter(unit => unit !== '')
  if (units.length < 20) return null
  const counts = new Map()
  for (const unit of units) counts.set(unit, (counts.get(unit) ?? 0) + 1)
  let repeated = 0
  for (const [, count] of counts) if (count >= 3) repeated += count
  return { ratio: repeated / units.length, units: units.length }
}

/**
 * 从一条用户消息里取消息来源。
 * @param {object} event - 事件。
 * @returns {{kind: string, form?: string, summary?: string}|undefined}} 来源；无来源时 `undefined`。
 */
function sourceOf(event) {
  const source = event.data?.source
  if (source === undefined || source === null) return undefined
  return {
    kind: typeof source.kind === 'string' ? source.kind : JSON.stringify(source.kind),
    form: typeof source.form === 'string' ? source.form : undefined,
    summary: typeof source.summary === 'string' ? source.summary : undefined,
  }
}

/**
 * 按摘要给提醒分类。
 *
 * **不分类就没法对账**：`plugin:dsh-allostasis` 这一个生产者身份下挂着三类提醒
 * （语言漂移 / 推理退化 / 空回合），它们判据独立、节流各一份。拿「本插件发出的提醒总数」
 * 去减「应当触发的**退化**提醒数」，会把漂移提醒算成退化提醒——差额被抹平，
 * 结论正好反过来（实测：0 条该触发 vs 8 条实发，相减得 -8，会印出「无缺口」）。
 * @param {string|undefined} summary - 客户端一行叙述。
 * @returns {'loop'|'drift'|'silent'|'other'} 类别；`loop` 才是退化提醒。
 */
function categorize(summary) {
  if (typeof summary !== 'string') return 'other'
  if (summary.startsWith('推理退化')) return 'loop'
  if (summary.startsWith('语言漂移')) return 'drift'
  if (summary.startsWith('空回合')) return 'silent'
  return 'other'
}

/** 解析命令行参数。 */
function parseArgs(argv) {  const options = { file: undefined, top: 12, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--top') options.top = Number(argv[++i])
    else if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}`)
    else if (options.file === undefined) options.file = arg
    else throw new Error(`多余的参数: ${arg}`)
  }
  if (!options.help && options.file === undefined) throw new Error('需要给出会话日志路径')
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

const { events, frames, torn } = readSession(options.file)

// ── 用插件判据逐步重算 ──────────────────────────────────────────────────────
const trackers = new Map()
const throttles = new Map()
const steps = []
const shouldFire = []
let index = 0

for (const event of events) {
  if (event.type !== 'assistant/message') continue
  const text = reasoningOf(event)
  if (text === undefined) continue
  index += 1
  const turn = event.data?.turn
  const step = event.data?.step
  const metrics = measureRepetition(text)
  const verdict = repetitionVerdict(metrics)
  const tracked = trackLoop(trackers.get('s'), verdict)
  trackers.set('s', tracked.state)
  const external = externalProfile(text)
  const row = {
    i: index, turn, step, seq: event.seq, chars: text.length,
    units: metrics.units, repeated: metrics.repeated, ratio: metrics.ratio, verdict,
    externalRatio: external?.ratio ?? null, externalUnits: external?.units ?? null,
    top: metrics.top.map(entry => ({ unit: entry.unit, count: entry.count })),
  }
  steps.push(row)
  if (!tracked.fire) continue
  const advanced = admitPerTurn(throttles.get('s'), turn)
  if (advanced === undefined) {
    row.suppressedByThrottle = true
    continue
  }
  throttles.set('s', advanced)
  shouldFire.push({ ...row, nth: advanced.count })
}

// ── 日志里真正发出去的提醒 ──────────────────────────────────────────────────
const notices = []
const kindCensus = new Map()
for (const event of events) {
  if (event.type !== 'user/message') continue
  const source = sourceOf(event)
  const kind = source?.kind ?? '(无 source)'
  kindCensus.set(kind, (kindCensus.get(kind) ?? 0) + 1)
  if (source?.kind !== 'plugin:dsh-allostasis') continue
  notices.push({ seq: event.seq, form: source.form, summary: source.summary, category: categorize(source.summary) })
}
/** 只有退化这一类的提醒才能拿去和 `shouldFire` 对账（见 `categorize`）。 */
const loopNotices = notices.filter(notice => notice.category === 'loop')

const judged = steps.filter(row => row.verdict !== 'insufficient')
const overline = judged.filter(row => row.verdict === 'loop')

if (options.json) {
  console.log(JSON.stringify({
    file: options.file, frames, torn, steps: steps.length, judged: judged.length,
    overline: overline.length, shouldFire, notices,
    kindCensus: Object.fromEntries(kindCensus),
  }, null, 2))
  process.exit(shouldFire.length === notices.length ? 0 : 1)
}

console.log(`文件      ${options.file}`)
console.log(`帧        ${frames}${torn ? '（尾部有写入中的半帧，已跳过）' : ''}`)
console.log(`事件      ${events.length}   带推理的 step  ${steps.length}   其中可判定  ${judged.length}`)

console.log(`\n── ① 双口径对照（按插件口径 ratio 降序，前 ${options.top}）──`)
console.log('  turn/step     seq   chars | 外部口径 units ratio | 插件口径 units ratio  judgment')
for (const row of [...steps].sort((a, b) => b.ratio - a.ratio).slice(0, options.top)) {
  const ext = row.externalUnits === null ? '   n/a      ' : `${String(row.externalUnits).padStart(5)} ${(row.externalRatio * 100).toFixed(0).padStart(4)}%`
  console.log(
    `  t${String(row.turn).padStart(3)}/s${String(row.step).padEnd(2)} ${String(row.seq).padStart(6)} ${String(row.chars).padStart(7)} | `
    + `${ext} | ${String(row.units).padStart(5)} ${(row.ratio * 100).toFixed(0).padStart(4)}%  ${row.verdict}`,
  )
}

console.log(`\n── ② 插件判据结论 ──`)
console.log(`越线 step（ratio ≥ 阈值）  ${overline.length}`)
console.log(`应当触发提醒              ${shouldFire.length}`)
if (shouldFire.length > 0) {
  console.log('  前若干次：')
  for (const row of shouldFire.slice(0, options.top)) {
    console.log(
      `    #${String(row.nth).padStart(2)}  seq ${String(row.seq).padStart(6)}  t${row.turn}/s${row.step}`
      + `  ratio ${(row.ratio * 100).toFixed(0)}%  (${row.repeated}/${row.units})`
      + `  top: ${row.top.slice(0, 3).map(entry => `${JSON.stringify(entry.unit.slice(0, 14))}×${entry.count}`).join('、')}`,
    )
  }
}
const throttleSuppressed = steps.filter(row => row.suppressedByThrottle === true).length
if (throttleSuppressed > 0) console.log(`  （另 ${throttleSuppressed} 个越线步被同 turn 节流挡下——这是设计内行为）`)

console.log(`\n── ③ 日志里实际注入的提醒 ──`)
console.log(`plugin:dsh-allostasis 共 ${notices.length} 条（退化 ${loopNotices.length} · 漂移 ${notices.filter(n => n.category === 'drift').length} · 空回合 ${notices.filter(n => n.category === 'silent').length}）`)
for (const notice of notices.slice(0, options.top)) {
  console.log(`  seq ${String(notice.seq).padStart(6)}  [${notice.category}]  ${notice.summary ?? '(无摘要)'}`)
}
if (notices.length > options.top) console.log(`  …另有 ${notices.length - options.top} 条`)

console.log(`\n── ④ user/message 的来源分布 ──`)
for (const [kind, count] of [...kindCensus].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${kind}`)
}

// 两种缺口要分开报：判据说要发却没发（链路），和判据自己认为不该发（门槛形状）。
// 后者才是「检测到却沉默」的样子——外部脚本报越线、插件报正常，看数字会误判成判据失灵。
const gap = shouldFire.length - loopNotices.length
/** 判据缺口：有越线步，却一步都没凑够触发条件。它与注入缺口同样是「检测有缺口」。 */
const criterionGap = overline.length > 0 && shouldFire.length === 0
console.log(`\n── 结论 ──`)
if (gap > 0) {
  console.log(`**注入缺口：该发未发 ${gap} 条。** 判据算出了应当触发，日志里却没有对应的注入——`)
  console.log('去查 `agent/pre-step` 的触发时机，以及被压缩遮蔽的事件在 `session.snapshot()` 里是否还可见。')
} else if (criterionGap) {
  console.log(`**判据缺口：有 ${overline.length} 个步越线，却一步都没凑够触发条件。**`)
  console.log('这不是注入链路的问题，是触发条件的形状问题——单点崩溃与抖动在「步数」这一个维度上长得一样，')
  console.log('而 `LOOP_WINDOW_HITS` 只用步数区分它们。修法方向见 `docs/排查/2026-10-05-单点崩溃绕过窗口门槛.md`。')
} else if (overline.length === 0) {
  console.log('本会话没有越线步——判据未被考验，**不能据此说它健康**。')
} else {
  console.log(`越线 ${overline.length} 步 → 触发 ${shouldFire.length} 次 → 实际注入 ${loopNotices.length} 条，一致。`)
}
// 退出码对自动化要有意义：判据缺口同样是缺口，不能只报注入链路那一种。
process.exit(gap > 0 || criterionGap ? 1 : 0)
