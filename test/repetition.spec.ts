import { describe, expect, it } from 'vitest'
import {
  CONSECUTIVE_STEPS,
  MIN_UNITS,
  REPEAT_MIN_COUNT,
  REPETITION_THRESHOLD,
  measureRepetition,
  repetitionVerdict,
  trackLoop,
} from '../src/repetition.ts'

/** 造一条文本：用换行拼出 n 个单元，其中前 repeated 个各重复 REPEAT_MIN_COUNT 次。 */
function craft(n: number, repeated: number): string {
  const parts: string[] = []
  for (let i = 0; i < repeated; i += 1) {
    for (let k = 0; k < REPEAT_MIN_COUNT; k += 1) parts.push('碎' + String(i))
  }
  while (parts.length < n) parts.push('独' + String(parts.length))
  return parts.slice(0, n).join('\n')
}

describe('measureRepetition', () => {
  it('空文本与纯空白返回全零，不产生 NaN', () => {
    for (const text of ['', '   ', '\n\n', '。']) {
      const m = measureRepetition(text)
      expect(m.units, JSON.stringify(text)).toBe(0)
      expect(m.repeated).toBe(0)
      expect(m.ratio).toBe(0)
      expect(m.top).toEqual([])
    }
  })

  it('换行与中英句读都切分，逗号分号不切', () => {
    expect(measureRepetition('甲\n乙。丙！丁？戊').units).toBe(5)
    expect(measureRepetition('甲；乙，丙').units).toBe(1)
  })

  it('重复按出现次数计，不按种类计', () => {
    const m = measureRepetition('同\n同\n同\n独')
    expect(m.units).toBe(4)
    expect(m.repeated).toBe(REPEAT_MIN_COUNT)
    expect(m.top).toEqual([{ unit: '同', count: REPEAT_MIN_COUNT }])
  })

  it('未达次数的单元不计入 repeated，也不进 top', () => {
    const m = measureRepetition('同\n同\n独')
    expect(m.repeated).toBe(0)
    expect(m.top).toEqual([])
  })

  it('top 按次数降序，最多 5 条', () => {
    const parts: string[] = []
    for (let i = 0; i < 7; i += 1) {
      for (let k = 0; k < 3 + i; k += 1) parts.push('u' + String(i))
    }
    const m = measureRepetition(parts.join('\n'))
    expect(m.top).toHaveLength(5)
    expect(m.top.map(entry => entry.unit)).toEqual(['u6', 'u5', 'u4', 'u3', 'u2'])
    expect(m.top.map(entry => entry.count)).toEqual([9, 8, 7, 6, 5])
  })
})

describe('repetitionVerdict', () => {
  it('单元数不足时不下结论', () => {
    const m = measureRepetition(craft(MIN_UNITS - 1, MIN_UNITS - 1))
    expect(m.units).toBeLessThan(MIN_UNITS)
    expect(repetitionVerdict(m)).toBe('insufficient')
  })

  it('阈值是闭区间下界', () => {
    expect(repetitionVerdict({ units: 100, repeated: 50, ratio: REPETITION_THRESHOLD, top: [] })).toBe('loop')
    expect(repetitionVerdict({ units: 100, repeated: 0, ratio: REPETITION_THRESHOLD - 0.01, top: [] })).toBe('normal')
  })
})

describe('trackLoop', () => {
  it('连续越线达到门槛才触发', () => {
    let last = trackLoop(undefined, 1, 'loop')
    for (let step = 1; step < CONSECUTIVE_STEPS; step += 1) {
      last = trackLoop(last.state, 1, 'loop')
    }
    expect(last.fire).toBe(true)
    expect(last.state.consecutive).toBe(CONSECUTIVE_STEPS)
  })

  it('中途一步清白即归零', () => {
    const first = trackLoop(undefined, 1, 'loop')
    const second = trackLoop(first.state, 1, 'normal')
    expect(second.fire).toBe(false)
    expect(second.state.consecutive).toBe(0)
  })

  it('insufficient 保持计数不变：既不清零也不加分', () => {
    const first = trackLoop(undefined, 1, 'loop')
    const second = trackLoop(first.state, 1, 'insufficient')
    expect(second.state.consecutive).toBe(first.state.consecutive)
    const third = trackLoop(second.state, 1, 'loop')
    expect(third.state.consecutive).toBe(first.state.consecutive + 1)
  })

  it('换 turn 从零起算', () => {
    const first = trackLoop(undefined, 1, 'loop')
    const next = trackLoop(first.state, 2, 'loop')
    expect(next.state.consecutive).toBe(1)
  })
})
