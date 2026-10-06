import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { guardStream, type StreamCutOptions } from '../src/cut/stream.ts'
import { MIN_UNITS } from '../src/repetition.ts'

/**
 * 假上游流：逐格吐出给定的增量，并在 `finally` 里记下「有没有被 return 掉」。
 *
 * 用 async generator 而不是手写 iterator，是因为真实上游（provider 适配器）就是
 * generator，`iterator.return?.()` 能不能下传到它的 `finally` 正是要验的东西。
 * @param chunks - 上游会吐出的增量。
 * @returns 流本体与探针。
 */
function fakeStream(chunks: readonly StreamChunk[]): {
  stream: AsyncIterable<StreamChunk>
  probes: { returned: boolean; consumed: number }
} {
  const probes = { returned: false, consumed: 0 }
  async function* generate(): AsyncGenerator<StreamChunk> {
    try {
      for (const chunk of chunks) {
        probes.consumed += 1
        yield chunk
      }
    } finally {
      probes.returned = true
    }
  }
  return { stream: generate(), probes }
}

/** 收集假流的输出。 */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** 造一格思考增量。 */
function reasoning(index: number, text: string): StreamChunk {
  return { type: 'reasoning-delta', index, text }
}

/** 命中后往下游再探会看到的那种「思考已结束」的格。 */
function blockEnd(index: number, text: string): StreamChunk {
  return { type: 'block-end', index, block: { type: 'text', text } }
}

/** `MIN_UNITS` 个「好。」——第 MIN_UNITS 格正好判越线。 */
const LOOP_DELTAS: readonly StreamChunk[] = Array.from(
  { length: MIN_UNITS },
  () => reasoning(0, '好。'),
)

/**
 * 跑一条流并收集诊断行。
 * @param chunks - 上游增量。
 * @param options - 档位与阈值；`log` 由本函数覆盖。
 * @returns 输出、探针、诊断行、掐断回调收到的记录。
 */
async function run(
  chunks: readonly StreamChunk[],
  options: { mode: 'observe' | 'cut'; threshold?: number } = { mode: 'cut' },
): Promise<{
  out: StreamChunk[]
  probes: { returned: boolean; consumed: number }
  lines: string[]
  cuts: Array<{ sessionId: string; record: unknown }>
}> {
  const { stream, probes } = fakeStream(chunks)
  const lines: string[] = []
  const cuts: Array<{ sessionId: string; record: unknown }> = []
  const guardOptions: StreamCutOptions = {
    mode: options.mode,
    threshold: options.threshold ?? 0.5,
    log: line => void lines.push(line),
    onCut: (sessionId, record) => void cuts.push({ sessionId, record }),
  }
  const out = await collect(guardStream(stream, 'session-cut-test', guardOptions))
  return { out, probes, lines, cuts }
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
})

describe('命中即收尾', () => {
  it('命中后思考仍在继续 → 补 block-end 与 finish{stop}，并终止上游', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
      reasoning(0, '好。'),
      reasoning(0, '好。'),
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { out, probes, lines, cuts } = await run(chunks)

    // 输出 = block-start + 触发点为止的 MIN_UNITS 格 + 补的两格。
    expect(out).toHaveLength(MIN_UNITS + 3)
    expect(out[0]).toEqual(chunks[0])
    expect(out[MIN_UNITS]).toEqual(chunks[MIN_UNITS])
    expect(out[MIN_UNITS + 1]).toEqual({
      type: 'block-end',
      index: 0,
      block: { type: 'reasoning', text: '好。'.repeat(MIN_UNITS) },
    })
    expect(out[MIN_UNITS + 2]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // 触发点之后的增量、usage、finish 一格都不放行——这正是省下来的 token。
    expect(out).not.toContainEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } })
    expect(probes.consumed).toBe(MIN_UNITS + 2)
    expect(probes.returned).toBe(true)
    expect(lines.filter(line => line.includes('流内掐断'))).toHaveLength(1)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.sessionId).toBe('session-cut-test')
    expect(cuts[0]?.record).toMatchObject({
      chars: MIN_UNITS * '好。'.length,
      chunks: MIN_UNITS,
      reading: { units: MIN_UNITS, repeated: MIN_UNITS, ratio: 1 },
    })
  })

  it('补块的文本等于已放行的全部思考增量——触发点那一格照常放行', async () => {
    // 少放行一格，`block-end.text` 就会比推理原文短一段，落盘的块与 stream 记录对不上。
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      reasoning(0, '开头的一句。'),
      ...Array.from({ length: 30 }, () => reasoning(0, '好。')),
    ]
    const { out } = await run(chunks)
    const emitted = out.filter(chunk => chunk.type === 'reasoning-delta')
    const text = emitted.map(chunk => (chunk.type === 'reasoning-delta' ? chunk.text : '')).join('')
    const patched = out.find(chunk => chunk.type === 'block-end')
    expect(patched).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text } })
    // 补块必须**紧跟**最后一个被放行的增量——触发点放行、下一格探到复读、当场收尾。
    expect(out[out.lastIndexOf(emitted[emitted.length - 1] as StreamChunk) + 1]).toEqual(patched)
    expect(text.startsWith('开头的一句。')).toBe(true)
    expect(out.length).toBeLessThan(chunks.length)
  })

  it('多块流里按当前块的 index 与文本补——换块时累积重置', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      reasoning(0, '甲。乙。'),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '甲。乙。' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      ...Array.from({ length: MIN_UNITS + 4 }, (): StreamChunk => reasoning(1, '好。')),
      reasoning(1, '好。'),
    ]
    const { out } = await run(chunks)
    const patched = out.filter(chunk => chunk.type === 'block-end')
    expect(patched).toHaveLength(2)
    // 补块用的是**当前块**的 index 与文本：前一块的「甲。乙。」不能混进来。
    const text = out
      .filter(chunk => chunk.type === 'reasoning-delta' && chunk.index === 1)
      .map(chunk => (chunk.type === 'reasoning-delta' ? chunk.text : ''))
      .join('')
    expect(patched[1]).toEqual({ type: 'block-end', index: 1, block: { type: 'reasoning', text } })
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain('甲')
  })
})

