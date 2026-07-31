---
title: 身份迁移的数据保全与预检策略
date: 2026-07-30
status: promoted
scope:
  - Workspace ownership、Library revision、Course membership
  - packages/database migration runner 与 Gate 0.1
related:
  - ../plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md
  - ../architecture/ARCHITECTURE.md
  - ../../packages/database/src/migrations/0003_identity.sql
promotion_target:
  - ../plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md#gate-01修复身份迁移的数据保留风险
  - ../operations/database-migrations.md
  - ../../packages/database/src/migration-preflight.ts
---

# 身份迁移的数据保全与预检策略

## 1. 决策问题

旧版 `0003_identity.sql` 会删除无法关联 `users` 的 workspace，并临时关闭 revision 的不可变保护。Gate 0.1 必须选择一种升级策略，在不能可靠推断 owner 时保全全部学习资产，同时让正常数据库以低开销继续迁移。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 旧数据库升级后，用户的笔记、历史版本、课程及资产关系不能静默消失 |
| 产品入口/流程 | Library、Learn 及所有依赖 workspace ownership 的流程 |
| 领域对象 | Workspace、Document、Block、Revision、Relation、Property、Course、AssetMembership |
| 代码边界 | `packages/database/src/migrate.ts`、migration preflight、`0004_identity_repair.sql`、集成测试 |
| 计划任务 | Phase 0 Gate 0.1；Gate 0.2 将继续统一 registry/checksum/并发规则 |

## 3. 不变量与约束

- orphan workspace 不能被删除、自动转让或通过级联清理。
- `library_revisions` 始终保持 append-only；失败路径也必须恢复 trigger。
- owner 映射只能来自明确、可审计的操作者输入，不能由邮箱、时间或内容猜测。
- 历史 `0003_identity.sql` 不修改；已发生的数据删除无法由 corrective migration 自动恢复。
- 2 GiB VM 上预检不得加载资产正文或 revision JSON；只做 workspace 级聚合计数。
- PostgreSQL 是事实源，迁移事务失败后不得留下部分 schema 或部分映射。

## 4. 已验证事实

- `0003_identity.sql` 第 34-43 行关闭 revision triggers、删除 orphan workspace 后再启用 triggers。
- `0001_library.sql` 和 `0002_courses.sql` 中多个表通过 `ON DELETE CASCADE` 引用 workspace，因此一次 workspace 删除会扩散到文档、版本与课程数据。
- 当前 runner 只按文件名排序并记录 migration ID，没有 preflight、checksum 或 legacy verification state；后者属于 Gate 0.2。
- 已批准的 Phase 1 计划明确选择“迁移前预检并阻断”，禁止自动删除和伪造 owner。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 生产库是否已执行旧版 `0003` | 可能已经发生不可恢复删除 | operator attestation、备份和数据库状态检查；Gate 0.2 正式化 |
| 真实旧库 orphan 数量与资产规模 | 聚合查询可能在超大库变慢 | `EXPLAIN ANALYZE` 与迁移窗口基准；必要时增加既有 FK 列索引 |
| owner 映射的组织审批来源 | 错误映射构成越权 | 运维流程要求映射来源、操作者、时间和数据库 fingerprint |

## 6. 候选方案

### 方案 A：确定性 fail-closed 预检

以 orphan workspace 为驱动集合，对各资产表做聚合计数；存在任何 orphan 即抛出稳定错误码并回滚。待操作者提供审计映射后再次运行。这是已批准基线。

### 方案 B：自动 quarantine workspace

将 orphan 数据移动到系统隔离 owner 下，迁移可自动继续，但会改变 ownership 语义并引入额外状态、访问策略和恢复工具。在当前契约未定义 quarantine 前风险高于收益。

### 方案 C：启发式 owner 推断

按历史 ID、邮箱或活动关系猜测 owner。它可能减少人工工作，但误归属会导致跨用户数据泄漏，且当前数据没有可证明的映射依据，因此拒绝。

## 7. 算法评估

| 维度 | A：fail-closed | B：quarantine | C：启发式推断 |
|---|---|---|---|
| 目标效果 | 数据零删除、零误归属 | 数据保留但临时改属 | 自动完成率高但可能误归属 |
| 数据需求 | schema 与 owner 映射 | 新系统 owner/隔离状态 | 高质量身份关联特征 |
| 延迟/吞吐 | O(workspace + 关联索引扫描) | 额外批量更新与约束处理 | 推断与人工复核成本不确定 |
| 成本 | 实现与运维成本低 | 中高 | 高 |
| 可解释性 | 每个 orphan 与计数可审计 | 可解释但语义复杂 | 较差 |
| 隐私与安全 | 默认拒绝，最安全 | 隔离策略错误会暴露数据 | 误归属直接越权 |
| 可迁移/可回滚 | 事务回滚简单 | 需要反向映射和状态迁移 | 错误写入难恢复 |
| 扩展性 | 资产表清单需随 schema 维护 | 需扩展所有授权路径 | 特征与模型持续维护 |
| 失败降级 | 保持原库不变并人工处理 | 停在 quarantine | 必须回到人工处理 |

## 8. 推荐结论

- 推荐方案：A，确定性 fail-closed 预检与显式审计 owner 映射。
- 适用边界：身份迁移和新增 owner FK 之前的数据状态检查。
- 暂不采用：quarantine 和任何启发式/模型化 owner 推断。
- 升级触发条件：真实迁移数据显示 orphan 规模使人工映射不可执行，且先有正式 quarantine ownership/授权 ADR、恢复工具和安全测试。
- 回退方案：事务回滚，保留原数据库，恢复到已验证备份并完成人工处置。

## 9. 验证计划

- 数据集或测试夹具：旧 `0001`/`0002` schema，含一个正常 workspace、一个 orphan workspace，以及 document、block、revision、relation、property、course、membership。
- 当前基线：运行旧 `0003` 会删除 orphan 及级联资产。
- 离线指标：行保留率 100%；误归属 0；失败事务后的 trigger 启用率 100%。
- 线上/产品指标：迁移阻断必须带稳定错误码、workspace ID 与各类资产计数，不记录资产正文。
- 用户验收场景：有 orphan 时升级停止且全部行仍在；映射完整时迁移继续；历史 revision 仍不可更新或删除。
- 通过阈值：所有测试数据库场景满足零删除、零部分提交、零 trigger 漏开。
- 失败停止条件：任何行数下降、owner 被自动生成、trigger 被关闭或错误信息包含资产正文。

## 10. 风险与治理

预检结果包含 workspace ID 和数量，应进入受限运维日志，不包含标题、正文、revision blocks 或用户凭据。人工映射必须记录操作者、时间、来源、目标数据库 fingerprint 与备份证据；这些证据不能伪装成旧 migration checksum。

## 11. 正式化路径

- [ ] PRD/场景
- [ ] UX 与 AI 权限政策
- [x] 设计或实施计划
- [ ] ADR
- [ ] Contract/Schema/API
- [x] 测试与验收场景
- [ ] 监控与回滚说明

## 12. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-07-30 | promoted | 记录并解释 Gate 0.1 已批准的 fail-closed 迁移策略 | Phase 1 实施计划与当前 migration 源码 |
| 2026-07-30 | validated | 多 schema 回放证明：preflight 必须限定当前 schema；映射须绑定数据库 fingerprint 和原 owner，`0004` 的 trigger 恢复必须独立提交 | 7 个 PostgreSQL 兼容性集成场景 |
