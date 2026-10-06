/**
 * 每会话的掐断账本——把「这一步是我终止的」这件事从流内传给回合收尾。
 *
 * **它存在的理由是内部协调**（设计文档 §3.4）：掐断之后的那个 step 只剩 reasoning、
 * 没有文本也没有工具调用，**这恰好满足空回合判据**。不记账的话，同一次静默会被判两次：
 * 掐断方 steer 一次续跑，空回合兜底再 steer 一次补生成，模型同时收到两条措辞相近的提醒。
 * 跨插件时这就是 `dsh-repeat-guard` 与空回合检测在 dev 现场留下的那个形状
 * （`docs/排查/2026-10-07-补块落盘形状.md` §1.2）；吸收进本插件之后，掐断方自己知道
 * 「这一步是我终止的」，不需要任何跨插件协议。
 *
 * 记账按 **会话 + turn** 两级：
 *
 * · `pending` 数的是「已掐断、还没被回合收尾消费」的次数——每次掐断要换回一次续跑，
 *   所以它不是一个布尔量（一次 turn 里连掐两次是常态，见 §1.2 的现场日志）。
 * · `cutTurn` 记的是「因本插件掐断而跳过空回合判定」的那个 turn——因为 turn-stopping
 *   是可能重入的边界（同一 turn 里的第二次查账必须仍然跳过，否则那条纯 reasoning 的消息
 *   会被当成模型自己没说话而补一次生成）。它同时是 `resumes` 的 turn 归属。
 * · `resumes` 数的是**本 turn** 已经发出过几次续跑，上限由 `streamCutMaxResumes` 给
 *   （§九.7）：没有它，一次不收敛的退化会在同一个 turn 里无限重发续跑。
 *
 * **不做判定**：这里没有任何阈值、没有文本，只有记账与查账两类转移。状态不可变，
 * 每次推进返回一份新账本，形状与 `throttle.ts` / `repetition.ts` 的追踪状态一致。
 *
 * 键是会话 id 而不是会话对象：`llm/stream` 是 `{ global: true }` 的监听，能拿到的只有
 * `GenerateOptions.sessionId`（`packages/llm/llm/src/types.ts` 的 `sessionId?: Branded<'SessionId'>`），
 * 而 `agent/turn-stopping` 拿的是 `agent.session`。两边只有这个 id 是共同的。
 * @module @max-null/dsh-allostasis/cut/state
 */

import type { RepetitionReadout } from './detect.ts'

/** 一次掐断的现场读数——诊断行与续跑文案都要引用它。 */
export interface CutRecord {
  /** 命中时已放行的思考字符数——判据看的正是这些文本。 */
  readonly chars: number
  /** 命中时已放行的思考增量个数（= 该步已产出的输出 token 数）。 */
  readonly chunks: number
  /** 命中时的判据读数。 */
  readonly reading: RepetitionReadout
  /** 命中时出现次数达标的单元，按次数降序；续跑文案直接引用它。 */
  readonly top: ReadonlyArray<{ unit: string; count: number }>
}

/** 一个会话的掐断账本。 */
export interface CutLedger {
  /** 本会话累计掐断次数。 */
  readonly total: number
  /** 已掐断、但尚未被回合收尾消费的次数。> 0 表示本 turn 的静默是本插件造成的。 */
  readonly pending: number
  /** 最近一次「因本插件掐断而跳过空回合判定」的 turn；一次都没有时是 `NaN`。 */
  readonly cutTurn: number
  /**
   * **本 turn** 已经发出过几次续跑。
   *
   * 上限是 `streamCutMaxResumes`（§九.7）：同一个 turn 里连掐四次而靠模型自己让步收敛，
   * 那是模型的行为、不是机制的保证。计数的 turn 归属复用 `cutTurn`——查账时 turn 一变就
   * 当作 0，因此**换 turn 自动重置**，不需要第二个 turn 字段。
   */
  readonly resumes: number
  /** 最近一次掐断的现场读数；一次都没有时是 `undefined`。 */
  readonly last?: CutRecord
}

/** 空账本：没有掐断过任何一步。 */
export const NO_CUT: CutLedger = { total: 0, pending: 0, cutTurn: Number.NaN, resumes: 0 }

/**
 * 记一次掐断。
 *
 * 只动 `total` 与 `pending`：`resumes` 的推进发生在回合收尾查账时，因为「能不能续跑」
 * 要等那一刻才知道（掐断发生在流里，那时还没有 turn 收尾这件事）。
 * @param state - 上一次的账本；首次调用传 `undefined`。
 * @param record - 这次掐断的现场读数。
 * @returns 推进后的账本。
 */
export function recordCut(state: CutLedger | undefined, record: CutRecord): CutLedger {
  const current = state ?? NO_CUT
  return { total: current.total + 1, pending: current.pending + 1, cutTurn: current.cutTurn, resumes: current.resumes, last: record }
}

/**
 * 回合收尾时查账，并推进状态。
 *
 * 四种结果：
 *
 * | 情况 | `skip` | `resume` | `exhausted` | 含义 |
 * |---|---|---|---|---|
 * | 本 turn 有新掐断、续跑还有配额 | 是 | 是 | 否 | 跳过空回合判定，并续跑一步（§3.3 的重定向） |
 * | 本 turn 有新掐断、配额已用完 | 是 | 否 | 是 | 只跳过判定：**掐断照旧发生，停的是续跑**（§九.7） |
 * | 本 turn 之前查过账（重入） | 是 | 否 | 否 | 只跳过判定——这一次续跑早先已经发过 |
 * | 本 turn 与掐断无关 | 否 | 否 | 否 | 走既有的空回合判定，一个字都不多 |
 *
 * 第三条是 `turn-stopping` 可能重入所必需的：本 turn 早先那次掐断已经把 `pending`
 * 消费成 0，若第二次查账据此放行，那条纯 reasoning 的消息会立刻被判成空回合——正是
 * §3.4 要消灭的双提醒。
 *
 * 第二条与第三条都返回 `resume: false`，但**原因不同**（一个是用完配额、一个是重入），
 * 所以用 `exhausted` 分开——诊断行要能说清是哪一种，排查时才不至于把「机制拦住了」
 * 看成「漏发了」。
 * @param state - 上一次的账本；没有过掐断时传 `undefined`。
 * @param turn - 本次回合收尾的 turn。
 * @param maxResumes - 本 turn 允许的续跑次数上限（`streamCutMaxResumes`）。
 * @returns `ledger` 为推进后的账本；`skip` 表示跳过空回合判定；`resume` 表示应当续跑一步；
 *   `exhausted` 表示本次确实有掐断待续跑，但配额已经用完。
 */
export function cutBeforeStopping(
  state: CutLedger | undefined,
  turn: number,
  maxResumes: number,
): { ledger: CutLedger; skip: boolean; resume: boolean; exhausted: boolean } {
  const current = state ?? NO_CUT
  if (current.pending > 0) {
    const done = current.cutTurn === turn ? current.resumes : 0
    if (done >= maxResumes) {
      // 配额用完：这一次掐断不再换续跑。`pending` 仍然消费掉——留着它会让下一个 turn
      // 的第一次查账看到一次属于别处的掐断。
      return {
        ledger: { ...current, pending: 0, cutTurn: turn, resumes: done },
        skip: true,
        resume: false,
        exhausted: true,
      }
    }
    return {
      ledger: { ...current, pending: 0, cutTurn: turn, resumes: done + 1 },
      skip: true,
      resume: true,
      exhausted: false,
    }
  }
  return { ledger: current, skip: current.cutTurn === turn, resume: false, exhausted: false }
}
