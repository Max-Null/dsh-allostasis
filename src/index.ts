/**
 * 应变（allostasis）：会话状态的自我调节。
 *
 * 三个能力落在两个挂载点上：
 *
 * · **一期 · 中文锚定**（`agent/pre-step`）：判定为语言漂移（英文功能词密度越线）就追加
 *   一条中文锚定消息。
 * · **二期 · 退化提醒**（`agent/pre-step`）：判定为推理退化（重复率越线且连续若干步成立）
 *   就追加减速提醒，并向会话日志 append 一条 `allostasis/degeneration` 记录判定依据。
 * · **空回合检测**（`agent/turn-stopping`）：回合收尾时末条助手消息没有非空文本，向会话
 *   日志 append 一条 `allostasis/silent-turn`。
 *
 * 前两个共用 `agent/pre-step`，因为它们读同一份输入——最近一条思考。空回合读的是另一种
 * 输入（这一轮最终产出了什么），而且**它之后没有下一步**，`pre-step` 不会被再次调用，
 * 判定只能落在回合收尾。
 *
 * **平时不出现、异常时才出现**——按需出现是它作为信号的前提。但异常持续时也不每个 step
 * 都提醒：同一 turn 至多一次，见 `throttle.ts`。两类提醒各有独立的一份节流状态：判据无关，
 * 共用状态会让先说的那类把另一类挡在门外。
 *
 * 为什么不挂到 system prompt 前缀上：那是 `dsh-chinese-thinking` 的位置，它作为基线
 * 永远在场。而基线在长会话里会失效（固定前缀离输出最远，语言模式受近因支配）。本插件
 * 补的是「**你正在漂移 / 正在打转 / 这一轮什么也没说**」这类纠偏信号，因此必须落在近因
 * 或收尾位置。
 *
 * 为什么用 `agent/pre-step` 而不是 `systemPrompt.context()`：前者直接给出 `turn` /
 * `step`，且追加的是一条独立消息，落点比快照里的一个段更靠后。用法先例见官方
 * `packages/context/time-context/src/index.ts:180-220`。
 *
 * 阈值与档位全部走 `config.ts` 的配置面。**压缩动作按设计方案 §九 暂缓**：数据指向退化
 * 样本散布在整段退化区间，而 `compactRegion` 只压指定区间，能否打断循环尚未验证。
 *
 * 设计出处：`docs/设计/2026-09-20-应变-设计方案.md`、
 * `docs/设计/2026-09-28-应变二期-退化检测与自动干预.md`、
 * `docs/设计/2026-09-30-空回合检测与可见化.md`
 * @module @max-null/dsh-allostasis
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { anchorText } from './anchor.ts'
import { Config, resolveConfig, type ResolvedConfig } from './config.ts'
import { measureThinking, verdict } from './drift.ts'
import { degenerationEvent, silentTurnEvent } from './events.ts'
import { degenerationText, pluginNotice } from './messages.ts'
import { name } from './name.ts'
import { measureRepetition, repetitionVerdict, trackLoop, type LoopTrackerState } from './repetition.ts'
import { measureTail, tailSamples, tailVerdict } from './tail.ts'
import { latestThinking, type ThinkingSample } from './thinking.ts'
import { admitPerTurn, type PerTurnThrottleState } from './throttle.ts'

export { anchorText, Config, name }

/** 需要 `agents` 服务来接收 `agent/pre-step` 与 `agent/turn-stopping` 事件。 */
export const inject = ['agents']

/**
 * 组装一期的语言漂移提醒。
 * @param session - 产出该思考的会话，用作节流状态的键。
 * @param sample - 最近一条思考。
 * @param resolved - 已校验的配置。
 * @param throttles - 漂移提醒的节流状态表。
 * @returns 应当追加的消息；本步不提醒时返回 `undefined`。
 */
function driftMessage(
  session: Session,
  sample: ThinkingSample,
  resolved: ResolvedConfig,
  throttles: WeakMap<object, PerTurnThrottleState>,
): UserMessage | undefined {
  const metrics = measureThinking(sample.text)
  if (verdict(metrics, resolved.driftThreshold) !== 'drift') return undefined
  const advanced = admitPerTurn(throttles.get(session), sample.turn)
  if (advanced === undefined) return undefined
  throttles.set(session, advanced)
  return pluginNotice(
    anchorText(sample.turn, sample.step, metrics, advanced.count),
    `语言漂移 · turn ${sample.turn} · 第 ${advanced.count} 次`,
  )
}

/**
 * 组装二期的推理退化提醒，并落下判定依据。
 *
 * 追踪状态**每步都推进**，包括被节流挡住的那几步：计数描述的是退化本身持续了多久，
 * 与「这一步有没有说出口」无关。
 * @param session - 产出该思考的会话。
 * @param sample - 最近一条思考。
 * @param resolved - 已校验的配置。
 * @param trackers - 连续越线的追踪状态表。
 * @param throttles - 退化提醒的节流状态表。
 * @returns 应当追加的消息；本步不提醒时返回 `undefined`。
 */
