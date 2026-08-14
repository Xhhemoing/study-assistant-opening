# TODO — AIstudy 优化代办

> 来源：graphify 架构理解 + 程序泛用性 / 学习闭环完整度审计（2026-08-13）
> 经 gpt-5.6-sol（正常分组）交叉验证后修订：P0 收缩为"状态不可修正/不可解释"问题，多目标接入下调至 P1，判题正确性提前到 P1 前段。

## P0 — 统一学习 evidence 与纠正重算（状态不可修正/不可解释）

- [x] 统一 attempt / review / correction 的 evidence 模型（`EvidenceEvent.source`、`reviewGradeToEvidence`、review 计入 recall 能力证据）
  - 位置：`packages/domain/src/assessment/status.ts`、`apps/web/src/lib/data/mock/provider-plan.ts`
- [x] 让状态纠正触发重算：`recordStatusCorrection` 支持 `overrideStatus`；note-only 标记为 `user-disputed`，均接入 `deriveStatus` 并带纠正说明
  - 位置：`provider-plan.ts`、`status.ts`
- [x] 明确状态时间语义：事件按 `occurredAt`（发生时间）排序，乱序/迟到事件不影响正确归位（已补回归测试）

## P1 — 判题正确性与计划/领域泛化边界

- [x] 判题下沉 domain：新增 `packages/domain/src/practice/grading.ts`（删 web 副本）；short_answer 的 ASCII/数字改为 token-boundary 匹配（修复 "12" 匹配 "2" 的误判），CJK 保留子串语义
- [x] syllabus 解耦：`MockProviderOptions.syllabus` 可注入，默认 `SEED_SYLLABUS`；`provider-plan.ts` 不再直接 import 常量
- [~] 多目标接入（部分完成）：`activeGoals` 聚合所有未归档目标的 `dailyMinutes` 预算已接入；课程 requirement profile / `computeEffectiveRequirements`（能力权重、评估开关）未接入——mock 缺课程↔考点映射，需产品规则后再接
  - 位置：`provider-plan.ts` planForDate、`packages/domain/src/goals/effective-requirements.ts`、`courses/requirements.ts`
- [ ] scenario 去考试硬编码：`contracts/goals.ts` 的 `scenarioPresetSchema = z.enum(["final","gaokao","kaoyan","custom"])` 建模为可扩展计划策略/配置（需设计决策：preset = id+version 数据驱动，而非扩枚举）

## P2 — 错误到干预的自动闭环

- [ ] 在 evidence 与状态推导稳定后：错误分类、步骤提示、变式、复习卡生成、7 天干预窗口及干预效果反馈（依赖真实 AI provider 或规则候选）
