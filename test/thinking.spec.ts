import { describe, expect, it } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { latestThinking } from '../src/thinking.ts'

/**
 * 把最小夹具铸成事件。
 *
 * 真实的 `assistant/message` 还带 provider 流与 source 元数据，而 `latestThinking` 只读
 * `turn` / `step` / `stream`；手写一份完整事件只会让夹具比被测代码还长。
 * @param fixture - 只含 `type` / `seq` / `time` / `data` 的最小对象。
 * @returns 同一个对象，按 `SessionEvent` 使用。
 */
function event(fixture: object): SessionEvent {
  return fixture as unknown as SessionEvent
}

/** 造一条 `assistant/message`；流记录按给出顺序原样放入。 */
function assistantMessage(turn: number, step: number, ...stream: object[]): SessionEvent {
  return event({ type: 'assistant/message', seq: turn, time: 0, data: { turn, step, stream } })
}

/** 只产出文本增量的消息——没有思考，倒扫时应当被跳过。 */
function spokenMessage(turn: number, step: number, text: string): SessionEvent {
  return assistantMessage(turn, step, { type: 'text-chunks', texts: [text] })
}

/** 只产出思考增量的消息。 */
function thinkingMessage(turn: number, step: number, ...texts: string[]): SessionEvent {
  return assistantMessage(turn, step, { type: 'reasoning-chunks', texts })
}

/** 会话只需提供 `snapshotEvents`；`latestThinking` 不读别的成员。 */
function sessionOf(events: SessionEvent[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

describe('latestThinking', () => {
  it('取最近一条含思考的事件，跳过更晚的纯输出步', () => {
    const sample = latestThinking(sessionOf([
      thinkingMessage(1, 1, '早先想的'),
      spokenMessage(2, 1, '后面只说了话'),
    ]))
    expect(sample).toEqual({ turn: 1, step: 1, text: '早先想的' })
  })

  it('一条思考都没有时返回 undefined', () => {
    expect(latestThinking(sessionOf([]))).toBeUndefined()
    expect(latestThinking(sessionOf([spokenMessage(1, 1, '只说了话')]))).toBeUndefined()
  })

  it('思考增量全为空串的事件不算数，继续往前找', () => {
    const sample = latestThinking(sessionOf([
      thinkingMessage(1, 1, '有内容'),
      thinkingMessage(1, 2, '', ''),
    ]))
    expect(sample).toEqual({ turn: 1, step: 1, text: '有内容' })
  })

  it('同一条消息的多份记录按出现顺序拼接，文本增量不参与', () => {
    const sample = latestThinking(sessionOf([
      assistantMessage(3, 4,
        { type: 'reasoning-chunks', texts: ['前半'] },
        { type: 'text-chunks', texts: ['不该进来'] },
        { type: 'reasoning-chunks', texts: ['后半'] },
      ),
    ]))
    expect(sample?.text).toBe('前半后半')
    expect(sample?.step).toBe(4)
  })

  it('单条记录的元素数远超引擎实参上限时仍能拼出全文', () => {
    // 元素数等于该步的输出 token 数：2026-10-06 一个退化步产出 210,139 个增量，
    // `parts.push(...record.texts)` 因此超出引擎实参上限（本机 node v26.2.0 为 124,884）
    // 抛出 RangeError——`agent/pre-step` 每个 step 都调用本函数，该会话此后每一步都在
    // 这里失败，永久锁死。这里取 30 万，远高于任何已知上限，展开写法必然红。
    const chunks = new Array<string>(300_000).fill('冗')
    chunks[0] = '始'
    chunks[chunks.length - 1] = '终'
    const sample = latestThinking(sessionOf([assistantMessage(1, 1, { type: 'reasoning-chunks', texts: chunks })]))
    expect(sample?.text).toHaveLength(300_000)
    expect(sample?.text.startsWith('始')).toBe(true)
    expect(sample?.text.endsWith('终')).toBe(true)
  })
})
