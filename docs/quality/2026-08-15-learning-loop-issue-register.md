# AIstudy 学习闭环问题总账

**审计日期：**2026-08-15

**审计范围：**当前分支 `feat/complete-phase1-current-work`、当前工作区未提交变更、源码、数据库迁移、测试、README、PRD、架构文档。

**验证来源：**源码静态审查、`npx vitest run --project unit`（Task 0 重跑为 104 个文件、479 个测试通过）、完整 Vitest 环境失败证据、`ai98pro/gpt-5.6-sol` 独立审查、`deepseek/deepseek-v4-pro` 反证审查。

**当前工作区状态：**Task 0 基线捕获 106 个 Git 状态项；不得将未提交文件、测试文件或规划文档直接视为已发布能力。

## 使用规则

- **事实：**可以从源码、迁移、测试或命令输出直接复核。
- **推断：**根据事实推导的风险；修复前需要增加针对性测试。
- **状态：**`Open` 表示尚未修复；`Partial` 表示已有局部实现但主链未闭合；`Blocked` 表示修复依赖环境或前置任务；`Accepted gap` 表示已知规划缺口，不应伪装成已实现。
- 关闭问题必须同时填写：修复提交、测试命令、实际输出、残余风险。
- 迁移问题必须确认目标数据库是否已经执行旧迁移；已执行迁移不得修改原文件。

## 严重度与优先级

| 等级 | 含义 | 处理要求 |
|---|---|---|
| Critical / P0 | 会破坏学习事实、状态可信度、数据一致性或安全边界 | 在任何真实用户试点前关闭 |
| High / P1 | 会阻止纵向闭环、生产异步链路、恢复或发布 | P0 后关闭；没有关闭不得宣称 alpha 闭环 |
| Medium / P2 | 影响扩展、可维护性、开源或产品广度 | 在试点反馈后按证据处理 |
| Low / P3 | 局部体验或整理问题 | 不阻塞首个学习闭环 |

## 问题总览

| ID | 严重度 | 状态 | 所属域 | 一句话问题 |
|---|---|---|---|---|
| AIST-001 | Critical / P0 | Open | 数据可信度 | 作答接口信任客户端的 `correct`、考点和能力切片 |
| AIST-002 | Critical / P0 | Partial | 数据架构 | 学习 UI 的主读路径仍是 Mock/localStorage，数据库事件只形成薄镜像 |
| AIST-003 | Critical / P0 | Open | SRS 并发 | 同一卡片并发评分可能发生 lost update |
| AIST-004 | High / P0 | Open | 事件不可变性 | `learning_events` 有 no-update guard，但没有 no-delete guard |
| AIST-005 | High / P0 | Open | 内容事实源 | 没有正式题目、考点、答案版本和服务端评分规则表 |
| AIST-006 | High / P0 | Partial | 验证交付 | 跨平台 wrapper 已修复；PostgreSQL、Redis、浏览器门禁仍未在当前环境闭合 |
| AIST-007 | High / P0 | Open | 测试完整性 | Backup 路由和测试只存在于未提交工作区，数据库 handler 门禁未验证 |
| AIST-008 | High / P1 | Partial | Assessment | 状态和计划没有由真实事件在服务端重放并作为 UI 真源 |
| AIST-009 | High / P1 | Partial | Worker / AI | Worker 仍是 smoke processor，没有真实 BullMQ consumer 或 provider |
| AIST-010 | High / P1 | Accepted gap | 内容供给 | Marketplace、模考和真实资源包尚未形成 |
| AIST-011 | High / P1 | Partial | 备份恢复 | Markdown/Anki 投影存在，但 Native Backup API/恢复入口未接通 |
| AIST-012 | High / P1 | Open | 隐私安全 | 自由文本、未成年人、Provider 数据边界、删除和训练用途没有闭合策略 |
| AIST-013 | Medium / P2 | Open | 开源 / 自托管 | 缺少 LICENSE、治理文件和包含 Web/Worker 的完整 Compose |
| AIST-014 | Medium / P2 | Closed | 文档治理 | README、TODO 和基线已区分 HEAD、未提交工作区与规划能力 |
| AIST-015 | Medium / P2 | Open | 架构可维护性 | `library.ts`、auth service 等超大模块增加变更风险 |
| AIST-016 | Medium / P2 | Accepted gap | 检索架构 | 当前是 FTS/trigram，pgvector 仍是规划方向 |
| AIST-017 | Medium / P1 | Open | 效果评估 | 干预已经生成，但没有稳定的 7 日独立验证结果链路 |
| AIST-018 | Medium / P2 | Accepted gap | 产品范围 | 同时推进知识库、考试、AI、市场、教师、自托管和离线，首个价值楔子过宽 |

