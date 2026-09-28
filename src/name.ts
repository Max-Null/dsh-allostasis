/**
 * Cordis 插件名。单独成模块是为了让 `messages.ts` 与入口共用同一个字面量——
 * 它同时是插件身份、注入消息的 `source.plugin` 与轨迹里的生产者标签，两处漂移的代价
 * 是日志里出现两个看似无关的生产者。
 * @module @max-null/dsh-allostasis/name
 */

/** Cordis 插件名，同时用作注入消息 source 的 kind 与 section 名。 */
export const name = 'dsh-allostasis'

/**
 * 注入消息 source 的 `kind`：v4 会话格式对第三方生产者的规范形式。
 *
 * `as const` 是必需的——`MessageSourceMap` 的成员键必须是字面量类型，而模板字符串
 * 默认推断为 `string`。`messages.ts` 的声明合并键与这里必须是同一个值。
 */
export const SOURCE_KIND = `plugin:${name}` as const

