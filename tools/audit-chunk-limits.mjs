#!/usr/bin/env node
/**
 * 单步输出的 chunk 数量审计：量一个会话离「展开调用被撑爆」还有多远。
 *
 * 为什么需要它：DSH 把每一步的流式输出按增量无损存成 `reasoning-chunks.texts`，
 * **元素数等于该步的输出 token 数**。正常步几千个，退化步实测到过 21 万个 —— 任何把
 * 这份数组展开进函数调用的代码（`fn(...record.texts)`、`parts.push(...texts)`）都会在
 * 超过引擎实参上限时抛 `RangeError: Maximum call stack size exceeded`。
 * 2026-10-06 实测：0.3.0 的 `latestThinking()` 正是这种写法，一个 210,139 个增量的退化步
 * 让整场会话此后每一步都在 `agent/pre-step` 里失败，无法自行恢复。
 *
 * 它能回答：
 *   · 这个会话里最大的单步输出是多少个 chunk？离本机上限还有多少余量？
 *   · 会话库里有没有已经越线、或很接近的会话？
 *   · 有没有 turn 以 error 结束（与越线交叉出现即可定位自锁）。
 *
 * 判据（全部来自日志与本机实测，不猜）：
 *   · 上限＝**本机实测值**，启动时二分探测，不写死常量 —— 它是运行时属性
 *     （引擎版本、栈大小、调用点形态都会影响），换一台机器结论就该不同
 *   · 元素数取自 `assistant/message` 的 `data.stream[]` 里 `type: 'reasoning-chunks'`
 *     的 `texts.length`；`text-chunks` 一并量，本次取证未见它触顶
 *
 * 用法：
 *   node audit-chunk-limits.mjs <session.v4.jsonl|.jsonl.zstd>   # 单会话
 *   node audit-chunk-limits.mjs --root <dir> [--min-size 1MB]    # 跨会话
 *   node audit-chunk-limits.mjs --limit                          # 只报本机上限
 *
 * 选项：
 *   --root <dir>       递归扫该目录下的 `*.jsonl` / `*.jsonl.zstd`
 *   --min-size <size>  `--root` 模式的最小文件，支持 `1MB` / `500KB`（默认 1MB）
 *   --top <n>          单会话模式列出的最大条目数（默认 10）
 *   --margin <ratio>   报告「接近上限」的阈值比例（默认 0.5）
 *   --json             输出 JSON
 *   --help             显示本说明
 *
 * 退出码：0 = 未越线；1 = 有会话越线；2 = 用法错误或读取失败。
 *
 * 本次取证的完整记录：`docs/排查/2026-10-06-展开调用爆栈与会话自锁.md`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DEFAULT_MIN_BYTES = 1024 * 1024
const DEFAULT_TOP = 10
const DEFAULT_MARGIN = 0.5
const VALUE_FLAGS = new Set(['--root', '--min-size', '--top', '--margin'])

const USAGE = `单步输出的 chunk 数量审计 —— 量一个会话离「展开调用被撑爆」还有多远。

用法：
  node audit-chunk-limits.mjs <session.v4.jsonl|.jsonl.zstd>
  node audit-chunk-limits.mjs --root <dir> [--min-size 1MB]
  node audit-chunk-limits.mjs --limit

选项：
  --root <dir>       递归扫该目录下的 *.jsonl / *.jsonl.zstd
  --min-size <size>  --root 模式的最小文件（默认 1MB，支持 500KB 写法）
  --top <n>          单会话模式列出的最大条目数（默认 10）
  --margin <ratio>   报告「接近上限」的阈值比例（默认 0.5）
  --json             输出 JSON
  --help             显示本说明

退出码：0 = 未越线；1 = 有会话越线；2 = 用法错误或读取失败。
判据与背景见文件头注释。`

/**
 * 解析 `1MB` / `500KB` / 纯字节数。
 * @param raw - 用户输入的大小。
 * @returns 字节数。
 */
function parseSize(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(raw.trim())
  if (!match) throw new Error(`无法解析大小：${raw}`)
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(match[2] ?? 'B').toUpperCase()]
  return Math.floor(Number(match[1]) * scale)
}

