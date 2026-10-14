#!/usr/bin/env node
/**
 * 退化提醒的疗效审计 —— 提醒发出去之后，重复率到底有没有落下来。
 *
 * **它存在的理由**：`docs/设计/2026-09-29-压缩干预-重新设计.md` §六 未决 1 把
 * 「效果判据的窗口该多长」列为**没有依据、不许拍**的问题，而三级干预阶梯的放行
 * （第一级证伪后才允许上第二级）就卡在这个数上。本工具产出那个分布。
 *
 * **判据必须与插件同源。** 提醒文本里的百分比是插件口径（`src/repetition.ts` 的
 * `measureRepetition`：单元须含汉字或两个连续拉丁字母，`MIN_UNITS` = 12）。用外部脚本
 * 的口径去量「提醒前 vs 提醒后」，等于拿两把尺子比长度——`tools/audit-loop-detection.mjs`
 * 已实测过同一 step 两个口径报 57% / 45%。所以本工具直接从 `../src` import 判据，
 * 也不在文件里重新实现。
 *
 * 输出五块（`--root` 模式下另加会话明细，其余同构）：
 *   ① 会话规模 —— 判据可用的 step 数（含其中越线的步数）/ 提醒条数
 *   ② 逐条对账 —— 提醒指认的那一步，以及它之后第 1 / 2 / 3 / 5 步的重复率，带落点标记
 *   ③ 窗口汇总 —— 分「全部提醒」与「只看落点在越线上的」两块统计
 *   ④ 复发间隔 —— 提醒之后隔多少步再越线，分桶分布（含「到会话末未再越线」一档）
 *   ⑤ 读法 —— 各块之间的关系，以及几个自由度为什么必须显式
 *
 * **`--root` 为什么要有**：疗效类问题没有分布就没法定论，而单会话样本永远稀薄
 * （实测本机 ≥3MB 的 11 个会话里只有 2 个带退化提醒）。跨会话模式把各会话的样本**池化**
 * 而不是对各会话的比例取平均——只有一两条提醒的会话方差极大，平均会被它们拽偏。会话之间
 * 的差异另由明细表呈现。
 *
 * **复发间隔与窗口不是同一个问题**：窗口问「打断当场有没有效」，复发间隔问「打断之后多久
 * 失守」。实测那个分布是双峰的（近端 1–2 步、远端 >10 步各占约四成），两者的成因与处置方向
 * 都不同，所以分开报。**只报分布，不设阈值**——判据留给数据。
 *
 * **落点为什么要分层**：`trackLoop` 的触发条件是「最近 5 步里越线 2 次」，所以提醒可能
 * 落在一步**已经回落**的思考上（越线发生在它之前）。那批样本本来就没有下降空间，混进
 * 总体只会把疗效读低。分层的差就是它们造成的稀释量。
 *
 * **两个指标为什么都要报**：`均值比提醒前低` 量的是「这一段整体有没有变好」，
 * 会随窗口拉长被稀释；`窗口内出现过 <50%` 量的是「有没有回落过」，会随窗口拉长
 * 单调上升——长到某个长度时它必然接近 100%。**单看后者会得出「几乎全都有效」，
 * 单看前者会得出「七成有效」，两者都对，差别全在窗口。**报两个是为了让窗口这个
 * 自由度是显式的，而不是藏在指标里。
 *
 * 用法：
 *   node tools/audit-reminder-effect.mjs <session.vN.jsonl.zstd>
 *   node tools/audit-reminder-effect.mjs <session.vN.jsonl>          # 导出包里的未压缩日志
 *   node tools/audit-reminder-effect.mjs <file> --windows 1,2,5,10
 *   node tools/audit-reminder-effect.mjs <file> --json
 *
 * 会话日志位置：SSiD = `~/.dsh/sessions-ssid/<工作区>/<会话 id>/session.v4.jsonl.zstd`。
 * SSiD 的会话导出包给的是**未压缩**的 `session.v4.jsonl`，本工具按魔数自动分辨，两者都吃。
 *
 * 退出码：0 = 出报告；1 = 会话里没有退化提醒（无样本可算）；2 = 用法错误或读不出。
 *
 * 运行环境：本工具 import 插件的 `.ts` 源码，依赖 Node 内置的类型剥离（type stripping）。
 *   · ≥ 22.18.0 或 ≥ 23.6.0：默认启用，直接 `node tools/…` 即可
 *   · 22.6.0–22.17.x / 23.0–23.5.x：需加 `--experimental-strip-types`
 *   · < 22.6.0：不支持
 * Node 拒绝处理 `node_modules` 下的 `.ts`，所以本工具只在**源码仓库**里可用。
 *
 * 实测案例：`docs/设计/2026-09-29-压缩干预-重新设计.md` §四（第一份疗效样本）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const { measureRepetition, repetitionVerdict, MIN_UNITS } = await import(pathToFileURL(join(SRC, 'repetition.ts')).href)

const ZSTD_MAGIC = 0xfd2fb528
const DEFAULT_WINDOWS = [1, 2, 3, 5]
const DEFAULT_MIN_BYTES = 1024 * 1024
const LOG_NAME = 'session.v4.jsonl'
const LOG_NAME_ZSTD = 'session.v4.jsonl.zstd'

/** 提醒正文里「重复率 NN%」的抓取口径；正文由 `src/messages.ts` 的 `degenerationText` 组装。 */
const QUOTED_RATIO = /重复率 (\d+)%/

