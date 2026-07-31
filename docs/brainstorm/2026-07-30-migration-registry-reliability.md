---
title: Migration Registry 的可验证升级与并发安全
date: 2026-07-30
status: promoted
scope:
  - packages/database migration runner
  - scripts/db-migrate.ts
  - schema_migrations registry
  - Phase 0 Gate 0.2
related:
  - ../plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md
  - 2026-07-30-identity-migration-safety.md
  - ../operations/database-migrations.md
promotion_target:
  - ../plans/2026-07-24-phase1-tasks-9-30-superpowers-plan.md#gate-02统一-migration-编号升级和测试数据库规则
  - ../../packages/database/src/migrate.ts
  - ../../scripts/db-migrate.ts
---

# Migration Registry 的可验证升级与并发安全

## 1. 决策问题

当前 runner 仅按文件名字典序读取 SQL 并以 `schema_migrations.id` 去重。它没有文件命名校验、校验和、历史验证状态、全程 advisory lock 或统一 CLI 路径。Gate 0.2 需要在不修改已发布 migration 的前提下，让空库、旧库与并发调用得到可重放、可解释、fail-closed 的结果。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 发布升级不能重复执行、错序执行或静默使用被篡改的 schema SQL |
| 产品入口/流程 | 运维发布、CI migration、开发数据库初始化 |
| 领域对象 | MigrationFile、MigrationRegistryRow、LegacyVerification、OperatorAttestation |
| 代码边界 | `packages/database/src/migrate.ts`、`scripts/db-migrate.ts`、integration fixtures/tests |
| 计划任务 | Phase 0 Gate 0.2；为 Task 9 之前的所有 schema 变更提供基础 |

## 3. 不变量与约束

- 历史 `0001` 至 `0004` SQL 不修改；空库仍按其原始顺序执行。
- 每个 migration 文件必须符合 `^([0-9]{4})_[a-z0-9_-]+\\.sql$`，版本号唯一且不跳号。
- runner 对 registry 读取、状态验证、SQL 执行与 registry 写入持有同一 PostgreSQL advisory lock。
- 新执行 migration 使用 SHA-256 和 `verified`；已有无 checksum 的历史 row 只能标为 `legacy-unverified`。
- 被验证 migration 的 checksum 漂移、未知 registry ID、未知 verification state、重复/跳号版本必须 fail closed。
- 已记录旧 `0003_identity.sql` 不得回填或伪造 checksum；只可经 Gate 0.1 数据预检、operator attestation、备份证据和 `0004` corrective path 继续。
- 测试显式要求 `DATABASE_URL`；不允许凭据 fallback。
- 2 GiB VM 上保持线性文件扫描、单 DB lock，不引入外部 migration 服务。

## 4. 已验证事实

- 当前 `migrate.ts` 只对 `schema_migrations(id, applied_at)` 建表、按 lexical sort 执行、并对 registry `INSERT` 使用 `ON CONFLICT DO NOTHING`。
- 旧版 `scripts/db-migrate.mjs` 曾复制一套 runner，因此可绕过 Gate 0.1 的 owner preflight；已被删除并由 `scripts/db-migrate.ts` 取代。
- 当前迁移文件为 `0001_library.sql`、`0002_courses.sql`、`0003_identity.sql` 和未提交的 `0004_identity_repair.sql`；计划锁定后续 0005 至 0012。
- PostgreSQL 在本机可用，Gate 0.1 已用真实 schema 回放覆盖 legacy 与 corrective 路径。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 生产历史 registry 是否包含未知手工 migration | 跳过未审计 SQL | upgrade fixture + 生产 preflight dry-run |
| 旧库是否有可靠 attestation/备份记录 | 无法证明旧 `0003` 的升级决策 | operator 记录与可恢复备份核验 |
| 多个部署实例是否可能同时启动 migration | SQL 重复或状态竞争 | 两 client 并发 integration test |
| 文件目录是否曾存在不规范命名 | 字典序掩盖真实顺序 | 临时 migration directory fixture + parser unit tests |

## 6. 候选方案

### 方案 A：PostgreSQL registry 状态机与 advisory lock

