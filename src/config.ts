/**
 * 插件的可配置面。
 *
 * 只暴露**判定阈值与档位**这一类值：它们是「宁可晚一点也别误报」这条取舍的刻度，随任务
 * 类型与模型行为漂移，属于部署间会变的选择（DSH 插件规范 "No hardcoded tunables in
 * plugins"）。判据里的小样本门槛（`MIN_WORDS` / `MIN_UNITS` / `REPEAT_MIN_COUNT`）
 * 不在此列——它们不是偏好，改了就是把密度与比例算飞，属于判据几何的一部分。
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
import { CONSECUTIVE_STEPS, REPETITION_THRESHOLD } from './repetition.ts'
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
  /** 连续多少步越线才触发退化提醒（默认 2）。取 1 会跟着正常期的单次抖动误报。 */
  consecutiveSteps?: number
  /**
   * 空回合兜底的档位（默认 `observe`）。
   *
   * `off` 连判定都不做；`observe` 判定并落 `allostasis/silent-turn` 事件；`steer` 在
   * 判定之外追加一次补生成请求。补生成受两条边界约束：同一回合至多一次（`throttle.ts`），
   * 取消的回合与子代理会话不触发（见 `index.ts` 的 `installSilentTurn`）。
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
  /** 见 {@link Config.consecutiveSteps}。 */
  readonly consecutiveSteps: number
  /** 见 {@link Config.silentTurn}。 */
  readonly silentTurn: SilentTurnMode
}

/** Loader 用于校验 `cordis.patch.yml` 里 `config` 段的 schema。 */
export const Config: Schema<Config> = Schema.object({
  driftThreshold: Schema.number(),
  repetitionThreshold: Schema.number(),
  consecutiveSteps: Schema.number(),
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
 * @param config - Loader 传入的配置；未配置时传 `undefined` 或 `{}`。
 * @returns 字段齐全且已校验的配置。
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const driftThreshold = ratio('driftThreshold', config.driftThreshold ?? DRIFT_THRESHOLD)
  const repetitionThreshold = ratio('repetitionThreshold', config.repetitionThreshold ?? REPETITION_THRESHOLD)
  const consecutiveSteps = config.consecutiveSteps ?? CONSECUTIVE_STEPS
  if (!Number.isInteger(consecutiveSteps) || consecutiveSteps < 1) {
    throw new Error(`dsh-allostasis: \`consecutiveSteps\` must be an integer >= 1, got ${consecutiveSteps}`)
  }
  const silentTurn = oneOf('silentTurn', config.silentTurn ?? SILENT_TURN_MODE, SILENT_TURN_MODES)
  return { driftThreshold, repetitionThreshold, consecutiveSteps, silentTurn }
}
