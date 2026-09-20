/**
 * 锚定文本的组装。
 *
 * 单独成文件而不是留在入口里：入口 `index.ts` 要导入 `@deepseek-ai/dsh-llm` 的
 * `createUserMessage`（运行时依赖，由宿主 profile 提供），而测试环境只装了 npm 上的
 * 部分 DSH 包——放在同一个文件里会让纯文本逻辑的测试连带去解析 DSH 运行时。
 * @module @max-null/dsh-allostasis/anchor
 */

import type { DriftMetrics } from './drift.ts'

/**
 * 组装锚定文本。
 *
 * 刻意点明「引用英文标识符是正常的」：判据只看英文语法结构，若不说明，模型可能为了
 * 规避提醒而不敢写代码符号，那会伤到正常工作。
 * @param turn - 产出该思考的 turn。
 * @param step - 产出该思考的 step。
 * @param metrics - 那一步思考的量化结果。
 * @returns 一条锚定消息的正文。
 */
export function anchorText(turn: number, step: number, metrics: DriftMetrics): string {
  return `⚠️ 语言漂移提醒（应变）：你上一步（turn ${turn} step ${step}）的思考是英文的`
    + `（英文功能词密度 ${metrics.funcDensity.toFixed(2)}，共 ${metrics.words} 个英文词）。`
    + '现在回到中文思考。注意：读代码时引用英文标识符是正常的，'
    + '这里判定的是整句英文——出现英文语法结构才算漂移。'
}
