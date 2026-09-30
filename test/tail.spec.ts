import { describe, expect, it } from 'vitest'
import { measureTail, shapeOf, tailVerdict, type TailSample } from '../src/tail.ts'

/** 造一条助手消息样本：块用 `[类型, 正文?]` 的紧凑记法给出。 */
function sample(turn: number, step: number, ...content: Array<[type: string, text?: string]>): TailSample {
  return {
    turn,
    step,
    content: content.map(([type, text]) => (text === undefined ? { type } : { type, text })),
  }
}

describe('shapeOf', () => {
  it('空内容返回全零，不产生 NaN', () => {
    const shape = shapeOf(1, 1, [])
    expect(shape.textChars).toBe(0)
    expect(shape.reasoningChars).toBe(0)
    expect(shape.blocks).toEqual({ reasoning: 0, text: 0, toolCalls: 0 })
  })

  it('只含空白的文本块不产生可见字数——判据不能把它当成说了话', () => {
    expect(shapeOf(1, 1, [{ type: 'text', text: '  \n\t ' }]).textChars).toBe(0)
  })

  it('推理与文本各按自己的字段计长，工具调用只计数', () => {
    const shape = shapeOf(3, 7, [
      { type: 'reasoning', text: '想了一百个字'.repeat(10) },
      { type: 'text', text: '结论' },
      { type: 'tool-call' },
      { type: 'tool-call' },
    ])
    expect(shape.turn).toBe(3)
    expect(shape.step).toBe(7)
    expect(shape.reasoningChars).toBe(60)
    expect(shape.textChars).toBe(2)
    expect(shape.blocks).toEqual({ reasoning: 1, text: 1, toolCalls: 2 })
  })
})

describe('measureTail', () => {
  it('取本 turn 的最后一条助手消息，跳过更早的步', () => {
    const shape = measureTail([
      sample(1, 1, ['text', '早']),
      sample(1, 2, ['reasoning', '想']),
    ], 1)
    expect(shape?.step).toBe(2)
    expect(shape?.textChars).toBe(0)
  })

  it('别的 turn 的消息不参与判定——中断残留不该改写这一轮的结论', () => {
    const shape = measureTail([
      sample(1, 1, ['reasoning', '想']),
      sample(2, 1, ['text', '下一轮说了话']),
    ], 1)
    expect(shape?.step).toBe(1)
    expect(shape?.textChars).toBe(0)
  })

  it('该 turn 没有助手消息时返回 undefined，不下结论', () => {
    expect(measureTail([sample(2, 1, ['text', '别的轮'])], 1)).toBeUndefined()
  })
})

describe('tailVerdict', () => {
  it('没有助手消息时不下结论', () => {
    expect(tailVerdict(undefined)).toBe('unknown')
  })

  it('有非空文本即说过了话', () => {
    expect(tailVerdict(shapeOf(1, 1, [{ type: 'text', text: '你好' }]))).toBe('spoke')
  })

  it('只有推理即空回合——实测 34 轮异常里 32 轮是这个形态', () => {
    expect(tailVerdict(shapeOf(1, 1, [{ type: 'reasoning', text: '想了很多但没写出来' }]))).toBe('silent')
  })

  it('以工具调用结尾同样算空回合：工具执行完还会再走一步，除非回合已经结束', () => {
    expect(tailVerdict(shapeOf(1, 1, [{ type: 'reasoning', text: '想' }, { type: 'tool-call' }]))).toBe('silent')
  })
})
