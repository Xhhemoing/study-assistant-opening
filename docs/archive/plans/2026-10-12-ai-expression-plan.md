# AI 表达优化计划：Markdown 为主，受控块为岛

**Date:** 2026-10-12
**Baseline:** `c924faa`（`feat/jingwei-core`）
**Inputs:** SenseWeave 终版报告与原型（`senseweave-final-report-and-prototype.zip`）、学习表达开发计划（`study-assistant-ai-expression-dev-plan-2026-10-11.zip`），以及对当前仓库的核查
**Status:** S1 #25、S2 #26、S5 #28 已合入；S5 选区 #29 审查中；S4 进行中；S3、S6 未开始

## Outcome

每条 AI 回答都有清楚的正文：列表、表格、公式、代码正确渲染，先给结论，来源能定位到句。只有图比文字更清楚、且数据来自问题或材料时，才在正文中原地出现受控图解，图解失败时退回可读文字。保存到笔记时保留结构。

## 现状核查（c924faa）

| 位置 | 事实 | 影响 |
|---|---|---|
| `apps/web/src/features/opening/assistant/message-list.tsx:105` | 回答以 `<p className="whitespace-pre-wrap">` 原样输出；仓库无任何 Markdown/KaTeX 依赖 | 模型写的列表、表格、公式全部显示为原始符号，影响每条消息 |
| `packages/ai/src/opening/provider.ts:11` | 输出指令只约束 JSON 外形 `{text, citedChunkIds, candidates}`，无写作指引、无能力目录 | 表达质量全靠模型自发 |
| `apps/web/src/features/opening/jingwei-host.ts` | 图解靠规则规划器读取时从文本推导，附在正文下方；`OPENING_CHAT_ARTIFACTS` 默认关 | 同一内容讲两遍；只覆盖箭头链和数值表 |
| `packages/jingwei` | 信封、注册表、`decideBlock` 校验、显示降级、RenderBoundary 已就绪；`describe()`、`isCurrentFrame` 尚无生产调用方 | 结构化能力已有，缺少模型这一端的输入 |
| `packages/database/src/repositories/opening-note-provenance.ts:28` | `saveSnippet` 只存一个纯文本 `paragraph` 块 | 结构、图解、引用在笔记中丢失 |
| provider 调用 | 非流式 `/chat/completions`，保存的回合靠轮询 | 流式暂不成立，后置 |

## 对两份调研的取舍

保留：模型选择表达，受控渲染器负责画图和计算；每种能力都能退回纯文字；没有数据就不编数值；视图状态与内容版本分开；动画和演示不冒充真实进度。这些已经由 `packages/jingwei` 实现，不重做。

调整：