const USAGE = `退化提醒的疗效审计。

用法：
  node tools/audit-reminder-effect.mjs <session.vN.jsonl[.zstd]> [--windows 1,2,3,5] [--json]
  node tools/audit-reminder-effect.mjs --root <dir> [--min-size 1MB] [--top 15]

选项：
  --root <dir>        递归扫该目录下的会话日志，池化所有样本后出报告
  --min-size <size>   --root 模式的最小文件（默认 1MB，支持 500KB 写法）
  --windows 1,2,3,5   要统计的窗口长度（以 step 计）
  --top <n>           --root 模式下会话明细列出的条数（默认 15）
  --json              输出 JSON

退出码：0 = 出报告；1 = 没有退化提醒；2 = 用法错误或读不出。`

/**
 * 解析 `1MB` / `500KB` / 纯字节数。
 * @param {string} raw - 用户输入的大小。
 * @returns {number} 字节数。
 */
function parseSize(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(raw.trim())
  if (match === null) throw new Error(`无法解析大小: ${raw}`)
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? 'B').toLowerCase()]
  return Math.floor(Number(match[1]) * scale)
}

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{file?: string, root?: string, minBytes: number, windows: number[], top: number, json: boolean, help: boolean}} 解析结果。
 */
function parseArgs(argv) {
  const options = {
    file: undefined, root: undefined, minBytes: DEFAULT_MIN_BYTES,
    windows: DEFAULT_WINDOWS, top: 15, json: false, help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--root') options.root = argv[++i]
    else if (arg === '--min-size') options.minBytes = parseSize(argv[++i] ?? '')
    else if (arg === '--top') options.top = Number(argv[++i])
    else if (arg === '--windows') {
      const raw = argv[++i] ?? ''
      const parsed = raw.split(',').map(part => Number(part.trim()))
      if (parsed.length === 0 || parsed.some(n => !Number.isInteger(n) || n < 1)) {
        throw new Error(`--windows 需要正整数列表，收到: ${raw}`)
      }
      options.windows = [...new Set(parsed)].sort((a, b) => a - b)
    } else if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}`)
    else if (options.file === undefined) options.file = arg
    else throw new Error(`多余的参数: ${arg}`)
  }
  if (!options.help && options.file === undefined && options.root === undefined) {
    throw new Error('需要给出会话日志路径，或用 --root 指定会话目录')
  }
  if (options.file !== undefined && options.root !== undefined) {
    throw new Error('--root 与单文件路径二选一')
  }
  return options
}

/**
 * 定位拼接 zstd 流里的完整帧边界，不展开块内容。
 * 复制自 DSH 的 `scanZstdFrames`（`packages/session/session-persistence-jsonl/src/zstd.ts`）。
 * @param {Buffer} buffer - 会话日志的全部字节。
 * @returns {{frames: {start: number, end: number}[], tornStart?: number}} 帧区间；尾部半帧由 `tornStart` 标出。
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
 *
 * 两种来源都收：运行中的会话是拼接 zstd（`session.v4.jsonl.zstd`），导出包给的是
 * 未压缩的 `session.v4.jsonl`。按首 4 字节的魔数分辨，不靠扩展名。
 * @param {string} file - 日志路径。
 * @returns {{events: object[], frames: number, compressed: boolean}} 事件与读取统计。
 */
function readSession(file) {
  const buffer = readFileSync(file)
  const compressed = buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
  const chunks = []
  if (!compressed) {
    chunks.push(buffer.toString('utf8'))
  } else {
    const { frames } = scanZstdFrames(buffer)
    for (const frame of frames) {
      chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    }
  }
  const events = []
  for (const text of chunks) {
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
  return { events, frames: compressed ? chunks.length : 0, compressed }
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
 * 收集日志里实际注入的退化提醒。
 *
 * 只认 `推理退化` 这一类：`plugin:dsh-allostasis` 一个生产者身份下挂着三类提醒
 * （语言漂移 / 推理退化 / 空回合），它们的判据与节流各一份，混进来会污染样本。
 * @param {object[]} events - 全部事件。
 * @returns {{eventSeq: number, quoted: number|null}[]} 提醒落点；`quoted` 是正文里自报的重复率百分数。
 */
function reminderEvents(events) {
  const found = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const kind = event.data?.source?.kind
    if (kind !== 'plugin:dsh-allostasis') continue
    const text = JSON.stringify(event.data)
    if (!text.includes('推理退化')) continue
    const match = QUOTED_RATIO.exec(text)
    found.push({ eventSeq: event.seq, quoted: match === null ? null : Number(match[1]) })
  }
  return found
}

/**
 * 把每个带判据的 step 按日志顺序排成序列。
 *
 * `insufficient`（单元数 < `MIN_UNITS`）的 step 不入列——判据在那一步不下结论，
 * 让它参与窗口统计等于把「没判」当成「没重复」。这也与 `trackLoop` 的处理一致。
 * @param {object[]} events - 全部事件。
 * @returns {{eventSeq: number, turn: number|undefined, step: number|undefined, ratio: number, units: number, loop: boolean}[]} step 序列；`loop` 为该步自身是否越线。
 */
function ratedSteps(events) {
  const rows = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const text = reasoningOf(event)
    if (text === undefined) continue
    const metrics = measureRepetition(text)
    const verdict = repetitionVerdict(metrics)
    if (verdict === 'insufficient') continue
    rows.push({
      eventSeq: event.seq,
      turn: event.data?.turn,
      step: event.data?.step,
      ratio: metrics.ratio,
      units: metrics.units,
      loop: verdict === 'loop',
    })
  }
  return rows
}

/**
 * 按窗口汇总一批提醒样本。
 *
 * **两个指标都要报**：`windowMeanLower` 量的是「这一段整体有没有变好」，会随窗口拉长被
 * 稀释；`windowEverRecovered` 量的是「有没有回落过」，会随窗口拉长单调上升——长到某个
 * 长度时它必然接近 100%。单看后者会把窗口长度当成疗效。
 * @param {{base: object, after: (number|null)[]}[]} rows - 提醒样本。
 * @param {number[]} windows - 窗口长度（以 step 计）。
 * @returns {object[]} 每个窗口一行的汇总。
 */
function summarize(rows, windows) {
  return windows.map((k, i) => {
    const pairs = rows.map(r => ({ before: r.base.ratio, after: r.after[i] })).filter(p => p.after !== null)
    const lower = pairs.filter(p => p.after < p.before).length
    const recovered = pairs.filter(p => p.after < 0.5).length
    let windowLower = 0
    let windowRecovered = 0
    let windowN = 0
    for (const r of rows) {
      const seen = r.after.slice(0, i + 1).filter(v => v !== null)
      if (seen.length === 0) continue
      windowN += 1
      const mean = seen.reduce((a, b) => a + b, 0) / seen.length
      if (mean < r.base.ratio) windowLower += 1
      if (seen.some(v => v < 0.5)) windowRecovered += 1
    }
    return {
      window: k,
      n: pairs.length,
      nextStepLower: pairs.length === 0 ? null : lower / pairs.length,
      nextStepRecovered: pairs.length === 0 ? null : recovered / pairs.length,
      windowMeanLower: windowN === 0 ? null : windowLower / windowN,
      windowEverRecovered: windowN === 0 ? null : windowRecovered / windowN,
    }
  })
}

/**
 * 把复发间隔汇总成分桶分布。
 *
 * **这是「第二级干预要不要做」要的那个数**（`docs/设计/2026-10-15-应变下一步-复发机制与测量常态化.md`
 * §二 的 ②）：提醒把它之后那一步的重复率压下去之后，隔多久又越线。间隔集中在 2–3 步说明是
 * 「同一步的余波」，散布到十几步说明是独立事件——两者的处置方向不同。
 *
 * **只报分布，不设阈值**：判据留给数据，这份报告的作用是让分布可见。
 * @param {{recurrence: number|null}[]} rows - 提醒样本。
 * @returns {{buckets: {label: string, count: number}[], n: number, median: number|null}} 分布与中位间隔。
 */
function recurrenceProfile(rows) {
  const buckets = [
    { label: '1 步', test: d => d === 1, count: 0 },
    { label: '2 步', test: d => d === 2, count: 0 },
    { label: '3 步', test: d => d === 3, count: 0 },
    { label: '4–5 步', test: d => d >= 4 && d <= 5, count: 0 },
    { label: '6–10 步', test: d => d >= 6 && d <= 10, count: 0 },
    { label: '>10 步', test: d => d > 10, count: 0 },
    { label: '到会话末未再越线', test: d => d === null, count: 0 },
  ]
  const distances = []
  for (const row of rows) {
    const distance = row.recurrence
    if (distance !== null && distance !== undefined) distances.push(distance)
    for (const bucket of buckets) {
      if (bucket.test(distance)) { bucket.count += 1; break }
    }
  }
  distances.sort((a, b) => a - b)
  const mid = distances.length / 2
  const median = distances.length === 0
    ? null
    : (distances.length % 2 === 1
      ? distances[(distances.length - 1) / 2]
      : (distances[mid - 1] + distances[mid]) / 2)
  return { buckets: buckets.map(bucket => ({ label: bucket.label, count: bucket.count })), n: rows.length, median }
}

/**
 * 跑一次窗口敏感性分析。
 *
 * **样本必须分层**：`trackLoop` 的触发条件是「最近 `LOOP_WINDOW_STEPS` 步里越线
 * `LOOP_WINDOW_HITS` 次」，所以提醒的落点可能是一步**已经回落**的思考（窗口里的越线
 * 发生在它之前）。拿这些样本去量「提醒之后有没有下降」，等于在一个本来就不高的基线上
 * 找下降空间——它们拉低整体读数，却不说明提醒无效。`onLoop` 那一层才是「提醒落在
 * 正在打转的那一步」的样本。
 * @param {object[]} events - 全部事件。
 * @param {number[]} windows - 要统计的窗口长度（以 step 计）。
 * @returns {object} 结构化结果。
 */
function analyze(events, windows) {
  const steps = ratedSteps(events)
  const reminders = reminderEvents(events)

  const rows = []
  for (const reminder of reminders) {
    // 提醒插在它针对的那个 step 之后 —— 取 eventSeq 小于提醒的第一条的前一条。
    const index = steps.findIndex(s => s.eventSeq > reminder.eventSeq) - 1
    if (index < 0) continue
    const base = steps[index]
    const after = windows.map(k => (index + k < steps.length ? steps[index + k] : null))
    // 复发间隔：从这一步往后数，第一条再次越线的 step 隔了多少步；数到会话末都没有就是 null。
    // 它量的是「打断之后多久失守」，与 `after` 量「打断当场有没有效」不是同一个问题。
    let recurrence = null
    for (let j = index + 1; j < steps.length; j += 1) {
      if (steps[j].loop) { recurrence = j - index; break }
    }
    rows.push({
      base,
      after: after.map(s => (s === null ? null : s.ratio)),
      quoted: reminder.quoted,
      onLoop: base.loop,
      recurrence,
    })
  }

  return {
    steps: steps.length,
    loopSteps: steps.filter(s => s.loop).length,
    reminders: reminders.length,
    rows,
    windows,
    summary: summarize(rows, windows),
    summaryOnLoop: summarize(rows.filter(r => r.onLoop), windows),
    recurrence: recurrenceProfile(rows),
    recurrenceOnLoop: recurrenceProfile(rows.filter(r => r.onLoop)),
  }
}

/** 百分比格式化。 */
const pct = (ratio) => (ratio === null ? '  -  ' : `${(ratio * 100).toFixed(0).padStart(3)}%`)

/**
 * 往报告里追加一块窗口汇总。单会话与跨会话两种渲染共用，免得两处的列宽漂开。
 * @param {string[]} lines - 报告行缓冲。
 * @param {string} title - 块标题。
 * @param {object[]} summary - `summarize` 的结果。
 * @returns {void}
 */
function windowBlock(lines, title, summary) {
  lines.push('')
  lines.push(`── ${title} ──`)
  lines.push('  窗口   均值低于提醒前   窗口内出现过 <50%')
  for (const row of summary) {
    const a = row.windowMeanLower === null ? '  -  ' : `${(row.windowMeanLower * 100).toFixed(0)}%`
    const b = row.windowEverRecovered === null ? '  -  ' : `${(row.windowEverRecovered * 100).toFixed(0)}%`
    lines.push(`  ${String(row.window).padStart(2)} 步  ${a.padStart(12)}   ${b.padStart(14)}`)
  }
}

/**
 * 往报告里追加一块复发间隔分布。
 * @param {string[]} lines - 报告行缓冲。
 * @param {string} title - 块标题。
 * @param {object} profile - `recurrenceProfile` 的结果。
 * @returns {void}
 */
function recurrenceBlock(lines, title, profile) {
  lines.push('')
  lines.push(`── ${title} ──`)
  const median = profile.median === null ? 'n/a' : `${profile.median} 步`
  lines.push(`  样本 ${profile.n} 条 · 中位间隔 ${median}`)
  const widest = profile.buckets.reduce((best, bucket) => Math.max(best, bucket.count), 0)
  for (const bucket of profile.buckets) {
    const bar = widest === 0 ? '' : '█'.repeat(Math.round(bucket.count / widest * 30))
    lines.push(`  ${bucket.label.padEnd(20)}${String(bucket.count).padStart(5)}  ${bar}`)
  }
}

/**
 * 渲染人读报告。
 * @param {object} report - `analyze` 的返回值。
 * @param {string} file - 日志路径，用于抬头。
 * @param {boolean} compressed - 日志是否为 zstd。
 * @returns {string} 报告全文。
 */
function render(report, file, compressed) {
  const lines = []
  lines.push(`会话      ${file}${compressed ? '' : '（未压缩日志）'}`)
  lines.push(`样本      ${report.steps} 个带判据的 step（其中 ${report.loopSteps} 步越线） · ${report.reminders} 条退化提醒`)
  lines.push(`判据      src/repetition.ts（MIN_UNITS=${MIN_UNITS}，阈值 0.5 与插件同源）`)

  lines.push('')
  lines.push('── 逐条：提醒指认那一步 → 之后第 k 步 ──')
  lines.push('  落点  = 提醒发出时，被指认的那一步自身是否在打转（≠ 表示窗口累计触发，落点已回落）')
  const head = ['turn/step', '提醒前', ...report.windows.map(k => `+${k} 步`)]
  lines.push(`  ${'落点'.padEnd(6)}${head.map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(7))).join('')}`)
  for (const row of report.rows) {
    const where = `t${row.base.turn ?? '?'}/s${row.base.step ?? '?'}`
    const cells = [pct(row.base.ratio), ...row.after.map(pct)]
    lines.push(`  ${(row.onLoop ? '越线' : '≠').padEnd(6)}${where.padEnd(12)}${cells.map(c => c.padStart(7)).join('')}`)
  }

  windowBlock(lines, '窗口汇总 · 全部提醒', report.summary)
  windowBlock(lines, '窗口汇总 · 只看落点在越线上的', report.summaryOnLoop)
  recurrenceBlock(lines, '复发间隔 · 全部提醒（提醒后隔多少步再越线）', report.recurrence)
  recurrenceBlock(lines, '复发间隔 · 只看落点在越线上的', report.recurrenceOnLoop)

  lines.push('')
  lines.push('── 读法 ──')
  lines.push('  · 「窗口内出现过 <50%」随窗口拉长单调上升，长到一定程度必然接近 100%——')
  lines.push('    它量的是「回落过」，不是「恢复」。单独用它会把窗口长度当成疗效。')
  lines.push('  · 「均值低于提醒前」随窗口拉长被稀释，量的是这一段整体有没有变好。')
  lines.push('  · 两块窗口汇总的差，就是「落点已经回落」那批样本造成的稀释——它们本来就没有')
  lines.push('    下降空间，混进来只会把疗效读低。')
  lines.push('  · 复发间隔与窗口不是同一个问题：窗口问「打断当场有没有效」，复发间隔问')
  lines.push('    「打断之后多久失守」。间隔集中在 2–3 步 = 同一步的余波；散布到十几步')
  lines.push('    = 独立事件。两者处置方向不同，所以分开报。')
  return lines.join('\n')
}

/**
 * 递归收集会话日志路径。
 *
 * 只认 DSH 的固定文件名（`session.v4.jsonl` / `session.v4.jsonl.zstd`），不按扩展名泛匹配——
 * 同一个会话目录树下还有子代理会话与投影缓存，泛匹配会把它们一起收进来。
 * @param {string} root - 会话根目录。
 * @param {number} minBytes - 文件大小下限，小于它的跳过（短会话没有可统计的提醒样本）。
 * @returns {{path: string, size: number}[]} 命中的日志，按路径排序。
 */
function collectLogs(root, minBytes) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // 目录不可读（权限、竞态），跳过这一支。
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.name !== LOG_NAME && entry.name !== LOG_NAME_ZSTD) continue
      try {
        const size = statSync(full).size
        if (size >= minBytes) found.push({ path: full, size })
      } catch {
        // 扫描途中文件被清理，跳过。
      }
    }
  }
  walk(root)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 扫一个会话根，把所有会话的提醒样本池化。
 *
 * **为什么池化而不是对各会话的比例取平均**：只有一两条提醒的会话比例方差极大，平均会被它们
 * 拽偏；池化让**每条提醒等权**，报出来的是「一条提醒的疗效」而不是「一个会话的疗效」。会话
 * 之间的差异另由明细表呈现——两者回答的问题不同，都需要。
 * @param {string} root - 会话根目录。
 * @param {object} options - `parseArgs` 的结果。
 * @returns {object} 池化结果；`sessions` 里每个元素要么带 `report`，要么带 `error`。
 */
function scanRoot(root, options) {
  const logs = collectLogs(root, options.minBytes)
  const sessions = []
  for (const log of logs) {
    const name = basename(dirname(log.path))
    try {
      const { events } = readSession(log.path)
      sessions.push({ name, path: log.path, size: log.size, report: analyze(events, options.windows) })
    } catch (error) {
      sessions.push({ name, path: log.path, size: log.size, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const usable = sessions.filter(session => session.report !== undefined)
  const rows = usable.flatMap(session => session.report.rows)
  return {
    root,
    minBytes: options.minBytes,
    windows: options.windows,
    scanned: sessions.length,
    withReminders: usable.filter(session => session.report.reminders > 0).length,
    unreadable: sessions.filter(session => session.error !== undefined).length,
    steps: usable.reduce((sum, session) => sum + session.report.steps, 0),
    loopSteps: usable.reduce((sum, session) => sum + session.report.loopSteps, 0),
    reminders: rows.length,
    sessions,
    summary: summarize(rows, options.windows),
    summaryOnLoop: summarize(rows.filter(row => row.onLoop), options.windows),
    recurrence: recurrenceProfile(rows),
    recurrenceOnLoop: recurrenceProfile(rows.filter(row => row.onLoop)),
  }
}

/**
 * 渲染跨会话报告。
 * @param {object} report - `scanRoot` 的结果。
 * @param {object} options - `parseArgs` 的结果。
 * @returns {string} 报告全文。
 */
function renderMulti(report, options) {
  const lines = []
  lines.push(`会话根    ${report.root}`)
  lines.push(`规模      扫到 ${report.scanned} 个会话（≥ ${(report.minBytes / 1048576).toFixed(1)} MB），其中 ${report.withReminders} 个有退化提醒`
    + (report.unreadable > 0 ? `，${report.unreadable} 个读不出` : ''))
  lines.push(`样本      ${report.steps} 个带判据的 step（其中 ${report.loopSteps} 步越线） · 合计 ${report.reminders} 条退化提醒`)
  lines.push(`判据      src/repetition.ts（MIN_UNITS=${MIN_UNITS}，阈值 0.5 与插件同源）`)

  lines.push('')
  lines.push(`── 会话明细（按提醒数降序，前 ${options.top}） ──`)
  lines.push('  会话                                        步数   提醒  落点越线  1步回落')
  const ranked = report.sessions
    .filter(session => session.report !== undefined && session.report.reminders > 0)
    .sort((a, b) => b.report.reminders - a.report.reminders)
    .slice(0, options.top)
  for (const session of ranked) {
    const onLoopRows = session.report.rows.filter(row => row.onLoop)
    const one = summarize(onLoopRows, session.report.windows)[0]
    const fell = one === undefined || one.windowMeanLower === null
      ? '  -  '
      : `${(one.windowMeanLower * 100).toFixed(0)}%`
    const name = session.name.length > 36 ? `${session.name.slice(0, 35)}…` : session.name
    lines.push(`  ${name.padEnd(38)}${String(session.report.steps).padStart(6)}`
      + `${String(session.report.reminders).padStart(7)}${String(onLoopRows.length).padStart(10)}${fell.padStart(9)}`)
  }

  windowBlock(lines, '池化窗口汇总 · 全部提醒', report.summary)
  windowBlock(lines, '池化窗口汇总 · 只看落点在越线上的', report.summaryOnLoop)
  recurrenceBlock(lines, '池化复发间隔 · 全部提醒（提醒后隔多少步再越线）', report.recurrence)
  recurrenceBlock(lines, '池化复发间隔 · 只看落点在越线上的', report.recurrenceOnLoop)
  return lines.join('\n')
}

// —— 入口 ——
let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
  process.exit(2)
}
if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

if (options.root !== undefined) {
  let multi
  try {
    multi = scanRoot(options.root, options)
  } catch (error) {
    console.error(`扫不出会话根：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  if (options.json) console.log(JSON.stringify(multi, null, 2))
  else console.log(renderMulti(multi, options))
  if (multi.reminders === 0) {
    console.error('\n扫到的会话里没有退化提醒，没有样本可算。')
    process.exit(1)
  }
  process.exit(0)
}

let report
let meta
try {
  const { events, compressed, frames } = readSession(options.file)
  report = analyze(events, options.windows)
  meta = { compressed, frames }
} catch (error) {
  console.error(`读不出会话日志：${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

if (options.json) {
  console.log(JSON.stringify({ file: options.file, ...meta, ...report }, null, 2))
} else {
  console.log(render(report, options.file, meta.compressed))
}

if (report.reminders === 0) {
  console.error('\n本会话没有退化提醒，没有样本可算。')
  process.exit(1)
}
process.exit(0)
