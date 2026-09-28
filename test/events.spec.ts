import { describe, expect, it } from 'vitest'
import { degenerationEvent, UNIT_SAMPLE_MAX_CHARS } from '../src/events.ts'
import type { RepetitionMetrics } from '../src/repetition.ts'

/** 一份形状合法的最小量化结果；各用例只覆盖自己关心的字段。 */
function metrics(over: Partial<RepetitionMetrics> = {}): RepetitionMetrics {
  return { units: 20, repeated: 12, ratio: 0.6, top: [{ unit: '好', count: 9 }], ...over }
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