1. **先修正文，再扩图解。** 调研重点放在图解和动画上，漏掉了正文没有 Markdown 渲染这个最大的短板。
2. **输出契约是一等工作。** 一页写作规则的成本远低于新组件，收益覆盖所有消息。
3. **图解就地插入，不另附。** 模型在需要图的位置写一个 ` ```jw:<capability>@<major> ` 围栏，内容为 JSON 参数，原地校验并渲染。不再增加一次单独的规划调用。规则规划器只保留给旧消息。
4. **不把 C01–C10 全部做成 JSON 组件。** 概念、例子、步骤、比较表用 Markdown 写作约定表达。只有要计算或要画的内容（流程、数值图、矩阵演示）才做成受控块。这样行文质量、流式能力和 token 成本都更好。
5. **验收按 AGENTS.md 精简。** 不引入 73 条用例、evidence 模板或五层 gate。结构和数值由 zod 与计算内核自动校验；语义质量用固定样本离线评估；视觉效果由用户在浏览器验收。
6. **统一落点。** 不新建 `opening/workbench/presentation` 或 `opening/presentation`。结构化能力放在 jingwei，正文渲染放在 `assistant/learning-prose.tsx`。

## 切片

| 切片 | 内容 | 主要位置 | 退出条件 |
|---|---|---|---|
| S1 正文渲染 | 新增 `LearningProse`：react-markdown + remark-gfm + remark-math + rehype-katex；禁用原始 HTML，链接只允许 http(s)/mailto，KaTeX 设 `trust:false` 并限制宏与尺寸；长公式和代码在各自容器内横向滚动；Tailwind 排版（正文 16–17px、行高约 1.8、最大宽度约 720px）；用 flag 控制，旧消息直接兼容 | `assistant/learning-prose.tsx`、`message-list.tsx`、`apps/web/package.json`（锁定版本） | 单元测试覆盖 HTML/危险 URL 被拒、公式与表格渲染、渲染失败退回原文；web 类型检查通过；待用户浏览器验收 |
| S2 输出契约 | 在 `outputInstruction` 中加入写作规则（见附录）；按 TutorMode 区分：hint 不给完整答案，listen 少用结构，explain 允许小标题和例子；用 flag 灰度 | `packages/ai/src/opening/provider.ts`、`packages/domain/src/opening/tutor-policy.ts` | provider 测试覆盖指令拼装；固定样本对比改动前后（首段直答率、长度预算、Markdown 残留） |
| S3 内联受控块 | `LearningProse` 的代码块渲染识别 `jw:*`，依次走 `parseArtifact` → `decideBlock` → `BlockView`，失败时显示 `toText` 或原代码块；提示词只放精简目录（每种能力一行说明加一个最小示例），不放完整 JSON Schema；artifact 的 `provenance.origin` 设为 `"model"` | `jingwei-host.ts`、`packages/jingwei`（新增精简描述导出）、`provider.ts` | 非法、未知、超限的块都退回可读文字，且绝不执行；模型块存在时规则规划器不再重复附图 |
| S4 行内引用 | 模型在句末写 `[n]`，n 对应 `citedChunkIds` 的序号（从 1 开始），渲染为可点击的来源 chip，复用现有 viewer；越界标号按纯文本显示；没有标号时保持消息级出处栏 | `message-list.tsx`、`learning-prose.tsx`、`provider.ts` | 越界或伪造标号不生成链接；现有出处、版本提示不回归 |
| S5 笔记保留结构 | `saveSnippet` 保存 Markdown 原文并转换为 BlockNote 块；`jw` 块存为 `type:"artifact"` 块（沿用 jingwei 既定决策，viewState 不入库）；选区保存以源码为准，映射失败时退回保存整段并提示 | `opening-note-provenance.ts`、`promotions.ts` | 不涉及 migration（`content` 已是 jsonb）；provenance 校验和来源准入不变；集成测试覆盖 |
| S6 流式（后置） | provider 支持流式后再做：Markdown 逐段显示；`jw` 块在围栏闭合、校验通过前只显示占位；用 `isCurrentFrame` 防止旧帧覆盖新内容 | `provider.ts`、轮询链路 | 前提是流式传输上线，本计划不承诺 |

**顺序：** S1 → S2 → S3 → S4 → S5，S6 后置。S1、S2 影响所有消息，建议插到 jingwei PR4（笔记成果块）之前。S3 是 jingwei PR5「LLM 规划」的轻量版：同一次回答顺带产出受控块，不另加规划调用。S5 即 jingwei PR4。

**需要拍板：** S2 会改变所有模式的回答风格，默认按 flag 灰度；S5 改变笔记保存格式，不涉及 migration。

## 评估

- 固定 30 个代表性问题，覆盖事实、概念、推导、比较、流程、代码，以及 hint/explain 模式。
- 自动检查：首段是否直接回答、长度是否在预算内、是否残留未渲染的 Markdown 符号、`jw` 块解析成功率、引用标号是否越界。
- 改动提示词前后各跑一次，结果只在 PR 中对比，不建 baseline 文件。LLM 评审只做抽查，不能替代用户验收。

## 非目标

任意 HTML/JS 生成、动画视频、白板、新聊天运行时、为样式改造引入 SSE、十类组件全部结构化、第二套 Markdown 引擎同时上线。

## 通用方案（适用于其他 Agent / Chat）

1. **风格契约**：一页系统提示，即附录。
2. **稳健渲染**：支持流式的 Markdown（Streamdown，或 react-markdown 加未闭合标记修补），配齐公式、代码、表格；禁用原始 HTML。
3. **类型化岛屿**：围栏语言写成 `ui:<name>@<major>`，内容为 JSON；每个岛屿在注册表中有 zod schema 和 `toText`；未知或非法的岛屿按普通代码显示；围栏闭合后才渲染。
4. **Agent 状态分离**：工具调用和进度只由真实事件驱动，折叠成一行状态；最终回答放在最上面，过程轨迹可展开；「建议执行」与「已执行（带回执）」用不同样式。
5. **评估闭环**：固定 20–50 题，加上第三条评估中的自动检查，改动前后对比。

## 附录：写作规则（S2 草案）

```text
写作规则：
1. 第一段直接回答问题（1–2 句）；需要前提时紧跟写明，不要铺垫。
2. 只有内容超过 3 段时才用小标题，标题写判断（“误差来自采样”），不写“分析/总结”。
3. 列表只用于真正并列或有顺序的内容；连续论证用段落。
4. 公式用 $...$ / $$...$$；代码用带语言标记的围栏。
5. 依据材料的句子末尾标 [n]，n 是 citedChunkIds 中的序号；没有依据就不标，也不编。
6. 不确定或依赖假设时直接写明条件，不用加粗或语气制造确定感。
7. 仅当图比文字更清楚、且数据来自问题或材料时，才使用目录中的受控块；不输出 HTML 或脚本。
8. 结尾最多给一个与当前问题直接相关的下一步。
9. 篇幅匹配问题：事实题不超过 3 句；概念题给一个例子；用户要“简短”就简短。
```

## 回滚

每个切片有独立 flag。关闭后回到纯文本渲染和原提示词。S5 已保存的结构化笔记块仍是合法的 BlockNote 内容，不需要回退数据。