runner 解析 numeric version，bootstrap 可向后兼容扩展 registry 字段，在 session-level advisory lock 内验证完整 registry、核对 checksum、逐文件事务执行并记录状态。旧 `0003` 明确进入 attested `legacy-unverified` compatibility 分支。`scripts/db-migrate.ts` 仅作为调用 canonical runner 的 thin wrapper。

### 方案 B：仅加强文件排序和 checksum

保留两个 runner，不锁定 registry。这会检测部分篡改，但无法消除并发重复执行与 CLI 旁路，不满足发布安全要求。

### 方案 C：引入外部 migration SaaS 或独立控制平面

可提供额外界面与审批流，但增加服务依赖、成本和恢复面；当前单体与低资源部署不需要。

## 7. 算法评估

| 维度 | A：registry 状态机 | B：排序 + checksum | C：外部控制平面 |
|---|---|---|---|
| 目标效果 | 顺序、完整性、并发和升级路径均可验证 | 只覆盖部分完整性 | 可扩展审批，但过度复杂 |
| 数据需求 | 本地 registry、文件内容、attestation | registry、文件内容 | 外部状态与凭据 |
| 延迟/吞吐 | 文件数线性，单 migration transaction | 略低，但存在重试竞争 | 网络依赖和额外调用 |
| 成本 | 低，无新服务 | 低 | 中高 |
| 可解释性 | 状态、checksum、错误码均可追溯 | 部分可追溯 | 依赖外部产品 |
| 安全 | 默认拒绝未知/漂移/非法历史 | runner 旁路与并发风险保留 | 增加凭据与供应商攻击面 |
| 可迁移/回滚 | 事实源仍是 PostgreSQL，可重建 registry 元数据 | 弱 | 外部系统绑定 |
| 扩展性 | 支持后续 migration 和审计字段 | 迟早需要补锁和兼容状态 | 远超当前需求 |
| 失败降级 | 保持 DB 不变并输出可操作错误 | 可能遇到竞争后不确定 | 依赖控制平面可用 |

## 8. 推荐结论

- 推荐方案：A。
- 适用边界：所有正式数据库 schema 变更及 CI/运维执行入口。
- 暂不采用：B，因为不能封住双 runner 与并发；C，因为当前没有多环境审批规模证据。
- 升级触发条件：当迁移审批、跨区域部署或长运行数据回填需要集中排程时，再评估独立控制平面。
- 回退方案：advisory lock 内失败即回滚当前 migration transaction；registry 保留最后验证状态，operator 从备份恢复或处理明确错误后重试。

## 9. 验证计划

- 数据集或测试夹具：空 schema、legacy `0001/0002`、已记录旧 `0003`、unknown registry ID、checksum drift、并发双 client、临时非法文件名与跳号目录。
- 当前基线：字典序文件循环，无 checksum、无 advisory lock、双 runner。
- 离线指标：非法历史阻断率 100%；verified checksum drift 阻断率 100%；重复 SQL 执行次数 0；registry/file 顺序错误 0。
- 线上/产品指标：migration P95、lock wait、失败错误码、legacy-unverified 数量；不记录 SQL 正文或凭据。
- 用户验收场景：同一 DB 并发调用只执行一次；已记录合法 migration 重跑为 no-op；旧 `0003` 无 attestation 阻断；有完整 attestation 时仅运行 `0004`。
- 通过阈值：所有夹具和重复运行满足确定性结果、无重复执行、无未登记部分状态。
- 失败停止条件：未知历史被跳过、checksum 漂移继续执行、lock 外执行 SQL、或 CLI 路径仍可绕过 canonical runner。

## 10. 风险与治理

checksum 验证文件完整性，不证明历史业务数据正确。operator attestation 证明本次对 legacy state 的处置决策，不得倒推为旧 `0003` checksum。日志只记录 migration ID、version、verification state、fingerprint 摘要和 backup reference，禁止输出连接字符串或 SQL 内可能含有的敏感数据。

## 11. 正式化路径

- [ ] PRD/场景
- [ ] UX 与 AI 权限政策
- [x] 设计或实施计划
- [ ] ADR
- [x] Contract/Schema/API
- [x] 测试与验收场景
- [x] 监控与回滚说明

## 12. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-07-30 | promoted | 为 Gate 0.2 固化 registry 状态机、numeric parser、checksum、advisory lock 和 legacy compatibility 选择 | 已批准 Phase 0 计划与现有 runner 勘察 |
