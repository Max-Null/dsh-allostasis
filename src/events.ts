/**
 * 本插件的会话事件——「插件当时判了什么」的落盘。
 *
 * 判定输入本来就可重放（推理原文在日志的 `reasoning-chunks.texts`，占用与压缩点在
 * `data.usage` / `compaction/start`），所以「如果当时阈值是 X 会怎样」能离线回答。
 * 缺的是**插件实际用过的阈值与判定结果**：只靠重算，复盘的是「按现在的脚本判会怎样」，
 * 不是「插件当时判了什么」，两个口径会随时间漂移。事件补的就是这道缝
 * （设计方案 §4.3 选项 A）。
 *
 * `SessionEventMap` 是 merge-extensible 的，内核的会话 invariant 对未知事件类型直接
 * 放行——「Merge-extensible event relations belong to their owning plugin」
 * （`packages/core/session/src/invariant.ts:165-167`），因此这里不需要在内核侧登记。
 *
 * @module @max-null/dsh-allostasis/events
 */

import type { RepetitionMetrics } from './repetition.ts'
import type { TailShape } from './tail.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 一次退化触发；只记录判定，不记录干预——压缩动作是否发生由压缩事件自己回答。 */
    'allostasis/degeneration': DegenerationEvent
    /** 一次空回合判定；只记录判定，补生成是否发生由 `steered` 自答。 */
    'allostasis/silent-turn': SilentTurnEvent
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

/** {@link silentTurnEvent} 的输入。 */
export interface SilentTurnTrigger {
  /** 判定的回合号。 */
  readonly turn: number
  /** 该回合末条助手消息的产出形态。 */
  readonly shape: TailShape
  /** 本次是否已经 steer 了一次补生成。 */
  readonly steered: boolean
}

/** `allostasis/silent-turn` 的 payload：一次空回合的判定依据。 */
export interface SilentTurnEvent {
  /** 判定的回合号。 */
  turn: number
  /** 末条助手消息的 step。 */
  step: number
  /** 末条消息的非空文本字符数；空回合恒为 0。 */
  textChars: number
  /** 末条消息的推理字符数——区分「想了很久没说」与「完全没输出」。 */
  reasoningChars: number
  /** 末条消息按类型的块计数。 */
  blocks: { reasoning: number; text: number; toolCalls: number }
  /** 本次是否触发了补生成（`steer` 档位且节流放行）；`observe` 档位下恒 `false`。 */
  steered: boolean
}

/**
 * 把一次空回合判定整理成事件 payload。
 * @param trigger - 判定依据。
 * @returns 可直接交给 `session.append` 的 payload。
 */
export function silentTurnEvent(trigger: SilentTurnTrigger): SilentTurnEvent {
  const { shape } = trigger
  return {
    turn: trigger.turn,
    step: shape.step,
    textChars: shape.textChars,
    reasoningChars: shape.reasoningChars,
    blocks: { ...shape.blocks },
    steered: trigger.steered,
  }
}
