# ADR-015：聊天回答中的 SenseWeave 片段（SW0）

**状态**: 提议（草稿 PR，待评审）
**日期**: 2026-10-24

## 背景

现在助理回答由 `LearningProse` 渲染（Markdown、KaTeX、引用角标、选区映射回原文）。`OPENING_CHAT_ARTIFACTS` 打开时，经纬规则规划器会在回答**下方**额外生成一张图解，同一内容会出现两次。SenseWeave Runtime 能在本地、确定性地判断回答中的某一段（Mermaid 流程、带单位的数据表、按序的成绩、按天的计划）是否更适合用组件呈现。它不调用模型，并保证原文无损。

## 决策

1. **原样拷贝**：上游 `SenseWeave-Runtime` 的运行时代码拷贝到 `packages/senseweave/vendor/`，来源、版本和提交号记录在 `VENDOR.json` 中。不在本仓库修改，改动回到上游。包名 `@aistudy/senseweave`，只暴露两个入口：`/host`（决策与切分，纯函数）和 `/block`（浏览器挂载单块，组件代码首次出现时才加载）。
2. **嵌入方式**：回答**完成后**做一次决策。被选中的片段原位换成无外框组件，其余片段仍由 `LearningProse` 渲染，并带上原文偏移（`sourceOffset`），所以选区、存笔记、引用照常工作。流式输出期间不切分。
3. **开关**：`OPENING_CHAT_SENSEWEAVE=off|shadow|on`，默认 `shadow`，通过 capabilities 下发；`OPENING_CHAT_PROSE=0` 时强制 `off`。
   - `shadow`：只计算，界面与 `off` 逐字相同；诊断模式下显示“SenseWeave（影子）：选择了什么 · 预设 · 耗时”。
   - `on`：显示组件。每个组件下有“改回文字”，作为显式反馈保存在本地（localStorage），影响以后的选择。
4. **避免重复**：`on` 模式下，回答一旦被 SenseWeave 增强，就不再显示经纬规则图解。
5. **预设**：按学习者的问题选择保守预设（hint/review/plan/data/compare/derive/explain）。预设只**收窄**可用组件，不新增内容；所有预设都不启用 `exercise` 和 `math`（批改和 TeX 仍由现有链路负责）。

## 许可

上游为 GPL-3.0-only，AIstudy 为 AGPL-3.0-only。GPLv3 第 13 条与 AGPLv3 第 13 条允许二者组合；组合作品整体按 AGPLv3 分发，拷贝的文件保留其 GPLv3 许可与 `LICENSE`。

## 后果

- 新增依赖仅为本地拷贝，无网络、无模型调用；决策代码约 30 KB gz，组件代码约 33 KB gz，只有出现第一个组件时才加载。
- 回滚：设 `OPENING_CHAT_SENSEWEAVE=off`，无需发版；无数据迁移。
- 后续（不在本 ADR 范围）：SW1 用 shadow 数据评估误增强率和“改回文字”率；SW2 在系统提示中加入 `instructions(preset)`，并按产品模式传递预设，取代按问题猜测。

## 验收（用户负责浏览器验收）

见 PR 说明：入口、前提、操作步骤与预期结果。