---

## AIST-001：客户端可伪造学习事实

**严重度：**Critical / P0

**状态：**Open

**置信度：**已从源码直接确认

### 证据

- `packages/contracts/src/attempts.ts` 的 `submitAttemptRequestSchema` 接受 `correct`、`syllabusPointId`、`contentVersion`、`abilitySlice`。
- `apps/web/src/features/practice/attempt-service.ts` 将上述字段直接写入 `learning_events`。
- `apps/web/src/lib/data/persist-attempt.ts` 在客户端先判题，再把 `correct` 发送到服务端。
- 当前 `packages/domain/src/practice/grading.ts` 只提供客户端可调用的有限字符串匹配规则，服务端没有根据正式题目版本独立重算。

### 影响

攻击者或错误客户端可以伪造正确率、考点归属和能力维度，污染状态、计划、干预统计和未来训练数据。这个问题会使“可解释能力状态”和“7 日效果指标”失去可信基础。

### 修复要求

- 请求契约只接受 `practiceItemId`、答案和行为上下文；客户端字段 `correct`、考点、能力切片不再是权威输入。
- 服务端按 `practiceItemId + contentVersion` 加载正式题目和评分规则。
- 服务端生成 `correct`、`syllabusPointId`、`abilitySlice` 和最终内容版本。
- 客户端上报的旧字段若为兼容期保留，只能作为非可信诊断字段，不能写入事实事件。

### 关闭证据

- handler 测试伪造 `correct: true`、错误考点和错误能力切片，断言服务端重算结果。
- 跨 Workspace 题目访问失败。
- 旧内容版本仍可重现历史判题。
- `npx vitest run --project unit`、handler 集成和 E2E 均通过。

**对应修复任务：**计划 Task 2、Task 3。

---

## AIST-002：Mock/localStorage 与数据库双重真源

**严重度：**Critical / P0

**状态：**Partial

**置信度：**已从源码直接确认

### 证据

- `apps/web/src/lib/data/react.ts` 的 `useStudyProvider()` 创建 `createMockProvider()`，并包裹 `withPersistedAttempts`、`withPersistedReviews`。
- `apps/web/src/lib/data/mock/` 仍负责目标、今日计划、状态、题目、复习队列和探索回复的主要读模型。
- `apps/web/src/features/auth/service.ts` 已装配真实 learning event 和 card repositories，但没有对应的真实 `StudyDataProvider` 实现。
- 作答和复习存在“写入 PostgreSQL + 更新本地 Mock”的镜像路径，数据库事件没有完整反向驱动 UI 读模型。

### 影响

刷新、清理 localStorage、跨设备、多标签页或服务端重放时，用户看到的状态可能不同。服务器无法独立重建用户看到的计划和状态，效果评估也无法确定数据来源。

### 修复要求

- 建立服务端 `StudyDataProvider` 或按领域拆分 typed API client。
- `getTodayPlan`、`listStatuses`、`listDueCards`、目标读取和诊断必须从 PostgreSQL 及事件重放结果读取。
- localStorage 只保留草稿、UI 偏好和明确标注的 Demo fixture。
- 增加跨浏览器、清理缓存、乱序事件和多设备测试。

### 关闭证据

- 清空 localStorage 后用户状态、目标、计划和复习数据不丢失。
- 第二个浏览器上下文能看到相同结果。
- UI 关键读路径不再调用 `createMockProvider()`。
- 服务端从事件重放可以生成相同 `evidenceSnapshotId`、状态和计划。

