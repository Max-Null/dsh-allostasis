/**
 * 本插件产生的消息：source 登记与正文组装。
 *
 * 单独成文件与 `anchor.ts` 同因——入口要导入 `@deepseek-ai/dsh-llm` 的运行时值，
 * 而测试环境只装了 npm 上的部分 DSH 包。
 *
 * **source 用 `notice` 而不是 `snapshot`**：`snapshot` 的语义是「同一生产者的后一份
 * 取代前一份」，而每次提醒都是独立的即时信号，谁也不取代谁——那是 `notice` 的定义
 * （`llm/llm/src/message.ts:60-67`）。两者的差别不只是措辞：轨迹视图按 form 决定
 * 呈现方式，snapshot 会被当作可折叠的上下文块，notice 是一行「刚发生了什么」。
 *
 * **kind 走声明合并而不是类型断言**：`MessageSourceMap` 是可合并扩展的，官方明确
 * 「each producer declares its own `kind` in its own module; there is no shared
 * catch-all `plugin` kind」（同文件 L303-307），官方插件如 `repeat-tool-reminder`
 * 正是这么登记的。`plugin:<名>` 是 v4 会话格式对第三方生产者的规范形式
 * （`session-format-v3-to-v4/src/sources.ts:64` 的 `return \`plugin:${plugin}\``）。
 * @module @max-null/dsh-allostasis/messages
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { SOURCE_KIND } from './name.ts'
import type { RepetitionMetrics } from './repetition.ts'
import type { TailShape } from './tail.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 应变注入的即时提醒：语言漂移锚定与推理退化提醒共用这一个生产者身份。 */
    'plugin:dsh-allostasis': { kind: typeof SOURCE_KIND } & ContextFormed
  }
}

/** 提醒文本里每个重复单元的截断长度；比落盘的 `UNIT_SAMPLE_MAX_CHARS` 更短，因为它要读起来顺。 */
const TOP_UNIT_MAX_CHARS = 40

/** 提醒文本里最多列举几个高频单元。 */
const TOP_UNITS_SHOWN = 3

/**
 * 把一段提醒正文包成一条 `notice` 形式的消息。
 * @param text - 模型读到的正文。
 * @param summary - 客户端一行叙述；超长会被 `boundContextSummary` 截断。
 * @returns 可追加到 pre-step 决策上的用户消息。
 */
export function pluginNotice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(summary),
    },
  })
}

/**
 * 组装推理退化提醒。
 *
 * 刻意点明「重复不等于想得更细」：退化期的输出读起来像在认真铺陈，若不说明，模型可能
 * 把重复当成详尽而继续加码。给的两条出路是具体的——给结论，或换一个与前面不同的动作，
 * 而不是「请继续努力」这类没有落点的督促。
 * @param turn - 产出该思考的 turn。
 * @param step - 产出该思考的 step。
 * @param metrics - 那一步思考的重复度量化结果。
 * @param reminder - 这是本会话第几次退化提醒；默认 1。
 * @returns 一条退化提醒消息的正文。
 */
export function degenerationText(
  turn: number,
  step: number,
  metrics: RepetitionMetrics,
  reminder = 1,
): string {
  const head = reminder > 1
    ? `⚠️ 推理退化提醒（应变，第 ${reminder} 次）：你仍然在重复自己——上一步`
    : '⚠️ 推理退化提醒（应变）：你上一步'
  const where = `（turn ${turn} step ${step}）的思考在重复自己——重复率 `
    + `${(metrics.ratio * 100).toFixed(0)}%（${metrics.units} 个片段里有 `
    + `${metrics.repeated} 个出现 3 次以上）`
  const top = metrics.top.slice(0, TOP_UNITS_SHOWN)
    .map(entry => `「${entry.unit.length <= TOP_UNIT_MAX_CHARS ? entry.unit : `${entry.unit.slice(0, TOP_UNIT_MAX_CHARS)}…`}」×${entry.count}`)
    .join('、')
  // `top` 只收出现 ≥ `REPEAT_MIN_COUNT` 次的片段，所以它为空**等价于**重复率为 0。
  // `repetitionThreshold: 0` 是合法配置（阈值校验允许 0，等于「任何一步都提醒」），
  // 那条路径下必须省略这一句，否则会拼出「最高频的是 。」这种残句。
  const highlight = top === '' ? '' : `，最高频的是 ${top}`
  return `${head}${where}${highlight}。`
    + '重复不等于想得更细，它是原地打转：这些片段没有带来新信息。'
    + '现在检查手上已有的信息够不够完成任务——够就直接给结论，'
    + '不够就换一个与前面不同的动作去取，而不是把同一句话再写一遍。'
}

/**
 * 组装空回合的补生成请求。
 *
 * 措辞对着**用户此刻的处境**写：他看到的是空白，所以先说清发生了什么，再给一条可执行的
 * 出路。两条禁令是必要的——不点明「不要重做工具」，模型很可能把整轮动作再跑一遍，而这一轮
 * 的产出已经不是用户缺的东西了。
 * @param turn - 判定的回合号。
 * @param shape - 该回合末条助手消息的产出形态。
 * @returns 一条补生成请求的正文。
 */
export function silentTurnText(turn: number, shape: TailShape): string {
  const produced = shape.reasoningChars > 0
    ? `只生成了推理（${shape.reasoningChars} 字），没有文本`
    : '没有产出任何内容'
  const tools = shape.blocks.toolCalls > 0
    ? `，另有 ${shape.blocks.toolCalls} 个工具调用`
    : '，也没有工具调用'
  return `⚠️ 空回合（应变）：turn ${turn} 的最后一步${produced}${tools}。`
    + '用户此刻看到的是一串折叠的操作条，然后什么都没有——他不知道这一轮发生了什么。'
    + '用一两句话补上：这一轮得出的结论、以及下一步需要他做什么。'
    + '不要重做已经执行过的工具调用，也不要复述推理里的过程。'
}
