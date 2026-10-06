/**
 * 流内判据：可增量维护的重复率扫描器。
 *
 * 与 `src/repetition.ts` 的 `measureRepetition` 是**同一套口径**（同样的切分、
 * 同样的实义单元过滤、同样的 `MIN_UNITS` / `REPEAT_MIN_COUNT` / 阈值），差别只在维护方式：
 * 那边每次拿全文重算，这边每 `push` 一段增量只处理新增文本，因此可以在生成过程中逐 chunk 判。
 *
 * **为什么必须有这一份**：三期的判据要在流上跑（设计文档 §三.2），而全文重算对一条 21 万
 * 增量的退化流是 O(n²)——实测的对照成本见 `docs/排查/2026-10-07-统计判据在流上的误报面.md`
 * §三（第一版逐 chunk 跑原实现，十分钟跑不完；增量版 2.44 秒）。
 *
 * **它只做判据**：不碰会话、不碰流、不构造消息。读数与判定都只是字符串统计。
 *
 * 两处增量细节是**照抄**的，改掉任何一处都会让流上判定与步骤边界的判定指向不同结论
 * （都由标定验证过）：
 *
 * 1. `repeated` 只在一个单元的计数**跨过** `REPEAT_MIN_COUNT`(3) 时补记：2→3 时 `+3`，
 *    其后每次 `+1`。原口径是「计数 ≥ 3 的单元的计数之和」，跨过之前一次都不记。
 * 2. **未收尾的尾段每次用临时值参与读数，但不写回状态**。原实现每次调用都能看到
 *    `split` 的最后一段，增量实现若把它写回，同一行会被后续 chunk 重复计入
 *    （设计文档 §九.2 点名的那个细节）。
 *
 * 设计出处：`docs/设计/2026-10-07-应变三期-生成中掐断与重定向.md` §十一.2
 * @module @max-null/dsh-allostasis/cut/detect
 */

import {
  isSemanticUnit,
  REPEAT_MIN_COUNT,
  REPETITION_THRESHOLD,
  repetitionVerdict,
  UNIT_SEPARATOR,
} from '../repetition.ts'

/**
 * 判据读数。
 *
 * 字段是 `RepetitionMetrics` 的前三项，判定不在这里下——一律交给
 * `repetitionVerdict`，好让「流上与步骤边界口径一致」由同一个函数保证，而不是靠两份
 * 各自正确的比较式。
 */
export interface RepetitionReadout {
  /** 计入统计的实义单元总数（含未收尾尾段的临时计入）。 */
  readonly units: number
  /** 重复单元的总出现次数（含未收尾尾段的临时计入）。 */
  readonly repeated: number
  /** 重复率；样本为空时为 0。 */
  readonly ratio: number
}

/**
 * 流上的判据。
 *
 * `push` 是唯一推进状态的入口，返回的是判定而不是读数——调用方（`cut/stream.ts`）
 * 每喂一段增量都只关心「现在该不该掐」。读数走 `reading()` / `describe()`，
 * 供诊断行与标定工具使用。
 */
export interface StreamDetector {
  /**
   * 喂一段增量，返回「到这一刻为止是否越线」。
   *
   * 判定条件与 `repetitionVerdict` 逐字段一致：`units >= MIN_UNITS(12)` 且
   * `ratio >= threshold`。越线之后继续喂，它仍然返回 `true`（状态是单调累积的），
   * 调用方自己去重。
   * @param delta - 新到的文本增量。
   * @returns 是否越线。
   */
  push(delta: string): boolean
  /** 当前读数。 */
  reading(): RepetitionReadout
  /**
   * 已收尾部分里出现次数达标的单元，按次数降序（同次数按字典序）。
   *
   * 只给**续跑文案**用，所以刻意不做成 `reading()` 的一部分：它是排序，不是每 push
   * 都要付的成本，只在掐断那一刻取一次。排序规则与 `measureRepetition` 的 `top` 一致。
   * @param limit - 最多返回几条。
   * @returns 高频单元。
   */
  frequent(limit: number): Array<{ unit: string; count: number }>
  /**
   * 未收尾缓冲区的峰值长度。
   *
   * 「每次 push 只扫最后一段」这个性能前提需要一个证据，而缓冲是内部状态——
   * `tools/audit-stream-firing.mjs` 报告 ④ 打印的 `buf峰值` 就是它。
   * @returns 峰值字符数。
   */
  peakBuffer(): number
  /** 诊断行用的一行读数。 */
  describe(): string
}

