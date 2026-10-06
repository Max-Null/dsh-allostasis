import { describe, expect, it } from 'vitest'
import { resolveConfig, type Config } from '../src/config.ts'
import { DRIFT_THRESHOLD, measureThinking, verdict } from '../src/drift.ts'
import {
  LOOP_WINDOW_HITS,
  LOOP_WINDOW_STEPS,
  measureRepetition,
  REPETITION_THRESHOLD,
  repetitionVerdict,
  trackLoop,
} from '../src/repetition.ts'
import { SILENT_TURN_MODE, SILENT_TURN_MODES } from '../src/tail.ts'
import { STREAM_CUT_MAX_RESUMES, STREAM_CUT_MODE, STREAM_CUT_MODES } from '../src/cut/stream.ts'

describe('resolveConfig', () => {
  it('不传配置时全部取判据模块的常量——配置前后行为逐字一致', () => {
    expect(resolveConfig()).toEqual({
      driftThreshold: DRIFT_THRESHOLD,
      repetitionThreshold: REPETITION_THRESHOLD,
      loopWindowSteps: LOOP_WINDOW_STEPS,
      loopWindowHits: LOOP_WINDOW_HITS,
      silentTurn: SILENT_TURN_MODE,
      streamCut: STREAM_CUT_MODE,
      streamCutResumeText: undefined,
      streamCutMaxResumes: STREAM_CUT_MAX_RESUMES,
    })
  })

  it('传空对象与不传等价——Loader 未配置时两种形态都要落到默认值', () => {
    expect(resolveConfig({})).toEqual(resolveConfig())
  })

  it('只覆盖一个字段时，其余仍取默认值', () => {
    expect(resolveConfig({ repetitionThreshold: 0.7 })).toEqual({
      driftThreshold: DRIFT_THRESHOLD,
      repetitionThreshold: 0.7,
      loopWindowSteps: LOOP_WINDOW_STEPS,
      loopWindowHits: LOOP_WINDOW_HITS,
      silentTurn: SILENT_TURN_MODE,
      streamCut: STREAM_CUT_MODE,
      streamCutResumeText: undefined,
      streamCutMaxResumes: STREAM_CUT_MAX_RESUMES,
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

  it.each([0, -1, 1.5, Number.NaN])('观察窗口步数 %s 非法——它必须是 >= 1 的整数', (value) => {
    expect(() => resolveConfig({ loopWindowSteps: value })).toThrow(/loopWindowSteps/)
  })

  it.each([0, -1, 1.5, Number.NaN])('窗口命中数 %s 非法——它必须是 >= 1 的整数', (value) => {
    expect(() => resolveConfig({ loopWindowHits: value })).toThrow(/loopWindowHits/)
  })

  it('窗口步数 1 合法——它意味着单步越线即提醒，误报由使用者自己承担', () => {
    expect(resolveConfig({ loopWindowSteps: 1, loopWindowHits: 1 }).loopWindowSteps).toBe(1)
  })

  it('命中数超过窗口步数时报错——那是一个永不成立的触发条件', () => {
    // 静默夹取等于关掉退化提醒而不说。
    expect(() => resolveConfig({ loopWindowSteps: 2, loopWindowHits: 3 })).toThrow(/can never fire/)
  })

  it('空回合档位默认 observe——判定与留痕先跑起来，补生成等数据说话', () => {
    expect(resolveConfig().silentTurn).toBe('observe')
  })

  it.each([...SILENT_TURN_MODES])('空回合档位 %s 被接受', (value) => {
    expect(resolveConfig({ silentTurn: value }).silentTurn).toBe(value)
  })

  it('未知档位报错中止，不静默回退——静默回退会让「我改了配置」与「按默认跑」同时成立', () => {
    // 配置来自 YAML，运行时可以是任意字符串；断言在这里是模拟外部输入的必需手段。
    const unknown = 'yes' as string
    expect(() => resolveConfig({ silentTurn: unknown } as Config)).toThrow(/silentTurn/)
    expect(() => resolveConfig({ silentTurn: unknown } as Config)).toThrow(/off \| observe \| steer/)
  })

  it('流内掐断档位默认 observe——强动作由使用者知情后自行打开', () => {
    // 理由不是「不知道下游会怎样」，而是已知的代价：掐断会让该步的 usage 与 replayState
    // 两格缺失（`cut/stream.ts` 的档位注释）。
    expect(resolveConfig().streamCut).toBe('observe')
    expect(STREAM_CUT_MODE).toBe('observe')
  })

  it.each([...STREAM_CUT_MODES])('流内掐断档位 %s 被接受', (value) => {
    expect(resolveConfig({ streamCut: value }).streamCut).toBe(value)
  })

  it('未知的流内掐断档位报错中止，不静默回退', () => {
    const unknown = 'observe-only' as string
    expect(() => resolveConfig({ streamCut: unknown } as Config)).toThrow(/streamCut/)
    expect(() => resolveConfig({ streamCut: unknown } as Config)).toThrow(/off \| observe \| cut/)
  })

  it('续跑文案未配置时是 undefined——它意味着「按当次读数组装」而不是一个空值', () => {
    expect(resolveConfig().streamCutResumeText).toBeUndefined()
    expect(resolveConfig({ streamCutResumeText: '直接给结论。' }).streamCutResumeText).toBe('直接给结论。')
  })

  it.each(['', '   '])('续跑文案是空串（%j）时报错——那是「配了但什么也没说」', (value) => {
    expect(() => resolveConfig({ streamCutResumeText: value })).toThrow(/streamCutResumeText/)
  })

  it('每 turn 的续跑上限默认 3——四次才收敛是边界情形，不是目标（§九.7）', () => {
    expect(resolveConfig().streamCutMaxResumes).toBe(STREAM_CUT_MAX_RESUMES)
    expect(STREAM_CUT_MAX_RESUMES).toBe(3)
  })

  it.each([0, 1, 2, 5, 10])('续跑上限 %i 可配', (value) => {
    expect(resolveConfig({ streamCutMaxResumes: value }).streamCutMaxResumes).toBe(value)
  })

  it('上限 0 合法——它表达「只掐不续」这个中间语义', () => {
    // 现有三档里没有它：`observe` 完全不掐、`cut` 是掐 + 续。0 只省 token、不改动对话内容
    // （steer 是往模型上下文里加一条消息，那是一种污染）。
    expect(resolveConfig({ streamCutMaxResumes: 0 }).streamCutMaxResumes).toBe(0)
  })

  it.each([-1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    '续跑上限 %s 非法——它必须是 >= 0 的整数',
    (value) => {
      expect(() => resolveConfig({ streamCutMaxResumes: value })).toThrow(/streamCutMaxResumes/)
    },
  )

  it('上限的报错文本点名字段与取值，且说的是 >= 0 这条界', () => {
    expect(() => resolveConfig({ streamCutMaxResumes: -1 })).toThrow(/must be an integer >= 0, got -1/)
  })

  it('放宽上限的下界没有连带影响窗口参数——两者各有各的校验', () => {
    // `steps` 与 `times` 分开的理由：窗口装不下一步是永不成立的触发条件，必须拒；
    // 而续跑次数 0 是一个真实的设置。
    expect(() => resolveConfig({ loopWindowSteps: 0, loopWindowHits: 0 })).toThrow(/loopWindowSteps/)
    expect(() => resolveConfig({ loopWindowHits: 0 })).toThrow(/loopWindowHits/)
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

  it('窗口参数真的改变触发时机——窗口 1 命中 1 时首步即触发', () => {
    expect(trackLoop(undefined, 'loop', 1, 1).fire).toBe(true)
    expect(trackLoop(undefined, 'loop', 5, 2).fire).toBe(false)
  })
})
