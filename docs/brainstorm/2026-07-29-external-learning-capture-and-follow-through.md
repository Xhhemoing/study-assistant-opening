---
title: 外部学习触发、采集与跟踪闭环
date: 2026-07-29
status: proposed
scope:
  - 全局捕获与收件箱
  - Explore / Learn / Library
  - Source / LearningIntent / Task / Artifact / LearningEvent
related:
  - ../plans/2026-07-21-lifelong-learning-design.md
  - ../plans/2026-07-21-lifelong-learning-implementation.md
  - ../product/PRD.md
promotion_target:
  - 外部学习采集与跟踪闭环设计
  - PRD 与实施计划增量修订
---

# 外部学习触发、采集与跟踪闭环

## 1. 决策问题

AIstudy 如何承接用户在文献、GitHub、软件教程和社交收藏中产生的碎片化学习需求，并把它们推进到理解、行动、产出、验证和复盘，而不是形成新的收藏坟场？

## 2. 明确指向

| 层次 | 指向 |
|---|---|
| 用户场景 | 划词翻译后追问；软件上手；GitHub 待读/评估/应用；社交收藏归纳 |
| 全局能力 | 分享、URL、文本、截图、文件和浏览器扩展捕获 |
| Explore | 收件箱分诊、理解、比较、开放问题和候选沉淀 |
| Learn | LearningIntent、Task、重新出现、实践与验证 |
| Library | 确认后的来源、笔记、关系、程序和作品 |
| 领域对象 | Source、Snapshot、Anchor、Annotation、LearningIntent、Task、Artifact、LearningEvent |

不新增第四个顶层 Inbox。Inbox 是贯穿三个入口的采集与分流能力，不是一种新的学习目的。

## 3. 已验证事实

- 已批准设计具有三个平等入口，并定义 `Source/Snapshot/Annotation`、探索、任务、作品和学习事件等边界。
- 当前数据库只落地 Library 文档、块、修订、关系和属性；来源、采集、翻译和跟踪闭环尚未实现。
- 当前实施计划的搜索任务假设 Source 已存在，而来源基础被放在更晚任务，存在依赖断层。
- 用户明确要求覆盖四类日常学习触发，并连接到后续解决和实际应用。

## 4. 产品不变量

- Source 不等于 Task；一个 Source 可以承载多个学习意图。
- Task 不等于 LearningEvent；计划完成不自动证明掌握。
- 翻译、摘要、收藏和打开只能作为接触/辅助事件，不能成为能力证据。
- 同一来源、笔记和作品保持工作区级稳定身份，通过关系进入多个课程或项目。
- AI 只创建摘要、关系、任务和修订候选，不静默覆盖正式资产。
- 平台连接器失败时，URL、文本、截图、文件和手工粘贴仍需可用。

## 5. 统一学习链路

```text
外部触发
→ CaptureEnvelope
→ Source + Snapshot + Anchor
→ LearningIntent（为什么保存、期望结果）
→ Task/Trigger（下一步和重新出现条件）
→ Processing Session（阅读、试用、练习、创作）
→ Artifact + LearningEvent
→ Verification
→ Review / Archive / Drop
```

建议 LearningIntent：

```text
kind: read | understand | evaluate | try | apply | cite | monitor
state: inbox | ready | active | waiting | done | dropped
fields: desiredOutcome, nextAction, reviewAt, timeBudget,
        course/project/goal refs, verificationRule
```

## 6. 场景映射

| 来源 | 意图 | 验证结果 |
|---|---|---|
| 文献术语/选区 | understand、cite | 能无提示解释、在语境中使用或正确引用 |
| 新软件/教程 | try、apply | 跑通真实用例并保留操作/失败记录 |
| GitHub 仓库 | read、evaluate、try、apply、monitor | Demo、比较报告、采用决定或集成代码 |
| 社交收藏 | read、evaluate、apply | 少量专题结论、行动或作品，其余主动归档 |

GitHub 仓库是 Source，commit/release 可形成 Snapshot；“待读、试用、采用、监控”是不同 Intent。平台类型不得成为新的根资产模型。

## 7. 推荐方案与扩展性

先做平台无关的纵向切片：

1. URL/文本/文件捕获和来源去重；
2. 收件箱分诊、Intent、下一步和重新出现；
3. 实践/产出/验证结果回链；
4. 再增加划词翻译、GitHub、软件上手和社交批量归纳处理器；
5. 通用协议稳定后再建设浏览器扩展和第三方连接器 SDK。

来源识别先采用外部 ID、规范化 URL、版本键和内容哈希；近重复算法只能提出合并候选。任务排序先采用可解释规则，待真实事件足够后再评估约束优化或策略学习。

## 8. 验收与效果指标

必须覆盖：

- 捕获后无需课程或目标即可进入 Explore；
- 同一来源重复捕获不复制正式资产，但可新增 Intent；
- 来源更新形成 Snapshot，不破坏旧 Anchor；
- Intent 可转成多个 Task，并可完成、等待、放弃或归档；
- 每个“完成”都按 verificationRule 判断；
- 翻译/摘要不会提升能力状态；
- 连接器失败时仍可手工导入；
- 删除或失效来源不会留下不可解释的 AI 结论。

核心指标：首次捕获耗时、捕获后完成分诊比例、Intent 到有效产出比例、验证完成率、主动归档率和未处理积压年龄；收藏数与停留时长不作为主要成功指标。

## 9. 风险

- 平台接口、登录态、反抓取和内容失效；
- 网页内容提示注入、恶意附件和版权限制；
- 自动摘要造成错误归纳；
- 过度提醒将自由探索转成压力系统；
- 自动去重误合并不同版本或语境。

## 10. 正式化路径

批准后应在当前应用壳独立完成的前提下：

1. 新增正式采集闭环设计；
2. 修订 PRD 的日常流程和验收场景；
3. 在现有 Task 12 前补来源、采集和 LearningIntent 基础任务；
4. 明确 Source/Intent/Task/Event/Artifact 契约与数据库边界；
5. 为连接器失败、版本更新、重复捕获和验证规则建立 TDD 场景。
