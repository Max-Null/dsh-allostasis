/**
 * 回合尾部的空回合提示。
 *
 * 挂在 `conversation.chat.turnTail` 座位（`ui-chat` 声明为 `{ kind: 'list', scope: 'session' }`），
 * 跟着它所属的那一轮渲染——用户看到空白的那个位置，就是提示该出现的位置。座位只在**已完成**
 * 的回合渲染，而空回合按定义就是 `completed`，两者正好对齐。
 *
 * **这不是浮层**：`shell.overlay` 是帧级的，一次提醒无法绑定到某一轮，滚动或切换会话后就与
 * 它要解释的那段空白脱了钩。Turn 尾部座位天然挂在 turn 号上，回看历史时提示还在原处。
 *
 * **样式用内联 token 而不走 CSS Modules**：外层插件没有 DSH 的 `clientBundle` 预设
 * （`packages/client/tsdown.client.ts`），CSS Modules 需要那条构建链。这里直接引用
 * `--dsw-*` 语义别名，亮暗主题各自成立，也就不必判断主题。
 * @module @max-null/dsh-allostasis/client/SilentTurnNotice
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SILENT_TURN_KEY } from './silent-turn.ts'

/** 回合尾部空回合提示的 props：座位 owner 货币 + 本插件的文案座位。 */
export type SilentTurnNoticeProps =
  & PropsRuntime<'conversation.chat.turnTail'>
  & PropsLocale<'allostasis'>

/**
 * 渲染本 Turn 的空回合提示；该 Turn 没有命中判定时什么都不渲染。
 *
 * 每个 list 条目都会对每一轮渲染一次，所以判定在这里收窄到自己的那两个键上。
 * @param props - 回合尾部 owner 货币与本地化座位。
 * @returns 提示条，或 `null`。
 */
export function SilentTurnNotice({ turn, t }: SilentTurnNoticeProps): ReactNode {
  const data = turn.data.get(SILENT_TURN_KEY)
  if (data === undefined) return null
  return (
    <div style={wrap} role="status" data-allostasis-silent-turn={data.turn}>
      <span style={headline}>{t('silent.headline')}</span>
      <span style={hint}>
        {data.reasoningChars > 0 ? t('silent.hintReasoned') : t('silent.hintEmpty')}
      </span>
    </div>
  )
}

const wrap = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  margin: '6px 0 2px',
  padding: '8px 12px',
  borderLeft: '2px solid var(--dsw-alias-label-caption)',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-bg-overlay)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: '12px',
  lineHeight: '18px',
} as const

const headline = { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } as const

const hint = { opacity: 0.85 } as const
