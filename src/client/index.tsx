/**
 * 浏览器半边的装配点。
 *
 * 三件事：登记文案字典、把空回合投影注册进 Conversation 事件表、在回合尾部开一个座位。
 *
 * **半边之间不共享运行时代码**：浏览器半边自己折叠 `turn/start` / `assistant/message` /
 * `turn/end` 下判定（宿主不写会话事件，理由见根模块注释），与宿主同名判据共用的是
 * `../tail.ts` 里的纯函数，浏览器产物里不会混进宿主实现。
 *
 * **为什么是 `conversation.chat.turnTail` 而不是 `shell.overlay`**：见 `silent-turn.ts` 的模块
 * 注释——帧级浮层拿不到会话身份，而这个座位天生带 turn 号与会话作用域。
 *
 * **`silentTurn` 档位控制不到这里**：浏览器半边的 `apply` 拿不到插件配置（2026-10-01 实测：
 * `cordis.patch.yml` 里给这一行配 `silentTurn: off`，宿主读到 `off`，浏览器半边收到空对象）。
 * 提示折叠的是会话事件流，与宿主判据同源但独立于档位；要完全静默就禁用插件。
 * @module @max-null/dsh-allostasis/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SilentTurnNotice } from './SilentTurnNotice.tsx'
import { en, NS, zh, type SilentTurnKey } from './locales.ts'
import { SILENT_TURN_KEY, silentTurnDefinition } from './silent-turn.ts'

/** 本插件在浏览器半边的包名，用作诊断行的前缀。 */
const PLUGIN_ID = '@max-null/dsh-allostasis'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 空回合提示的文案。 */
    'allostasis': SilentTurnKey
  }
}

/** 需要槽位注册表、文案服务与 Conversation 的事件注册表。 */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * 登记文案与回合尾部座位。
 * @param ctx - 浏览器半边上下文。
 */
export function apply(ctx: ClientContext): void {
  // 与 host 半边的 loaded 行对称：浏览器半边在此之前没有任何界面元素，装没装上、
  // apply 有没有跑到，只能从这一行读。
  console.info(`[${PLUGIN_ID}] client applied`)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-allostasis: 文案字典')
  ctx.effect(() => ctx.uiConversation.events.register(silentTurnDefinition), 'dsh-allostasis: 空回合投影')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: SILENT_TURN_KEY,
    order: 10,
    locale: NS,
  }, SilentTurnNotice))
}
