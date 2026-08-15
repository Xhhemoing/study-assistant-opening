# TODO — AIstudy 统一修复入口

> 更新：2026-08-15
>
> 验证：源码审查 + `ai98pro/gpt-5.6-sol` + `deepseek/deepseek-v4-pro` 交叉复核。
>
> 规则：本文件只保留执行摘要；问题事实、状态和关闭证据统一记录在问题总账中。

## 权威文档

- [学习闭环问题总账](docs/quality/2026-08-15-learning-loop-issue-register.md)
- [服务端权威学习闭环详细修复计划](docs/superpowers/plans/2026-08-15-server-authoritative-learning-loop-repair.md)
- [产品规格](docs/product/PRD.md)
- [数据模型与预测原则](docs/architecture/DATA_MODEL_AND_PREDICTION.md)

## 当前判断

当前不是纯 Mock 原型：认证、Workspace、知识库、课程资产、探索、候选审核、Learning Event、Cards 和导出已有真实数据库/API 切片。但 Learn 主读路径仍由 Mock/localStorage 驱动，服务端还信任客户端判题字段，SRS 并发和完整门禁也未闭合。

任何“学习闭环完成”声明必须同时满足：服务端权威内容与判题、不可变事件、并发一致 SRS、服务端状态/计划重放、跨浏览器持久化、真实 PostgreSQL/handler/browser 验证。

## P0 — 真实学习事实与一致性

- [ ] `AIST-006/AIST-014`：冻结当前 92 项工作区基线，修复跨平台验证入口，更新 README 的已实现/未接通/规划中边界。
- [ ] `AIST-004`：新增 migration，数据库级拒绝普通 Learning Event DELETE。
- [ ] `AIST-005`：建立版本化内容包、考点、题目版本、答案规则和 Practice Session。
- [ ] `AIST-001`：移除客户端权威 `correct/syllabusPointId/abilitySlice/contentVersion`，改为服务端判题。
- [ ] `AIST-003`：锁定同一卡片评分事务，补并发和幂等集成测试。
- [ ] `AIST-007`：实现 Native Backup 路由或保持显式失败；不得删除测试掩盖缺失能力。

## P1 — 服务端读模型与试点

- [ ] `AIST-008`：从真实 Learning Event 重放 Assessment 和 Correction。
- [ ] `AIST-002`：持久化 Goals/Plan State，把 Learn/Practice/Review/Status 主读路径迁出 Mock/localStorage。
- [ ] `AIST-010/AIST-018`：只准备一个高数垂直内容包和 4–8 周成人小规模试点。
- [ ] `AIST-011`：完成 Native Backup/Restore、权限和恢复演练。
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
npx vitest run --project unit
98 个测试文件通过
467 个测试通过
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
