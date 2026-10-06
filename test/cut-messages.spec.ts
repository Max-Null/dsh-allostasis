import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { streamCutNotice, streamCutResumeText, streamCutSummary } from '../src/cut/messages.ts'
import type { CutRecord } from '../src/cut/state.ts'
import { SOURCE_KIND } from '../src/name.ts'

/** 落盘形态的 source——`JSON.stringify` 丢掉 undefined 字段，正是日志里看到的样子。 */
function sourceOf(message: UserMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message.source)) as Record<string, unknown>
}

/** 一次掐断的现场读数。 */
function record(overrides: Partial<CutRecord> = {}): CutRecord {
  return {
    chars: 3989,
    chunks: 2090,
    reading: { units: 200, repeated: 100, ratio: 0.5 },
    top: [{ unit: '好', count: 80 }],
    ...overrides,
  }
}

describe('streamCutResumeText', () => {
  it('默认文案带当次读数，并点明「被打断了」与「别解释」', () => {
    const text = streamCutResumeText(7, record())
    expect(text).toContain('turn 7')
    expect(text).toContain('50%')
    expect(text).toContain('200 个片段里有 100 个')
    expect(text).toContain('最高频的是 「好」×80')
    expect(text).toContain('截断')
    expect(text).toContain('不要解释这次截断')
  })

  it('没有高频单元时省掉那半句，不拼出残句', () => {
    // `repetitionThreshold: 0` 是合法配置，那条路径下 top 可能是空的。
    const text = streamCutResumeText(1, record({ top: [] }))
    expect(text).not.toContain('最高频的是')
    expect(text).toContain('50%')
  })

  it('超长单元被截断后加省略号', () => {
    const long = '甲'.repeat(60)
    expect(streamCutResumeText(1, record({ top: [{ unit: long, count: 3 }] }))).toContain(`「${'甲'.repeat(40)}…」×3`)
  })

  it('配置覆盖时整段用它——配置项是纯文本，没有占位符', () => {
    expect(streamCutResumeText(7, record(), '直接干。')).toBe('直接干。')
  })
})

describe('streamCutSummary', () => {
  it('一行里给出读数与「这一步不是模型自己结束的」', () => {
    const summary = streamCutSummary(7, record())
    expect(summary).toContain('流内掐断')
    expect(summary).toContain('turn 7')
    expect(summary).toContain('50%')
    expect(summary).toContain('续跑一步')
  })
})

describe('streamCutNotice', () => {
  it('复用 pluginNotice 的 source 口径：同一生产者、notice 形式', () => {
    const notice = streamCutNotice(7, record())
    const source = sourceOf(notice)
    expect(notice.role).toBe('user')
    expect(source['kind']).toBe(SOURCE_KIND)
    expect(source['form']).toBe('notice')
  })

  it('正文与摘要是同一份读数的两种读法', () => {
    const notice = streamCutNotice(7, record())
    expect(notice.content[0]).toMatchObject({ type: 'text', text: streamCutResumeText(7, record()) })
    expect(sourceOf(notice)['summary']).toBe(streamCutSummary(7, record()))
  })
})
