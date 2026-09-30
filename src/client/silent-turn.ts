/**
 * 空回合的 Turn 级投影。
 *
 * **判定在浏览器半边自己做**：`turn/start` 开一个 Turn，`assistant/message` 记下末条助手消息的
 * 产出形态，`turn/end` 收尾时下结论。宿主半边不写会话事件（理由见根模块的模块注释），
 * 所以也没有「等宿主把结论送过来」的通道；这里折叠的是同一份事件流，判据共用 `../tail.ts`
 * 的纯函数，两侧不会各写一份。
 *
 * **为什么走 Conversation 的 Definition，而不是自己订阅事件源**：事件源
 * （`SessionEventSource`）按会话挂在 `SessionBinding` 上，插件在 apply 里拿不到「用户正在
 * 看的那个会话」——`ctx.sessions.binding(id)` 要先有 id，而选中会话是 ui-workspace 的状态。
 * Definition 反过来：registry 按会话把事件喂进来，`buildLocationData` 发布到 turn 号上，
 * 注册处只声明「这一轮的尾部多一个座位」，不必知道会话是谁。
 *
 * **只判 `completed`**：`aborted` 是用户按下停止、`interrupted` / `forked` 是崩溃与分叉的
 * 边界标记，`error` / `blocked` / `max-tokens` 有自己的展示。这些收尾的沉默都不是
 * 「说完了却什么也没说」，提示只会变成噪音。
 * @module @max-null/dsh-allostasis/client/silent-turn
 */

import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { shapeOf, tailVerdict, type TailShape } from '../tail.ts'

/** Turn 数据键；同时用作 Definition 的 `kind`。 */
export const SILENT_TURN_KEY = 'allostasis-silent'

/** 一条空回合判定在渲染端读到的全部事实。 */
export interface SilentTurnData {
  /** 判定为空的回合号。 */
  readonly turn: number
  /** 末条助手消息的非空文本字符数；空回合恒为 0。 */
  readonly textChars: number
  /** 末条助手消息的推理字符数——区分「想了很久没说」与「完全没输出」。 */
  readonly reasoningChars: number
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
  /** 本 Turn 最后一条助手消息的产出形态；该 Turn 还没有助手消息时为 null。 */
  readonly tail: TailShape | null
  /** 已收尾且判定为空回合时的事实，否则 null。 */
  readonly found: SilentTurnData | null
}

/**
 * 对一个已收尾的 Turn 下判定。
 * @param turn - 收尾的回合号。
 * @param reason - `turn/end` 记录的收尾原因。
 * @param tail - 本 Turn 末条助手消息的形态；没有助手消息时为 null。
 * @returns 命中时渲染端要读到的事实，否则 null。
 */
export function silentData(turn: number, reason: TurnEndReason, tail: TailShape | null): SilentTurnData | null {
  if (reason.kind !== 'completed' || tail === null) return null
  if (tailVerdict(tail) !== 'silent') return null
  return { turn, textChars: tail.textChars, reasoningChars: tail.reasoningChars }
}

/**
 * 累积空回合判定。
 *
 * `match` 只读当前事件：`turn/start` 开一个 Turn，之后两条更新各自折进 State。历史窗口从
 * 中间加载时 `turn/start` 可能不在窗口里，那种情况下本 Definition 不启动——没有开头就
 * 无从知道这一轮是怎么开始的。
 */
export const silentTurnDefinition: ConversationNodeDefinition<SilentTurnState> = {
  kind: SILENT_TURN_KEY,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'assistant/message') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('allostasis-silent start requires turn/start')
    return { turn: match.event.data.turn, tail: null, found: null }
  },
  update: (context, match) => {
    const { event } = match
    if (event.type === 'assistant/message') {
      return {
        ...context.state,
        turn: event.data.turn,
        tail: shapeOf(event.data.turn, event.data.step, event.data.message.content),
      }
    }
    if (event.type === 'turn/end') {
      return {
        ...context.state,
        turn: event.data.turn,
        found: silentData(event.data.turn, event.data.reason, context.state.tail),
      }
    }
    return context.state
  },
  buildLocationData: (context, scope, previous) => {
    const { state } = context
    if (scope !== 'turn' || state === undefined || state.found === null) return null
    if (previous?.kind === 'turn'
      && previous.turn === state.turn
      && previous.key === SILENT_TURN_KEY
      && previous.value === state.found) return previous
    return {
      kind: 'turn',
      turn: state.turn,
      key: SILENT_TURN_KEY,
      value: state.found,
    }
  },
}