describe('命中在末尾时不收尾', () => {
  it('命中行后面换成正文 → 放行，不补块', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
      blockEnd(1, '结论在这里'),
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { out, probes, lines, cuts } = await run(chunks)
    // 一字不差地透传：没有补块、没有丢格。
    expect(out).toEqual([...chunks])
    expect(probes.returned).toBe(true)
    expect(probes.consumed).toBe(chunks.length)
    expect(cuts).toHaveLength(0)
    expect(lines.some(line => line.includes('流内命中后放行'))).toBe(true)
  })

  it('命中行后面就是流末尾 → 放行，不补块', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
    ]
    const { out, probes, cuts } = await run(chunks)
    expect(out).toEqual([...chunks])
    expect(probes.consumed).toBe(chunks.length)
    expect(cuts).toHaveLength(0)
  })

  it('探到的那一格是工具调用前的块收尾 → 也放行', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
      { type: 'block-start', index: 1, blockType: 'text' },
      blockEnd(1, '我这就动手'),
    ]
    const { out, cuts } = await run(chunks)
    expect(out).toEqual([...chunks])
    expect(cuts).toHaveLength(0)
  })
})

describe('上游的终止', () => {
  it('消费者提前 break 时也下传 return——取消路径不能把上游挂着', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...Array.from({ length: 30 }, () => reasoning(0, '正常的一句。')),
    ]
    const { stream, probes } = fakeStream(chunks)
    const out: StreamChunk[] = []
    for await (const chunk of guardStream(stream, 's', { mode: 'cut', threshold: 0.5 })) {
      out.push(chunk)
      if (out.length === 3) break
    }
    expect(out).toHaveLength(3)
    expect(probes.returned).toBe(true)
    expect(probes.consumed).toBeLessThan(chunks.length)
  })

  it('上游 return 抛错时不升级成失败——这一步的产出已经交付', async () => {
    const upstream: AsyncIterable<StreamChunk> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: reasoning(0, '正常。') }),
        return: async () => {
          throw new Error('socket already closed')
        },
      }),
    }
    const out: StreamChunk[] = []
    // 不命中，走正常路径；返回时 `return()` 的异常不该冒出来。
    for await (const chunk of guardStream(upstream, 's', { mode: 'cut', threshold: 0.5 })) {
      out.push(chunk)
      if (out.length === 2) break
    }
    expect(out).toHaveLength(2)
  })
})

describe('记账故障', () => {
  it('onCut 抛错时仍把收尾补齐——记账失败不该升级成回合失败', async () => {
    const { stream } = fakeStream([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
      reasoning(0, '好。'),
    ])
    const lines: string[] = []
    const out: StreamChunk[] = []
    for await (const chunk of guardStream(stream, 's', {
      mode: 'cut',
      threshold: 0.5,
      log: line => void lines.push(line),
      onCut: () => {
        throw new Error('账本写不进去')
      },
    })) out.push(chunk)
    expect(out.some(chunk => chunk.type === 'block-end')).toBe(true)
    expect(out[out.length - 1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(lines.some(line => line.includes('记账失败'))).toBe(true)
  })
})

describe('observe 档', () => {
  it('命中但不掐断，内容一字不差', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...LOOP_DELTAS,
      reasoning(0, '好。'),
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { out, lines, cuts } = await run(chunks, { mode: 'observe' })
    expect(out).toEqual([...chunks])
    expect(cuts).toHaveLength(0)
    expect(lines.filter(line => line.includes('observe'))).toHaveLength(1)
    // 命中时探走的那一格必须被放行——否则 observe 就成了「悄悄丢内容」。
    expect(out.filter(chunk => chunk.type === 'reasoning-delta')).toHaveLength(MIN_UNITS + 1)
  })

  it('不命中时一行痕都不留', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      reasoning(0, '每一句都不一样。'),
      reasoning(0, '所以重复率是零。'),
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { out, lines } = await run(chunks, { mode: 'observe' })
    expect(out).toEqual([...chunks])
    expect(lines).toEqual([])
  })
})

describe('判定之外的透传', () => {
  it('非思考增量、空流都原样走完', async () => {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '正文一句。' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    expect((await run(chunks)).out).toEqual([...chunks])
    expect((await run([])).out).toEqual([])
  })

  it('阈值可调：0.5 掐、0.9 不掐，判据只有阈值这一个自由度', async () => {
    // 6 个「好」+ 6 个独立单元 = ratio 0.5。
    const mixed: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...Array.from({ length: 6 }, () => reasoning(0, '好。')),
      ...Array.from({ length: 6 }, (_, i) => reasoning(0, `独${i}。`)),
      reasoning(0, '好。'),
    ]
    expect((await run(mixed, { mode: 'cut', threshold: 0.5 })).cuts).toHaveLength(1)
    expect((await run(mixed, { mode: 'cut', threshold: 0.9 })).cuts).toHaveLength(0)
  })
})
