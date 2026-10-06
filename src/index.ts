/**
 * 应变（allostasis）：会话状态的自我调节。
 *
 * 四个能力落在三个挂载点上：
 *
 * · **一期 · 中文锚定**（`agent/pre-step`）：判定为语言漂移（英文功能词密度越线）就追加
 *   一条中文锚定消息。
 * · **二期 · 退化提醒**（`agent/pre-step`）：判定为推理退化（窗口内累计若干步重复率越线）
 *   就追加减速提醒。
 * · **三期 · 流内掐断**（`llm/stream`）：在同一步的生成过程中逐增量判重复率，命中就把这次
 *   生成伪装成正常收尾（补 `block-end` + `finish{stop}`），再由回合收尾边界 steer 续跑一步。
 *   掐断是**能中断模型生成**的强动作，档位与代价见 `cut/stream.ts` 与设计文档 §六 / §九.3。
 * · **空回合检测**（`agent/turn-stopping`）：回合收尾时末条助手消息没有非空文本即判定成立，
 *   `steer` 档位下追加一次补生成。**它带一条例外**：本 turn 被本插件掐断过就跳过判定与补
 *   生成——那一步的静默是掐断造成的，不是模型自己没说话（§3.4 的内部协调）。
 *
 * **判定结果不写会话日志**。会话日志的事件词汇表 `KNOWN_SESSION_EVENT_TYPES` 由内核在构建期
 * 生成，下游插件的事件类型不在其中；`Session.append()` 的封装
 * （`packages/core/session/src/index.ts:744-750`）没有 `ignorable` 通道，而
 * `SessionEvent.ignorable` 的契约要求这类「丢失不影响重建」的记录必须自带该标记
 * （`packages/core/session/src/types.ts:501-511`）。缺标记的自定义类型会让**整份**日志在下次
 * 加载时被拒读（`packages/session/session-persistence/src/storage-contract.ts:75-80`）——
 * 2026-10-01 实测：dev 与装版各有会话因此打不开。判定输入本来就可重放（推理原文在
 * `reasoning-chunks.texts`、回合边界在 `turn/start` / `turn/end`），留痕因此改由本模块的
 * `console.debug` 诊断行与浏览器半边的提示承担；浏览器半边自行从事件流折叠判定，
 * 见 `client/silent-turn.ts`。
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
import { streamCutNotice } from './cut/messages.ts'
import { cutBeforeStopping, recordCut, type CutLedger } from './cut/state.ts'
import { installStreamCut } from './cut/stream.ts'
import { measureThinking, verdict } from './drift.ts'
import { degenerationText, pluginNotice, silentTurnText } from './messages.ts'
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
 * 组装二期的推理退化提醒。
 *
 * 追踪状态**每步都推进**，包括被节流挡住的那几步：窗口描述的是退化本身分布在哪几步，
 * 与「这一步有没有说出口」无关。
 * @param session - 产出该思考的会话。
 * @param sample - 最近一条思考。
 * @param resolved - 已校验的配置。
 * @param trackers - 越线窗口的追踪状态表。
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
  const tracked = trackLoop(trackers.get(session), stepVerdict, resolved.loopWindowSteps, resolved.loopWindowHits)
  trackers.set(session, tracked.state)
  if (!tracked.fire) return undefined
  const advanced = admitPerTurn(throttles.get(session), sample.turn)
  if (advanced === undefined) return undefined
  throttles.set(session, advanced)
  return pluginNotice(
    degenerationText(sample.turn, sample.step, metrics, advanced.count),
    `推理退化 · turn ${sample.turn} · 重复率 ${(metrics.ratio * 100).toFixed(0)}%`,
  )
}

/**
 * 注册回合收尾监听：检出空回合；`steer` 档位下追加一次补生成；掐断造成的静默改走续跑。
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
 *
 * **掐断造成的静默走另一条分支**（设计文档 §3.4）：掐断之后的那个 step 只剩 reasoning，
 * 恰好满足空回合判据，若不区分就会与掐断的续跑撞成两条提醒。所以本函数第一个查的就是
 * `cut/state.ts` 的账本——命中即跳过判定与补生成（**留痕照旧**），并在这里把续跑请求送进去
 * （§3.3 的重定向）。两条边界与既有逻辑刻意不同：
 *
 * · 它**不看 `silentTurn` 档位**：续跑是掐断的必要配套动作，不是空回合兜底的一部分，
 *   关掉空回合兜底不该把掐断变成「白掐」。
 * · 它**不排除子代理**：掐断已经在流里发生了（`llm/stream` 拿不到会话对象，无从预判），
 *   续跑是补救——不续跑等于让子代理那一步静默收场，父回复拿到一段空白。
 *   （这是判断，不是实测：`docs/排查/2026-10-07-补块落盘形状.md` §5.4 把「allostasis
 *   自己实现的掐断」整条列为未验证面。）
 *
 * **补生成的记账发生在发送之前**：`turn-stopping` 是可能重入的边界，先记账才能保证同一次
 * 补生成不会被投两遍——与 `fenceFeedback` 同一条约束。掐断的续跑同理：`cutBeforeStopping`
 * 先把 `pending` 清零，第二次查账就只剩「跳过」而没有「续跑」。
 *
 * **补生成单独包一层 catch**：判定已经成立，补生成失败不该升级成回合失败。
 * @param ctx - 插件上下文。
 * @param resolved - 已校验的配置。
 * @param steers - 补生成的节流状态表，按会话各一份。
 * @param cutLedgers - 掐断账本，按会话 id 各一份（键的形式见 `cut/state.ts`）。
 */
