# AIstudy 学习闭环问题总账

**审计日期：**2026-08-15

**2026-09-06 复核：**分支仍为 `feat/complete-phase1-current-work`；当前 HEAD `146d6662a74c0dc957b59f2ab505342b08e214e2`。本轮只做源码/Git 审查与文档对齐，未重跑 unit/integration/handler/browser，也未把未提交的 `0016` Goals 草稿视为已发布。

**审计范围：**当前分支 `feat/complete-phase1-current-work`、当前工作区未提交变更、源码、数据库迁移、测试、README、PRD、架构文档。

**验证来源：**2026-08-15 源码静态审查与当时本地 unit 数字保留为历史；2026-09-06 以 HEAD `146d666` 源码、已提交 migration `0001`–`0015`、GitHub Actions run [31008499233](https://github.com/Xhhemoing/AIstudy/actions/runs/31008499233) 为准。

**当前工作区状态：**HEAD 已包含当时未提交的 0012–0015 切片。工作区仍脏：未提交 `0016_goal_and_plan_state.sql` 与 `/api/goals`。不得将未提交文件、测试文件或规划文档直接视为已发布能力。

## 使用规则

- **事实：**可以从源码、迁移、测试或命令输出直接复核。
- **推断：**根据事实推导的风险；修复前需要增加针对性测试。
- **状态：**`Open` 表示尚未修复；`Partial` 表示已有局部实现但主链未闭合；`Reopened / Partial` 表示曾经关闭后又相对当前 HEAD 漂移；`Blocked` 表示修复依赖环境或前置任务；`Accepted gap` 表示已知规划缺口，不应伪装成已实现。
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
| AIST-001 | Critical / P0 | Partial | 数据可信度 | `/api/attempts` 已服务端判题；Learn 主读仍 Mock |
| AIST-002 | Critical / P0 | Partial | 数据架构 | Learn/Goals/Practice/Review/Today Plan 仍 Mock；未提交 0016 草稿不算已发布 |
| AIST-003 | Critical / P0 | Partial | SRS 并发 | `FOR UPDATE` 与并发测试已在 HEAD；本环境未跑 PostgreSQL 集成测试 |
| AIST-004 | High / P0 | Partial | 事件不可变性 | `0014` 表级 no-delete 已提交；账号级 CASCADE / 合规删除未做 |
| AIST-005 | High / P0 | Partial | 内容事实源 | `0015` 内容包已提交；练习页主读仍 Mock，未切服务端 |
| AIST-006 | High / P0 | Partial | 验证交付 | 跨平台 wrapper 已修；CI 被 `bitnami/minio:2025.4.22` 阻断；本地无 Docker/bash |
| AIST-007 | High / P0 | Partial | 测试完整性 | Backup 路由/测试已在 HEAD；完整恢复演练与 handler/e2e 未证明 |
| AIST-008 | High / P1 | Partial | Assessment | `/api/assessment` 已从事件重放；UI / Today Plan 仍 Mock |
| AIST-009 | High / P1 | Partial | Worker / AI | Worker 仍是 smoke processor，没有真实 BullMQ consumer 或 provider |
| AIST-010 | High / P1 | Accepted gap | 内容供给 | Marketplace、模考和真实资源包尚未形成 |
| AIST-011 | High / P1 | Partial | 备份恢复 | export/restore 已在 HEAD；完整 Workspace 恢复演练未作为 CI 证据 |
| AIST-012 | High / P1 | Open | 隐私安全 | 自由文本、未成年人、Provider 数据边界、删除和训练用途没有闭合策略 |
| AIST-013 | Medium / P2 | Open | 开源 / 自托管 | 缺少 LICENSE、治理文件和包含 Web/Worker 的完整 Compose |
| AIST-014 | Medium / P2 | Reopened / Partial | 文档治理 | 相对 HEAD `146d666` 再次漂移；2026-09-06 文档对齐中 |
| AIST-015 | Medium / P2 | Open | 架构可维护性 | `library.ts`、auth service 等超大模块增加变更风险 |
| AIST-016 | Medium / P2 | Accepted gap | 检索架构 | 当前是 FTS/trigram，pgvector 仍是规划方向 |
| AIST-017 | Medium / P1 | Open | 效果评估 | 干预已经生成，但没有稳定的 7 日独立验证结果链路 |
| AIST-018 | Medium / P2 | Accepted gap | 产品范围 | 同时推进知识库、考试、AI、市场、教师、自托管和离线，首个价值楔子过宽 |

---

## AIST-001：客户端可伪造学习事实

**严重度：**Critical / P0

**状态：**Partial

**置信度：**2026-09-06 已从 HEAD `146d666` 源码直接确认

### 证据

- `packages/contracts/src/attempts.ts` 的 `submitAttemptRequestSchema` 现为 `{ practiceSessionId, answer, confidence, errorCause, idempotencyKey }`，不再接受客户端 `correct/syllabusPointId/abilitySlice/contentVersion`。响应事件仍含服务端生成的 `correct` 等字段。
- `apps/web/src/features/practice/attempt-service.ts` 在事务内 lock practice session、`content.getGradableVersion(...)`，再用 `gradePracticeAnswer(item.answerRule, parsed.answer)` 服务端判题后 append learning event。
- `apps/web/src/lib/data/persist-attempt.ts` 只 POST 上述五个请求字段。
- 仍未闭合：Learn UI 主读仍是 `createMockProvider()` + `withPersistedAttempts`；`practice-player.tsx` 仍 `useStudyProvider()`，题目来自 Mock，本地仍调用 `isPracticeAnswerCorrect`。没有把练习主读切到服务端内容包。

### 影响

服务端 API 不再信任客户端判题字段，但 Mock 主读仍可让 UI 展示与服务器事实不一致的题目和本地 verdict。在练习页切到服务端内容包之前，状态、计划和干预统计仍可能被演示数据污染。

### 修复要求

- 练习主读改为服务端内容包 / practice session，而不是 Mock seeds。
- 客户端本地 `isPracticeAnswerCorrect` 不得作为事实源。
- handler 测试覆盖未知字段被拒绝、跨 Workspace 题目访问失败、旧内容版本仍可重现历史判题。

### 关闭证据

- handler 测试提交额外 `correct: true`、错误考点和错误能力切片，断言请求被拒绝或服务端重算结果。
- 跨 Workspace 题目访问失败。
- 旧内容版本仍可重现历史判题。
- 练习页不再从 Mock 取题；`npx vitest run --project unit`、handler 集成和 E2E 均通过。

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
- 2026-09-06：工作区有未提交 `0016_goal_and_plan_state.sql` 与 `/api/goals` 草稿，属于下一片，不得视为已发布。

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

**状态：**Partial

**置信度：**HEAD 源码与测试文件已确认；本环境未跑 PostgreSQL 集成测试

### 证据

- `packages/database/src/repositories/cards-ops.ts` 已有 `lockCardForUpdate` / `loadReviewStateForUpdate`，SELECT 带 `FOR UPDATE`。
- `tests/integration/card-concurrency.test.ts` 已在 HEAD：两个不同幂等键 → 2 events / `reps=2`；相同幂等键并发 → 1 event / `reps=1`；append 失败时 event+state 同时回滚。
- 2026-08-15 当时的缺口（无 `FOR UPDATE`、无并发测试）已被 `911dd37` 切片覆盖。
- 仍未闭合：本次环境无 Docker / PATH 无 bash，未跑该 PostgreSQL 集成测试；源码+测试文件存在 ≠ CI 已绿。

### 影响

实现已按行锁串行化同一卡片评分，但缺少本环境/CI 执行证据。若行锁路径未被真实数据库跑过，仍不能宣称并发一致性已交付。

### 修复要求

采用一种并发策略并保持单一实现：

1. 事务内锁定 card state 行；首评时锁定 card 行或使用等价串行机制；
2. 在锁内再次检查幂等键；
3. 状态更新和 review event append 在同一事务内完成；
4. 不允许用简单的“重试几次”替代一致性保证。
5. 在 PostgreSQL 集成环境和 CI 中实际执行 `card-concurrency` 测试。

### 关闭证据

- 并发集成测试对同一卡片发起两个不同幂等键评分，最终 `reps`、事件数和状态符合两次评分。
- 相同幂等键并发只创建一个事件。
- 数据库异常时 event 和 state 同时回滚。
- 上述测试在 CI 或干净 PostgreSQL 环境中通过，并记录命令输出。

**对应修复任务：**计划 Task 4。

---

## AIST-004：Learning Event 没有数据库级 no-delete guard

**严重度：**High / P0

**状态：**Partial

**置信度：**HEAD migration 与测试文件已确认

### 证据

- HEAD 已有 `0014_learning_event_delete_guard.sql`：`learning_events_no_delete` BEFORE DELETE trigger，无 session-variable 旁路。
- `tests/integration/learning-event-idempotency.test.ts` 已断言 `DELETE FROM learning_events` 抛 `learning_events are append-only`，correction 仍可 append。
- `0012_learning_events.sql` 仍有 `ON DELETE CASCADE` 到 workspace/user。
- 账号级级联删除 / 合规删除流程未做。运维手册 `docs/operations/database-migrations.md` 已记录 `0014`。

### 影响

普通 DELETE 已被表级拒绝。用户/Workspace 删除仍可能级联抹掉事件，不能与“事件不可变”混为一谈。

### 修复要求

- 对用户删除建立独立的合规删除流程和审计记录。
- 明确备份保留、训练数据抽取和派生状态删除边界。
- 不修改已经执行的 `0012` / `0014` 文件。

### 关闭证据

- 直接 DELETE learning event 的数据库集成测试失败并返回约束错误（测试已在 HEAD，待 CI/干净环境执行）。
- correction 仍可追加。
- 受控用户删除流程有单独测试和文档。

**对应修复任务：**计划 Task 1、Task 10。

---

## AIST-005：没有正式的服务端内容事实源

**严重度：**High / P0

**状态：**Partial

**置信度：**HEAD schema / migration 已确认；练习主读未切

### 证据

- HEAD 已有 `0015_practice_content.sql`、`packages/database/src/schema/practice-content.ts`、`packages/contracts/src/practice-content.ts` 及对应 repository / integration test。
- 表：`content_packages` / `syllabus_nodes` / `practice_items` / `practice_item_versions` / `practice_sessions`。
- `/api/attempts` 已按 session 加载 `getGradableVersion` 做服务端评分。
- 仍未闭合：练习 UI 主读仍 Mock（`useStudyProvider()` / `createMockProvider()`）；没有宣称“练习页从服务端读题”。`learn/marketplace` 和 `learn/exams` 仍是规划页。

### 影响

服务端已能对已创建的内容版本判题，但用户在练习页看到的题目仍来自演示数据。算法和评估仍可能围绕 Mock 运行。

### 修复要求

为一个垂直场景打通最小内容模型到 UI：考点、题目、题目版本、答案/评分规则、来源、审核状态和内容包版本；练习页从服务端读取题目。

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

**置信度：**本地环境探测 + GitHub Actions run 确认

### 证据

- Task 0 已修复 `scripts/run-heavy.sh`：`flock`、`nice`、`ionice`、`taskset` 按能力可选使用，子进程退出码保持不变。
- 2026-08-15 的 104/479 unit 数字是当时脏工作区本地证据，**不得写成 2026-09-06 验证**。
- 2026-09-06 本地：PATH 无 `bash`、无 Docker CLI；有 `wsl.exe`；Node v24.18.0 / npm 11.16.0。完整 PostgreSQL / handler / browser / build 未跑。
- GitHub `main` 最新 run [31008499233](https://github.com/Xhhemoing/AIstudy/actions/runs/31008499233)（SHA `7e0f6b88fafeecd4ca53b7a62798b9ae6f127ffe`）在 **Initialize containers** 失败：`manifest for bitnami/minio:2025.4.22 not found`。Checkout / Node / lint / test / build 全部 skipped。feat/dev 无 CI run。
- 本地 compose 使用 `minio/minio:RELEASE.2025-04-22T22-12-26Z`；CI workflow 仍用失效的 bitnami tag。本次文档对齐不修 CI。
- `docs/operations/ci.md` 和 README 已明确 unit-only、完整本地和 GitHub Actions 权威门禁的区别。

### 影响

不能把 focused tests 或静态 TypeScript 检查等同于真实数据库、handler、browser 和 build 验收。当前甚至不能把 GitHub Actions `quality` 当作已执行证据。

### 修复要求

- 明确本地 Windows、WSL/Linux 和 CI 的支持路径。
- 替换或修复 CI MinIO 镜像，使容器能初始化。
- 提供服务启动前置检查和清晰跳过原因。
- 在 CI 中执行完整门禁。
- 发布记录保存 commit SHA、migration version、Node/Playwright version 和残余风险。

**对应修复任务：**计划 Task 0、Task 11。

---

## AIST-007：Backup 路由与授权测试尚未形成可交付证据

**严重度：**High / P0

**状态：**Partial

**置信度：**HEAD 文件存在已确认；完整演练未证明

### 证据

- 2026-08-15 当时 HEAD `ef0334f` 不含 Backup 路由；该切片已由 `911dd37` 提交进当前 HEAD `146d666`。
- HEAD 已包含：
  - `apps/web/src/app/api/backups/export/route.ts`
  - `apps/web/src/app/api/backups/restore/route.ts`
  - `tests/integration/handler/backup-routes-authorization.test.ts`
  - `tests/integration/native-backup-roundtrip.test.ts`
  - `tests/e2e/native-backup.spec.ts`
- 当前环境未设置可用 PostgreSQL/Docker，因此没有执行 handler 或 e2e；完整 Workspace 恢复演练未证明。

### 影响

路由和测试已进入版本历史，但未执行的 handler/e2e 不能证明 Backup API 的权限、冲突和恢复行为。

### 修复要求

在真实 PostgreSQL / Playwright 环境执行授权、冲突和 roundtrip 测试；补完整 Workspace 恢复演练。不得只删除 import 让 suite 变绿。

### 关闭证据

- 两个路由真实存在并进行 principal-bound authorization。
- 未登录 401、跨 Workspace 409/403、同 Workspace 导出/恢复通过。
- 完整 handler、integration 和恢复演练收集成功。

**对应修复任务：**计划 Task 9。

---

## AIST-008：Assessment/Plan 仍不是服务端读模型

**严重度：**High / P1

**状态：**Partial

**置信度：**源码确认

### 证据

- `packages/domain/src/assessment/` 有纯函数和测试。
- `packages/domain/src/planning/` 有 planner 和测试。
- API 已有 `/api/assessment`、`/api/assessment/corrections`；`assessment-service.ts` 从 learning events 重放。
- 当前学习 UI 仍通过 `useStudyProvider()` → Mock 读取状态和计划；Today Plan 仍 Mock。
- 没有明确的持久化 assessment snapshot 表。

### 影响

领域算法“可重算”和 Assessment API“可重放”不等于产品 UI “来自真实事件”。原因抽屉和今日计划无法在多设备和服务端环境中稳定重现。

### 修复要求

先保证事件重放驱动 UI，再决定是否持久化快照。快照必须是派生缓存而不是事实源，带 model、strategy、evidence snapshot 版本。

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

**置信度：**HEAD 源码确认；演练未证明

### 证据

- `packages/domain/src/portability/markdown/` 和 `anki/` 有实现和测试。
- `apps/web/src/app/api/exports/` 有 Markdown/Anki 路由。
- Native backup 领域函数、契约以及 `/api/backups/export`、`/api/backups/restore` 已在 HEAD（同 AIST-007）。
- 完整 Workspace 恢复演练 / 权限门禁未作为 CI 证据。

### 修复要求

在 CI 或干净环境执行 principal-bound 恢复演练；所有外部投影继续显示 loss report。

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

**状态：**Reopened / Partial

**置信度：**Git 和文档直接确认

### 证据

- 2026-08-15 曾把 README/TODO/基线分成 HEAD / 未提交工作区 / 规划中三类，并关闭本问题。
- 2026-09-06 复核时，这些文档相对 HEAD `146d666` 再次漂移：仍写 migration 止于 `0011`、0012/0013 未提交、Backup 不在 HEAD、AIST-001/003/004/005/007 仍为 Open，并沿用过时的 98/467 或 104/479 作为当前验证。
- 本次文档对齐覆盖 `README.md`、`TODO.md`、`docs/releases/phase-1-repair-baseline.md`（只在快照顶部增加 Current HEAD 对照，不改写历史段落）和本总账。
- 关闭证据仍缺本次 docs commit 之后的稳定 SHA 自检，以及完整产品门禁。本文件与对齐提交同批落地，无法在同一提交内自引用 SHA。

### 修复要求

- 本问题总账作为质量问题的统一索引。
- `TODO.md` 只保留可执行摘要并链接本总账和实施计划。
- 每个阶段更新 README 的已实现/未接通/规划中状态。
- 任何“完成”必须带验证命令和环境条件。

### 关闭证据

```text
源码审查 + Git HEAD 146d666
未重跑 unit/integration/handler/browser
完整门禁未跑：本地无 Docker/bash；CI bitnami/minio:2025.4.22 manifest unknown
```

文档漂移可在对齐提交落地且 README/TODO/总账与 HEAD 一致后重新关闭；这不代表完整产品门禁已闭合。

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
