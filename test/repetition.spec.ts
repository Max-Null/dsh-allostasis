import { describe, expect, it } from 'vitest'
import {
  LOOP_WINDOW_HITS,
  LOOP_WINDOW_STEPS,
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
    // 单元名用两个以上连续字母：单字母（`u0`）会被实义单元判据滤掉，不是本用例要测的东西。
    const parts: string[] = []
    for (let i = 0; i < 7; i += 1) {
      for (let k = 0; k < 3 + i; k += 1) parts.push('unit' + String(i))
    }
    const m = measureRepetition(parts.join('\n'))
    expect(m.top).toHaveLength(5)
    expect(m.top.map(entry => entry.unit)).toEqual(['unit6', 'unit5', 'unit4', 'unit3', 'unit2'])
    expect(m.top.map(entry => entry.count)).toEqual([9, 8, 7, 6, 5])
  })

  it('纯标记单元不计入：代码围栏、花括号、星号', () => {
    // 这些符号在写代码时天然高频；计入会让正常步越线（2026-10-01 实测的三个假阳性会话）。
    const markers = ['```', '```ts', '}', '*', '*/', '|', '---']
    const text = [...Array.from({ length: 6 }, () => markers).flat(), '正文甲', '正文乙'].join('\n')
    const m = measureRepetition(text)
    expect(m.units).toBe(2)
    expect(m.repeated).toBe(0)
  })

  it('实义单元的门槛：一个汉字算，两个连续字母算，单个字母不算', () => {
    expect(measureRepetition('单字').units).toBe(1)
    expect(measureRepetition('ok').units).toBe(1)
    expect(measureRepetition('x').units).toBe(0)
    expect(measureRepetition('a1').units).toBe(0)
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
  it('窗口内累计达标即触发，**不要求连续**', () => {
    // 这是本判据取代「连续 2 步」的原因：散布型退化里越线之间夹着正常步，
    // 按连续判定会一次都不触发（实测 a8ac8e89 有 17 次语义越线却凑不出连续 2 步）。
    const first = trackLoop(undefined, 'loop')
    expect(first.fire).toBe(false)
    const second = trackLoop(first.state, 'normal')
    expect(second.fire).toBe(false)
    const third = trackLoop(second.state, 'loop')
    expect(third.fire).toBe(true)
    expect(third.state.recent.filter(Boolean)).toHaveLength(LOOP_WINDOW_HITS)
  })

  it('命中数随窗口滑动下降，不影响已发生的触发判定', () => {
    let state = trackLoop(undefined, 'loop').state
    state = trackLoop(state, 'loop').state
    expect(trackLoop(state, 'normal').fire).toBe(true)
    let last = trackLoop(state, 'normal')
    for (let i = 0; i < LOOP_WINDOW_STEPS; i += 1) last = trackLoop(last.state, 'normal')
    expect(last.fire).toBe(false)
    expect(last.state.recent.every(hit => !hit)).toBe(true)
  })

  it('insufficient 既不记命中也不记未命中', () => {
    const first = trackLoop(undefined, 'loop')
    const skipped = trackLoop(first.state, 'insufficient')
    expect(skipped.state.recent).toEqual(first.state.recent)
    // 让「推理偶尔写得很短」占位会稀释窗口、反复推迟触发。
    const second = trackLoop(skipped.state, 'loop')
    expect(second.fire).toBe(true)
  })

  it('窗口大小 1 退化为单步判定', () => {
    expect(trackLoop(undefined, 'loop', 1, 1).fire).toBe(true)
    expect(trackLoop(undefined, 'normal', 1, 1).fire).toBe(false)
  })

  it('窗口长度不超过配置的步数', () => {
    let last = trackLoop(undefined, 'normal', 3, 2)
    for (let i = 0; i < 10; i += 1) last = trackLoop(last.state, 'normal', 3, 2)
    expect(last.state.recent).toHaveLength(3)
  })
})
