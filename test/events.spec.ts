import { describe, expect, it } from 'vitest'
import { degenerationEvent, silentTurnEvent, UNIT_SAMPLE_MAX_CHARS } from '../src/events.ts'
import type { RepetitionMetrics } from '../src/repetition.ts'
import type { TailShape } from '../src/tail.ts'

/** 一份形状合法的最小量化结果；各用例只覆盖自己关心的字段。 */
function metrics(over: Partial<RepetitionMetrics> = {}): RepetitionMetrics {
  return { units: 20, repeated: 12, ratio: 0.6, top: [{ unit: '好', count: 9 }], ...over }
}

/** 一份形状合法的最小末步形态；各用例只覆盖自己关心的字段。 */
function shape(over: Partial<TailShape> = {}): TailShape {
  return {
    turn: 9,
    step: 31,
    textChars: 0,
    reasoningChars: 3747,
    blocks: { reasoning: 1, text: 0, toolCalls: 0 },
    ...over,
  }
}

describe('degenerationEvent', () => {
  it('展平判定依据——阈值与实际取值都要在，否则复盘的是「按现在的脚本判会怎样」', () => {
    expect(degenerationEvent({
      turn: 12,
      step: 43,
      metrics: metrics(),
      consecutive: 2,
      threshold: 0.5,
      required: 2,
    })).toEqual({
      turn: 12,
      step: 43,
      ratio: 0.6,
      units: 20,
      consecutive: 2,
      threshold: 0.5,
      required: 2,
      top: [{ unit: '好', count: 9 }],
    })
  })

  it('记录的是当时的阈值而不是默认值——阈值改过之后，旧事件仍能自证', () => {
    const event = degenerationEvent({
      turn: 1,
      step: 1,
      metrics: metrics(),
      consecutive: 2,
      threshold: 0.42,
      required: 3,
    })
    expect(event.threshold).toBe(0.42)
    expect(event.required).toBe(3)
  })

  it('超长单元被截断——日志不该被碎片全文撑大', () => {
    const long = '好'.repeat(UNIT_SAMPLE_MAX_CHARS + 20)
    const event = degenerationEvent({
      turn: 1,
      step: 1,
      metrics: metrics({ top: [{ unit: long, count: 49 }] }),
      consecutive: 2,
      threshold: 0.5,
      required: 2,
    })
    expect(event.top[0]?.unit).toBe(`${'好'.repeat(UNIT_SAMPLE_MAX_CHARS)}…`)
    expect(event.top[0]?.count).toBe(49)
  })

  it('恰好等于上限的单元不加省略号——边界不制造无谓的截断', () => {
    const exact = '好'.repeat(UNIT_SAMPLE_MAX_CHARS)
    const event = degenerationEvent({
      turn: 1,
      step: 1,
      metrics: metrics({ top: [{ unit: exact, count: 3 }] }),
      consecutive: 2,
      threshold: 0.5,
      required: 2,
    })
    expect(event.top[0]?.unit).toBe(exact)
  })

  it('没有高频单元时 top 为空数组，不省略字段——payload 形状对复盘脚本要稳定', () => {
    const event = degenerationEvent({
      turn: 1,
      step: 1,
      metrics: metrics({ top: [] }),
      consecutive: 2,
      threshold: 0.5,
      required: 2,
    })
    expect(event.top).toEqual([])
  })
})

describe('silentTurnEvent', () => {
  it('展平判定依据——推理长度与块计数都要在，否则复盘不出「想过但没说」与「完全没输出」的区别', () => {
    expect(silentTurnEvent({ turn: 9, shape: shape(), steered: false })).toEqual({
      turn: 9,
      step: 31,
      textChars: 0,
      reasoningChars: 3747,
      blocks: { reasoning: 1, text: 0, toolCalls: 0 },
      steered: false,
    })
  })

  it('以工具调用结尾的回合也记下工具次数——它决定这条事件属于哪一类异常', () => {
    const event = silentTurnEvent({
      turn: 9,
      shape: shape({ blocks: { reasoning: 1, text: 0, toolCalls: 2 } }),
      steered: false,
    })
    expect(event.blocks.toolCalls).toBe(2)
    expect(event.textChars).toBe(0)
  })

  it('块计数是拷贝——事件落到日志后不该再随判定时的对象变化', () => {
    const source = shape()
    const event = silentTurnEvent({ turn: 9, shape: source, steered: false })
    expect(event.blocks).not.toBe(source.blocks)
    expect(event.blocks).toEqual(source.blocks)
  })

  it('steered 如实记录——事件只记判定，补生成是否发生由它自答', () => {
    expect(silentTurnEvent({ turn: 9, shape: shape(), steered: true }).steered).toBe(true)
    expect(silentTurnEvent({ turn: 9, shape: shape(), steered: false }).steered).toBe(false)
  })
})
