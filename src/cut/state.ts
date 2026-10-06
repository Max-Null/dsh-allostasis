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
 *   会被当成模型自己没说话而补一次生成）。
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
  /** 最近一次掐断的现场读数；一次都没有时是 `undefined`。 */
  readonly last?: CutRecord
}

/** 空账本：没有掐断过任何一步。 */
export const NO_CUT: CutLedger = { total: 0, pending: 0, cutTurn: Number.NaN }

/**
 * 记一次掐断。
 * @param state - 上一次的账本；首次调用传 `undefined`。
 * @param record - 这次掐断的现场读数。
 * @returns 推进后的账本。
 */
export function recordCut(state: CutLedger | undefined, record: CutRecord): CutLedger {
  const current = state ?? NO_CUT
  return { total: current.total + 1, pending: current.pending + 1, cutTurn: current.cutTurn, last: record }
}

/**
 * 回合收尾时查账，并推进状态。
 *
 * 三种结果：
 *
 * | 情况 | `skip` | `resume` | 含义 |
 * |---|---|---|---|
 * | 本 turn 有新掐断未消费 | 是 | 是 | 跳过空回合判定，并续跑一步（§3.3 的重定向） |
 * | 本 turn 之前查过账（重入） | 是 | 否 | 只跳过判定——续跑已经发过一次了 |
 * | 本 turn 与掐断无关 | 否 | 否 | 走既有的空回合判定，一个字都不多 |
 *
 * 第二条是 `turn-stopping` 可能重入所必需的：本 turn 早先那次掐断已经把 `pending`
 * 消费成 0，若第二次查账据此放行，那条纯 reasoning 的消息会立刻被判成空回合——正是
 * §3.4 要消灭的双提醒。
 * @param state - 上一次的账本；没有过掐断时传 `undefined`。
 * @param turn - 本次回合收尾的 turn。
 * @returns `ledger` 为推进后的账本；`skip` 表示跳过空回合判定；`resume` 表示应当续跑一步。
 */
export function cutBeforeStopping(
  state: CutLedger | undefined,
  turn: number,
): { ledger: CutLedger; skip: boolean; resume: boolean } {
  const current = state ?? NO_CUT
  if (current.pending > 0) {
    return { ledger: { ...current, pending: 0, cutTurn: turn }, skip: true, resume: true }
  }
  return { ledger: current, skip: current.cutTurn === turn, resume: false }
}
