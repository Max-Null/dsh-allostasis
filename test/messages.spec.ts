import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { degenerationText, pluginNotice, silentTurnText } from '../src/messages.ts'
import { SOURCE_KIND } from '../src/name.ts'
import type { RepetitionMetrics } from '../src/repetition.ts'
import type { TailShape } from '../src/tail.ts'
import { CONTEXT_SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-llm'

/** 落盘形态的 source——`JSON.stringify` 丢掉 undefined 字段，正是日志里看到的样子。 */
function sourceOf(message: UserMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message.source)) as Record<string, unknown>
}

/** 一份形状合法的最小量化结果；各用例只覆盖自己关心的字段。 */
function metrics(over: Partial<RepetitionMetrics> = {}): RepetitionMetrics {
  return { units: 46, repeated: 31, ratio: 0.6, top: [{ unit: '好', count: 49 }], ...over }
}

/** 一份形状最小的末步形态；各用例只覆盖自己关心的字段。 */
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

describe('SOURCE_KIND', () => {
  it('与 messages.ts 里声明合并的键是同一个值——两处漂移会让日志出现两个生产者', () => {
    expect(SOURCE_KIND).toBe('plugin:dsh-allostasis')
  })
})

describe('pluginNotice', () => {
  it('source 是 notice 形式的一行叙述，而不是会被后一份取代的 snapshot', () => {
    const source = sourceOf(pluginNotice('正文', '语言漂移 · turn 3 · 第 1 次'))
    expect(source['kind']).toBe('plugin:dsh-allostasis')
    expect(source['form']).toBe('notice')
    expect(source['summary']).toBe('语言漂移 · turn 3 · 第 1 次')
  })

  it('正文原样进 content——模型的读法与客户端的摘要是两条独立通道', () => {
    const message = pluginNotice('⚠️ 提醒正文', '摘要')
    expect(message.content).toEqual([{ type: 'text', text: '⚠️ 提醒正文' }])
  })

  it('超长摘要被截到上界，不让一行叙述无限膨胀', () => {
    const source = sourceOf(pluginNotice('正文', '漂'.repeat(CONTEXT_SUMMARY_MAX_CHARS * 2)))
    const summary = source['summary'] as string
    expect(summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    expect(summary.startsWith('漂')).toBe(true)
  })
})

describe('degenerationText', () => {
  it('点明位置、重复率与样本量——判据的三个数都要在，模型才知道这不是泛泛的督促', () => {
    const text = degenerationText(12, 43, metrics())
    expect(text).toContain('turn 12 step 43')
    expect(text).toContain('60%')
    expect(text).toContain('46 个片段')
    expect(text).toContain('31 个')
  })

  it('列举高频片段及其次数', () => {
    const text = degenerationText(1, 1, metrics({
      top: [{ unit: '好', count: 49 }, { unit: '做', count: 32 }],
    }))
    expect(text).toContain('「好」×49')
    expect(text).toContain('「做」×32')
  })

  it('没有达到次数的片段时不拼「最高频的是 。」——阈值 0 是合法配置，这条路径可达', () => {
    // `top` 为空等价于重复率为 0（top 只收出现 ≥3 次的片段）。2026-10-02 在隔离实例上
    // 把 repetitionThreshold 压到 0 做触发验证时，正文拼出了「最高频的是 。」这种残句。
    const text = degenerationText(1, 1, metrics({ units: 16, repeated: 0, ratio: 0, top: [] }))
    expect(text).not.toContain('最高频的是')
    expect(text).toContain('16 个片段里有 0 个出现 3 次以上')
    // 省掉一句之后正文仍要完整收尾，不能断在半截
    expect(text.endsWith('而不是把同一句话再写一遍。')).toBe(true)
  })

  it('最多列举三个——再多就成了把碎片复述一遍', () => {
    const text = degenerationText(1, 1, metrics({
      top: [
        { unit: '一', count: 9 }, { unit: '二', count: 8 }, { unit: '三', count: 7 },
        { unit: '四', count: 6 },
      ],
    }))
    expect(text).toContain('「三」×7')
    expect(text).not.toContain('「四」')
  })

  it('超长片段在正文里截得更短——它要读起来顺，与落盘的上界不是一回事', () => {
    const text = degenerationText(1, 1, metrics({ top: [{ unit: '好'.repeat(80), count: 5 }] }))
    expect(text).toContain(`${'好'.repeat(40)}…`)
    expect(text).not.toContain('好'.repeat(41))
  })

  it('第一次不带序号，第二次起换口径——措辞一成不变的重复提醒就是纯噪音', () => {
    expect(degenerationText(1, 1, metrics())).toContain('推理退化提醒（应变）：你上一步')
    expect(degenerationText(1, 1, metrics(), 1)).not.toContain('第 1 次')
    expect(degenerationText(1, 1, metrics(), 2)).toContain('第 2 次')
    expect(degenerationText(1, 1, metrics(), 2)).toContain('你仍然在重复自己')
  })

  it('给出两条具体出路——够就给结论，不够就换个动作', () => {
    const text = degenerationText(1, 1, metrics())
    expect(text).toContain('够就直接给结论')
    expect(text).toContain('换一个与前面不同的动作')
  })
})

describe('silentTurnText', () => {
  it('说清末步产出了什么——推理字数进正文，模型才知道自己停在哪一步', () => {
    const text = silentTurnText(9, shape())
    expect(text).toContain('turn 9')
    expect(text).toContain('3747 字')
  })

  it('推理为空时不写「生成了 0 字推理」——那句话描述的是判据，不是模型做过的事', () => {
    const text = silentTurnText(9, shape({ reasoningChars: 0 }))
    expect(text).toContain('没有产出任何内容')
    expect(text).not.toContain('0 字')
  })

  it('带工具调用时点出次数——2/34 的那一类要说得出自己与多数案例不同在哪', () => {
    const text = silentTurnText(9, shape({ blocks: { reasoning: 1, text: 0, toolCalls: 2 } }))
    expect(text).toContain('2 个工具调用')
  })

  it('点明用户此刻看到什么——这是补生成的全部理由', () => {
    expect(silentTurnText(9, shape())).toContain('折叠的操作条')
  })

  it('带上两条禁令：不重做工具、不复述推理——少了它们，模型很可能把整轮再跑一遍', () => {
    const text = silentTurnText(9, shape())
    expect(text).toContain('不要重做已经执行过的工具调用')
    expect(text).toContain('不要复述推理里的过程')
  })
})
