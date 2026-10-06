/**
 * 流内掐断：包一层 `llm/stream`，逐增量判、命中则把这次生成**伪装成正常收尾**。
 *
 * `llm/stream` 是官方文档化的扩展点（`packages/llm/llm/src/index.ts:75`，且进
 * `packages/extensions/tool-cordis/src/api-catalog.ts` 的 API catalog），内核自己在
 * `session/session-title` 与 `session/session-checkpoint-policy` 两处按同一形态使用。
 * 它是 waterfall：包一层上游流即可逐 chunk 观察，不需要 `agent.cancel()`。
 *
 * **为什么不用 `agent.cancel()`**：那会作废整轮。这里的做法是让这一步**看起来是自己结束的**
 * （设计文档 §三.2），所以补三格：
 *
 * ```text
 * yield chunk                                            // 触发点照常放行
 * yield { type: 'block-end', index, block: { reasoning } }  // 该块的完整文本
 * yield { type: 'finish', reason: { kind: 'stop' } }        // 终态：正常收尾
 * ```
 *
 * 三个不能省的细节（都由实测逼出来）：
 *
 * 1. **命中后要再探一格**。若下一格仍是 `reasoning-delta`，说明思考在继续复读，拦；若换成
 *    正文、工具调用或直接收尾，说明命中行本来就是这段思考的最后一句，属正常收尾，**放行**。
 *    没有这一格，正常步的结尾语会被误拦。
 * 2. **`finally` 里必须 `iterator.return?.()`**。提前收尾时若不下传，上游 HTTP 流会继续跑完，
 *    **供应商照常计满 token**，连接还悬挂着。
 * 3. **触发点那个增量照常放行**，否则补块里的文本与落盘的 `block-end.text` 会对不上。
 *
 * **已知代价不在这里补**（设计文档 §九.3 已量过并接受）：掐断用 `iterator.return()` 提前终止
 * 上游，`usage` 与 `finish.replayState` 这两格从未产生，因此这一步的 `data.usage` 整键缺失、
 * `message.source.replayState` 缺键，该轮的 `deriveTurnTokenUsage` 会整体返回 `undefined`、
 * 客户端不渲染 token 摘要。**伪造它们比缺失更糟**——`replayState` 里含不可重算的
 * reasoning `signature`。
 *
 * 本模块**不知道谁在用它**：命中时通过 `onCut` 回调把事实交出去，注册与记账由 `index.ts` 做。
 * @module @max-null/dsh-allostasis/cut/stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { name } from '../name.ts'
import { createStreamDetector } from './detect.ts'
import type { CutRecord } from './state.ts'

/** 流内掐断的档位。 */
export type StreamCutMode = 'off' | 'observe' | 'cut'

/** 全部档位，供配置校验枚举。 */
export const STREAM_CUT_MODES: readonly StreamCutMode[] = ['off', 'observe', 'cut']

/**
 * 流内掐断的档位缺省值：`observe`。
 *
 * **不是 `cut`**（设计文档 §六）：掐断会让该轮的 `data.usage` 整键缺失、
 * `message.source.replayState` 缺键，进而让 `deriveTurnTokenUsage` 返回 `undefined`、
 * 客户端不渲染该轮的 token 摘要（§九.3）。这个代价可接受、但**不可完全抹平**——那两格由
 * 上游适配器在流末尾产出，掐断就是不产出——所以 `cut` 由使用者知情后自行开启。
 *
 * 判据本身的标定数据是支持开 `cut` 的：ratio ≥ 0.5 时干预率 3.11%、真阳性率 93.49%、
 * 召回 906/906（`docs/排查/2026-10-07-统计判据在流上的误报面.md` §四）。
 */
export const STREAM_CUT_MODE: StreamCutMode = 'observe'

/**
 * 同一个 turn 里允许的续跑次数上限缺省值。
 *
 * **它补的是一个实测暴露的缺口**（设计文档 §九.7）：dev 实测里同一个 turn 连掐四次，靠
 * **模型自己在第五步让步**收敛——那是模型的行为，不是机制的保证。`silentTurn` 有
 * `MAX_PER_TURN` 节流（`throttle.ts`），掐断原本没有。
 *
 * **为什么是 3**：四次才收敛属于边界情形，而模型在第二、三次干预时就已在思考里明说
 * 「被截断」「我必须立刻产出正文」。若三次打断都没让它回到正轨，问题通常不在「被打断」，
 * 而在那个会话的上下文本身已经病态——继续续跑只是拿 token 换一个不会到来的收敛。
 *
 * 超限之后**掐断照旧发生**（它本身已经省下 token，是收益），停的只是续跑这个动作。
 */
export const STREAM_CUT_MAX_RESUMES = 3

/** 续跑文案里最多列举几个高频单元。 */
const TOP_UNITS = 5

/** 判定、留痕与掐断的可调面。 */
export interface StreamCutOptions {
  /** 生效档位；`off` 不会走到这里（调用方不注册监听）。 */
  readonly mode: Exclude<StreamCutMode, 'off'>
  /** 重复率阈值，与 `repetitionThreshold` 同源。 */
  readonly threshold: number
  /** 真正掐断时的回调；`observe` 档不会触发它。 */
  readonly onCut?: (sessionId: string, record: CutRecord) => void
  /** 诊断输出的落点；缺省 `console.debug`。 */
  readonly log?: (line: string) => void
}