**对应修复任务：**计划 Task 5、Task 6、Task 7。

---

## AIST-003：SRS 并发评分丢失更新

**严重度：**Critical / P0

**状态：**Open

**置信度：**源码确认，需集成测试量化

### 证据

- `packages/database/src/repositories/cards-grade.ts` 在事务中读取 `card_review_states`，但 SELECT 没有 `FOR UPDATE`。
- `packages/database/src/repositories/cards-ops.ts` 的 `writeState()` 使用 `ON CONFLICT DO UPDATE`。
- `card_review_states` 没有 version/optimistic lock 字段。

### 影响

两个不同幂等键的并发评分可能基于同一个旧状态计算，最后写入覆盖先写入，造成 `reps`、interval、dueAt 与 review events 不一致。

### 修复要求

采用一种并发策略并保持单一实现：

1. 事务内锁定 card state 行；首评时锁定 card 行或使用等价串行机制；
2. 在锁内再次检查幂等键；
3. 状态更新和 review event append 在同一事务内完成；
4. 不允许用简单的“重试几次”替代一致性保证。

### 关闭证据

- 并发集成测试对同一卡片发起两个不同幂等键评分，最终 `reps`、事件数和状态符合两次评分。
- 相同幂等键并发只创建一个事件。
- 数据库异常时 event 和 state 同时回滚。

**对应修复任务：**计划 Task 4。

---

## AIST-004：Learning Event 没有数据库级 no-delete guard

**严重度：**High / P0

**状态：**Open

**置信度：**迁移源码确认

### 证据

`packages/database/src/migrations/0012_learning_events.sql` 创建了 `learning_events_no_update`，但没有拒绝 DELETE 的 trigger。外键上的 `ON DELETE CASCADE` 还允许删除 User/Workspace 时级联删除事件。

### 影响

普通事件删除可以破坏重放结果。用户级删除可能是合规所需，但必须作为显式、审计过的数据删除流程，而不能与“事件不可变”混为一谈。

### 修复要求

- 新增后续 migration 创建 no-delete trigger。
- 对用户删除建立独立的合规删除流程和审计记录。
- 明确备份保留、训练数据抽取和派生状态删除边界。
- 不修改已经执行的 `0012` 文件。

### 关闭证据

- 直接 DELETE learning event 的数据库集成测试失败并返回约束错误。
- correction 仍可追加。
- 受控用户删除流程有单独测试和文档。

**对应修复任务：**计划 Task 1、Task 10。

---

## AIST-005：没有正式的服务端内容事实源

**严重度：**High / P0

**状态：**Open

**置信度：**schema 和 migration 清单确认

### 证据

- `packages/database/src/schema/` 当前没有正式的 practice item、syllabus node、content package schema。
- `packages/database/src/migrations/0001` 至 `0013` 没有题目和考点内容表。
- 练习内容主要来自 `apps/web/src/lib/data/mock/seeds.ts`、`seeds-content.ts`。
- `learn/marketplace` 和 `learn/exams` 是 `PlannedPage`。

### 影响

无法在服务端独立判题、固定题目版本、保留历史引用或维护内容责任人。算法和评估只能围绕演示数据运行。

### 修复要求

为一个垂直场景建立最小内容模型：考点、题目、题目版本、答案/评分规则、来源、审核状态和内容包版本。

### 关闭证据

- 空数据库可由 seed 脚本导入固定内容包。
- 练习页面从服务端读取题目。
- 服务端评分只读取内容版本。
- 内容发布新版本不改变旧事件引用。

**对应修复任务：**计划 Task 2、Task 3、Task 8。

---

## AIST-006：完整质量门禁当前未闭合

**严重度：**High / P0

**状态：**Partial

**置信度：**命令输出确认

### 证据

