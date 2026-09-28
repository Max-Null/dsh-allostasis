import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { DRIFT_THRESHOLD, measureThinking, verdict } from '../src/drift.ts'
import {
  CONSECUTIVE_STEPS,
  measureRepetition,
  REPETITION_THRESHOLD,
  repetitionVerdict,
  trackLoop,
} from '../src/repetition.ts'

describe('resolveConfig', () => {
  it('不传配置时全部取判据模块的常量——配置前后行为逐字一致', () => {
    expect(resolveConfig()).toEqual({
      driftThreshold: DRIFT_THRESHOLD,
      repetitionThreshold: REPETITION_THRESHOLD,
      consecutiveSteps: CONSECUTIVE_STEPS,
    })
  })

  it('传空对象与不传等价——Loader 未配置时两种形态都要落到默认值', () => {
    expect(resolveConfig({})).toEqual(resolveConfig())
  })

  it('只覆盖一个字段时，其余仍取默认值', () => {
    expect(resolveConfig({ repetitionThreshold: 0.7 })).toEqual({
      driftThreshold: DRIFT_THRESHOLD,
      repetitionThreshold: 0.7,
      consecutiveSteps: CONSECUTIVE_STEPS,
    })
  })

  it('显式传 0 与不传是两回事——0 是合法设置，不是缺省', () => {
    expect(resolveConfig({ repetitionThreshold: 0 }).repetitionThreshold).toBe(0)
  })

  it('上界 1 合法——它意味着事实上关闭退化提醒，是使用者的权利', () => {
    expect(resolveConfig({ repetitionThreshold: 1 }).repetitionThreshold).toBe(1)
    expect(resolveConfig({ driftThreshold: 1 }).driftThreshold).toBe(1)
  })

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    '越界的阈值 %s 报错中止，不静默回退',
    (value) => {
      expect(() => resolveConfig({ driftThreshold: value })).toThrow(/driftThreshold/)
      expect(() => resolveConfig({ repetitionThreshold: value })).toThrow(/repetitionThreshold/)
    },
  )

  it('报错文本点名字段与实际取值——这正是 fail-loud 的价值', () => {
    expect(() => resolveConfig({ driftThreshold: 5 })).toThrow(/between 0 and 1, got 5/)
  })

  it.each([0, -1, 1.5, Number.NaN])('连续步数 %s 非法——它必须是 >= 1 的整数', (value) => {
    expect(() => resolveConfig({ consecutiveSteps: value })).toThrow(/consecutiveSteps/)
  })

  it('连续步数 1 合法——它意味着单步越线即提醒，误报由使用者自己承担', () => {
    expect(resolveConfig({ consecutiveSteps: 1 }).consecutiveSteps).toBe(1)
  })
})

describe('配置到判定的接线', () => {
  /** 60 个英文词、其中 20 个功能词 → 密度 0.333，落在 0.15 与 0.9 之间。 */
  const driftText = [...Array<string>(40).fill('alpha'), ...Array<string>(20).fill('the')].join(' ')
  /** 20 个单元、其中 10 个是同一个 → 重复率 0.5，落在 0.3 与 0.8 之间。 */
  const loopText = [...Array<string>(10).fill('好'), ...Array.from({ length: 10 }, (_, i) => `第${i}件`)].join('。')

  it('漂移阈值真的改变判定', () => {
    const metrics = measureThinking(driftText)
    expect(verdict(metrics, 0.15)).toBe('drift')
    expect(verdict(metrics, 0.9)).toBe('chinese')
  })

  it('重复率阈值真的改变判定', () => {
    const metrics = measureRepetition(loopText)
    expect(repetitionVerdict(metrics, 0.3)).toBe('loop')
    expect(repetitionVerdict(metrics, 0.8)).toBe('normal')
  })

  it('连续步数真的改变触发时机——第 1 步越线在 required=1 时就触发', () => {
    expect(trackLoop(undefined, 7, 'loop', 1).fire).toBe(true)
    expect(trackLoop(undefined, 7, 'loop', 2).fire).toBe(false)
  })
})
