#!/usr/bin/env node
/**
 * 思考块语言漂移分析 — 读一份 DSH 会话日志（`session.v3.jsonl`），逐 step 量「思考用什么语言」。
 *
 * 判据：**英文功能词密度** = 英文功能词数 / 英文词数，且**英文词数 ≥ 50** 才判定。
 *   中文期（中位 0.012）与英文期（中位 0.273–0.389）以 **0.15** 干净分开。
 *
 * 为什么要词数门槛：中文期唯一的越线点（Turn 1 step 13，密度 0.192）只有 26 个英文词——
 *   小样本让密度失真。加门槛后中文期零越线、英文期全部越线。
 *
 * 为什么不用另外两个看起来更直观的指标：
 *   · `cjkRatio`（中文字符占比）—— 中文思考本来就大量夹英文标识符，实测中文期只有
 *     0.19–0.37，与英文期的 0.00–0.15 区分度太小。
 *   · `maxRun`（最长连续英文游程）—— 中文思考里引用一段代码就会把它顶到 43，而英文期
 *     反而有大量 1–5 的短思考。它测的是「引用了多长的代码」，不是「用什么语言思考」。
 *
 * 用法：
 *   node analyze-thinking-lang.mjs <session.v3.jsonl>             # 逐 step 明细
 *   node analyze-thinking-lang.mjs <session.v3.jsonl> --summary   # 只报每 turn 汇总与首个越线点
 *
 * 退出码：0 = 未发现漂移；1 = 有 step 越线；2 = 用法错误或读不出 reasoning 文本。
 *
 * 实测样本（2026-09-20，会话 session-3bf8bcfb-fd48-4127-a9e7-08b89b4e7167）：
 *   10 turn / 157 step / 156 条 `assistant/message`，其中 147 条含 reasoning 文本。
 *   Turn 1（deepseek-flash）中文；Turn 1→2 之间 4 次 `model/selection` 切到
 *   `qwen-token-plan/qwen3.8-flash`，Turn 2 全程英文；Turn 2→3 切回 deepseek-flash 后
 *   **英文仍未恢复**——Turn 2 的英文思考已进会话历史，后续模型跟随历史的语言。
 *
 * 设计输入（判据来源与完整数据）：`max-null-plugins/dsh-allostasis/docs/设计/2026-09-20-应变-设计方案.md` §4
 */
import { readFileSync } from 'node:fs'

const FUNC = new Set(('the is are was were and or but to of in that this with for it as be not if on at by from an a ' +
  'we i you they have has will can should would there which when what how so then than also all one two no yes do does did ' +
  'its their our my his her them these those been being more most some any each both into over after before while because ' +
  'however thus therefore instead about only just even still yet first second next last new same other such per here where ' +
  'who whose must may might shall').split(' '))

/** 功能词密度越线阈值；中文期中位 0.012、英文期中位 0.273 以上，取两者之间。 */
const DRIFT_THRESHOLD = 0.15

/** 判定所需的最少英文词数；低于此值只报数不判定，避免小样本把密度算飞。 */
const MIN_WORDS = 50

/** 从一条思考文本算出各量。`funcDensity` 是判据，其余保留用于诊断与对比。 */
function metrics(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || []
  const funcw = words.filter(w => FUNC.has(w.toLowerCase())).length
  const segs = text.split(/[\u4e00-\u9fff]+/)
  let maxRun = 0
  for (const s of segs) {
    const n = (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).length
    if (n > maxRun) maxRun = n
  }
  return {
    chars: text.length,
    cjk,
    cjkRatio: text.length ? cjk / text.length : 0,
    words: words.length,
    funcw,
    funcDensity: words.length ? funcw / words.length : 0,
    maxRun,
  }
}

/** 三态判定：词数不够时不下结论。 */
function verdict(s) {
  if (s.words < MIN_WORDS) return '样本不足'
  return s.funcDensity >= DRIFT_THRESHOLD ? '漂移' : '中文'
}

const file = process.argv[2]
const summaryOnly = process.argv.includes('--summary')
if (!file) {
  console.error('用法：node analyze-thinking-lang.mjs <session.v3.jsonl> [--summary]')
  process.exit(2)
}

const steps = []
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'assistant/message') continue
  const d = ev.data || {}
  const texts = []
  for (const rec of Array.isArray(d.stream) ? d.stream : []) {
    if (rec && rec.type === 'reasoning-chunks' && Array.isArray(rec.texts)) texts.push(...rec.texts)
  }
  steps.push({ turn: d.turn, step: d.step, ...metrics(texts.join('')) })
}

const withThinking = steps.filter(s => s.chars > 0)
if (withThinking.length === 0) {
  console.error(`读不出 reasoning 文本：${steps.length} 条 assistant/message 全为空。`)
  console.error('这通常意味着该会话是旧格式（无 reasoning-chunks），别把「扫不出来」读成「没问题」。')
  process.exit(2)
}

const drifted = withThinking.filter(s => verdict(s) === '漂移')
const skipped = withThinking.filter(s => verdict(s) === '样本不足')
const first = drifted[0]

console.log(`assistant/message ${steps.length} 条，含 reasoning 文本 ${withThinking.length} 条`)
console.log(`判据「英文功能词密度」≥ ${DRIFT_THRESHOLD} 且英文词数 ≥ ${MIN_WORDS} 视为漂移；越线 ${drifted.length} 条，样本不足 ${skipped.length} 条`)
if (first) {
  console.log(`首个越线点：turn ${first.turn} step ${first.step}（密度 ${first.funcDensity.toFixed(2)}，${first.words} 词）`)
} else {
  console.log('未发现越线 step。')
}
console.log('')

if (summaryOnly) {
  const byTurn = new Map()
  for (const s of withThinking) {
    if (!byTurn.has(s.turn)) byTurn.set(s.turn, [])
    byTurn.get(s.turn).push(s)
  }
  console.log('turn  步数   中位密度   最大密度   越线  样本不足  cjkRatio 范围')
  for (const [turn, list] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const dens = list.map(s => s.funcDensity).sort((a, b) => a - b)
    const median = dens[Math.floor(dens.length / 2)]
    const ratios = list.map(s => s.cjkRatio)
    console.log(
      String(turn).padStart(4) + ' ' +
      String(list.length).padStart(5) + ' ' +
      median.toFixed(3).padStart(10) + ' ' +
      Math.max(...dens).toFixed(3).padStart(10) + ' ' +
      String(list.filter(s => verdict(s) === '漂移').length).padStart(5) + '  ' +
      String(list.filter(s => verdict(s) === '样本不足').length).padStart(7) + '   ' +
      Math.min(...ratios).toFixed(2) + '–' + Math.max(...ratios).toFixed(2))
  }
} else {
  console.log('turn step   chars    cjk  cjkRat  words  funcW  density  maxRun  判定')
  for (const s of withThinking) {
    console.log(
      String(s.turn).padStart(4) + ' ' +
      String(s.step).padStart(4) + ' ' +
      String(s.chars).padStart(7) + ' ' +
      String(s.cjk).padStart(6) + ' ' +
      s.cjkRatio.toFixed(2).padStart(6) + ' ' +
      String(s.words).padStart(6) + ' ' +
      String(s.funcw).padStart(6) + ' ' +
      s.funcDensity.toFixed(3).padStart(8) + ' ' +
      String(s.maxRun).padStart(6) + '  ' +
      verdict(s))
  }
}

process.exit(drifted.length > 0 ? 1 : 0)
