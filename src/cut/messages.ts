/**
 * 掐断后的续跑文案。
 *
 * 掐断只是让这一步提前结束，机器还得继续走——否则 turn 就以「模型没说话」收尾
 * （设计文档 §3.3）。续跑请求由 `agent/turn-stopping` 里的 `agent.steer` 送进去，
 * 正文在这里组装。
 *
 * **文案要说清三件事**，缺哪件都会让模型做出错误反应：
 *
 * 1. **它刚才那段思考是被截断的**，不是自己想完了——否则模型会接着那个被切断的句子继续写，
 *    而截断点正好在复读中间。
 * 2. **不必解释这次截断**——不点明的话，模型很可能先花一段话讨论「为什么输出中断了」。
 * 3. **现在做什么**——给结论，或换一个与前面不同的动作去取信息。这是退化提醒一贯的落点
 *    （见 `src/messages.ts` 的 `degenerationText`）：重复不带来新信息，出路只有换动作。
 *
 * 使用者可以用 `streamCutResumeText` 配置项整段覆盖正文；覆盖之后读数不再出现在文案里
 * （配置项是纯文本，没有占位符），诊断行里仍然有。
 * @module @max-null/dsh-allostasis/cut/messages
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'
import { pluginNotice } from '../messages.ts'
import type { CutRecord } from './state.ts'

/** 提醒文本里列举高频单元时的截断长度；与 `src/messages.ts` 的取值同源。 */
const TOP_UNIT_MAX_CHARS = 40

/** 提醒文本里最多列举几个高频单元。 */
const TOP_UNITS_SHOWN = 3

/**
 * 组装续跑请求的正文。
 * @param turn - 发生掐断的回合。
 * @param record - 掐断时的现场读数。
 * @param configured - 配置项 `streamCutResumeText`；给了就整段用它。
 * @returns 模型读到的正文。
 */
export function streamCutResumeText(turn: number, record: CutRecord, configured?: string): string {
  if (configured !== undefined) return configured
  const { reading } = record
  const highlight = record.top.length === 0
    ? ''
    : `，最高频的是 ${record.top.slice(0, TOP_UNITS_SHOWN).map(entry =>
      `「${entry.unit.length <= TOP_UNIT_MAX_CHARS ? entry.unit : `${entry.unit.slice(0, TOP_UNIT_MAX_CHARS)}…`}」×${entry.count}`,
    ).join('、')}`
  return `⚠️ 推理退化（应变）：turn ${turn} 这一轮的思考在重复自己——重复率 `
    + `${(reading.ratio * 100).toFixed(0)}%（${reading.units} 个片段里有 ${reading.repeated} 个出现 3 次以上）`
    + `${highlight}，已经在生成中途被截断：`
    + '那一步只剩推理、没有结论，用户此刻看到的是空白。'
    + '不要接着写那句话，也不要解释这次截断。现在直接继续：'
    + '手上的信息够就给出结论，不够就换一个与前面不同的动作去取。'
}

/**
 * 续跑配额用完时注入的收尾请求：让模型把工作整理成交接材料。
 *
 * 配额用完说明「再续跑一次也不会收敛」，此前什么都不注入、那一步就此停住——用户拿到的
 * 是一片空白。改成要求写交接材料有两个好处：它是**结构化产出**（空转期的模型写「已完成 /
 * 未完成 / 下一步」比「想下一步做什么」容易），而且**给使用者留了换会话的接续点**。
 *
 * 刻意要求「写完就停」：这一步之后不再执行新操作，否则等于换一种方式继续空转。
 * @param turn - 发生掐断的回合。
 * @param record - 掐断时的现场读数。
 * @param cap - 配额说明，由调用方按「上限为 0」与「运行时耗尽」区分。
 * @param configured - 配置项 `streamCutHandoverText`；给了就整段用它。
 * @returns 模型读到的正文。
 */
export function streamCutHandoverText(
  turn: number,
  record: CutRecord | undefined,
  cap: string,
  configured?: string,
): UserMessage {
  if (configured !== undefined) return pluginNotice(configured, `流内掐断 · turn ${turn} · 改为要求交接材料`)
  const ratio = record === undefined ? '' : `（重复率 ${(record.reading.ratio * 100).toFixed(0)}%）`
  const text = `⚠️ 应变：turn ${turn} 这一轮已经因为推理退化被截断多次${ratio}——${cap}。`
    + '继续用原来的方式思考不会收敛，所以这一步不再续跑。\n\n'
    + '现在请把手头的工作整理成一份**交接材料**，分四段写清楚：\n\n'
    + '1. **已经完成**：改了哪些文件、执行了哪些命令、结果如何。\n'
    + '2. **未完成**：还剩什么没做，卡在哪里。\n'
    + '3. **下一步**：如果换一个人接手，他应该先做哪一件事——只写一条，要具体。\n'
    + '4. **关键上下文**：接手时必须知道的信息（路径、命令、已定的决策、踩过的坑）。\n\n'
    + '写完这一段就结束，**不要再执行新的操作**。'
  return pluginNotice(text, `流内掐断 · turn ${turn} · 续跑配额用尽 · 改为要求交接材料`)
}

/**
 * 组装轨迹页那一行叙述。
 *
 * 与正文分开：正文给模型读，摘要给人读（`pluginNotice` 的 `summary`），两者的取舍不同——
 * 摘要要短，且要能一眼看出「这一步不是模型自己结束的」。
 * @param turn - 发生掐断的回合。
 * @param record - 掐断时的现场读数。
 * @returns 一行叙述。
 */
export function streamCutSummary(turn: number, record: CutRecord): string {
  return `流内掐断 · turn ${turn} · 重复率 ${(record.reading.ratio * 100).toFixed(0)}%`
    + ` · 第 ${record.chunks} 个增量 / ${record.chars} 字 · 续跑一步`
}

/**
 * 把续跑请求包成一条可 `steer` 的消息（构造，不发送）。
 *
 * 复用 `src/messages.ts` 的 `pluginNotice`：source 的 kind / form / summary 三处口径
 * 各只有一份，另起一个会漂移。
 * @param turn - 发生掐断的回合。
 * @param record - 掐断时的现场读数。
 * @param configured - 配置项 `streamCutResumeText`；给了就整段用它。
 * @returns 可追加到回合收尾流程上的用户消息。
 */
export function streamCutNotice(turn: number, record: CutRecord, configured?: string): UserMessage {
  return pluginNotice(streamCutResumeText(turn, record, configured), streamCutSummary(turn, record))
}
