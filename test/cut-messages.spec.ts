import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  streamCutHandoverText,
  streamCutNotice,
  streamCutResumeText,
  streamCutSummary,
} from '../src/cut/messages.ts'
import type { CutRecord } from '../src/cut/state.ts'
import { SOURCE_KIND } from '../src/name.ts'

/** 落盘形态的 source——`JSON.stringify` 丢掉 undefined 字段，正是日志里看到的样子。 */
function sourceOf(message: UserMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message.source)) as Record<string, unknown>
}

/** 模型读到的正文；收窄掉非文本块，避免用断言绕过类型。 */
function textOf(message: UserMessage): string {
  const [block] = message.content
  if (block === undefined || block.type !== 'text') throw new Error('期望一段纯文本正文')
  return block.text
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

describe('streamCutHandoverText', () => {
  it('四段结构齐全，并要求写成一个文件', () => {
    const text = textOf(streamCutHandoverText(7, record(), '本 turn 续跑已达上限（3 次）'))
    for (const section of ['已经完成', '未完成', '下一步', '关键上下文']) {
      expect(text).toContain(section)
    }
    expect(text).toContain('交接材料')
    expect(text).toContain('写成一个文件')
    expect(text).toContain('handover-YYYY-MM-DD.md')
  })

  it('要求用代码块给出可复制的续接提示词，里面带文件的完整路径', () => {
    const text = textOf(streamCutHandoverText(7, record(), '本 turn 续跑已达上限（3 次）'))
    expect(text).toContain('代码块')
    expect(text).toContain('完整路径')
    expect(text).toContain('新会话')
    // 形态示例用行内代码：这里出现围栏会与客户端渲染出的代码块混淆。
    expect(text).not.toContain('```')
  })

  it('带上配额说明与当次读数，并点明写完就停', () => {
    const text = textOf(streamCutHandoverText(7, record(), '本 turn 续跑已达上限（3 次）'))
    expect(text).toContain('turn 7')
    expect(text).toContain('本 turn 续跑已达上限（3 次）')
    expect(text).toContain('50%')
    expect(text).toContain('不要再执行新的操作')
  })

  it('没有现场读数时省掉重复率，不拼出空括号', () => {
    const text = textOf(streamCutHandoverText(3, undefined, '本 turn 续跑上限为 0（只掐不续）'))
    expect(text).not.toContain('重复率')
    expect(text).toContain('本 turn 续跑上限为 0（只掐不续）')
  })

  it('复用 pluginNotice 的 source 口径，摘要写明是配额用尽', () => {
    const notice = streamCutHandoverText(7, record(), '本 turn 续跑已达上限（3 次）')
    const source = sourceOf(notice)
    expect(notice.role).toBe('user')
    expect(source['kind']).toBe(SOURCE_KIND)
    expect(source['form']).toBe('notice')
    expect(source['summary']).toContain('续跑配额用尽')
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
