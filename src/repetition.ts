/**
 * 思考重复度判定（退化检测的判据）。
 *
 * 判据由两部分构成。
 *
 * **单步度量**：按换行与中英句读切分推理，统计「出现 ≥3 次的单元」占比。只统计**实义
 * 单元**——纯标记（代码围栏、花括号、星号）在写代码时天然高频，把它们计入会让正常步越线。
 * 实测（2026-10-01，本机 `sessions-ssid` 根 37 个 ≥3MB 会话）：三个会话的越线全部来自这类
 * 标记，排除后归零；而真退化会话的峰值反而更高——噪声单元出局后真实重复的占比更突出。
 *
 * **触发条件**：最近若干步内**累计**越线次数，不要求连续。原判据要求连续 2 步，其依据是
 * 单个会话（`fabc21b2`，本机最严重的样本）里退化在同一 turn 内连成片；换成散布型退化时
 * 判据失效——`a8ac8e89` 有 17 次语义越线却凑不出一次连续 2 步，提醒因此几乎不被发出
 * （该会话只触发 1 次、落在 t38；另有 `8fa3b15e` 与 `cb56f381` 两个真退化会话触发 0 次）。
 * 窗口累计在同一批样本上让两个零触发的会话开始触发，而三个假阳性会话（语义口径下越线为
 * 零）在任何窗口下都不触发。窗口**跨 turn** 累计：散布正是跨 turn 的，按 turn 清零会把
 * 它们重新拆散。
 *
 * `insufficient`（单元数不足）既不记命中也不记未命中：让「推理偶尔写得很短」占位会稀释
 * 窗口、反复推迟触发。
 *
 * 为什么不用推理长度当辅助判据：退化期的单条推理并不特别长（实测 1,000–2,600 字符），
 * 长度不区分两群；重复率本身已经把「这段内容有多少信息」量化了。
 *
 * 设计出处：`docs/设计/2026-09-28-应变二期-退化检测与自动干预.md` §四、
 * `docs/设计/2026-10-01-提醒判据修正与实测方案.md`
 * @module @max-null/dsh-allostasis/repetition
 */

/** 单元重复达到此次数才计入「重复单元」。 */
export const REPEAT_MIN_COUNT = 3

/** 判定所需的最少单元数；低于此值只报数不判定，避免小样本把比例算飞。 */
export const MIN_UNITS = 12

/** 重复率判定阈值——起点值，非标定值。 */
export const REPETITION_THRESHOLD = 0.5

/** 触发所需的观察窗口，以步为单位（默认 5）。 */
export const LOOP_WINDOW_STEPS = 5

/** 窗口内需要累计的越线步数（默认 2）。取 3 会漏掉「少而猛」型退化。 */
export const LOOP_WINDOW_HITS = 2

/**
 * 切分单元用的分隔符：换行与中英句读。
 *
 * **导出给流内判据与标定工具用**：三期的 `src/cut/detect.ts` 与
 * `tools/audit-stream-firing.mjs` 都必须按同一份切分口径增量扫描，复刻一份即漂移面
 * （工具过去正是靠运行期探针自检兜这个漂移）。这个正则**不带 `g` 标志**，因此没有
 * `lastIndex` 状态，可以在多处共享。
 */
export const UNIT_SEPARATOR = /[\n。！？]/

/**
 * 一个单元是否计入重复统计。
 *
 * 排除两类：以代码围栏开头的整段（` ``` ` 与 ` ```ts `），以及不含实义文字的纯标记单元。
 * 实义 = 至少一个汉字，或至少两个连续拉丁字母——单个字母会让 `}`、`*`、`|` 这类符号的
 * 邻接字母混进来。
 *
 * 与 {@link UNIT_SEPARATOR} 同样导出，理由见上——它也是切分口径的一部分：少这一步，
 * 「单元数」就不是同一个量。
 * @param unit - 切分并去空白后的单元。
 * @returns 该单元是否计入。
 */
export function isSemanticUnit(unit: string): boolean {
  if (unit.startsWith('```')) return false
  return /[\p{Script=Han}]|[A-Za-z]{2}/u.test(unit)
}

