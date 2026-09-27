# Personal-use Learning Loop Multi-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Read this file, execution.json and the assigned subplan before writing. Checkboxes are planned actions, not execution evidence.

**Goal:** 将一门真实课程、一份材料、一个卡点从首次求助接续到下一次学习，并以实际使用负担、学习证据和恢复能力决定何时扩大依赖。

**Architecture:** 复用opening现有材料、保存会话、学习观察、预算与备份组件。接续先做有来源的只读投影；学习资格与恢复分别补齐证据；单一集成者冻结契约，独立worktree按文件租约并行，按依赖串行合入。

**Tech Stack:** Node.js 20+、TypeScript、Next.js/React 18兼容、PostgreSQL、Redis/BullMQ、S3/MinIO、Zod、Vitest、Playwright、PowerShell 7。

## Global Constraints

- 用户已确认个人先用、先形成完整主流程、可靠性与实际使用并进，并要求自主分析及多agent具体计划。本轮产物为实施计划，不代表已执行业务改动或发布。
- 原[43任务总计划](2026-09-12-opening-release-implementation.md)和[CAP01–06映射](opening-release/traceability.md)继续有效。PU编号为执行切片；原task只有完整门禁满足才升verified。
- 首切片不以商业化、多人系统、图数据库、原生客户端或自训练模型为前置。邮箱/钉钉/媒体/知识结构仍为已批准扩展范围，M4与M5/Q04分别验收。
- 所有命令pwsh；每脚本首行`$ErrorActionPreference = 'Stop'`；文本读写UTF8；原生命令逐条检查退出码。保护已有dirty内容、权限、隐私、历史证据与费用边界。
- 新改代码文件≤200行；UI仅Tailwind、lucide-react；包级AGENTS、PRD与UX/AI政策仍适用。普通开发不再逐步请用户选择，付费/生产/新数据授权按原明确边界执行。

## 1. 证据基线与具体问题

[V]表示本轮已读到代码/文档，非本轮运行产品测试；[H]是需失败用例验证的静态风险；[T]尚无本轮实证。

| 结论 | 依据与处理 |
| --- | --- |
| [V] 今天页已有真实最近会话与confirm/continue等状态 | `apps/web/src/features/opening/planning/today-read.ts`、`today-service.ts`；复用而非重建首页 |
| [H] 待确认分支可能遮住继续入口，部分确认链接指向API | `apps/web/src/app/(opening)/opening/today/page.tsx`、today-read；PU03写可见行为失败测试再改 |
| [H] 缺问题/版本/可信核验的学习记录可能升独立状态 | `learning-summary.ts`、learning/read-service、observation-service；PU04先复现，已有通过则记反证，不盲修 |
| [V] 现有恢复组件不等于发布和apply | [当前运维边界](../../operations/opening-release.md)、[9/25备份集成计划](2026-09-25-opening-backup-integration.md)；PU05沿用现成组件 |
| [H] 无材料source的记忆删除需在独立journal保留memory身份 | `opening-memory-delete.ts`只为实际source写exclusion；PU05A0用旧包恢复负例核验 |
| [T] 真实模型效果/费用、真机、完整恢复与SHA绑定交付仍需各自证据 | [9/24记录含9/25续验](../evidence/2026-09-24-opening-isolated-acceptance/verification.md)的fixture/local边界；不按测试数量推定长期可用 |

原设计已包含G2/R2c接续卡和微学习闭环；本计划细化首切片，不另建学习平台。只读首切片没有用户确认的“下一步”，明确返回null；完整R2c保存/修改确认断点继续留在原G2，不虚报完成。PU07报告收集其实际需求与负担，为后续写入切片提供验收样本。

## 2. 文件入口和执行账本

- [00 协作协议与PU00基线](personal-use/00-execution-protocol.md)：dirty快照、worktree、资源/文件租约、审查与合入。
- [04 PU01共享契约](personal-use/04-contracts.md)：唯一schema owner、输入输出定义、兼容测试与迁移预约。
- [01 接续PU02–PU03](personal-use/01-continuity.md)：只读投影、Today显示、来源/版本/删除与重返行为。
- [02 学习价值PU04/PU07](personal-use/02-learning-value.md)：证据资格、offline/live评估、短周期真实使用与停止条件。
- [03 可靠性PU05/PU06/PU08](personal-use/03-reliability.md)：独立删除日志、真实导出/恢复、受控准入与日常交付。
- [execution.json](personal-use/execution.json)：12个执行节点的owner、依赖、原任务映射、入口/操作门禁、出口证据与状态；初始全部planned。现有原计划validator不代管这些新增门禁，协调者按协议核对，本轮不新增自动调度器。

| 节点 | 唯一负责角色 | 交付 | 前置 |
| --- | --- | --- | --- |
| PU00 | COORDINATOR | 可复现snapshotCommit、允许文件清单、迁移预约和隔离服务租约 | 无 |
| PU01 | COORDINATOR | 接续/学习/恢复严格schema及consumer fixtures、contractRevision | PU00 |
| PU02 | CONTINUITY_DATA | 有来源、版本与隐私过滤的只读接续投影 | PU01 |
| PU03 | CONTINUITY_UI | 不被旧建议挡住的继续入口和真实浏览器恢复 | PU02 |
| PU04 | LEARNING | 关闭错误学习升档、离线评估器、显式受限live适配 | PU01 |
| PU05A0 | RELIABILITY | 无source记忆也受保护的独立删除journal | PU01 |
| PU05A1 | RELIABILITY | 17表/真实对象导出与归档集成，继承9/25切片 | PU05A0 |
| PU05B | RELIABILITY | 发布可见性协议和事务restore apply | PU05A1 |
| PU05C | RELIABILITY | 隔离真实恢复、readiness实际探针、运维协议 | PU05B |
| PU06 | INTEGRATION | 合成/脱敏资料受控试用准入，fixture模型只验流程 | PU03、PU04 |
| PU07 | PILOT | 7日自然使用观察，最多一次7日续观；可用性与效果分开 | PU06，另需有效live许可/质量核验 |
| PU08 | INTEGRATION | M4基础日常可依赖的完整验收；M5/Q04单列 | PU05C、PU06、PU07 |

