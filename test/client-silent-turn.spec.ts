import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import type {
  ConversationMatch, ConversationNodeContext, ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SILENT_TURN_KEY, silentData, silentTurnDefinition } from '../src/client/silent-turn.ts'
import { shapeOf } from '../src/tail.ts'

/** Definition 自己声明的状态；不导出，从签名推导以免测试复制一份。 */
type State = Parameters<NonNullable<typeof silentTurnDefinition.update>>[0]['state']

/**
 * 把最小夹具铸成事件。
 *
 * 真实的 `assistant/message` 要带 provider 流与 source 元数据，而 Definition 一个字段都不读；
 * 手写一份完整事件只会让夹具比被测代码还长。
 * @param fixture - 只含 `type` / `seq` / `time` / `data` 的最小对象。
 * @returns 同一个对象，按 `SessionEvent` 使用。
 */
function event(fixture: object): SessionEvent {
  return fixture as unknown as SessionEvent
}

/** 造一条 `turn/start`。 */
function turnStart(turn: number): SessionEvent {
  return event({ type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn } })
}

/** 造一条 `assistant/message`；块用 `[类型, 正文?]` 的紧凑记法给出。 */
function assistantMessage(turn: number, step: number, ...content: Array<[type: string, text?: string]>): SessionEvent {
  return event({
    type: 'assistant/message',
    seq: SessionSeq(0),
    time: 0,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        content: content.map(([type, text]) => (text === undefined ? { type } : { type, text })),
      },
    },
  })
}

/** 造一条 `turn/end`。 */
function turnEnd(turn: number, reason: TurnEndReason = { kind: 'completed' }): SessionEvent {
  return event({ type: 'turn/end', seq: SessionSeq(0), time: 0, data: { turn, reason } })
}

/** 造一条与本 Definition 无关的事件。 */
function otherEvent(): SessionEvent {
  return event({ type: 'session/end-seed', seq: SessionSeq(0), time: 0, data: {} })
}

function updateMatch(event: SessionEvent): ConversationMatch {
  return { event, role: 'update', location: { kind: 'unresolved' } } as ConversationMatch
}

function startMatch(event: SessionEvent): ConversationStartMatch {
  return { event, role: 'start', location: { kind: 'unresolved' } } as ConversationStartMatch
}

function contextOf(state: State | undefined): ConversationNodeContext<State> {
  return {
    key: '', kind: SILENT_TURN_KEY, id: '1', matches: [], start: undefined, state, current: new Map(),
  }
}

/** 把一串事件按引擎的顺序喂进去，返回最终的 State。 */
function fold(...events: SessionEvent[]): State {
  let state = silentTurnDefinition.start(
    contextOf(undefined) as ConversationNodeContext<State>, startMatch(events[0] as SessionEvent), {} as never,
  )
  for (const event of events.slice(1)) {
    state = silentTurnDefinition.update(
      { ...contextOf(state), state } as ConversationNodeContext<State> & { state: State },
      updateMatch(event),
    )
  }
  return state
}

describe('silentData', () => {
  it('正常完成且末步只有推理，命中', () => {
    const data = silentData(4, { kind: 'completed' }, shapeOf(4, 2, [{ type: 'reasoning', text: '想了一百个字'.repeat(10) }]))
    expect(data).toEqual({ turn: 4, textChars: 0, reasoningChars: 60 })
  })

  it('末步说了话就不命中', () => {
    expect(silentData(1, { kind: 'completed' }, shapeOf(1, 1, [{ type: 'text', text: '结论' }]))).toBeNull()
  })

  it('只含空白的文本块不算说了话', () => {
    expect(silentData(1, { kind: 'completed' }, shapeOf(1, 1, [{ type: 'text', text: ' \n ' }]))).not.toBeNull()
  })

  it.each(['aborted', 'interrupted', 'forked', 'blocked', 'max-tokens'] as const)(
    '收尾原因 %s 不下判定——那不是「说完了却什么也没说」',
    (kind) => {
      const reason: TurnEndReason = kind === 'aborted'
        ? { kind: 'aborted', reason: { kind: 'legacy' } }
        : { kind } as TurnEndReason
      expect(silentData(1, reason, shapeOf(1, 1, [{ type: 'reasoning', text: '想' }]))).toBeNull()
    },
  )

  it('本回合没有助手消息时不下判定', () => {
    expect(silentData(1, { kind: 'completed' }, null)).toBeNull()
  })
})