/**
 * 造一个增量扫描器。
 * @param threshold - 重复率阈值；缺省用 {@link REPETITION_THRESHOLD}。
 * @returns 判据实例；每个流各用一个，实例之间不共享状态。
 */
export function createStreamDetector(threshold: number = REPETITION_THRESHOLD): StreamDetector {
  /** 已收尾单元的计数。 */
  const counts = new Map<string, number>()
  /** 已收尾的实义单元数。 */
  let units = 0
  /** 已收尾部分里重复单元的总出现次数。 */
  let repeated = 0
  /**
   * 尚未收尾的尾段。
   *
   * 稳态下它就是「最后一行」——分隔符把前面的文本都切走了，所以每次 push 的扫描量由
   * 最后一段的长度决定，而不是已生成的全文。这个性质是增量扫描 O(1) 摊还的来源，也是
   * `tools/audit-stream-firing.mjs` 报告 ④ 里那个 buf 峰值要盯的东西。
   */
  let pending = ''
  /** `pending` 的历史峰值，见 {@link StreamDetector.peakBuffer}。 */
  let peak = 0

  /**
   * 结算一个完整单元。
   * @param raw - 分隔符之间的原文。
   */
  const settle = (raw: string): void => {
    const unit = raw.trim()
    if (unit === '' || !isSemanticUnit(unit)) return
    const count = (counts.get(unit) ?? 0) + 1
    counts.set(unit, count)
    units += 1
    if (count === REPEAT_MIN_COUNT) repeated += count
    else if (count > REPEAT_MIN_COUNT) repeated += 1
  }

  const reading = (): RepetitionReadout => {
    // 尾段按**假设它已成单元**算一份临时值，但不落到 counts / units / repeated 上。
    let tempUnits = units
    let tempRepeated = repeated
    const tail = pending.trim()
    if (tail !== '' && isSemanticUnit(tail)) {
      tempUnits += 1
      const count = (counts.get(tail) ?? 0) + 1
      if (count === REPEAT_MIN_COUNT) tempRepeated += count
      else if (count > REPEAT_MIN_COUNT) tempRepeated += 1
    }
    return {
      units: tempUnits,
      repeated: tempRepeated,
      ratio: tempUnits === 0 ? 0 : tempRepeated / tempUnits,
    }
  }

  return {
    push(delta: string): boolean {
      pending += delta
      if (pending.length > peak) peak = pending.length
      let at = pending.search(UNIT_SEPARATOR)
      while (at !== -1) {
        settle(pending.slice(0, at))
        pending = pending.slice(at + 1)
        at = pending.search(UNIT_SEPARATOR)
      }
      const current = reading()
      return repetitionVerdict({ ...current, top: [] }, threshold) === 'loop'
    },
    peakBuffer: () => peak,
    reading,
    frequent(limit: number): Array<{ unit: string; count: number }> {
      const entries: Array<{ unit: string; count: number }> = []
      for (const [unit, count] of counts) {
        if (count >= REPEAT_MIN_COUNT) entries.push({ unit, count })
      }
      entries.sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit))
      return entries.slice(0, limit)
    },
    describe(): string {
      const current = reading()
      return `units=${current.units} repeated=${current.repeated}`
        + ` ratio=${(current.ratio * 100).toFixed(0)}%`
    },
  }
}