function installSilentTurn(
  ctx: Context,
  resolved: ResolvedConfig,
  steers: WeakMap<object, PerTurnThrottleState>,
  cutLedgers: Map<string, CutLedger>,
): void {
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }): void => {
    try {
      if (signal.aborted) return
      const { session } = agent
      const key = String(session.id)
      const cut = cutBeforeStopping(cutLedgers.get(key), turn)
      if (cut.skip) {
        cutLedgers.set(key, cut.ledger)
        const record = cut.ledger.last
        if (!cut.resume) {
          console.debug(`[${name}] 流内掐断 · turn ${turn} · 跳过空回合判定（本 turn 的续跑已经发过）`)
          return
        }
        console.debug(
          `[${name}] 流内掐断 · turn ${turn} · 跳过空回合判定 · 续跑一步`
          + (record === undefined ? '' : ` · 本会话累计 ${cut.ledger.total} 次`),
        )
        if (record === undefined) return
        try {
          agent.steer(streamCutNotice(turn, record, resolved.streamCutResumeText))
        } catch (error: unknown) {
          ctx.logger?.warn?.(`${name}: stream-cut steer failed (${error instanceof Error ? error.message : String(error)})`)
        }
        return
      }
      if (resolved.silentTurn === 'off') return
      if (session.header.parentSession !== undefined) return
      const shape = measureTail(tailSamples(session.snapshotEvents()), turn)
      if (shape === undefined || tailVerdict(shape) !== 'silent') return
      const plan = resolved.silentTurn === 'steer' ? admitPerTurn(steers.get(session), turn) : undefined
      if (plan !== undefined) steers.set(session, plan)
      console.debug(
        `[${name}] 空回合 · turn ${turn} step ${shape.step}`
        + ` · reasoning ${shape.reasoningChars} 字`
        + ` blocks=reasoning×${shape.blocks.reasoning} text×${shape.blocks.text}`
        + ` tool×${shape.blocks.toolCalls}`
        + ` steered=${plan !== undefined}`,
      )
      if (plan === undefined) return
      try {
        agent.steer(pluginNotice(silentTurnText(turn, shape), `空回合 · turn ${turn} · 补一次生成`))
      } catch (error: unknown) {
        ctx.logger?.warn?.(`${name}: silent-turn steer failed (${error instanceof Error ? error.message : String(error)})`)
      }
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
    + ` loopWindow=${resolved.loopWindowHits}/${resolved.loopWindowSteps}`
    + ` silentTurn=${resolved.silentTurn}`
    + ` streamCut=${resolved.streamCut}`,
  )
  /** 每个会话各一份状态；用 WeakMap 以免会话销毁后残留。 */
  const anchorThrottles = new WeakMap<object, PerTurnThrottleState>()
  const loopThrottles = new WeakMap<object, PerTurnThrottleState>()
  const loopTrackers = new WeakMap<object, LoopTrackerState>()
  const silentSteers = new WeakMap<object, PerTurnThrottleState>()
  /**
   * 掐断账本。
   *
   * 用 `Map<string, …>` 而不是 WeakMap：流侧只能拿到 `options.sessionId`，拿不到会话对象
   * （`cut/state.ts` 有说明）。每会话的条目是三个数字加一份现场读数，量级可忽略。
   */
  const cutLedgers = new Map<string, CutLedger>()

  if (resolved.streamCut !== 'off') {
    installStreamCut(ctx, {
      mode: resolved.streamCut,
      threshold: resolved.repetitionThreshold,
      onCut: (sessionId, record): void => {
        cutLedgers.set(sessionId, recordCut(cutLedgers.get(sessionId), record))
      },
    })
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // 判定与组装整段包在 try 里，理由与 `installSilentTurn` 同源：内核的契约测试写明
    // `agent/pre-step` 里抛出的异常会让 turn 以 error 结束，而在 pre-step 上那个结束发生在
    // **这一步进入模型之前**。异常源若留在会话里（例如此刻取不出思考文本），下一个 turn 会在
    // 同一步以同一个异常结束——一次判据故障于是成了整场会话的终点（2026-10-06 实测）。
    const appended: UserMessage[] = []
    try {
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
      const drift = driftMessage(agent.session, sample, resolved, anchorThrottles)
      if (drift !== undefined) appended.push(drift)
      const loop = loopMessage(agent.session, sample, resolved, loopTrackers, loopThrottles)
      if (loop !== undefined) appended.push(loop)
    } catch (error: unknown) {
      // 取数失败时窗口状态尚未推进（`trackLoop` 的写入在判定之后），这一步因此等价于
      // `insufficient`：既不算命中也不算未命中，与「样本太短」同一处理。
      // 记 `warn` 而不是 `debug`：它意味着判据本身坏了，与「这一步判成了什么」不是一类。
      ctx.logger?.warn?.(
        `${name}: pre-step check failed (${error instanceof Error ? error.message : String(error)}); 这一步不判定`,
      )
      return decision
    }
    if (appended.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...appended] }
  }, { prepend: true })

  installSilentTurn(ctx, resolved, silentSteers, cutLedgers)
}
