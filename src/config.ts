/**
 * 插件的可配置面。
 *
 * 只暴露**判定阈值与档位**这一类值：它们是「宁可晚一点也别误报」这条取舍的刻度，随任务
 * 类型与模型行为漂移，属于部署间会变的选择（DSH 插件规范 "No hardcoded tunables in
 * plugins"）。判据里的小样本门槛（`MIN_WORDS` / `MIN_UNITS` / `REPEAT_MIN_COUNT`）与
 * 实义单元规则不在此列——它们不是偏好，改了就是把密度与比例算飞，属于判据几何的一部分。
 *
 * **schema 只管形式，缺省与范围在 `resolveConfig`**：两处各管一半是有意的。schema 用
 * `.default()` 会让输出类型变成 `number | Volatile<number>`（默认值允许是动态函数），
 * 与接口对不上，内核自己也要在那里补 `as Schema<T>` 断言；而缺省值有两个来源之后，
 * 「我明明改了配置」与「插件按默认值跑」就能同时成立而无从察觉。缺省值就是判据模块里的
 * 常量本身，因此不配置时行为与配置前逐字一致。
 *
 * @module @max-null/dsh-allostasis/config
 */

import Schema from '@deepseek-ai/schemastery'
import { DRIFT_THRESHOLD } from './drift.ts'
import { LOOP_WINDOW_HITS, LOOP_WINDOW_STEPS, REPETITION_THRESHOLD } from './repetition.ts'
import { SILENT_TURN_MODE, SILENT_TURN_MODES, type SilentTurnMode } from './tail.ts'

/**
 * 插件配置，与同名 schemastery schema 一起由 Loader 校验。
 *
 * 值域外的取值在 `resolveConfig` 里**报错中止**，不静默回退。
 */
export interface Config {
  /** 英文功能词密度达到此值即判为漂移（默认 0.15）。实测中文期中位 0.012、英文期 0.273 以上。 */
  driftThreshold?: number
  /** 重复率阈值，0–1（默认 0.5）。取 1 等于事实上关闭退化提醒。 */
  repetitionThreshold?: number
  /** 观察窗口的大小，以步为单位（默认 5）。窗口内累计越线达标即触发。 */
  loopWindowSteps?: number
  /**
   * 窗口内需要累计的越线步数（默认 2）。
   *
   * 取 3 会漏掉「少而猛」型退化——单条推理重复率很高但只发生两次的那种（实测样本
   * `8fa3b15e`，峰值 76%、只有 2 次语义越线）。取 1 会跟着正常期的单次抖动误报。
   */
  loopWindowHits?: number
  /**
   * 空回合兜底的档位（默认 `observe`）。
   *
   * `off` 宿主不判定也不干预；`observe` 判定并打一行诊断；`steer` 在判定之外追加一次
   * 补生成请求。补生成受两条边界约束：同一回合至多一次（`throttle.ts`），取消的回合与
   * 子代理会话不触发（见 `index.ts` 的 `installSilentTurn`）。
   *
   * **档位管不到对话页那行提示**：提示由浏览器半边折叠会话事件流得出，与宿主判据同源
   * 但独立于档位——浏览器半边的 `apply` 拿不到插件配置（2026-10-01 实测）。要完全静默
   * 就禁用插件。
   *
   * **默认取 `observe` 而不是 `steer`**：补生成能不能改变采样轨迹尚未验证
   * （设计文档 §六.1），先让它只观测、由使用者显式打开。
   */
  silentTurn?: SilentTurnMode
}

/** {@link Config} 经校验后的形态：字段齐全，可直接参与判定。 */
export interface ResolvedConfig {
  /** 见 {@link Config.driftThreshold}。 */
  readonly driftThreshold: number
  /** 见 {@link Config.repetitionThreshold}。 */
  readonly repetitionThreshold: number
  /** 见 {@link Config.loopWindowSteps}。 */
  readonly loopWindowSteps: number
  /** 见 {@link Config.loopWindowHits}。 */
  readonly loopWindowHits: number
  /** 见 {@link Config.silentTurn}。 */
  readonly silentTurn: SilentTurnMode
}

/** Loader 用于校验 `cordis.patch.yml` 里 `config` 段的 schema。 */
export const Config: Schema<Config> = Schema.object({
  driftThreshold: Schema.number(),
  repetitionThreshold: Schema.number(),
  loopWindowSteps: Schema.number(),
  loopWindowHits: Schema.number(),
  silentTurn: Schema.union(SILENT_TURN_MODES),
})

/**
 * 校验一个 0–1 的阈值字段。
 * @param field - 字段名，用于报错文案。
 * @param value - 字段值。
 * @returns 校验通过的原值。
 */
function ratio(field: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`dsh-allostasis: \`${field}\` must be a number between 0 and 1, got ${value}`)
  }
  return value
}

/**
 * 校验一个正整数步数字段。
 * @param field - 字段名，用于报错文案。
 * @param value - 字段值。
 * @returns 校验通过的原值。
 */
function steps(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-allostasis: \`${field}\` must be an integer >= 1, got ${value}`)
  }
  return value
}

/**
 * 校验一个枚举字段。
 * @param field - 字段名，用于报错文案。
 * @param value - 字段值。
 * @param allowed - 允许的取值。
 * @returns 校验通过的原值。
 */
function oneOf<T extends string>(field: string, value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) {
    throw new Error(`dsh-allostasis: \`${field}\` must be one of ${allowed.join(' | ')}, got ${String(value)}`)
  }
  return value
}

/**
 * 校验配置并补齐缺省值。
 *
 * 范围约束不交给 schema 的 `.min()/.max()`：那样报错只会说「number」，而说出该字段的
 * 合理区间与收到的实际值，正是 fail-loud 的全部价值。
 *
 * `loopWindowHits` 超过 `loopWindowSteps` 时报错而不是静默夹取：那是一个**永不成立**的
 * 触发条件（窗口装不下所需命中数），静默接受等于关掉退化提醒而不说。
 * @param config - Loader 传入的配置；未配置时传 `undefined` 或 `{}`。
 * @returns 字段齐全且已校验的配置。
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const driftThreshold = ratio('driftThreshold', config.driftThreshold ?? DRIFT_THRESHOLD)
  const repetitionThreshold = ratio('repetitionThreshold', config.repetitionThreshold ?? REPETITION_THRESHOLD)
  const loopWindowSteps = steps('loopWindowSteps', config.loopWindowSteps ?? LOOP_WINDOW_STEPS)
  const loopWindowHits = steps('loopWindowHits', config.loopWindowHits ?? LOOP_WINDOW_HITS)
  if (loopWindowHits > loopWindowSteps) {
    throw new Error(
      `dsh-allostasis: \`loopWindowHits\` (${loopWindowHits}) cannot exceed`
      + ` \`loopWindowSteps\` (${loopWindowSteps}) — that trigger can never fire`,
    )
  }
  const silentTurn = oneOf('silentTurn', config.silentTurn ?? SILENT_TURN_MODE, SILENT_TURN_MODES)
  return { driftThreshold, repetitionThreshold, loopWindowSteps, loopWindowHits, silentTurn }
}
