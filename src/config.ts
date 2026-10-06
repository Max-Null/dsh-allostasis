/**
 * 插件的可配置面。
 *
 * 只暴露**判定阈值、档位与一段可覆盖的文案**：前者是「宁可晚一点也别误报」这条取舍的刻度，
 * 随任务类型与模型行为漂移，属于部署间会变的选择（DSH 插件规范 "No hardcoded tunables in
 * plugins"）；文案（`streamCutResumeText`）则是给别人写的话——模型读到的措辞属于使用者
 * 可以有的意见，不属于判据。判据里的小样本门槛（`MIN_WORDS` / `MIN_UNITS` /
 * `REPEAT_MIN_COUNT`）与实义单元规则不在此列——它们不是偏好，改了就是把密度与比例算飞，
 * 属于判据几何的一部分。
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
import { STREAM_CUT_MAX_RESUMES, STREAM_CUT_MODE, STREAM_CUT_MODES, type StreamCutMode } from './cut/stream.ts'
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
  /**
   * 流内掐断的档位（默认 `observe`）。
   *
   * `off` 不注册 `llm/stream`，与没有这个能力时一致；`observe` 判定并打一行诊断、不掐断；
   * `cut` 掐断并续跑一步（见 `cut/stream.ts`）。
   *
   * **默认不是 `cut`**：掐断会让该步的 `data.usage` 整键缺失、`message.source.replayState`
   * 缺键，该轮的 token 汇总因此整体不可用（客户端不渲染它）。代价已知、可接受，但补不回来
   * ——那两格由上游适配器在流末尾产出，掐断就是不产出——所以由使用者知情后自行开启。
   */
  streamCut?: StreamCutMode
  /**
   * 掐断后续跑请求的正文（默认由 `cut/messages.ts` 组装，含当次读数）。
   *
   * 配了就用配的：那是一段纯文本，没有占位符，因此覆盖之后读数不再出现在文案里
   * （诊断行与轨迹页摘要不受影响）。空串会被拒绝——「配了但什么也没说」等于把续跑请求
   * 变成一条空白消息。
   */
  streamCutResumeText?: string
  /**
   * 同一个 turn 里最多续跑几次（默认 3）。
   *
   * **为什么需要上限**（设计文档 §九.7）：掐断本身是收益（它省下了 token），但续跑是动作，
   * 没有上限时一次不收敛的退化会在同一个 turn 里一直重发——dev 实测那个 turn 连掐四次才
   * 收敛，靠的是模型自己让步，那是模型的行为、不是机制的保证。
   *
   * **为什么是 3**：四次才收敛属于边界情形，而模型在第二、三次干预时就已在思考里明说
   * 「被截断」「我必须立刻产出正文」。若三次打断都没让它回到正轨，问题通常不在「被打断」，
   * 而在那个会话的上下文本身已经病态——继续续跑只是拿 token 换一个不会到来的收敛。
   *
   * 超限之后**掐断照旧发生**，停的只是续跑。
   *
   * **取 0 是一个有意义的档位：只掐不续。** 每一次掐断都走超限分支——掐断照旧发生、
   * 空回合判定照旧跳过（那一步的静默仍然是我们造成的），只是不再往模型上下文里注入续跑
   * 消息。它比 `cut` 保守：steer 本身是往上下文里加一条消息，那是一种污染，而只掐不续
   * 只省 token、不改动对话内容；它比 `observe` 有用：observe 完全不掐。现有的三档
   * （`off` / `observe` / `cut`）里没有这个中间语义，所以它由这个数表达。
   *
   * 取值范围 ≥ 0 的整数——**这条约束与窗口参数不同**，见 `times`。
   */
  streamCutMaxResumes?: number
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
  /** 见 {@link Config.streamCut}。 */
  readonly streamCut: StreamCutMode
  /**
   * 见 {@link Config.streamCutResumeText}。
   *
   * `undefined` 表示「用内置文案」——它不是空值，而是一份**要按当次读数组装**的正文
   * （`cut/messages.ts` 的 `streamCutResumeText`），所以缺省只能留在这里、不能在解析时
   * 折成一个静态字符串。
   */
  readonly streamCutResumeText: string | undefined
  /** 见 {@link Config.streamCutMaxResumes}。 */
  readonly streamCutMaxResumes: number
}

/** Loader 用于校验 `cordis.patch.yml` 里 `config` 段的 schema。 */
export const Config: Schema<Config> = Schema.object({
  driftThreshold: Schema.number(),
  repetitionThreshold: Schema.number(),
  loopWindowSteps: Schema.number(),
  loopWindowHits: Schema.number(),
  silentTurn: Schema.union(SILENT_TURN_MODES),
  streamCut: Schema.union(STREAM_CUT_MODES),
  streamCutResumeText: Schema.string(),
  streamCutMaxResumes: Schema.number(),
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
 * 校验一个非负整数次数字段。
 *
 * **与 {@link steps} 分开而不是把它的下界放宽到 0**：`loopWindowSteps` / `loopWindowHits`
 * 的取值必须 ≥ 1——窗口装不下一步、或窗口里装不下所需的命中数，都是**永不成立**的触发
 * 条件，静默接受等于关掉退化提醒而不说。而续跑次数 0 成立：它是一个真实的设置（只掐不续，
 * 见 {@link Config.streamCutMaxResumes}），不是同一个字段的越界值。两者共用一个校验函数
 * 时，改一个字段的取值范围会连带改另一个。
 * @param field - 字段名，用于报错文案。
 * @param value - 字段值。
 * @returns 校验通过的原值。
 */
function times(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`dsh-allostasis: \`${field}\` must be an integer >= 0, got ${value}`)
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
 * 校验一个可选文本字段。
 * @param field - 字段名，用于报错文案。
 * @param value - 字段值；未配置时是 `undefined`。
 * @returns 校验通过的原值或 `undefined`。
 */
function optionalText(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`dsh-allostasis: \`${field}\` must be a non-empty string, got ${JSON.stringify(value)}`)
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
  const streamCut = oneOf('streamCut', config.streamCut ?? STREAM_CUT_MODE, STREAM_CUT_MODES)
  const streamCutResumeText = optionalText('streamCutResumeText', config.streamCutResumeText)
  // 0 合法：它表达「只掐不续」（见 `Config.streamCutMaxResumes`），不是越界值。
  const streamCutMaxResumes = times('streamCutMaxResumes', config.streamCutMaxResumes ?? STREAM_CUT_MAX_RESUMES)
  return {
    driftThreshold,
    repetitionThreshold,
    loopWindowSteps,
    loopWindowHits,
    silentTurn,
    streamCut,
    streamCutResumeText,
    streamCutMaxResumes,
  }
}
