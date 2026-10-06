import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.ts'

/** `apply` 注册到 `agent/pre-step` 上的那个钩子。 */
type PreStepHandler = (
  payload: { agent: { session: Session }; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

/**
 * 装一个只提供 `on` 与 `logger.warn` 的上下文并跑 `apply`，取出 pre-step 钩子。
 * @returns 钩子本体，以及累计到的 warn 文本。
 */
function harness(): { preStep: PreStepHandler; warnings: string[] } {
  const hooks = new Map<string, unknown>()
  const warnings: string[] = []
  const ctx = {
    on: (event: string, handler: unknown) => {
      hooks.set(event, handler)
    },
    logger: { warn: (message: string) => void warnings.push(message) },
  }
  apply(ctx as unknown as Context, {})
  return { preStep: hooks.get('agent/pre-step') as PreStepHandler, warnings }
}

/** 造一条只带思考增量的助手消息。 */
function assistantEvent(turn: number, step: number, chunks: string[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 0,
    data: { turn, step, stream: [{ type: 'reasoning-chunks', texts: chunks }] },
  } as unknown as SessionEvent
}

/** 会话只需提供 `snapshotEvents`；钩子不读别的成员。 */
function sessionOf(events: SessionEvent[]): Session {
  return { snapshotEvents: () => events } as unknown as Session
}

/** 调一次钩子；`next` 固定返回内核已经给出的「进入这一步」。 */
async function run(preStep: PreStepHandler, session: Session): Promise<PreStepDecision> {
  const enter: PreStepDecision = { kind: 'enter', messages: [] }
  return preStep(
    { agent: { session }, signal: { aborted: false } as AbortSignal },
    async () => enter,
  )
}

beforeEach(() => {
  // `apply` 的加载行走 info、每步的诊断行走 debug，都会污染用例输出。
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
})

describe('pre-step 钩子的失败边界', () => {
  it('取数抛错时不向上抛，原样返回内核给出的决策', async () => {
    // 2026-10-06 的事故形状：`latestThinking` 抛 RangeError，钩子没有兜底，
    // 于是 turn 在进入这一步之前就以 error 结束，此后每个 turn 都在同一步失败。
    const { preStep, warnings } = harness()
    const exploding = {
      snapshotEvents: () => {
        throw new RangeError('Maximum call stack size exceeded')
      },
    } as unknown as Session
    const result = await run(preStep, exploding)
    expect(result.kind).toBe('enter')
    expect(result.kind === 'enter' && result.messages).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Maximum call stack size exceeded')
  })

  it('单条思考记录有 30 万个增量时仍能返回决策——这是事故现场的数量级', async () => {
    // 引擎的展开实参上限实测约 12.5 万（`tools/audit-chunk-limits.mjs --limit`）；
    // 事故里的那一步是 210,139 个增量。这里取 30 万，远高于任何已知上限。
    const { preStep, warnings } = harness()
    const chunks = new Array<string>(300_000).fill('冗')
    const result = await run(preStep, sessionOf([assistantEvent(1, 1, chunks)]))
    expect(result.kind).toBe('enter')
    expect(warnings).toEqual([])
  })

  it('会话里没有思考文本时原样返回决策，不记 warn', async () => {
    const { preStep, warnings } = harness()
    const result = await run(preStep, sessionOf([]))
    expect(result.kind).toBe('enter')
    expect(warnings).toEqual([])
  })
})

describe('pre-step 钩子的正常路径', () => {
  it('判据命中时把锚定消息追加进决策', async () => {
    // 对照组：证明夹具能走通完整路径，上面三条「原样返回」不是因为钩子根本没生效。
    const { preStep, warnings } = harness()
    const english = new Array(4)
      .fill('the is are was were and or but to of in that this with for it as be not if on at by from an a')
      .join(' ')
    const result = await run(preStep, sessionOf([assistantEvent(3, 2, [english])]))
    expect(result.kind).toBe('enter')
    expect(result.kind === 'enter' ? result.messages : []).toHaveLength(1)
    expect(warnings).toEqual([])
  })
})
