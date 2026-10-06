import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { MIN_UNITS } from '../src/repetition.ts'

/** `apply` 注册到 `llm/stream` 上的那个 waterfall 监听。 */
type StreamHandler = (
  request: { purpose?: string; sessionId?: unknown },
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>

/** `apply` 注册到 `agent/turn-stopping` 上的那个监听。 */
type StoppingHandler = (payload: {
  agent: { session: Session; steer: (message: unknown) => void }
  turn: number
  signal: AbortSignal
}) => void

/** 每个用例共享的诊断行收集（`console.debug` 在 `beforeEach` 里被接住）。 */
let debugLines: string[] = []

beforeEach(() => {
  vi.restoreAllMocks()
  debugLines = []
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    debugLines.push(args.map(argument => String(argument)).join(' '))
  })
})

/** 装一个只提供 `on` 与 `logger.warn` 的上下文并跑 `apply`。 */
function harness(config: Config = {}): { hooks: Map<string, unknown>; warnings: string[] } {
  const hooks = new Map<string, unknown>()
  const warnings: string[] = []
  const ctx = {
    on: (event: string, handler: unknown) => {
      hooks.set(event, handler)
    },
    logger: { warn: (message: string) => void warnings.push(message) },
  }
  apply(ctx as unknown as Context, config)
  return { hooks, warnings }
}

/** 造一条「只有推理、没有文本」的助手消息——空回合判据的靶子，也正是掐断步的形状。 */
function reasonOnlyEvent(turn: number, step: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 0,
    data: { turn, step, message: { content: [{ type: 'reasoning', text: '一长段没有结论的思考' }] }, stream: [] },
  } as unknown as SessionEvent
}

/** 会话只需提供 `id` / `header` / `snapshotEvents`；两个钩子不读别的成员。 */
function sessionOf(events: SessionEvent[]): Session {
  return {
    id: 'session-cut-wiring',
    header: {},
    snapshotEvents: () => events,
  } as unknown as Session
}

/** 假上游流。 */
function upstreamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  async function* generate(): AsyncGenerator<StreamChunk> {
    for (const chunk of chunks) yield chunk
  }
  return generate()
}

/** 走一遍 `llm/stream` 钩子，收集输出。 */
async function feed(
  hooks: Map<string, unknown>,
  chunks: readonly StreamChunk[],
  request: { purpose?: string; sessionId?: unknown } = { sessionId: 'session-cut-wiring' },
): Promise<StreamChunk[]> {
  const handler = hooks.get('llm/stream') as StreamHandler | undefined
  if (handler === undefined) throw new Error('llm/stream 没有注册')
  const out: StreamChunk[] = []
  for await (const chunk of handler(request, () => upstreamOf(chunks))) out.push(chunk)
  return out
}

/** 触发一次回合收尾，返回 steer 收到的消息。 */
function stopTurn(hooks: Map<string, unknown>, session: Session, turn: number): unknown[] {
  const handler = hooks.get('agent/turn-stopping') as StoppingHandler | undefined
  if (handler === undefined) throw new Error('agent/turn-stopping 没有注册')
  const steered: unknown[] = []
  handler({
    agent: { session, steer: message => void steered.push(message) },
    turn,
    signal: { aborted: false } as AbortSignal,
  })
  return steered
}

