/**
 * 退化触发的会话事件——「插件当时判了什么」的落盘。
 *
 * 判定输入本来就可重放（推理原文在日志的 `reasoning-chunks.texts`，占用与压缩点在
 * `data.usage` / `compaction/start`），所以「如果当时阈值是 X 会怎样」能离线回答。
 * 缺的是**插件实际用过的阈值与判定结果**：只靠重算，复盘的是「按现在的脚本判会怎样」，
 * 不是「插件当时判了什么」，两个口径会随时间漂移。这个事件补的就是这道缝
 * （设计方案 §4.3 选项 A）。
 *
 * `SessionEventMap` 是 merge-extensible 的，内核的会话 invariant 对未知事件类型直接
 * 放行——「Merge-extensible event relations belong to their owning plugin」
 * （`packages/core/session/src/invariant.ts:165-167`），因此这里不需要在内核侧登记。
 *
 * @module @max-null/dsh-allostasis/events
 */

import type { RepetitionMetrics } from './repetition.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 一次退化触发；只记录判定，不记录干预——压缩动作是否发生由压缩事件自己回答。 */
    'allostasis/degeneration': DegenerationEvent
  }
}

/** 落盘时每个重复单元的截断长度；够复盘看出重复的是什么，又不让日志被碎片撑大。 */
export const UNIT_SAMPLE_MAX_CHARS = 80

/** {@link degenerationEvent} 的输入。 */
export interface DegenerationTrigger {
  /** 产出该推理的 turn。 */
  readonly turn: number
  /** 产出该推理的 step。 */
  readonly step: number
  /** 该步的重复度量化结果。 */
  readonly metrics: RepetitionMetrics
  /** 已连续越线的步数。 */
  readonly consecutive: number
  /** 判定所用的重复率阈值。 */
  readonly threshold: number
  /** 触发所需的连续步数。 */
  readonly required: number
}

/** `allostasis/degeneration` 的 payload：一次触发的完整判定依据。 */
export interface DegenerationEvent {
  /** 产出该推理的 turn。 */
  turn: number
  /** 产出该推理的 step。 */
  step: number
  /** 触发时的重复率。 */
  ratio: number
  /** 单元总数，即重复率的样本量。 */
  units: number
  /** 已连续越线的步数。 */
  consecutive: number
  /** 判定所用的重复率阈值。 */
  threshold: number
  /** 触发所需的连续步数。 */
  required: number
  /** 最高频的重复单元，按出现次数降序，单元已截断。 */
  top: Array<{ unit: string; count: number }>
}

/**
 * 把一次触发整理成事件 payload。
 * @param trigger - 触发时的判定依据。
 * @returns 可直接交给 `session.append` 的 payload。
 */
export function degenerationEvent(trigger: DegenerationTrigger): DegenerationEvent {
  const { metrics } = trigger
  return {
    turn: trigger.turn,
    step: trigger.step,
    ratio: metrics.ratio,
    units: metrics.units,
    consecutive: trigger.consecutive,
    threshold: trigger.threshold,
    required: trigger.required,
    top: metrics.top.map(entry => ({
      unit: entry.unit.length <= UNIT_SAMPLE_MAX_CHARS
        ? entry.unit
        : `${entry.unit.slice(0, UNIT_SAMPLE_MAX_CHARS)}…`,
      count: entry.count,
    })),
  }
}