- Task 0 已修复 `scripts/run-heavy.sh`：`flock`、`nice`、`ionice`、`taskset` 按能力可选使用，子进程退出码保持不变。
- `npm run verify:ci` 在当前 Windows/Git Bash 环境中通过：1 个 contract 文件、3 个测试通过。
- `npx vitest run --project unit` 重跑为 104 个文件、479 个测试通过；domain/contracts TypeScript 检查退出 0。
- integration/handler 仍需要 `DATABASE_URL` 和 PostgreSQL，Redis/MinIO 需要服务，browser 还需要隔离 E2E 数据库和 live server。
- `docs/operations/ci.md` 和 README 已明确 unit-only、完整本地和 GitHub Actions 权威门禁的区别。

### 影响

不能把 focused tests 或静态 TypeScript 检查等同于真实数据库、handler、browser 和 build 验收。

### 修复要求

- 明确本地 Windows、WSL/Linux 和 CI 的支持路径。
- 提供服务启动前置检查和清晰跳过原因。
- 在 CI 中执行完整门禁。
- 发布记录保存 commit SHA、migration version、Node/Playwright version 和残余风险。

**对应修复任务：**计划 Task 0、Task 11。

---

## AIST-007：Backup 路由与授权测试尚未形成可交付证据

**严重度：**High / P0

**状态：**Open

**置信度：**HEAD/工作区文件状态直接确认

### 证据

- HEAD `ef0334fe1fe77c02f0388068f3e122244e3c40d0` 不包含 Backup 路由或 handler 测试。
- 当前未提交工作区已包含：
  - `apps/web/src/app/api/backups/export/route.ts`
  - `apps/web/src/app/api/backups/restore/route.ts`
  - `tests/integration/handler/backup-routes-authorization.test.ts`
- 当前环境未设置 `DATABASE_URL` 且没有 Docker，因此没有执行该 PostgreSQL handler 测试。

### 影响

源码存在性已经消除原先的模块导入缺口，但未提交、未执行的 handler 测试不能证明 Backup API 的权限、冲突和恢复行为。

### 修复要求

在 Native Backup API 实现前，测试应保持失败并明确标记为未接通；执行 Backup 功能时实现路由、服务和权限测试。不得只删除 import 让 suite 变绿。

### 关闭证据

- 两个路由真实存在并进行 principal-bound authorization。
- 未登录 401、跨 Workspace 409/403、同 Workspace 导出/恢复通过。
- 完整 handler 和 integration 测试收集成功。

**对应修复任务：**计划 Task 9。

---

## AIST-008：Assessment/Plan 仍不是服务端读模型

**严重度：**High / P1

**状态：**Partial

**置信度：**源码和迁移清单确认

### 证据

- `packages/domain/src/assessment/` 有纯函数和测试。
- `packages/domain/src/planning/` 有 planner 和测试。
- 但当前学习 UI 主要通过 Mock Provider 读取状态和计划。
- 没有完整的服务端 assessment/plan API 读路径，也没有明确的持久化 assessment snapshot 表。

### 影响

领域算法“可重算”不等于产品结果“来自真实事件”。原因抽屉和今日计划无法在多设备和服务端环境中稳定重现。

### 修复要求

先保证事件重放可用，再决定是否持久化快照。快照必须是派生缓存而不是事实源，带 model、strategy、evidence snapshot 版本。

**对应修复任务：**计划 Task 6、Task 7。

---

## AIST-009：Worker 和 AI 只有契约，没有生产执行链路

**严重度：**High / P1

**状态：**Partial

**置信度：**源码和 package 依赖确认

### 证据

- `apps/worker/src/index.ts` 只是 `processSmokeJob()`。
- `apps/worker/package.json` 没有 BullMQ 依赖。
- `packages/ai/src/providers/provider.ts` 只有 provider interface 和 response validation，没有具体 provider adapter。
- `apps/worker/src/jobs/exploration-chat.ts` 是可测纯函数，但没有实际队列入口。
- Mock 探索回复来自 `apps/web/src/lib/data/mock/mock-replies.ts`。

### 影响

不能把当前探索回复称为真实 AI；没有重试、死信、成本账本、任务幂等和 Provider 数据边界。

### 修复要求

核心学习流程先不依赖 AI。P1 再实施 transactional outbox、BullMQ、provider adapter、预算和候选落库。