优先波次：PU00→PU01；再PU02+PU04；PU02合入后PU03与PU05A0并行；PU05后续保持同owner串行，可与PU06/PU07并行准备。最多2个实现agent+1审查agent+协调者；重型服务检查全局串行。契约/exports/runtime/迁移/CI/原账本均协调者单写。

## 3. 主流程验收矩阵

| 场景 | 必须观察到的结果 | 节点／证据 |
| --- | --- | --- |
| AC-P01 材料进入后离开 | 同一材料状态可找回；失败仍可下载原件，真实字节相等 | PU03、PU06；真实API/对象存储，trace和hash |
| AC-P02 带尝试求助 | 出处支持回答；提示/完整解释区分；不支持时承认未知 | PU04；逐例live人工核验，fixture不得替代语义 |
| AC-P03 刷新/换端 | 同一逻辑请求与已存结果；未知计费不自动重试 | PU06；幂等/中断/真实多context与预算账本 |
| AC-P04 次日继续 | ≤1次点击回同会话，原问题/来源版本准确；未知下一步不编造 | PU02、PU03、PU07；自动导航与实际跨日分别记录 |
| AC-P05 独立与延迟验证 | 帮助曝光不洗掉；新题和参照可信；缺测不当失败 | PU04、PU07；资格负例与自愿真实尝试 |
| AC-P06 停用后回来 | 候选可忽略、不强迫清积压、不改正式计划、关键期限不自动消失 | PU03、PU06；30天时间夹具+行状态前后比较 |
| AC-P07 更正/删除/恢复 | 旧材料/旧认识不复活；已删source/memory不回流；不恢复付费任务或凭据 | PU02、PU05、PU06；并发与新目标库恢复证据 |

旧学习偏好更正/临时过期仍由原M01/M03验收；本切片使用其既有机制，PU06补跨模块负例。来源版本变化不直接解释为能力下降。新学期/目标变化的长期效果仅在真实经历出现后记录，不以时间夹具宣称数月有效。

## 4. 三档准入与退出

1. **controlled-trial-local（PU06）**：所有相关权限/隐私/费用失败路径通过，无未处理阻塞级缺陷；只用可替换合成/脱敏资料并保留原件。并非M4发布，不启用敏感长期采集，不以新门禁绕开原Q依赖。
2. **personal-pilot（PU07）**：PU06成立，live许可/正定价/持久费用上限有效，选定能力的真实质量样本已判读；缺外部配置=not_started。观察阈值是小样本操作门槛，不是科学效能结论。
3. **daily-reliable-foundation（PU08/M4）**：Q03真实恢复/运维→Q01完整安全集成→Q02真实模型/真机，最终SHA对应PR/CI及手验；原扩展M5/Q04继续单列，不以外部CAP缺口冒称全量完成，也不让M4暗中依赖M5。

任一越权、删除复活、帮助后误标独立、超预算或关键有依据错误→停止相关能力、保留原件、失败回归后再放行。观察机会不足记observe，不催用户凑样本。系统制造的确认/维护负担超试点停止线时先减负，不继续加功能。

## 5. 合入、回退与后续扩展

- 每任务先规格、后质量独立审查；协调者在组合树复跑相邻接口与关键负例。文档/源码扫描、unit、集成、浏览器、live、真机、恢复、CI分别报告。
- 代码依赖快照不等于发布：交付按[仓库Git流程](../../../.agents/skills/aistudy-git-workflow/SKILL.md)。push/生产部署/真实迁移按已有授权边界；未授权时交本地可审阅结果，不伪报远端证据。
- 回退只影响对应功能入口/应用版本；不删除学习记录，不逆删隐私日志，不释放unknown费用，不自动重放job。PU05迁移回退保留journal，停止新恢复入口。
- CAP01–06仍沿用X01/C01–C03/V01/K01–K02/P04/U04/Q04，具体任务/接口已在原子计划。PU07结论只帮助细化顺序，不自动删范围、换架构或提升状态。
- 本轮不增加定时自动化。备份、演练周期和费用建议均为待实施约定，不能在聊天中声称已开启后台监督。

## 6. 计划核验与执行起点

本轮由三个agent分别完成三个子计划，协调者统一契约与依赖，另由接续agent只读审查协作/学习文档。中途服务503及用户中断后先检查残留再继续，未将失败轮次计作完成。审查发现的迁移空档、原生命令退出码、费用读取接口、延迟时间字段、调度门禁与文件租约均已修订；真实核验命令见[本轮验证记录](personal-use/verification.md)。

**开始执行：** 协调者先执行PU00。没有snapshotCommit不分派代码实现；没有contractRevision不并行接口消费者。依据execution.json取得已满足依赖的节点，附00协议派发，逐项记录证据。本轮计划文件完成不使任何PU节点变verified。