/** `MIN_UNITS` 个「好。」——第 MIN_UNITS 格正好判越线，再补一格让「思考仍在继续」成立。 */
const LOOP_STREAM: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  ...Array.from({ length: MIN_UNITS }, (): StreamChunk => ({ type: 'reasoning-delta', index: 0, text: '好。' })),
  { type: 'reasoning-delta', index: 0, text: '好。' },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('三个档位各自的行为', () => {
  it('off 不注册 llm/stream——与没有这个能力时一致', () => {
    const { hooks } = harness({ streamCut: 'off' })
    expect(hooks.has('llm/stream')).toBe(false)
    expect(hooks.has('agent/turn-stopping')).toBe(true)
  })

  it('observe 注册监听但不产生 block-end', async () => {
    const { hooks } = harness({ streamCut: 'observe' })
    const out = await feed(hooks, LOOP_STREAM)
    expect(out).toEqual([...LOOP_STREAM])
    expect(out.some(chunk => chunk.type === 'block-end')).toBe(false)
    expect(debugLines.some(line => line.includes('observe，不掐断'))).toBe(true)
  })

  it('cut 产生 block-end 与 finish{stop}', async () => {
    const { hooks } = harness({ streamCut: 'cut' })
    const out = await feed(hooks, LOOP_STREAM)
    expect(out.some(chunk => chunk.type === 'block-end')).toBe(true)
    expect(out[out.length - 1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(debugLines.some(line => line.includes('流内掐断'))).toBe(true)
  })

  it('默认档位（不配置）就是 observe——强动作要显式打开', async () => {
    const { hooks } = harness()
    const out = await feed(hooks, LOOP_STREAM)
    expect(out.some(chunk => chunk.type === 'block-end')).toBe(false)
  })
})

describe('llm/stream 的边界', () => {
  it('辅助调用（会话标题、压缩）不参与检测', async () => {
    const { hooks } = harness({ streamCut: 'cut' })
    const out = await feed(hooks, LOOP_STREAM, { purpose: 'session-title', sessionId: 'session-cut-wiring' })
    expect(out).toEqual([...LOOP_STREAM])
    expect(debugLines).toEqual([])
  })

  it('没有会话归属的一次性调用不参与检测', async () => {
    const { hooks } = harness({ streamCut: 'cut' })
    const out = await feed(hooks, LOOP_STREAM, {})
    expect(out).toEqual([...LOOP_STREAM])
    expect(debugLines).toEqual([])
  })
})

describe('掐断的静默不进空回合判定', () => {
  it('掐断之后回合收尾：跳过空回合判定，只发一条续跑请求', async () => {
    const { hooks } = harness({ streamCut: 'cut', silentTurn: 'steer' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])

    await feed(hooks, LOOP_STREAM)
    const steered = stopTurn(hooks, session, 5)

    // 续跑请求发出去了，而且用的是掐断的文案（不是空回合的补生成）。
    expect(steered).toHaveLength(1)
    const notice = steered[0] as { content: Array<{ text: string }>; source: { summary: string } }
    expect(notice.content[0]?.text).toContain('推理退化')
    expect(notice.content[0]?.text).toContain('截断')
    expect(notice.source.summary).toContain('流内掐断')
    // 空回合那条判据一步都没跑——这正是 §3.4 要消灭的双提醒。
    expect(debugLines.some(line => line.includes('空回合 ·'))).toBe(false)
    expect(debugLines.some(line => line.includes('跳过空回合判定 · 续跑一步'))).toBe(true)
  })

  it('同一 turn 的第二次收尾不再续跑，也不再退回去判空回合', async () => {
    const { hooks } = harness({ streamCut: 'cut', silentTurn: 'steer' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])
    await feed(hooks, LOOP_STREAM)

    const before = debugLines.length
    stopTurn(hooks, session, 5)
    const second = stopTurn(hooks, session, 5)

    expect(second).toHaveLength(0)
    expect(debugLines.slice(before).some(line => line.includes('本 turn 的续跑已经发过'))).toBe(true)
    expect(debugLines.slice(before).some(line => line.includes('空回合 ·'))).toBe(false)
  })

  it('续跑文案可以被配置整段覆盖', async () => {
    const { hooks } = harness({ streamCut: 'cut', streamCutResumeText: '别解释了，直接给结论。' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])
    await feed(hooks, LOOP_STREAM)
    const steered = stopTurn(hooks, session, 5)
    const notice = steered[0] as { content: Array<{ text: string }> }
    expect(notice.content[0]?.text).toBe('别解释了，直接给结论。')
  })

  it('续跑不看 silentTurn 档位——关掉空回合兜底不该让掐断变成白掐', async () => {
    const { hooks } = harness({ streamCut: 'cut', silentTurn: 'off' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])
    await feed(hooks, LOOP_STREAM)
    expect(stopTurn(hooks, session, 5)).toHaveLength(1)
  })

  it('确认这条消息本来会被判成空回合——对照组', async () => {
    // 没有掐断账本时（默认 observe 档），同一条消息走的是既有的空回合路径。
    const { hooks } = harness({ streamCut: 'observe', silentTurn: 'steer' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])
    await feed(hooks, LOOP_STREAM)

    const steered = stopTurn(hooks, session, 5)
    expect(steered).toHaveLength(1)
    const notice = steered[0] as { content: Array<{ text: string }> }
    expect(notice.content[0]?.text).toContain('空回合')
    expect(debugLines.some(line => line.includes('空回合 ·'))).toBe(true)
  })

  it('别的 turn 的收尾不受本 turn 掐断影响', async () => {
    const { hooks } = harness({ streamCut: 'cut', silentTurn: 'steer' })
    const session = sessionOf([reasonOnlyEvent(5, 1), reasonOnlyEvent(6, 1)])
    await feed(hooks, LOOP_STREAM)
    stopTurn(hooks, session, 5)

    const before = debugLines.length
    const steered = stopTurn(hooks, session, 6)
    // turn 6 的空回合与掐断无关，该走的兜底照走。
    expect(steered).toHaveLength(1)
    expect(debugLines.slice(before).some(line => line.includes('空回合 · turn 6'))).toBe(true)
  })

  it('取消的回合不续跑——用户按了停止，再推一条续跑是违背意图的', async () => {
    const { hooks } = harness({ streamCut: 'cut', silentTurn: 'steer' })
    const session = sessionOf([reasonOnlyEvent(5, 1)])
    await feed(hooks, LOOP_STREAM)

    const handler = hooks.get('agent/turn-stopping') as StoppingHandler
    const steered: unknown[] = []
    handler({
      agent: { session, steer: message => void steered.push(message) },
      turn: 5,
      signal: { aborted: true } as AbortSignal,
    })
    expect(steered).toHaveLength(0)
  })
})