/** 试一次展开调用：通过返回 true，被引擎拒绝返回 false。 */
function spreadable(count) {
  const source = new Array(count).fill('x')
  const target = []
  try {
    target.push(...source)
    return true
  } catch {
    return false
  }
}

/**
 * 二分探测本机「一次展开调用能吃下多少个元素」。
 *
 * 不写死常量：上限是运行时属性，同一份日志在不同机器上必须能判出不同结论。
 * @returns `limit` 为最大可通过的元素数；`saturated` 为 true 表示连探针上界都没撑破。
 */
function probeSpreadLimit() {
  const ceiling = 1 << 20
  if (spreadable(ceiling)) return { limit: ceiling, saturated: true }
  let low = 1
  let high = ceiling
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (spreadable(mid)) low = mid + 1
    else high = mid
  }
  return { limit: low - 1, saturated: false }
}

/** 按 zstd magic 切帧逐段解压：日志是拼接的多帧，流式解压器只吐第一帧。 */
function decompressFrames(buffer) {
  const offsets = []
  let at = buffer.indexOf(ZSTD_MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + 4)
  }
  const chunks = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // 尾部残帧：写入被截断，忽略。
    }
  }
  return chunks.join('')
}

/**
 * 读一个会话文件为事件数组。
 * @param path - `.jsonl` 或 `.jsonl.zstd`。
 * @returns 事件数组；解析失败的行被跳过。
 */
function readEvents(path) {
  const buffer = readFileSync(path)
  const text = path.endsWith('.zstd') ? decompressFrames(buffer) : buffer.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半行写入：落盘时可能截断，跳过。
    }
  }
  return events
}

/**
 * 审计一个会话的 chunk 数量分布。
 * @param events - 该会话的事件，按 seq 升序。
 * @returns `steps` 按元素数降序；`errorTurns` 为以 error 结束的回合。
 */
function auditEvents(events) {
  const steps = []
  const errorTurns = []
  for (const event of events) {
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      errorTurns.push({
        turn: event.data.turn,
        seq: event.seq,
        message: event.data.reason.error?.message ?? '',
      })
      continue
    }
    if (event.type !== 'assistant/message') continue
    const stream = Array.isArray(event.data?.stream) ? event.data.stream : []
    let chunks = 0
    let kind = ''
    for (const record of stream) {
      if (record?.type !== 'reasoning-chunks' && record?.type !== 'text-chunks') continue
      const count = Array.isArray(record.texts) ? record.texts.length : 0
      if (count > chunks) {
        chunks = count
        kind = record.type
      }
    }
    if (chunks === 0) continue
    steps.push({
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      kind,
      chunks,
      outputTokens: event.data.usage?.outputTokens ?? null,
    })
  }
  steps.sort((a, b) => b.chunks - a.chunks)
  return { steps, errorTurns }
}

const args = process.argv.slice(2)
const flagValue = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const positionals = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (VALUE_FLAGS.has(arg)) {
    index += 1
    continue
  }
  if (arg.startsWith('-')) continue
  positionals.push(arg)
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

const wantJson = args.includes('--json')
const top = Number(flagValue('--top', String(DEFAULT_TOP)))
const marginRatio = Number(flagValue('--margin', String(DEFAULT_MARGIN))) || DEFAULT_MARGIN
const root = flagValue('--root', undefined)
const source = positionals[0]

