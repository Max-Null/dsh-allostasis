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
 * 输出四块：
 *   ① 会话规模 —— 判据可用的 step 数（含其中越线的步数）/ 提醒条数
 *   ② 逐条对账 —— 提醒指认的那一步，以及它之后第 1 / 2 / 3 / 5 步的重复率，带落点标记
 *   ③ 窗口汇总 —— 分「全部提醒」与「只看落点在越线上的」两块统计
 *   ④ 读法 —— 两块汇总的差从哪来，以及窗口这个自由度为什么必须显式
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
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const { measureRepetition, repetitionVerdict, MIN_UNITS } = await import(pathToFileURL(join(SRC, 'repetition.ts')).href)

const ZSTD_MAGIC = 0xfd2fb528
const DEFAULT_WINDOWS = [1, 2, 3, 5]

/** 提醒正文里「重复率 NN%」的抓取口径；正文由 `src/messages.ts` 的 `degenerationText` 组装。 */
const QUOTED_RATIO = /重复率 (\d+)%/

const USAGE = `退化提醒的疗效审计。

用法：
  node tools/audit-reminder-effect.mjs <session.vN.jsonl[.zstd]> [--windows 1,2,3,5] [--json]

退出码：0 = 出报告；1 = 没有退化提醒；2 = 用法错误或读不出。`

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{file: string, windows: number[], json: boolean, help: boolean}} 解析结果。
 */
function parseArgs(argv) {
  const options = { file: undefined, windows: DEFAULT_WINDOWS, json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
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
  if (!options.help && options.file === undefined) throw new Error('需要给出会话日志路径')
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
    rows.push({
      base,
      after: after.map(s => (s === null ? null : s.ratio)),
      quoted: reminder.quoted,
      onLoop: base.loop,
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
  }
}

/** 百分比格式化。 */
const pct = (ratio) => (ratio === null ? '  -  ' : `${(ratio * 100).toFixed(0).padStart(3)}%`)

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

  const block = (title, summary) => {
    lines.push('')
    lines.push(`── ${title} ──`)
    lines.push('  窗口   均值低于提醒前   窗口内出现过 <50%')
    for (const row of summary) {
      const a = row.windowMeanLower === null ? '  -  ' : `${(row.windowMeanLower * 100).toFixed(0)}%`
      const b = row.windowEverRecovered === null ? '  -  ' : `${(row.windowEverRecovered * 100).toFixed(0)}%`
      lines.push(`  ${String(row.window).padStart(2)} 步  ${a.padStart(12)}   ${b.padStart(14)}`)
    }
  }
  block('窗口汇总 · 全部提醒', report.summary)
  block('窗口汇总 · 只看落点在越线上的', report.summaryOnLoop)

  lines.push('')
  lines.push('── 读法 ──')
  lines.push('  · 「窗口内出现过 <50%」随窗口拉长单调上升，长到一定程度必然接近 100%——')
  lines.push('    它量的是「回落过」，不是「恢复」。单独用它会把窗口长度当成疗效。')
  lines.push('  · 「均值低于提醒前」随窗口拉长被稀释，量的是这一段整体有没有变好。')
  lines.push('  · 两块汇总的差，就是「落点已经回落」那批样本造成的稀释——它们本来就没有')
  lines.push('    下降空间，混进来只会把疗效读低。')
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