/** 一条思考的重复度量化结果。 */
export interface RepetitionMetrics {
  /** 计入统计的实义单元总数。 */
  units: number
  /** 重复单元的**总出现次数**（同一单元出现 5 次计 5，不是计 1）。 */
  repeated: number
  /** 重复率——判据本体。空文本与样本不足时仍给出可算的实数，判定另看 `repetitionVerdict`。 */
  ratio: number
  /** 最高频的若干单元，按出现次数降序；供提醒文本直接引用。 */
  top: Array<{ unit: string; count: number }>
}

/** 三态判定；单元数不足时不下结论。 */
export type RepetitionVerdict = 'loop' | 'normal' | 'insufficient'

/**
 * 统计一条思考文本的重复度。空文本返回全零。
 *
 * 单元按 `UNIT_SEPARATOR` 切分、去掉空白、滤掉非实义单元，因此纯空行的段落与代码标记
 * 都不参与统计。`top` 只收达到 `REPEAT_MIN_COUNT` 的单元，最多 5 条，同次数按单元字典序
 * 稳定排序。
 * @param text - 推理原文。
 * @returns 量化结果。
 */
export function measureRepetition(text: string): RepetitionMetrics {
  const units = text.split(UNIT_SEPARATOR)
    .map(part => part.trim())
    .filter(part => part !== '' && isSemanticUnit(part))
  const counts = new Map<string, number>()
  for (const unit of units) counts.set(unit, (counts.get(unit) ?? 0) + 1)
  let repeated = 0
  const frequent: Array<{ unit: string; count: number }> = []
  for (const [unit, count] of counts) {
    if (count < REPEAT_MIN_COUNT) continue
    repeated += count
    frequent.push({ unit, count })
  }
  frequent.sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit))
  return {
    units: units.length,
    repeated,
    ratio: units.length === 0 ? 0 : repeated / units.length,
    top: frequent.slice(0, 5),
  }
}

/**
 * 对一次测量下判定。
 *
 * 单元数不足 `MIN_UNITS` 时返回 `insufficient`——**不下结论**。调用方据此决定该步既不算
 * 越线也不算清白（见 `trackLoop`）。
 * @param metrics - 量化结果。
 * @param threshold - 重复率阈值；缺省用 {@link REPETITION_THRESHOLD}。
 * @returns 三态判定。
 */
export function repetitionVerdict(
  metrics: RepetitionMetrics,
  threshold: number = REPETITION_THRESHOLD,
): RepetitionVerdict {
  if (metrics.units < MIN_UNITS) return 'insufficient'
  return metrics.ratio >= threshold ? 'loop' : 'normal'
}

/** 越线窗口的追踪状态。不可变——每次推进都返回一份新状态。 */
export interface LoopTrackerState {
  /** 最近若干步的越线标记，最近的在后；长度不超过窗口步数。 */
  readonly recent: readonly boolean[]
}

/**
 * 推进越线窗口，并判定本次是否触发。
 *
 * 窗口**不按 turn 清零**：退化样本常常散布在若干轮里，按轮清零会把它们重新拆散——这正是
 * 原「连续 2 步」判据在 `a8ac8e89` 上失效的原因。
 *
 * `insufficient` 的样本**既不记命中也不记未命中**：让它占位会稀释窗口。代价是窗口可能
 * 跨过多个步才填满，但触发条件本身是「累计」而非「密度」，不受影响。
 * @param state - 上一次的状态；首次调用传 `undefined`。
 * @param verdict - 该步的判定。
 * @param windowSteps - 窗口大小，以步为单位；缺省用 {@link LOOP_WINDOW_STEPS}。
 * @param windowHits - 触发所需的窗口内越线步数；缺省用 {@link LOOP_WINDOW_HITS}。
 * @returns `state` 为推进后的新状态；`fire` 为本次是否达到触发条件。
 */
export function trackLoop(
  state: LoopTrackerState | undefined,
  verdict: RepetitionVerdict,
  windowSteps: number = LOOP_WINDOW_STEPS,
  windowHits: number = LOOP_WINDOW_HITS,
): { state: LoopTrackerState; fire: boolean } {
  const current = state ?? { recent: [] }
  if (verdict === 'insufficient') return { state: current, fire: false }
  const recent = [...current.recent, verdict === 'loop'].slice(-windowSteps)
  const hits = recent.filter(Boolean).length
  return { state: { recent }, fire: hits >= windowHits }
}