describe('silentTurnDefinition.match', () => {
  it('turn/start 开一个 Turn，身份是回合号', () => {
    expect(silentTurnDefinition.match(turnStart(7))).toEqual({ id: '7', role: 'start' })
  })

  it('助手消息与收尾都更新同一个 Turn', () => {
    expect(silentTurnDefinition.match(assistantMessage(7, 1, ['text', 'x']))).toEqual({ id: '7', role: 'update' })
    expect(silentTurnDefinition.match(turnEnd(7))).toEqual({ id: '7', role: 'update' })
  })

  it('别的事件不认领', () => {
    expect(silentTurnDefinition.match(otherEvent())).toBeNull()
  })
})

describe('silentTurnDefinition 折叠', () => {
  it('start 只接 turn/start', () => {
    expect(() => silentTurnDefinition.start(
      contextOf(undefined) as ConversationNodeContext<State>, startMatch(turnEnd(1)), {} as never,
    )).toThrow(/requires turn\/start/)
  })

  it('unresolved start 用回合号初始化，还没有助手消息', () => {
    expect(fold(turnStart(3))).toEqual({ turn: 3, tail: null, found: null })
  })

  it('末条助手消息覆盖更早的步——判定问的是「用户最后看到了什么」', () => {
    const state = fold(turnStart(3), assistantMessage(3, 1, ['text', '早']), assistantMessage(3, 2, ['reasoning', '想']))
    expect(state.tail?.step).toBe(2)
    expect(state.found).toBeNull()
  })

  it('收尾时才下判定，命中后带出推理字数', () => {
    const state = fold(turnStart(3), assistantMessage(3, 1, ['reasoning', '想']), turnEnd(3))
    expect(state.found).toEqual({ turn: 3, textChars: 0, reasoningChars: 1 })
  })

  it('说过话的回合收尾后不带结论', () => {
    expect(fold(turnStart(3), assistantMessage(3, 1, ['text', '结论']), turnEnd(3)).found).toBeNull()
  })

  it('与判定无关的事件原样返回同一个 State，不制造新引用', () => {
    const state = fold(turnStart(3), assistantMessage(3, 1, ['reasoning', '想']))
    const next = silentTurnDefinition.update(
      { ...contextOf(state), state } as ConversationNodeContext<State> & { state: State },
      updateMatch(otherEvent()),
    )
    expect(next).toBe(state)
  })
})

describe('silentTurnDefinition.buildLocationData', () => {
  const hit = fold(turnStart(5), assistantMessage(5, 1, ['reasoning', '想']), turnEnd(5))
  const miss = fold(turnStart(5), assistantMessage(5, 1, ['text', '说']), turnEnd(5))
  const build = silentTurnDefinition.buildLocationData

  it('未命中的 Turn 不发布键', () => {
    expect(build?.(contextOf(miss), 'turn', null)).toBeNull()
  })

  it('还没有收尾时不发布键', () => {
    expect(build?.(contextOf(fold(turnStart(5), assistantMessage(5, 1, ['reasoning', '想']))), 'turn', null)).toBeNull()
  })

  it('Step 级物化不发布 Turn 级的键', () => {
    expect(build?.(contextOf(hit), 'step', null)).toBeNull()
  })

  it('命中时发布到本回合号上', () => {
    expect(build?.(contextOf(hit), 'turn', null)).toEqual({
      kind: 'turn',
      turn: 5,
      key: SILENT_TURN_KEY,
      value: { turn: 5, textChars: 0, reasoningChars: 1 },
    })
  })

  it('值没变时沿用上一份，保住渲染端读到的引用', () => {
    const previous = build?.(contextOf(hit), 'turn', null)
    expect(build?.(contextOf(hit), 'turn', previous ?? null)).toBe(previous)
  })
})
