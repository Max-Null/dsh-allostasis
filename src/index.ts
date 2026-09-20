/**
 * 应变（allostasis）：会话状态的自我调节。
 *
 * 第一期只实现一个能力——**中文锚定**：每个 step 之前读最近一条思考，若判定为语言
 * 漂移（英文功能词密度越线），就在请求末尾追加一条中文锚定消息。**平时不出现、漂移
 * 时才出现**——稀缺是它作为信号的前提。
 *
 * 为什么不挂到 system prompt 前缀上：那是 `dsh-chinese-thinking` 的位置，它作为基线
 * 永远在场。而基线在长会话里会失效（固定前缀离输出最远，语言模式受近因支配）。本插件
 * 补的是「**你正在漂移**」这个纠偏信号，因此必须落在近因位置。
 *
 * 为什么用 `agent/pre-step` 而不是 `systemPrompt.context()`：前者直接给出 `turn` /
 * `step`，且追加的是一条独立消息，落点比快照里的一个段更靠后。用法先例见官方
 * `packages/context/time-context/src/index.ts:180-220`。
 *
 * 设计出处：`docs/设计/2026-09-20-应变-设计方案.md`
 * @module @max-null/dsh-allostasis
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { anchorText } from './anchor.ts'
import { measureThinking, verdict } from './drift.ts'
import { latestThinking } from './thinking.ts'

/** Cordis 插件名，同时用作注入消息的 `source.plugin` 与 section 名。 */
export const name = 'dsh-allostasis'

/** 需要 `agents` 服务来接收 `agent/pre-step` 事件。 */
export const inject = ['agents']

export { anchorText }

/**
 * 注册 pre-step 监听器；监听器随 `ctx` 生命周期销毁。
 *
 * 用 `{ prepend: true }` 以取得 `next()` 的决策后再追加，与官方 `time-context` 一致。
 * @param ctx - 插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const sample = latestThinking(agent.session)
    if (sample === undefined) return decision
    const metrics = measureThinking(sample.text)
    if (verdict(metrics) !== 'drift') return decision
    const text = anchorText(sample.turn, sample.step, metrics)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
