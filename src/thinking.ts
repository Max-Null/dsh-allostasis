/**
 * 从会话事件里取最近一条思考文本。
 *
 * 落点：`assistant/message` 事件的 `stream` 数组里 `type: 'reasoning-chunks'` 的
 * `texts`（`packages/llm/llm/src/assistant-stream.ts:28-34`，文件头注明是
 * `Lossless compact representation`）。每个 step 一条事件，带 `turn` / `step`。
 *
 * 取「最近一条含思考的事件」而不是「恰好上一步」：有些 step 没有思考文本（极短的
 * 工具步），沿事件倒扫直到命中可以跨过它们。
 *
 * 用 `snapshotEvents()` 而非 `eventAt(SessionSeq(n))` 遍历：后者需要 `SessionSeq`，
 * 而它并未从 `@deepseek-ai/dsh-session` 的包入口导出（`lib/types/index.d.ts:11` 只有
 * import，不是 re-export）。前者的用法在 `agent-loop/src/runtime-context.ts` 有先例。
 * @module @max-null/dsh-allostasis/thinking
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** 一条思考文本及其来源位置。 */
export interface ThinkingSample {
  /** 产出它的 turn。 */
  turn: number
  /** 产出它的 step。 */
  step: number
  /** 拼接后的思考全文。 */
  text: string
}

/** 取会话里最近一条非空思考；一条都没有时返回 `undefined`。 */
export function latestThinking(session: Session): ThinkingSample | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const parts: string[] = []
    for (const record of event.data.stream) {
      if (record.type === 'reasoning-chunks') parts.push(...record.texts)
    }
    const text = parts.join('')
    if (text.length === 0) continue
    return { turn: event.data.turn, step: event.data.step, text }
  }
  return undefined
}
