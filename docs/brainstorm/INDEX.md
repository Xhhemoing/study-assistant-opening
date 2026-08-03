# Brainstorm 索引

本表是项目研究和候选决策的唯一登记入口。状态含义见 [README](README.md)。

## 活跃研究

| 日期 | 主题 | 状态 | 指向板块 | 主要结论 | 正式落点 |
|---|---|---|---|---|---|
| 2026-08-02 | [自适应学习决策、记忆与持续校准系统](2026-08-02-adaptive-learning-decision-governance.md) | proposed | Learn、Planner、Assessment、AI、Worker、数据治理 | 采用规则、统计估计和 AI 候选生成的受治理混合架构；以 7/30 天独立与迁移为北极星，经配置快照、低风险探索、帕累托计划和灰度回滚持续校准 | PRD 指标、Planner/Assessment/Memory/AI 设计、事件与决策契约、实验治理 ADR |
| 2026-07-30 | [项目设定调研总图与实施决策门](2026-07-30-project-research-agenda-and-decision-gates.md) | proposed | 产品定位、大学/终身学习、AI、学习证据、数据治理、可靠性、生态 | Task 9–11 可继续；Task 14/21/24 前分别完成 AI 数据边界、事件/作品语义和能力评价研究；高级能力按证据触发 | PRD/场景、AI 与数据治理设计、学习事件/评价契约、实施计划研究门 |
| 2026-07-30 | [Migration Registry 的可验证升级与并发安全](2026-07-30-migration-registry-reliability.md) | promoted | Database migration、CI、发布运维、Gate 0.2 | PostgreSQL registry 状态机、numeric parser、checksum、advisory lock 与唯一 canonical runner | Phase 1 Gate 0.2、runner、CLI 与运维手册 |
| 2026-07-30 | [身份迁移的数据保全与预检策略](2026-07-30-identity-migration-safety.md) | promoted | Workspace ownership、Database migration、Gate 0.1 | 以确定性 fail-closed 预检和可审计人工映射保证零删除、零误归属 | Phase 1 Gate 0.1、迁移运维文档与 preflight 实现 |
| 2026-07-29 | [外部学习触发、采集与跟踪闭环](2026-07-29-external-learning-capture-and-follow-through.md) | proposed | 全局捕获、Explore、Learn、Library | 用 `Source → LearningIntent → Task → Artifact/Evidence` 连接多源收藏与真实学习结果 | 待新增采集闭环设计并修订实施计划 |
| 2026-07-29 | [学习记忆系统与插件化多源处理](2026-07-29-learning-memory-and-plugin-ingestion.md) | proposed | Source、AI、Worker、搜索、学习事件、插件 | 正式领域对象与可重建记忆投影分离；连接器协议化、增量化和隔离运行 | 待新增记忆设计、插件协议与 ADR |
| 2026-07-29 | [项目算法与做法地图](ALGORITHM_MAP.md) | exploring | 全项目 | 为每个板块定义基线、升级路径、指标和回退条件 | 持续提升到各设计、ADR 和任务 |

## 待调研队列

这些主题影响面较大，应按实施依赖逐项研究，不代表已经选择某种算法。

| 优先级 | 主题 | 决策问题 | 前置数据/任务 | 预期落点 |
|---|---|---|---|---|
| P0 | AI 支架与 Provider 数据边界 | 不同 AI 角色何时促进学习、何时污染证据；哪些数据可发送和保留 | Task 14 前的角色原型、数据流与小型交叉实验 | AI 权限/数据治理设计、Task 14 验收门 |
| P0 | 学习事件、复杂作品与验证语义 | 阅读、翻译、提示、提交、论文、代码、实验和团队贡献分别能证明什么 | Task 21 前的真实任务样本与领域工作坊 | Event/Artifact/Feedback/Verification 契约 |
| P0 | 能力构念、公平性与不确定性 | 四档状态何时有意义，何时必须 unknown/disabled/suppressed | Task 24 前的事件资格表、人工金标与切片回放 | Assessment 设计、Task 24 验收门 |
| P0 | 数据用途、保留、删除与未成年人 | 事件、来源、AI 提示、供应商日志和备份如何满足目的限制与删除 | Task 14/21 前的数据流、条款与法务/隐私审查 | 数据治理政策、Provider/Retention 契约 |
| P1 | 首个价值楔子与真实学习旅程 | 考试、外部学习闭环和长期知识工作台哪个应成为首个可验证场景 | 用户访谈、两周日记研究、可交付原型 | PRD、首个试点与成功指标 |
| P1 | 计划压力、无障碍与学习者差异 | 计划、风险和提醒怎样帮助执行而不制造压力或排除用户 | Task 19/25 前的纵向日志与辅助技术测试 | UX/指导模式/Planner 设计 |
| P1 | 来源权利、锚点与多模态忠实度 | 哪些来源可保存、解析、发送 AI、导出；结构和引用如何降级 | 受控语料、法务矩阵和威胁模型 | Source/Parser/Reader 设计 |
| P0 | 来源去重与版本识别 | URL、文件、仓库和社交内容何时视为同一来源或新版本 | Source/Snapshot 契约 | 来源基础设计 |
| P2 | 多路混合检索与重排 | 关键词、语义、关系、时间和权限怎样融合 | 全文基线、可评测的检索语料和查询集 | 搜索设计/ADR |
| P1 | Task 与 PlanItem 排序 | 如何在自由度、期限、风险和时间预算间排序 | LearningIntent/Task 契约稳定，Task 25 前完成回放与负担评估 | Learn/Planner 设计 |
| P1 | 复习调度 | 规则基线、FSRS 或其他调度何时优于现有策略 | Review/Attempt 事件和回放集 | SRS Spike/ADR |
| P1 | 能力证据与状态校准 | 如何按能力切片给出可解释、校准的状态 | 高质量 Attempt/Artifact/Feedback | 预测模型设计 |
| P1 | 内容和任务推荐 | 如何优化实际学习结果而非点击或停留 | 可靠反馈和反事实评估策略 | 推荐设计 |
| P1 | 主题聚类与知识关系候选 | 如何控制重复、漂移和错误关系 | 多源内容集与人工标注 | Library/AI 设计 |
| P2 | 时间知识图谱 | 何时关系表不足，值得引入图存储或图投影 | 路径查询和规模基准 | 架构 ADR |
| P2 | 离线同步与冲突合并 | 不同资产类型分别采用何种合并策略 | 客户端与离线需求批准 | 同步 ADR |
| P2 | 平台专用连接器 | GitHub、Zotero、社交平台怎样处理权限和增量同步 | 通用插件协议稳定 | Connector 设计 |

## 使用规则

- 新增研究先复制 [研究记录模板](templates/research-note.md)，再在本索引登记。
- 一个记录必须指向具体产品流程、领域对象、代码边界或计划任务。
- `proposed` 只能表示“建议批准”，不能被当成正式规格。
- 提升到正式文档后改为 `promoted`，并补充目标链接。
- 研究被推翻时使用 `rejected` 或 `superseded`，保留原因和替代链接。