/**
 * 包一层上游流：逐增量判、命中则补块收尾。
 *
 * 是 async generator，所以「取出下一格」与「放行这一格」在时间上分开——命中后探的那一格
 * 如果不是 `reasoning-delta`，它必须**照常放行**（正文或工具调用丢一格就是坏数据），
 * 于是它先被存进 `carried`，下一轮循环再 yield 出去。
 * @param upstream - `next()` 给出的上游流。
 * @param sessionId - 本次生成所属的会话，只用于诊断与记账。
 * @param options - 档位、阈值、回调。
 * @returns 包好之后的流；掐断时它在补块之后结束。
 */
export async function* guardStream(
  upstream: AsyncIterable<StreamChunk>,
  sessionId: string,
  options: StreamCutOptions,
): AsyncGenerator<StreamChunk> {
  const log = options.log ?? ((line: string): void => { console.debug(line) })
  const detector = createStreamDetector(options.threshold)
  const iterator = upstream[Symbol.asyncIterator]()
  /** 当前思考块的 index；换块时清空累积——一个流里可以有多个块。 */
  let blockIndex = -1
  /** 当前思考块已放行的全部文本。掐断时它成为补块的 `block.text`。 */
  let blockText = ''
  /** 已放行的思考字符数与增量个数——诊断行里的「命中于多少字」。 */
  let chars = 0
  let chunks = 0
  /** 判定只报一次：命中之后不再重复判，`observe` 档下也只留一行痕。 */
  let hit = false
  /** 从上游多取出来、还没放行的那一格。 */
  let carried: StreamChunk | undefined

  try {
    for (;;) {
      let chunk: StreamChunk
      if (carried === undefined) {
        const step = await iterator.next()
        if (step.done === true) return
        chunk = step.value
      } else {
        chunk = carried
        carried = undefined
      }

      if (chunk.type !== 'reasoning-delta') {
        yield chunk
        continue
      }

      if (chunk.index !== blockIndex) {
        blockIndex = chunk.index
        blockText = ''
      }
      blockText += chunk.text
      chars += chunk.text.length
      chunks += 1
      const fired = !hit && detector.push(chunk.text)
      yield chunk
      if (!fired) continue

      hit = true
      const where = `session=${sessionId} · 命中于 ${chars} 字（第 ${chunks} 个增量）`
      const probe = await iterator.next()
      if (probe.done === true) {
        log(`[${name}] 流内命中后放行 · ${where} · 上游已结束，按正常收尾处理`)
        return
      }
      if (probe.value.type !== 'reasoning-delta') {
        log(`[${name}] 流内命中后放行 · ${where} · 后面是 ${probe.value.type}，按正常收尾处理 · ${detector.describe()}`)
        carried = probe.value
        continue
      }

      // 思考在继续 —— 复读成立。这一步到此为止。
      if (options.mode === 'observe') {
        log(`[${name}] 流内命中（observe，不掐断）· ${where} · ${detector.describe()}`)
        // 探到的这一格照常放行：`observe` 只判定与留痕，不改变任何内容。
        carried = probe.value
        continue
      }
      const record: CutRecord = {
        chars,
        chunks,
        reading: detector.reading(),
        top: detector.frequent(TOP_UNITS),
      }
      log(`[${name}] 流内掐断 · ${where} · ${detector.describe()}`)
      // 记账失败不该升级成回合失败：掐断已经发生，最坏的后果是续跑没发出去——
      // 那比「这一步以 error 结束」轻得多（与 `index.ts` 两处钩子的兜底同源）。
      try {
        options.onCut?.(sessionId, record)
      } catch (error: unknown) {
        log(`[${name}] 流内掐断的记账失败（不影响这次收尾）· ${error instanceof Error ? error.message : String(error)}`)
      }
      yield { type: 'block-end', index: chunk.index, block: { type: 'reasoning', text: blockText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
  } finally {
    // 提前收尾时若不下传，上游 HTTP 流会跑完、供应商照常计满 token（repeat-guard 的源码
    // 注释记录了这条）。包 catch 是因为收尾路径上的异常不该升级成回合失败——与
    // `index.ts` 里 pre-step / turn-stopping 各自的兜底同源。
    try {
      await iterator.return?.()
    } catch {
      // 上游已经终止或已断开；这一步的产出在此刻已经交付。
    }
  }
}

/**
 * 注册 `llm/stream` 监听。
 *
 * **只对主对话调用生效**：辅助调用（`options.purpose !== undefined`，会话标题与上下文压缩）
 * 不参与检测——它们不是对话输出，掐断它们只会弄坏标题或压缩结果。**没有会话归属的调用**
 * （手搓的一次性请求）同样跳过：没有会话就没有「本 turn 被本插件掐断过」这件事可言，
 * 掐了也只是白掐。
 *
 * `{ global: true }` 是必需的：`llm/stream` 由 `LlmRuntime` 在 root scope 上派发，而本插件
 * 的 `ctx` 是它自己的 scope。
 * @param ctx - 插件上下文。
 * @param options - 档位、阈值、回调。
 */
export function installStreamCut(ctx: Context, options: StreamCutOptions): void {
  ctx.on('llm/stream', (request, next) => {
    const upstream = next()
    if (request.purpose !== undefined) return upstream
    const sessionId = request.sessionId
    if (sessionId === undefined) return upstream
    return guardStream(upstream, String(sessionId), options)
  }, { global: true })
}