**对应修复任务：**计划 Task 10、Task 11。

---

## AIST-010：真实内容供给与 Marketplace 未形成

**严重度：**High / P1

**状态：**Accepted gap

**置信度：**页面和 schema 清单确认

### 证据

- `apps/web/src/app/(workspace)/learn/marketplace/page.tsx` 是占位页。
- 数据库没有 ResourcePackage、ContentItem、Classroom 等对应 schema。
- PRD 和商业文档将 Marketplace、作者、教师和 Fork 放在后续能力。

### 处理决定

不把 Marketplace 作为当前 bug 修复；在一个真实、版本化、人工审核的垂直内容包验证前暂缓。

**对应修复任务：**计划 Task 8；Marketplace 进入 P2 观察项。

---

## AIST-011：导出投影存在，Native Backup 未接通

**严重度：**High / P1

**状态：**Partial

**置信度：**源码确认

### 证据

- `packages/domain/src/portability/markdown/` 和 `anki/` 有实现和测试。
- `apps/web/src/app/api/exports/` 有 Markdown/Anki 路由。
- Native backup 领域函数和契约已经出现，但缺少 `/api/backups/export`、`/api/backups/restore` 路由和完整 UI。
- Backup handler 测试已经提前引用这些不存在的路由。

### 修复要求

先完成真实路由和 principal-bound service，再做完整 Workspace/事件/卡片/附件恢复。所有外部投影继续显示 loss report。

**对应修复任务：**计划 Task 9。

---

## AIST-012：隐私、删除和 Provider 数据边界未闭合

**严重度：**High / P1

**状态：**Open

**置信度：**产品文档和源码边界共同确认

### 证据

- PRD 主要用户包含高中生，但把未成年人专项合规不作为首期阻塞。
- 自由探索和笔记包含自由文本，当前没有统一的数据用途、保留、删除和训练排除文档/管道。
- AI 契约有 source ID 权限规则，但没有完整 Provider 数据处理和成本边界。
- localStorage 仍承载一部分学习状态。

### 修复要求

公开试点前完成数据清单、删除传播、Provider 请求白名单、训练用途隔离、限流、审计和未成年人开放范围决定。

**对应修复任务：**计划 Task 10、Task 11。

---

## AIST-013：开源和自托管交付不完整

**严重度：**Medium / P2

**状态：**Open

**置信度：**仓库清单确认

### 证据

- 根目录没有 LICENSE、CONTRIBUTING.md、SECURITY.md 等基础治理文件。
- `infra/docker/compose.yml` 只编排 PostgreSQL、Redis、MinIO，没有 Web 和 Worker 服务。
- 当前有 Web Dockerfile/构建骨架，但没有完整发布、升级矩阵和恢复演练。

### 修复要求

在核心闭环稳定后补齐许可证、贡献和安全披露、应用/Worker Compose、版本发布、迁移兼容和备份恢复文档。

**对应修复任务：**计划 Task 12。

---

## AIST-014：文档、提交历史与工作区状态漂移

**严重度：**Medium / P2

**状态：**Closed

**置信度：**Git 和文档直接确认

### 证据

- `README.md` 已改为“已提交且可追溯 / 工作区存在但尚未完整验证 / 规划中”三类能力声明。
- `docs/releases/phase-1-repair-baseline.md` 固定记录分支、HEAD、106 个工作区状态项、migration 边界、环境缺口和验证命令。
- `TODO.md` 已成为问题总账和服务端权威修复计划的统一入口。
- `docs/operations/ci.md` 已区分 unit-only、本地完整门禁和 GitHub Actions 权威合并门禁。

### 修复要求

- 本问题总账作为质量问题的统一索引。
- `TODO.md` 只保留可执行摘要并链接本总账和实施计划。
- 每个阶段更新 README 的已实现/未接通/规划中状态。
- 任何“完成”必须带验证命令和环境条件。

### 关闭证据

