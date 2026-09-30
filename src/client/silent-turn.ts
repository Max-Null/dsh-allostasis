/**
 * 空回合的 Turn 级投影。
 *
 * 宿主半边在回合收尾判定出空回合后 append 一条 `allostasis/silent-turn`（见根模块的
 * `installSilentTurn`），这里把它折成该 Turn 的数据，交给 `conversation.chat.turnTail`
 * 座位渲染。
 *
 * **为什么走 Conversation 的 Definition，而不是自己订阅事件源**：事件源
 * （`SessionEventSource`）按会话挂在 `SessionBinding` 上，插件在 apply 里拿不到「用户正在
 * 看的那个会话」——`ctx.sessions.binding(id)` 要先有 id，而选中会话是 ui-workspace 的状态。
 * Definition 反过来：registry 按会话把事件喂进来，`buildLocationData` 发布到 turn 号上，
 * 注册处只声明「这一轮的尾部多一个座位」，不必知道会话是谁。
 *
 * **判定不在这里重做**：`allostasis/silent-turn` 已经带了宿主的判定结论，浏览器半边只做
 * 投影。在两边各写一遍判据，等于给自己制造一个迟早会分叉的副本。
 * @module @max-null/dsh-allostasis/client/silent-turn
 */

import type {} from '../events.ts'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Turn 数据键；同时用作 Definition 的 `kind`。 */
export const SILENT_TURN_KEY = 'allostasis-silent'

/** 一条空回合判定在渲染端读到的全部事实。 */
export interface SilentTurnData {
  /** 判定为空的回合号。 */
  readonly turn: number
  /** 宿主是否已就这次空回合补过一次生成（`silentTurn: 'steer'` 档位下才可能为真）。 */
  readonly steered: boolean
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** 本 Turn 命中空回合判定时的事实；未命中时该 Turn 没有这个键。 */
    'allostasis-silent': SilentTurnData
  }
}

/** 本 Turn 的空回合累积；一个 Turn 至多命中一次。 */
interface SilentTurnState {
  readonly turn: number
  readonly found: SilentTurnData | null
}

/**
 * 累积空回合判定。
 *
 * `match` 只读当前事件：`turn/start` 开一个 Turn，`allostasis/silent-turn` 往它里面放结论。
 * 宿主在同一个 Turn 里不会 append 第二条，所以这里不需要列表。
 */
export const silentTurnDefinition: ConversationNodeDefinition<SilentTurnState> = {
  kind: SILENT_TURN_KEY,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'allostasis/silent-turn') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('allostasis-silent start requires turn/start')
    return { turn: match.event.data.turn, found: null }
  },
  update: (context, match) => {
    if (match.event.type !== 'allostasis/silent-turn') return context.state
    const { turn, steered } = match.event.data
    // A window loaded from the middle of a Turn carries the conclusion without its
    // `turn/start`, so the state is seeded from the event rather than assumed present.
    const base = context.state ?? { turn, found: null }
    return { ...base, turn, found: { turn, steered } }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined || context.state.found === null) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === SILENT_TURN_KEY
      && previous.value === context.state.found) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: SILENT_TURN_KEY,
      value: context.state.found,
    }
  },
}
