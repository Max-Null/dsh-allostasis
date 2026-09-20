# @max-null/dsh-allostasis

本插件属于 **`@max-null/*` 插件系列**——这一系列共同构成 **[SSID（思灵 · Seek Soul in Darkness）](https://github.com/Max-Null/seek-soul-in-darkness)** 桌面体验。SSID 是整合它们的盒：`dsh-allostasis` · `dsh-capture` · `dsh-chat-rail` · `dsh-chinese-thinking` · `dsh-draft-polish` · `dsh-guardian` · `dsh-habit` · `dsh-memory` · `dsh-node-appearance` · `dsh-plugin-center` · `dsh-quick-toolbar` · `dsh-skill-mcp-center` · `dsh-ssid-panels` · `dsh-ssid-zh-ui` · `dsh-achievements`。

This plugin belongs to the **`@max-null/*` family** — a set of plugins that together form the **[SSID (思灵 · Seek Soul in Darkness)](https://github.com/Max-Null/seek-soul-in-darkness)** desktop experience.

Allostasis for the DeepSeek Harness — session self-regulation rather than monitoring.
Its first capability is **Chinese anchoring**: before each step it reads the most recent
reasoning block, and when that thinking has drifted into English it appends one near-end
message to bring it back.

## 它做什么

**应变**（allostasis）取「**通过改变自己来维持自己**」之义——它不只是一个监测器，它会改变行为。

| 能力 | 状态 | 触发条件 |
|---|---|---|
| **中文锚定** | **已实现** | 上一步思考的英文功能词密度越线 |
| 上下文占用感知 | 计划中 | 需先定「什么情况下才出现」（持续在场会退化成背景音） |
| 压缩预约落盘 | 计划中 | 待通路验证：`turn/end` → `whenIdle()` → `compactNow()` |

判据来源、实测数据与完整设计见 `docs/设计/2026-09-20-应变-设计方案.md`。

## 为什么需要它

`dsh-chinese-thinking` 把「始终使用中文进行思考」挂在 system prompt 的**固定前缀**上——那是对的定位：基线、常驻、cache-safe。但固定前缀离每一次输出最远，而语言模式受**近因**支配；长会话里基线会变弱。

本插件补的是**纠偏信号**——「你正在漂移」。它是叠加而非替代：基线层永远在场，增强层只在检测到漂移时出现。**平时不出现**正是它作为信号的前提；一段一直存在的提醒会退化成背景音，重演它要修的那个问题。

## 判据

**英文功能词密度** =（`the` / `is` / `are` / `and` / `of` / `to` / `that` 这类功能词数）/ 英文词数，**且英文词数 ≥ 50 才判定**。

实测数据（一份 10 turn / 157 step 的真实会话）：中文期中位 **0.012**、英文期中位 **0.273–0.389**，阈值 **0.15** 使两群完全分离。词数门槛不可省——中文期唯一的越线点只有 26 个英文词，小样本会让密度失真。

另外两个看起来更直观的指标被否掉：**中文字符占比**（中文思考本来就大量夹英文标识符，实测中文期只有 0.19–0.37，区分度不足）；**最长连续英文游程**（中文思考引用一段代码就会把它顶高，它测的是「引用了多长的代码」而非「用什么语言思考」）。

阈值由 `tools/analyze-thinking-lang.mjs` 在一份真实会话上标定，该工具随包发布。

## 截图

本插件是**会话行为调节类**：不新增任何按钮、面板或设置项。它在会话过程中读取思考的语言，漂移时向请求末尾追加一条提醒，效果体现在模型行为上。

> 按《SSiD 开发手册》§9 截图规范：截图须回答「装完会多出/变成什么」的**入口与面板**。
> 本插件无界面元素（no UI surface），故**不适用**该项要求，改以上述行为效果说明代替。

## Compose

```yaml
# cordis.yml (or via the bundle patch):
- id: allostasis
  name: '@max-null/dsh-allostasis'
```

Requires `agents` and `system-prompt` in the host composition (dsh-base ships both).
Installs as a bundle: `dsh plugin --profile <name> add @max-null/dsh-allostasis`.

## Config

第一期没有配置项；阈值与门槛是经过标定的常量，写在 `src/drift.ts` 里并附实测依据。

## Develop

```sh
npm install --legacy-peer-deps   # DSH peer types resolve via tsconfig paths
npm test                         # vitest
npm run typecheck                # tsc against the adjacent deepseek-harness lib/types
npm run build                    # emit dist/
```

**注意 tsconfig 的 `paths` 用 `../../deepseek-harness/...`**（本仓库位于 `max-null-plugins/` 下，`deepseek-harness/` 在再上一级）。写成 `../deepseek-harness/...` 时 TypeScript 会**静默回落**到 `node_modules` 里 npm 装的旧版 DSH 类型——症状是「某些显然存在的成员报 not exported」，而不是找不到模块。
