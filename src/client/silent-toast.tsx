/**
 * 空回合提醒：挂在 `shell.overlay` 上的一小块浮层。
 *
 * **指针事件是这个组件的关键约束。** `shell.overlay` 默认 click-through（`ui-layout`
 * 的注释：「The layer itself is click-through — entries opt back into pointer events」），
 * 所以外层容器保持 `pointer-events: none`，只有内层面板 `auto`——关闭按钮可点，而面板
 * 之外的区域照旧穿透。这条不是洁癖：`plugin-center` 的「插件更新」面板 opt-in 了整个
 * 覆盖层，结果连 composer 一起挡住（2026-10-01 排查时踩到，Playwright 的报错文本点名
 * `pc-overlay ... intercepts pointer events`）。
 *
 * **配色走 DSH 的 toast 语义别名**（`--dsw-alias-toast-bg` / `--dsw-alias-toast-label`），
 * 亮暗主题各自有值，因此这里不判断主题、也不写死颜色。这样也省掉了 CSS Modules 的构建
 * 链——内联样式直接引用变量即可。
 *
 * 文案全部来自 `locales.ts`，组件不内联产品字符串。
 * @module @max-null/dsh-allostasis/client/silent-toast
 */

import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** 一条待显示的空回合提醒。 */
export interface SilentToastState {
  /** 递增序号；同一次显示内不变，用于让下一轮重新弹出。 */
  readonly seq: number
  /** 判定为空的回合号。 */
  readonly turn: number
}

/**
 * 可观察快照。形状与 DSH 的 `ObservableSnapshot` 一致——renderer 正是按这个形状把
 * `hooks` 里的值绑成 `use<Name>`。
 */
export interface ToastSource {
  /** 当前提醒；`null` 表示没有。 */
  getSnapshot: () => SilentToastState | null
  /**
   * 订阅变化。
   * @param listener - 失效回调。
   * @returns 取消订阅。
   */
  subscribe: (listener: () => void) => () => void
}

/** 注册时注入给组件的接口。 */
export interface SilentToastInjected {
  /** 注入面：`toast` 会被 renderer 绑成 `useToast`。 */
  hooks: {
    /** 当前要显示的提醒。 */
    toast: ToastSource
  }
  /** 关掉当前这条提醒。 */
  dismiss: () => void
}

/** 组件 props：运行时座位 + 本地化座位 + 注入面。 */
export type SilentToastProps =
  & PropsRuntime<'shell.overlay'>
  & PropsLocale<'allostasis'>
  & SilentToastInjected

/**
 * 渲染一条空回合提醒；没有待显示项时什么都不渲染。
 * @param props - 座位与注入面，由注册处提供。
 * @returns 提醒面板，或 `null`。
 */
export function SilentToast({ useToast, t, dismiss }: SilentToastProps): ReactNode {
  const toast = useToast()
  if (toast === null) return null
  return (
    <div style={wrap} data-allostasis-silent-turn={toast.turn}>
      <div style={panel} role="status">
        <span style={headline}>{t('silent.headline')}</span>
        <span style={hint}>{t('silent.hint')}</span>
        <button type="button" style={close} aria-label={t('silent.dismiss')} onClick={dismiss}>
          ✕
        </button>
      </div>
    </div>
  )
}

/** 外层铺满但穿透指针；只有面板本体接收点击。 */
const wrap = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  paddingBottom: '96px',
  zIndex: 2147483000,
} as const

const panel = {
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
  maxWidth: '620px',
  margin: '0 16px',
  padding: '10px 12px 10px 14px',
  borderRadius: 'var(--dsw-radius-md)',
  background: 'var(--dsw-alias-toast-bg)',
  color: 'var(--dsw-alias-toast-label)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: '13px',
  lineHeight: '20px',
  boxShadow: '0 6px 24px rgba(0, 0, 0, 0.24)',
} as const

const headline = { fontWeight: 600, whiteSpace: 'nowrap' } as const

const hint = { opacity: 0.82 } as const

const close = {
  marginLeft: '2px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  lineHeight: '18px',
  cursor: 'pointer',
  opacity: 0.72,
} as const