let minBytes = DEFAULT_MIN_BYTES
try {
  minBytes = parseSize(flagValue('--min-size', '1MB'))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const { limit, saturated } = probeSpreadLimit()
const limitLine = `本机展开发实参上限：${limit.toLocaleString('en-US')} 个元素`
  + (saturated ? '（探针上界未撑破，实际更高）' : '')
  + `  ·  node ${process.version}`

if (args.includes('--limit')) {
  if (wantJson) console.log(JSON.stringify({ limit, saturated, node: process.version }, null, 2))
  else console.log(limitLine)
  process.exit(0)
}

if (root === undefined && source === undefined) {
  console.error(USAGE)
  process.exit(2)
}

let exceeded = false

if (root !== undefined) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) files.push(path)
    }
  }
  walk(root)

  const entries = []
  for (const file of files) {
    if (statSync(file).size < minBytes) continue
    try {
      const { steps, errorTurns } = auditEvents(readEvents(file))
      if (steps.length === 0) continue
      const worst = steps[0]
      if (worst.chunks < limit * marginRatio && errorTurns.length === 0) continue
      if (worst.chunks >= limit) exceeded = true
      entries.push({ file, worst, errorTurns })
    } catch (error) {
      entries.push({ file, readError: error.message })
    }
  }
  entries.sort((a, b) => (b.worst?.chunks ?? 0) - (a.worst?.chunks ?? 0))

  if (wantJson) {
    console.log(JSON.stringify({ limit, saturated, scanned: files.length, entries }, null, 2))
  } else {
    console.log(limitLine)
    console.log(`\n扫描 ${files.length} 个会话文件（只看 ≥ ${minBytes} 字节的），列出接近或已越线的：\n`)
    console.log('  最大 chunk 数   占上限   异常回合   文件')
    for (const entry of entries) {
      if (entry.readError) {
        console.log(`  !! 读取失败：${entry.file} —— ${entry.readError}`)
        continue
      }
      const pct = (entry.worst.chunks / limit) * 100
      // 三态分开报：越线才是真问题；「接近」是余量提示；两者都不是的，是**因为异常回合**
      // 才进表 —— 把它标成「接近」会让读者以为余量紧张（2026-10-06 首次运行时就是这样）。
      const mark = entry.worst.chunks >= limit
        ? '越线'
        : pct >= marginRatio * 100
          ? '接近上限'
          : `异常回合 ×${entry.errorTurns.length}（与上限无关）`
      console.log(
        `  ${String(entry.worst.chunks).padStart(12)}   ${pct.toFixed(0).padStart(4)}%   `
        + `${String(entry.errorTurns.length).padStart(6)}   [${mark}] ${entry.file}`,
      )
    }
    if (entries.length === 0) console.log('  （无：所有会话的最大单步输出都远低于上限）')
  }
} else {
  let events
  try {
    events = readEvents(source)
  } catch (error) {
    console.error(`读取失败：${source} —— ${error.message}`)
    process.exit(2)
  }
  const { steps, errorTurns } = auditEvents(events)
  exceeded = steps.length > 0 && steps[0].chunks >= limit

  if (wantJson) {
    console.log(JSON.stringify({ limit, saturated, file: source, steps: steps.slice(0, top), errorTurns }, null, 2))
  } else {
    console.log(limitLine)
    console.log(`\n文件：${source}`)
    console.log(`事件 ${events.length} 条 · 含增量的助手消息 ${steps.length} 条 · turn 以 error 结束 ${errorTurns.length} 次\n`)
    console.log('  位置         chunk 数   占上限   输出 token   分析')
    for (const entry of steps.slice(0, top)) {
      const pct = (entry.chunks / limit) * 100
      const verdict = entry.chunks >= limit
        ? '越线：展开调用会抛 RangeError'
        : pct >= marginRatio * 100 ? '接近上限' : '安全'
      console.log(
        `  t${entry.turn}/s${entry.step}`.padEnd(13)
        + String(entry.chunks).padStart(9)
        + `${pct.toFixed(0)}%`.padStart(8)
        + String(entry.outputTokens ?? '-').padStart(14)
        + `   ${verdict}`,
      )
    }
    if (errorTurns.length > 0) {
      console.log('\n  turn 以 error 结束：')
      for (const entry of errorTurns) {
        console.log(`    turn ${entry.turn}（seq ${entry.seq}）：${entry.message}`)
      }
      console.log(exceeded
        ? '\n  ⚠ 越线 + 异常回合同时出现：该会话可能已进入「每步都失败」的自锁状态。'
        : '\n  （越线与异常回合不重叠：本次异常与该上限无关。）')
    }
  }
}

process.exit(exceeded ? 1 : 0)
