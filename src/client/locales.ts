/**
 * 浏览器半边的文案字典。
 *
 * 产品可见字符串一律走这里，组件不内联文案（DSH 的 `verify-client-ui-i18n` 按来源
 * 归属校验）。`LocaleNamespaceMap` 里登记的是 `keyof typeof en`，两套字典的键必须一致。
 *
 * 措辞对着**用户此刻的困惑**写：他看到的是空白，所以先说明发生了什么，再给一条出路。
 * 不说「模型坏了」——那是归因，而这里只知道「这一轮没有产出」。
 * @module @max-null/dsh-allostasis/client/locales
 */

/** 本插件在浏览器半边占用的 locale 命名空间。 */
export const NS = 'allostasis'

/** 中文文案。 */
export const zh = {
  /** 一行叙述：这条提醒说的是什么。 */
  'silent.headline': '这一轮结束时模型没有产出内容',
  /** 末步只生成了推理时的说明：给出可执行的下一步。 */
  'silent.hintReasoned': '最后一步只生成了推理就停下了。可以再问一句让它接着说完，或直接看上面的操作记录。',
  /** 末步什么块都没有时的说明。 */
  'silent.hintEmpty': '最后一步没有产出任何内容。可以重问一次，或换一种说法。',
}

/** 英文文案；键与 {@link zh} 一一对应。 */
export const en = {
  'silent.headline': 'This turn ended with no visible output',
  'silent.hintReasoned': 'The last step stopped after reasoning. Ask again to let it finish the thought, or read the operation log above.',
  'silent.hintEmpty': 'The last step produced nothing at all. Ask again, or rephrase the request.',
}

/** 本命名空间的键集合，供 `LocaleNamespaceMap` 登记。 */
export type SilentTurnKey = keyof typeof zh
