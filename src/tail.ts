/**
 * 回合末步的产出形态判定（空回合检测的判据）。
 *
 * 落点：`assistant/message` 事件的 `message.content` —— 与 `thinking.ts` 读同一个事件的
 * 另一个字段（那边读 `stream` 里的 `reasoning-chunks`，这里读 `content` 的块构成）。
 *
 * 判据 = **本 turn 最后一条助手消息里没有非空 text 块**。
 *
 * 实测依据（2026-09-30，14 天内 1202 个 `completed` 回合）：完成态结尾沉默 34 轮
 * （2.8%），其中 **32 轮的末步只有 `reasoning`** —— 判据纯度 94%，误报面小。
 * `aborted` / `interrupted` 的沉默另有 15 轮，但那是用户中止的预期结果，**不在判据内**：
 * 调用方按 `signal.aborted` 排除，见 `index.ts` 的 turn-stopping 监听。
 *
 * 为什么读 `content` 而不是 `stream`：`stream` 里的 `text-chunks` 回答「模型有没有生成过
 * 文本」，`content` 回答「这一步最终产出了什么」。判据要的是后者，前者只在排查时用来
 * 交叉验证（设计文档 §2.2）。
 *
 * 设计出处：`docs/设计/2026-09-30-空回合检测与可见化.md` §二
 * @module @max-null/dsh-allostasis/tail
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 空回合兜底的档位：`off` 不判定，`observe` 判定并留痕，`steer` 额外补一次生成。 */
export type SilentTurnMode = 'off' | 'observe' | 'steer'

/** 全部档位，供配置校验枚举。 */
export const SILENT_TURN_MODES: readonly SilentTurnMode[] = ['off', 'observe', 'steer']

/**
 * 空回合兜底的档位缺省值。
 *
 * `observe` 而不是 `off`：判定与留痕必须先跑起来，否则「这个现象有多频繁、判据准不准」
 * 永远没有数据。补生成（`steer`）要等到有数据说明它值得开之后再加。
 */
export const SILENT_TURN_MODE: SilentTurnMode = 'observe'

/** 判定只需要块的类型与文本；用最小形状接收，判据模块因此不依赖会话包的内容类型。 */
export interface TailBlock {
  /** 块类型：`reasoning` / `text` / `tool-call`。 */
  readonly type: string
  /** 文本与推理块的正文；工具调用块没有这个字段。 */
  readonly text?: string
}

/** 一条助手消息的产出形态。 */
export interface TailShape {
  /** 该消息所属的 turn。 */
  readonly turn: number
  /** 该消息所属的 step。 */
  readonly step: number
  /** 非空 `text` 块的总字符数。空回合恒为 0。 */
  readonly textChars: number
  /** `reasoning` 块的总字符数——区分「想了很久没说」与「完全没输出」。 */
  readonly reasoningChars: number
  /** 按类型的块计数。 */
  readonly blocks: {
    readonly reasoning: number
    readonly text: number
    readonly toolCalls: number
  }
}

/**
 * 三态判定。`unknown` 用于「本回合没有助手消息」——比如用户消息刚落下、助手还没产出，
 * 此时既不能说它说了话，也不能说它是空回合。
 */
export type TailVerdict = 'spoke' | 'silent' | 'unknown'

/**
 * 统计一条助手消息的块构成。
 *
 * `text` 按去掉首尾空白后的长度计入：只含空白的文本块在界面上不产生任何可见内容，
 * 把它算作「说了话」会让判据漏掉真实的空回合。
 * @param turn - 该消息所属的 turn。
 * @param step - 该消息所属的 step。
 * @param content - 助手消息的内容块，按出现顺序。
 * @returns 该消息的产出形态。
 */
export function shapeOf(turn: number, step: number, content: readonly TailBlock[]): TailShape {
  let textChars = 0
  let reasoningChars = 0
  const blocks = { reasoning: 0, text: 0, toolCalls: 0 }
  for (const block of content) {
    if (block.type === 'reasoning') {
      blocks.reasoning += 1
      reasoningChars += block.text?.length ?? 0
    } else if (block.type === 'text') {
      blocks.text += 1
      textChars += block.text?.trim().length ?? 0
    } else if (block.type === 'tool-call') {
      blocks.toolCalls += 1
    }
  }
  return { turn, step, textChars, reasoningChars, blocks }
}

/** 从会话事件里取出的助手消息样本：判定只读这三个字段。 */
export interface TailSample {
  /** 该消息所属的 turn。 */
  readonly turn: number
  /** 该消息所属的 step。 */
  readonly step: number
  /** 内容块，按出现顺序。 */
  readonly content: readonly TailBlock[]
}

/**
 * 把会话事件收窄成判定样本。
 *
 * 与 {@link measureTail} 分成两步，是为了让判定完全落在纯函数上：`SessionEvent` 是
 * 所有事件的联合，拿它当参数就得在测试里伪造整个事件（含 `usage` / `stream`），
 * 或者用类型断言把缺口盖掉。收窄只在这里做一次。
 * @param events - 会话事件，按 seq 升序。
 * @returns 助手消息样本，保持原顺序；其它类型的事件被跳过。
 */
export function tailSamples(events: readonly SessionEvent[]): TailSample[] {
  const samples: TailSample[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    samples.push({
      turn: event.data.turn,
      step: event.data.step,
      content: event.data.message.content,
    })
  }
  return samples
}

/**
 * 取本 turn **最后一条**助手消息的产出形态。
 *
 * 倒扫而不是取「最后一条样本」：会话里可能夹着别的 turn 的助手消息（中断后的残留、
 * 子代理的投递），而判定要问的是「这一轮结束时用户看到了什么」。
 * @param samples - {@link tailSamples} 的产出。
 * @param turn - 要检查的 turn。
 * @returns 末条助手消息的形态；该 turn 没有助手消息时返回 `undefined`。
 */
export function measureTail(samples: readonly TailSample[], turn: number): TailShape | undefined {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]
    if (sample === undefined || sample.turn !== turn) continue
    return shapeOf(sample.turn, sample.step, sample.content)
  }
  return undefined
}

/**
 * 对一次测量下判定。
 *
 * 只有「有助手消息且它没有非空文本」才算空回合。工具调用**不**改变判定：一个以
 * `tool-call` 结尾的完成态回合同样是异常（工具执行完还会再走一步，除非回合已经结束）。
 * @param shape - 末条助手消息的形态；没有助手消息时传 `undefined`。
 * @returns 三态判定。
 */
export function tailVerdict(shape: TailShape | undefined): TailVerdict {
  if (shape === undefined) return 'unknown'
  return shape.textChars > 0 ? 'spoke' : 'silent'
}