function loopMessage(
  session: Session,
  sample: ThinkingSample,
  resolved: ResolvedConfig,
  trackers: WeakMap<object, LoopTrackerState>,
  throttles: WeakMap<object, PerTurnThrottleState>,
): UserMessage | undefined {
  const metrics = measureRepetition(sample.text)
  const stepVerdict = repetitionVerdict(metrics, resolved.repetitionThreshold)
  const tracked = trackLoop(trackers.get(session), sample.turn, stepVerdict, resolved.consecutiveSteps)
  trackers.set(session, tracked.state)
  if (!tracked.fire) return undefined
  const advanced = admitPerTurn(throttles.get(session), sample.turn)
  if (advanced === undefined) return undefined
  throttles.set(session, advanced)
  session.append('allostasis/degeneration', degenerationEvent({
    turn: sample.turn,
    step: sample.step,
    metrics,
    consecutive: tracked.state.consecutive,
    threshold: resolved.repetitionThreshold,
    required: resolved.consecutiveSteps,
  }))
  return pluginNotice(
    degenerationText(sample.turn, sample.step, metrics, advanced.count),
    `推理退化 · turn ${sample.turn} · 重复率 ${(metrics.ratio * 100).toFixed(0)}%`,
  )
}

/**
 * 注册回合收尾监听：检出空回合并落一条判定事件。
 *
 * **为什么整段包 try/catch**：内核的契约测试写明该事件里抛出的异常会让 turn 以 error
 * 结束（`packages/core/agent-loop/tests/contract-regressions.spec.ts:357`，loop 本身
 * 存活）。判据失败不得升级成回合失败——与二期对 `compactRegion` 的要求同源。这里记
 * `warn` 而不是 `debug`：它意味着判据本身坏了，与「这一步判成了什么」不是一类。
 *
 * **为什么要排除取消与子代理**：`aborted` / `interrupted` 回合的沉默是用户中止的预期
 * 结果（实测 22 轮里 12 轮），子代理的回合属于父回复的中间产物——两者都不该计入空回合，
 * 前者由 `signal.aborted` 判、后者由会话头的 `parentSession` 判，两条先例见
 * `@changfenhuang/dsh-genui` 的 `fenceFeedback`。
 * @param ctx - 插件上下文。
 * @param resolved - 已校验的配置。
 */
function installSilentTurn(ctx: Context, resolved: ResolvedConfig): void {
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }): void => {
    try {
      if (resolved.silentTurn === 'off') return
      if (signal.aborted) return
      if (agent.session.header.parentSession !== undefined) return
      const shape = measureTail(tailSamples(agent.session.snapshotEvents()), turn)
      if (shape === undefined || tailVerdict(shape) !== 'silent') return
      agent.session.append('allostasis/silent-turn', silentTurnEvent({ turn, shape, steered: false }))
      console.debug(
        `[${name}] 空回合 · turn ${turn} step ${shape.step}`
        + ` · reasoning ${shape.reasoningChars} 字`
        + ` blocks=reasoning×${shape.blocks.reasoning} text×${shape.blocks.text}`
        + ` tool×${shape.blocks.toolCalls}`,
      )
      // `steer` 档位（追加一次补生成）待边界落地后接在这里；当前与 `observe` 同行为。
    } catch (error: unknown) {
      ctx.logger?.warn?.(`${name}: silent-turn check failed (${error instanceof Error ? error.message : String(error)})`)
    }
  })
}

/**
 * 注册 pre-step 监听器；监听器随 `ctx` 生命周期销毁。
 *
 * 用 `{ prepend: true }` 以取得 `next()` 的决策后再追加，与官方 `time-context` 一致。
 * @param ctx - 插件上下文。
 * @param config - `cordis.patch.yml` 里的配置段；省略时全部取判据模块的缺省值。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  // 留痕：本插件没有任何界面元素，命中时也只在轨迹页留一行摘要，因此「装了没有、
  // 生效阈值是多少、每步判成了什么」必须能从日志直接读到——否则装上了也无从判断，
  // 更无从测试（2026-09-29：确认不了它是否加载）。加载行用 info（每个进程一次）；
  // 判定行走 debug，默认静默、排查时打开即可，不必为了看一眼判定去改阈值试。
  console.info(
    `[${name}] loaded · driftThreshold=${resolved.driftThreshold}`
    + ` repetitionThreshold=${resolved.repetitionThreshold}`
    + ` consecutiveSteps=${resolved.consecutiveSteps}`
    + ` silentTurn=${resolved.silentTurn}`,
  )
  /** 每个会话各一份状态；用 WeakMap 以免会话销毁后残留。 */
  const anchorThrottles = new WeakMap<object, PerTurnThrottleState>()
  const loopThrottles = new WeakMap<object, PerTurnThrottleState>()
  const loopTrackers = new WeakMap<object, LoopTrackerState>()

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const sample = latestThinking(agent.session)
    if (sample === undefined) return decision
    // 诊断行与下面的判定各算一次度量：两者都是纯字符串统计，重复计算的代价远低于
    // 让 metrics 在三个函数之间穿梭带来的耦合。
    const dMetrics = measureThinking(sample.text)
    const rMetrics = measureRepetition(sample.text)
    console.debug(
      `[${name}] turn ${sample.turn} step ${sample.step}`
      + ` · drift=${verdict(dMetrics, resolved.driftThreshold)}`
      + ` funcDensity=${(dMetrics.funcDensity * 100).toFixed(1)}% chars=${dMetrics.chars}`
      + ` · repetition=${repetitionVerdict(rMetrics, resolved.repetitionThreshold)}`
      + ` units=${rMetrics.units} ratio=${(rMetrics.ratio * 100).toFixed(0)}%`,
    )
    const appended: UserMessage[] = []
    const drift = driftMessage(agent.session, sample, resolved, anchorThrottles)
    if (drift !== undefined) appended.push(drift)
    const loop = loopMessage(agent.session, sample, resolved, loopTrackers, loopThrottles)
    if (loop !== undefined) appended.push(loop)
    if (appended.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...appended] }
  }, { prepend: true })

  installSilentTurn(ctx, resolved)
}
