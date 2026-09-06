# TODO — AIstudy 统一修复入口

> 更新：2026-09-06
>
> 验证：源码审查 + Git HEAD `146d666`（`feat/complete-phase1-current-work`）。本轮未重跑 unit/integration/handler/browser/CI。
>
> 规则：本文件只保留执行摘要；问题事实、状态和关闭证据统一记录在问题总账中。

## 权威文档

- [学习闭环问题总账](docs/quality/2026-08-15-learning-loop-issue-register.md)
- [服务端权威学习闭环详细修复计划](docs/superpowers/plans/2026-08-15-server-authoritative-learning-loop-repair.md)
- [产品规格](docs/product/PRD.md)
- [数据模型与预测原则](docs/architecture/DATA_MODEL_AND_PREDICTION.md)

## 当前判断

当前不是纯 Mock 原型：认证、Workspace、知识库、课程资产、探索、候选审核、Learning Event、Cards、Practice content、Assessment replay、Attempts、Backup 路由和导出已有真实数据库/API 切片，且 `0001`–`0015` 已提交。但 Learn 主读路径仍由 Mock/localStorage 驱动；练习页未切服务端内容包；账号级删除、完整恢复演练和完整门禁未闭合。

任何“学习闭环完成”声明必须同时满足：服务端权威内容与判题、不可变事件、并发一致 SRS、服务端状态/计划重放、跨浏览器持久化、真实 PostgreSQL/handler/browser 验证。

## P0 — 真实学习事实与一致性

- [ ] `AIST-006/AIST-014`：README/TODO/总账本次对齐 HEAD `146d666`；完整门禁仍未跑（本地无 Docker/bash；CI `bitnami/minio:2025.4.22` manifest unknown）。
- [ ] `AIST-004`：表级 no-delete 已提交（`0014`）；账号级 CASCADE / 合规删除流程未做。
- [ ] `AIST-005`：内容包表已提交（`0015`）；练习页主读仍 Mock，未切服务端内容包。
- [ ] `AIST-001`：请求契约已去掉客户端权威 `correct/...`，`/api/attempts` 已服务端判题；Learn 主读仍 Mock。
- [ ] `AIST-003`：`FOR UPDATE` 与并发测试已在 HEAD；本环境未跑 PostgreSQL 集成测试，CI 未绿。
- [ ] `AIST-007`：Backup 路由/测试已在 HEAD；完整恢复演练和 handler/e2e 未证明。

## P1 — 服务端读模型与试点

- [ ] `AIST-008`：`/api/assessment` 与 corrections 已从 learning events 重放；UI 仍 `useStudyProvider()` → Mock，Today Plan 仍 Mock。
- [ ] `AIST-002`：Learn/Goals/Practice/Review/Status 主读仍 Mock/localStorage。工作区有未提交 `0016` + `/api/goals` 草稿，不得视为已发布。
- [ ] `AIST-010/AIST-018`：只准备一个高数垂直内容包和 4–8 周成人小规模试点。
- [ ] `AIST-011`：export/restore 路由已在 HEAD；完整 Workspace 恢复演练 / 权限门禁未作为 CI 证据。
- [ ] `AIST-012`：完成数据清单、保留/删除、Origin、限流、Provider 数据边界和成人试点年龄门。
- [ ] `AIST-017`：记录干预分配和 7 日未见变式题结果；先统计，不自动调参。
- [ ] `AIST-009`：核心规则闭环稳定后再接 Transactional Outbox、BullMQ、真实 Provider 和成本预算。

## P2 — 发布与后续决策

- [ ] `AIST-013`：经法律/产品确认后补 LICENSE、CONTRIBUTING、SECURITY、应用/Worker Compose 和升级矩阵。
- [ ] `AIST-015`：核心闭环稳定后按职责拆分超大 auth/library 模块，不与功能修复混做。
- [ ] `AIST-016`：只有真实查询集证明 FTS/trigram 不足后才评估 pgvector。
- [ ] Marketplace、教师/班级、离线客户端、插件 SDK、FSRS/IRT/BKT/深度模型均等待首个试点证据。

## 当前可复核验证

```text
源码审查 + Git HEAD 146d666
以问题总账为准；完整门禁未跑
本地：PATH 无 bash、无 Docker CLI；有 wsl.exe；Node v24.18.0 / npm 11.16.0
CI：GitHub main run 31008499233 在 Initialize containers 失败
错误：manifest for bitnami/minio:2025.4.22 not found
Checkout / Node / lint / test / build 全部 skipped
feat/dev 无 CI run
```

完整门禁仍需 PostgreSQL、Redis、MinIO、Playwright Chromium 和可执行的跨平台 heavy-task wrapper；在完整门禁运行前不得宣称全部测试通过。

## 关闭问题的必填证据

每个 `AIST-*` 关闭时必须在问题总账中补充：

```text
修复提交 SHA
数据库 migration ID（若有）
精确验证命令
退出码和测试数量
CI run URL
残余风险
回滚方式（migration/破坏性变更必填）
```