```text
npm run verify:ci
1 contract file passed, 3 tests passed

npx vitest run --project unit
104 test files passed, 479 tests passed

npx tsc -p packages/domain/tsconfig.json --noEmit
npx tsc -p packages/contracts/tsconfig.json --noEmit
both exit 0
```

修复提交 SHA 和 CI run URL 需在提交/PR 后补充；当前关闭的是文档漂移问题，不代表完整产品门禁已闭合。

**对应修复任务：**计划 Task 0、Task 13。

---

## AIST-015：超大模块增加维护和审查风险

**严重度：**Medium / P2

**状态：**Open

**置信度：**文件统计直接确认

### 证据

- `packages/database/src/repositories/library.ts` 超过 1300 行。
- `apps/web/src/features/auth/service.ts` 超过 1000 行。
- 项目约定要求在文件超过 200 行前拆分，但现状已经明显超过。

### 影响

授权、事务、错误映射和领域逻辑混在大型模块中，增加回归、审查和外部贡献者进入成本。

### 修复要求

不在 P0 做无关重构。核心闭环稳定后按职责拆分：document CRUD、revision、relation/property、runtime assembly、auth/session mapping，并保持导出 API 兼容。

**对应修复任务：**计划 Task 13。

---

## AIST-016：pgvector 是规划而非现状

**严重度：**Medium / P2

**状态：**Accepted gap

**置信度：**迁移和查询代码确认

### 事实

当前搜索使用 PostgreSQL FTS/trigram；没有 pgvector 表、embedding pipeline 或向量查询。

### 处理决定

不作为当前缺陷修复。只有真实查询集证明全文检索不足，并且权限过滤、删除传播和 Provider 边界已经闭合后，才启动向量检索 Spike。

---

## AIST-017：干预效果没有形成 7 日结果链路

**严重度：**Medium / P1

**状态：**Open

**置信度：**TODO 与领域实现确认

### 事实

`packages/domain/src/practice/intervention.ts` 和 `intervention-content.ts` 已能生成规则干预和内容建议，但 `TODO.md` 仍明确记载干预效果反馈未完成。

### 影响

系统可以生成更多干预，但无法证明干预减少了同类错误或改善了未见题表现。

### 修复要求

记录 intervention assignment、资格、7 日验证题、提示污染、跳过和结果缺失，先生成统计报表，再考虑概率校准。

**对应修复任务：**计划 Task 11。

---

## AIST-018：首发范围过宽

**严重度：**Medium / P2

**状态：**Accepted gap

**置信度：**PRD、架构和 roadmap 共同确认

### 处理决定

首个可验证版本只做一个垂直场景：

```text
真实内容包 → 服务端判题 → Learning Event → 状态重放 → 今日计划 → 7 日变式题
```

Marketplace、教师、复杂多目标、PDF/EPUB、pgvector、离线、插件、高级模型和机构部署不进入首个闭环。

**对应修复任务：**计划 Task 8、Task 11、Task 12。

---

## 关闭顺序

```text
AIST-006 / AIST-014 基线与文档
        ↓
AIST-005 内容事实源
        ↓
AIST-001 服务端判题
        ↓
AIST-003 SRS 并发 + AIST-004 事件删除保护
        ↓
AIST-002 / AIST-008 服务端重放、状态和计划
        ↓
AIST-017 7 日效果链路
        ↓
AIST-009 Worker/AI、AIST-011 Backup、AIST-012 隐私
        ↓
AIST-013 / AIST-015 开源、自托管和模块治理
        ↓
AIST-010 / AIST-016 / AIST-018 扩展性决策
```

## 暂不作为缺陷修复的事项

以下属于明确的产品后续能力，不应为了“清空问题列表”而提前实现：

- Marketplace 和社区资源市场；
- 教师/班级/LTI/xAPI；
- pgvector、GraphRAG、复杂阅读器；
- FSRS、IRT、BKT、深度序列模型；
- 离线客户端、CRDT、插件 SDK；
- 公开排行榜和社交信息流；
- 多考试、多领域的大规模内容扩张。

这些能力只有在一个真实垂直学习场景完成 4–8 周试点并产生延迟学习结果后，才重新评估。
