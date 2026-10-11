# AI 主讲学习空间 v2 — 二次开发章程

**Date:** 2026-10-11  
**Baseline tip:** `1a4cf465c86da7f08b6fda3044f9b0f932b80824` (`feat/opening-release`)  
**Source plan:** `docs/superpowers/plans/ai-led-learning-v2/plan.md` + `tasks.json`（30 项，状态均为 proposed）  
**Task id:** V2-00

## Outcome

首个可试用版本必须是一段真实的 **AI 主讲闭环**：进入 → AI 开始教学 → 局部追问或换解释 → 实际尝试与反馈 → 暂停 → 跨端继续 → 可选独立题/后续回顾。可以只覆盖一门课的一个单元（建议样例：线性代数「秩与零空间」），但不能把「阅读器 + 聊天先上线、主讲以后再做」当作本版本交付。

## Goals (G1–G8)

| ID | 目标 | 硬约束（偏离反例） |
|---|---|---|
| G1 | AI 主讲 | 首页以开始/继续学习为主；主区是 AI 组织的内容。反例：必须先翻页选段才得到教学 |
| G2 | 完整陪伴 | 理解→探索→实践→反馈→沉淀→复习→恢复可连续。反例：功能孤岛、反复搬运上下文 |
| G3 | 用户自主 | 不强制先建课程；可跳过、看讲解、改道、退出。反例：先测验才允许阅读 |
| G4 | 可靠个性化 | 偏好可调、反馈分型、依据不足不介入。反例：停留久就判卡住；点赞直接提高掌握 |
| G5 | 合适表达 | 同语义驱动文字/公式/图示/交互，局部可改。反例：整页任意代码；图文参数不一致 |
| G6 | 证据诚实 | 来源、核验、帮助、能力维度与未知可区分。反例：有引用 ID 就称事实正确 |
| G7 | 连续恢复 | 保留位置、思路、尝试、帮助与未决问题。反例：只恢复聊天窗；生成失败丢草稿 |
| G8 | 增量可靠 | 复用原栈、事实账本、授权/预算/CI。反例：推倒重建、复制评分系统、绕过门槛 |

## Explicit non-goals (this wave)

虚拟老师形象、多 Agent 同学课堂、社交/课程市场、更多通讯平台、全新微服务或图数据库、未经本项目数据验证的掌握率预测、端到端任意脚本生成、语音/动画数量竞赛。已有阅读器、资料管理、自由探索、笔记与日程保留，转为证据与时间支持，不通过删除老功能制造“简洁”。

## Integration constraint (Paula 2026-10-11)

新能力必须嵌进现有学习路径与界面，不能另开一套突兀入口或平行产品面：

- 复用 Today / 助手 / 资料 / 证据账本与现有导航；AI 主讲是主区演进，不是旁路新 App
- 新接口与组件接入现有契约与样式（Tailwind、lucide-react），不平行造第二套事实或评分
- 入口优先落在现有「继续学习 / 开始学习」与活动流，不强迫新问卷或孤立落地页

## Conflict with prior scope

旧 K02a 等排除「一键课堂 / AI 主讲」的范围 **以本章程为准修订**：AI 主讲是首版主体验。不删除安全、权限、隐私 epoch、预算与证据约束。

## Facts ledger (do not fork)

继续以现有 `learning` 事实服务与 Observation/Attempt/Exposure 资格判定为唯一事实源。禁止另造「AI 说会了」分数系统；Episode 只读投影不得成为第二套评分来源。

## Milestones

| Milestone | Tasks | Exit |
|---|---|---|
| **M0** 目标与兼容边界 | V2-00–03 | 章程无冲突；迁移/接口影响清楚；无平行评分系统 |
| **M1** 第一个 AI 主讲闭环 | V2-04–16 | 真实模型主讲 + 追问 + 偏好 + 互动 + 尝试反馈 + 暂停恢复 |
| **M2** 连续个性化 | V2-17–22 | 跨天/材料/端连续；用户可修正偏好与证据解释 |
| **M3** 扩展与研究 | V2-23–29 | 扩展不伤主线；效果声明与证据相称 |

**Critical path (M1):** V2-03 → 04/05/06/07 → 08/09/10 → 12/13/14/15 → 16.

## First batch (M0) — assigned next

1. **V2-00**（本文件）— 章程收口  
2. **V2-01** Integrator — 修复 `material-library.tsx` / `react-hooks/exhaustive-deps` 导致的真实 CI 失败；核对运行配置  
3. **V2-02** AI + Experience — 建立可核查教学单元与评测样本（秩与零空间样例）  
4. **V2-03** Data — 活动/内容/证据兼容边界 ADR（无课程 activity、统一资产、不平行评分）

## Acceptance for V2-00

- [x] 无「阅读器先行、主讲后补」条款  
- [x] 无「强制全流程」条款  
- [x] 无「AI 自动授予掌握」条款  
- [x] 派工以 `docs/superpowers/plans/ai-led-learning-v2/tasks.json` 为准，不覆盖旧 opening-release 账本成功记录  

## Evidence layers (do not collapse)

工程通过 ≠ 真实模型通过 ≠ 用户浏览器验收 ≠ 学习效果已知。各任务在 `tasks.json` 的 `evidence_status` 分开记录。

## Authorization

代码改动、迁移、push/hermes 仍按现有规则：实现者不自 Accept；仅 Projects Manager 对接 Paula 做 push/deploy 授权。
