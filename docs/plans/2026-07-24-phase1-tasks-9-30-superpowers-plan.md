# AIstudy Phase 1 后半程实施计划（方案 A）

> **执行方式：** 本计划采用 Superpowers 的 spec-first、TDD、subagent-driven workflow。每个 Gate/Task 必须先写失败测试（RED），再实现最小代码（GREEN），然后经过 spec review 和 code-quality review，最后才进入下一项。
>
> **范围：** 从当前仓库状态继续执行安全闸门和实施计划 Task 9 至 Task 30。Task 31 及以后属于第二阶段扩展，不在本计划内。
>
> **计划性质：** 本文件是执行计划，不代表其中功能已经实现。计划创建时工作区应保持干净；每次执行前必须重新运行 `git status --short --branch`。

**Goal:** 在不破坏已有身份、workspace、版本化文档和课程资产不变量的前提下，将 AIstudy 从数据与授权底座推进到第一阶段可验收的学习产品闭环。

**Architecture:** 保持 TypeScript 模块化单体。`apps/web` 负责页面和同步 API，`apps/worker` 负责 BullMQ 异步任务；PostgreSQL 是事实源，Redis/BullMQ 负责异步，S3 兼容存储负责对象。所有正式知识、学习历史和课程数据通过明确契约写入；AI 只能产生候选内容或 revision proposal，不能直接覆盖正式资产。

**Tech Stack:** Next.js App Router、React、TypeScript、PostgreSQL、Drizzle/现有 database repository、Redis、BullMQ、S3 兼容存储、Zod、Vitest、`@playwright/test`、npm workspaces。

**审查状态：** 本计划已完成规格、工程可执行性和发布安全审查。原草案不能直接执行；本版本固定了迁移策略、测试 runner、任务边界和发布阻断条件。

---

## 0. 已知基线与不可违反的不变量

计划依据：

- 产品设计：[2026-07-21-lifelong-learning-design.md](./2026-07-21-lifelong-learning-design.md)
- 原实施计划：[2026-07-21-lifelong-learning-implementation.md](./2026-07-21-lifelong-learning-implementation.md)
- 架构：[ARCHITECTURE.md](../architecture/ARCHITECTURE.md)
- 数据模型：[DATA_MODEL_AND_PREDICTION.md](../architecture/DATA_MODEL_AND_PREDICTION.md)

当前已确认的事实：

- 已有 `0001_library.sql`、`0002_courses.sql`、`0003_identity.sql`。
- 已有用户、session、workspace、文档、blocks、revisions、relations、properties、courses 和 memberships 基础实现。
- `packages/ui` 已有导航 contract，但真实 `/learn`、`/explore`、`/library` 页面不存在。
- `apps/worker` 仍是内存 smoke processor；真实 BullMQ 尚未接入。
- `npm run lint`、`npm run typecheck`、`npm run build`、`npm run test:integration` 当前通过。
- 当前 `npm test` 和旧 `npm run test:e2e` 因 workspace-navigation 测试的 PostgreSQL fallback 凭据而失败；Gate 0.4 将其拆分为 `test:handler` 与真实 `test:browser`，旧命令在完成 Gate 前不作为通过证据。

所有任务必须保持以下不变量：

1. **Workspace 隔离：** 任意读写都以服务端 session principal 的 workspace 为准，不能信任客户端 workspaceId。
2. **Revision 追加写：** 历史 revision 不更新、不删除；文档当前 blocks 是可重建 projection。
3. **资产身份稳定：** 课程通过 membership 引用资产，不复制资产正文或改变资产 identity。
4. **学习事件追加写：** 修正通过新 correction event，不更新历史事件。
5. **派生可重算：** Assessment、Planner 等输出必须带策略/模型/证据版本。
6. **AI candidate-only：** AI 输出必须 Schema 校验，并进入 candidate/proposal/review 流程。
7. **用户可退出自动化：** Free 模式不阻塞 Explore、Library 或自由学习；计划不能把计划外学习标记为失败。
8. **测试可复现：** 测试不能依赖隐藏的本机密码、未启动的服务或手工状态。
9. **默认 UI 简洁：** 高级模型参数、证据和内部权重只在 Developer Mode 展示。
10. **不引入第二阶段范围：** 不实现 PDF/EPUB、Zotero、Marketplace、白板、协同编辑或插件 SDK。

---

## 1. Superpowers 执行协议

每个 Gate/Task 都必须按下面的固定循环执行。不能跳过 RED，也不能把审查合并成“看过 diff”。

### 1.1 Implementer 步骤

1. 读取本任务计划、相关架构文档和当前代码。
2. 建立任务分支或在当前工作分支建立清晰的任务提交边界。
3. 先编写一个最小失败测试。
4. 运行目标测试，确认是预期的 RED，而不是 import、环境或测试本身错误。
5. 实现满足该测试的最小代码。
6. 运行目标测试确认 GREEN。
7. 补齐该任务剩余验收场景，每补一个场景都遵循 RED/GREEN。
8. 运行受影响 package 的 typecheck、lint 和相关 integration/e2e。
9. 只提交本任务范围内文件。

### 1.2 Spec Reviewer 步骤

Spec reviewer 只检查规格符合性：

- 计划列出的每个验收场景是否有测试证据；
- 是否满足数据不变量；
- 是否有漏实现的文件或 API contract；
- 是否偷偷改变了任务范围；
- 是否真实验证了用户路径，而非只测试内部函数。

输出必须为 `PASS` 或 `FAIL`，并列出缺口。`Critical` 或 `Important` 缺口必须修复后重新审查。

### 1.3 Code-Quality Reviewer 步骤

Code-quality reviewer 只检查：

- 是否重复实现已有 contract/repository 规则；
- 是否引入不必要抽象或第二套状态机；
- 错误处理、并发、幂等和 workspace 隔离是否完整；
- 测试是否稳定、命名是否清楚；
- 是否存在死代码、未接线代码或不必要依赖；
- 是否破坏现有模块边界。

### 1.4 每项任务的固定验证命令

根据任务类型选择并执行：

```bash
npm run lint
npm run typecheck
npm test -- <target-test>
npm run test:integration -- <target-test>
npm run test:browser -- <target-test>
npm run build
```

每个任务完成时必须记录：

- RED 命令和失败原因；
- GREEN 命令和结果；
- spec review 结果；
- quality review 结果；
- commit SHA；
- 未解决的低优先级问题。

---

# Phase 0：执行前安全闸门

这些 Gate 是 Task 9 的前置条件。即使原计划把它们遗漏，也不能绕过。

## Gate 0.1：修复身份迁移的数据保留风险

**目的：** 防止执行身份迁移时因为 orphan workspace 被级联删除而丢失历史学习数据。

**Files:**

- Create: `packages/database/src/migrations/0004_identity_repair.sql`（修复已经记录旧版 0003 的数据库，并作为新库的预检/约束补充步骤）
- Modify: `packages/database/src/migrate.ts`
- Create: `packages/database/src/migration-preflight.ts`
- Create: `tests/integration/identity-migration-compatibility.test.ts`
- Create: `tests/fixtures/migrations/legacy-0001-0002.sql`
- Modify: `tests/integration/test-database.ts`（仅在现有测试工具不足时）
- Create: `docs/operations/database-migrations.md`

### Step 1：先写失败测试

创建旧 schema fixture，至少包含：

- 一个无对应 user 的 workspace；
- 该 workspace 下的 document、block、relation、property、revision；
- 一个 course 和 asset membership；
- 一个有对应 user 的 workspace，用于证明正常路径不受影响。

测试必须验证：

```text
apply old schema
insert legacy data
apply legacy 0003_identity.sql to a legacy database that has not recorded 0003
expect preflight blocks before 0004 can apply further ownership constraints when owner mapping is missing
apply 0004_identity_repair.sql to a database that already recorded the old 0003
expect migration does not delete any workspace or dependent row
expect all legacy rows remain
expect revision protection trigger remains enabled
```

### Step 2：确认 RED

```bash
npm run test:integration -- identity-migration-compatibility
```

预期：测试因为现有迁移删除 orphan workspace 或升级策略不明确而失败。若因测试 fixture/import 失败，先修测试，不进入实现。

### Step 3：实现固定的预检阻断策略

本计划固定选择“迁移前预检并阻断”，不允许 implementer 在 quarantine、伪造 owner 和删除数据之间自行选择。

- 历史 migration 一律不可修改，`0003_identity.sql` 的既有内容与 checksum 保持不变；新库也先执行其原始版本，再通过 `0004_identity_repair.sql` 补充预检和安全约束；
- `migration-preflight.ts` 在 `0004` 增加或验证 owner 约束前查询 orphan workspace，并输出 workspace ID、关联 document/course/revision 数量和处置建议；
- 检测到 orphan 时以稳定错误码终止 `0004`，事务回滚，不执行新的删除、不关闭 revision trigger；旧版 `0003` 已发生的删除不能被错误表述为可逆；
- 通过人工确认的 owner 映射表执行回填，映射必须记录操作者、时间和来源；
- operator attestation 必须记录运行者、时间、目标数据库 fingerprint、已观察到的 migration IDs、preflight 摘要和备份证据位置；它证明的是本次升级决定，不能替代缺失的旧 migration checksum；
- 已经执行旧版 `0003` 且数据已被删除的环境，不能由 migration 自动恢复，必须先从可验证备份恢复或人工重建；无可验证备份时阻断发布；
- `0004_identity_repair.sql` 只负责已记录旧版 `0003` 的安全检查、保护 trigger 恢复/验证和约束补齐，不假设已删除数据可以凭空恢复。现有 `schema_migrations` 只有 `id` 和 `applied_at`，没有历史 checksum；因此不得声称能追溯证明旧 `0003` 的精确内容，也不得伪造或回填历史 checksum。对已经记录 `0003_identity.sql` 的旧库，runner 将其明确标记为 `legacy-unverified`，仅允许在数据库状态预检、operator attestation 和 `0004` 事务保护均通过后继续；其他未知历史版本、重复版本或新增 migration 的 checksum 漂移一律 fail closed。

禁止：

- `DELETE FROM workspaces` 清理 orphan 数据；
- 依赖 `ON DELETE CASCADE` 作为迁移清理手段；
- 用伪造 user 自动接管真实学习数据而不记录来源。

补充操作文档，写明：备份、预检、迁移、验证和失败恢复步骤。

### Step 4：确认 GREEN 与升级安全

```bash
npm run test:integration -- identity-migration-compatibility
npm run typecheck
npm run lint
```

### Step 5：Superpowers 双审查与提交

- Spec review：确认旧数据完整保留、owner 缺失策略可审计。
- Code-quality review：确认迁移没有隐式删除和不可逆副作用。
- Commit：`fix: preserve legacy workspaces during identity migration`

**Gate 验收：** 新旧两类数据库升级都会在 owner 无法确认时 fail closed；不会静默丢失 workspace、course、document、block、relation、property、membership、revision 或对象 manifest。已被旧 `0003` 删除的数据必须有备份恢复证据，否则不得发布。

---

## Gate 0.2：统一 migration 编号、升级和测试数据库规则

**目的：** 建立唯一 migration registry、canonical runner 和并发安全规则，让新库、旧库升级及已执行旧 `0003` 的 corrective migration 都可复现。

**Migration 顺序锁定为：**

```text
0001_library.sql
0002_courses.sql
0003_identity.sql
0004_identity_repair.sql
0005_workspace_preferences.sql
0006_explorations.sql
0007_async_jobs.sql
0008_ai_candidates.sql
0009_promotions.sql
0010_goals.sql
0011_learning_events.sql
0012_cards.sql
```

后续新增 migration 必须使用下一个唯一序号，禁止复用原计划中的旧编号。

**Files:**

- Modify: `packages/database/src/migrate.ts`
- Modify: `scripts/db-migrate.ts`（只调用 canonical runner，不保留第二套实现）
- Modify: `.env.example`
- Modify: `infra/docker/compose.yml`（仅当连接参数需要统一）
- Modify: `tests/integration/test-database.ts`
- Create: `tests/integration/migration-order.test.ts`
- Create: `docs/operations/database-migrations.md`（如 Gate 0.1 已创建则补充）

### Step 1：先写失败测试

覆盖：

- 空库按顺序执行全部现有 migrations；
- 已执行 migration 不重复执行；
- migration 文件编号唯一；
- 未知或跳号版本有明确错误；
- 同一数据库并发执行不会重复执行同一 migration SQL；
- registry schema 升级后，所有新执行 migration 都记录 SHA-256 checksum，后续 checksum 不一致时明确阻断；已有的无 checksum 行只能被标记为 `legacy-unverified`，不得反向声称与当前文件精确匹配；
- 对旧的已记录 `0003_identity.sql`，只接受确定的兼容路径：migration ID 存在、数据库结构预检通过、operator attestation 与备份证据齐全，才允许继续执行 `0004`；不能从这些证据中推断或回填旧 `0003` checksum；
- 已记录 `0003` 的旧库会执行 `0004_identity_repair.sql`，不会重新执行 `0003`。

### Step 2：确认 RED

```bash
npm run test:integration -- migration-order
```

预期：当前实现或计划编号不满足至少一个版本规则。

### Step 3：实现最小规则

- migration runner 以数字版本排序并校验 `^([0-9]{4})_[a-z0-9_-]+\\.sql$`；
- 每个文件在独立事务中执行并写入 `schema_migrations`；
- runner 通过向 `schema_migrations` 新增 nullable `checksum`、`verification_state` 和 `recorded_at` 字段演进 registry；历史行保持 `checksum IS NULL`、`verification_state = 'legacy-unverified'`，新执行行写入 SHA-256 和 `verification_state = 'verified'`；这个 registry 演进由 runner 的向后兼容 bootstrap 完成，不能修改 `0001_library.sql`；
- 文件名版本唯一；
- 使用 PostgreSQL advisory lock，覆盖读取已应用版本、执行 SQL 和写入 registry 的整个过程；
- 检查已应用未知版本、重复版本和 verified migration 的 checksum 漂移；对 `legacy-unverified` 的旧 `0003` 只走前述 attestation + database-state-preflight + `0004` corrective path，并把该兼容分支、缺 attestation 和非法状态阻断分支覆盖在升级测试中；
- 测试 fixture 使用显式 `DATABASE_URL`，不得包含 `***` fallback；
- 清楚区分空库测试、升级测试和业务 integration 测试。

### Step 4：确认 GREEN

```bash
npm run test:integration -- migration-order
npm run db:migrate
```

### Step 5：审查与提交

- Spec review：确认编号、空库、升级、幂等和并发要求均有证据。
- Quality review：确认没有通过字符串排序造成 `00010`/`0002` 顺序错误。
- Commit：`test: make migration upgrades deterministic`

---

## Gate 0.3：把 lifecycle transition 接入持久化路径

**目的：** 使 `packages/contracts` 中的 lifecycle 规则真正约束 repository。

**Files:**

- Modify: `packages/database/src/repositories/library.ts`
- Modify: `packages/contracts/src/assets.ts`（只在需要补充错误类型时）
- Modify: `packages/contracts/src/assets.test.ts`
- Modify: `tests/integration/library-repository.test.ts`

### Step 1：先写失败测试

至少覆盖：

- `candidate -> confirmed` 合法；
- `confirmed -> published` 合法；
- `published -> candidate` 非法；
- 非法转换不会改 lifecycle、updatedAt 或追加 revision；
- 旧文档没有显式 lifecycle 时使用明确默认值。

### Step 2：确认 RED

```bash
npm test -- packages/contracts/src/assets.test.ts tests/integration/library-repository.test.ts
```

预期：repository 目前允许非法转换，测试失败。

### Step 3：实现

- Repository update 先读取当前 lifecycle；
- 调用已有 `assertLifecycleTransition`；
- 在同一事务内拒绝非法转换；
- 使用机器可识别错误码；
- 不在 database package 重写一套迁移规则；本 Gate 只在 repository 层强制既有领域契约，不新增数据库约束 migration。
- Task 10 的编辑器/API 暴露 lifecycle 更新时，必须转发 `lifecycle` 并覆盖非法转换的 handler 级 `409`；本 Gate 不引入未接线的 API 分支。
- 历史 migration（包括 `0001_library.sql`）绝不修改；若未来确有数据库级 guard 的证据，应另行设计、使用下一个唯一编号 corrective migration，并同步升级 fixture 与 registry。

### Step 4：确认 GREEN

```bash
npm test -- packages/contracts/src/assets.test.ts
npm run test:integration -- library-repository
```

### Step 5：审查与提交

Commit：`fix: enforce asset lifecycle transitions in repository`

---

## Gate 0.4：建立真实可复现的 E2E 基础设施

**目的：** `test:browser` 必须使用 `@playwright/test` 启动真实 Next.js 服务并访问真实页面；Route Handler 测试统一归入 `test:handler`，禁止同一 spec 在不同环境走不同路径。

**Files:**

- Move/Create: `tests/integration/handler/workspace-navigation.test.ts`
- Move/Create: `tests/integration/handler/auth.test.ts`
- Create: `tests/e2e/workspace-navigation.spec.ts`（Playwright Test spec）
- Create: `tests/e2e/auth.spec.ts`（Playwright Test spec）
- Create: `tests/e2e/e2e-server-smoke.spec.ts`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.env.example`
- Modify: `infra/docker/compose.yml`
- Modify: `docs/operations/ci.md`
- Create: `tests/integration/e2e-environment.test.ts`

### Step 1：先写失败的真实 server smoke test

测试必须：

- 启动 Next server；
- 访问 `/api/health` 或现有根页面；
- 使用 Playwright 建立真实 browser context；
- 在 320、768、1440 viewport 至少各执行一次页面访问；
- 不使用 direct handler 作为默认路径。

### Step 2：确认 RED

```bash
npm run test:browser -- e2e-server-smoke
```

预期：当前没有真实 server fixture 或 `E2E_BASE_URL`，测试失败。

### Step 3：实现测试运行器和 CI 接线

要求：

- Playwright 与 Vitest 的职责分开：`npm run test:handler` 运行 Route Handler 测试，`npm run test:browser` 运行 `playwright test`；
- 将 Playwright 作为根 workspace 的开发依赖显式加入 `package.json`，使用 lockfile 更新，不依赖 `spikes/test-tooling` 的传递依赖；
- CI 在 E2E 前执行 migration；
- CI 启动 Web server 并等待健康检查；
- 设置 `E2E_BASE_URL`；
- 测试数据库凭据来自同一套 CI env；
- 删除现有 E2E 的 direct-handler/static HTML fallback；缺少 live server、凭据或数据库时真实浏览器测试必须 fail closed；
- handler 测试不得伪装成 browser E2E；
- 失败时输出 server log 和页面 URL。

### Step 4：确认 GREEN

```bash
npm run test:browser -- e2e-server-smoke
npm run test:browser -- auth
npm run test:browser -- workspace-navigation
```

### Step 5：审查与提交

- Spec review：确认是真实 HTTP + browser，不是 HTML 字符串。
- Quality review：确认 server lifecycle、端口清理、失败日志和凭据注入稳定。
- Commit：`test: run browser flows against a real web server`

**Phase 0 出口条件：**

```bash
npm run lint
npm run typecheck
npm run test:handler
npm run test:integration
npm run test:browser
npm run build
```

全部通过后才能开始 Task 9。

---

# Phase 1：真实三入口、笔记和搜索

## Task 9：Build the Three-Entry Application Shell

**目的：** 将导航 contract 变成真实 workspace 应用壳。

**执行状态：**已完成（2026-08-01）。三入口路由与响应式导航沿用既有实现；Task 9 补充了 `0005_workspace_preferences.sql`、session-scoped preference API、服务端根路由重定向和真实 browser 回归。无偏好 workspace 明确回退到 `/learn`，onboarding 选择则持久化到 workspace-scoped 数据库记录。

**Files:**

- Create: `apps/web/src/app/(workspace)/layout.tsx`
- Create: `apps/web/src/app/(workspace)/learn/page.tsx`
- Create: `apps/web/src/app/(workspace)/explore/page.tsx`
- Create: `apps/web/src/app/(workspace)/library/page.tsx`
- Create: `packages/database/src/schema/preferences.ts`
- Create: `packages/database/src/migrations/0005_workspace_preferences.sql`
- Create: `packages/database/src/repositories/preferences.ts`
- Create: `apps/web/src/app/api/workspace/preferences/route.ts`
- Modify: `packages/ui/src/workspace-navigation.tsx`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/web/src/features/workspace/navigation.ts`
- Test: `packages/ui/src/workspace-navigation.test.tsx`
- Test: `tests/integration/handler/workspace-preferences.test.ts`
- Test: `tests/e2e/workspace-navigation.spec.ts`

### Step 1：写失败测试

组件测试：

- Learn、Explore、Library 三个入口都渲染；
- 三者具有相同的导航语义和可访问名称；
- Tab/Shift+Tab 顺序稳定；
- active 状态由 pathname 决定；
- mobile 使用 bottom placement，desktop 使用 sidebar placement。

E2E：

- 已登录用户可访问三条路径；
- 切换入口后刷新仍保留路径；
- 用户选择默认入口后根路径进入该入口；
- 无课程、无目标时 Explore 和 Library 可使用；
- 320、768、1440 viewport 无横向溢出和主要区域重叠。

Handler 测试：

- 未登录请求被拒绝；
- handler 从 session principal 推导 workspace，忽略请求体中的 workspace ID；
- 只能读取和更新自己的默认入口；
- 无效入口和无效 body 被 Zod contract 拒绝；
- 更新后读取返回同一 workspace 的持久化 preference。

### Step 2：确认 RED

```bash
npm test -- packages/ui/src/workspace-navigation.test.tsx
npm run test:handler -- workspace-preferences
npm run test:browser -- workspace-navigation
```

### Step 3：最小实现

- workspace layout 统一加载导航和主要区域；
- 页面先提供真实可交互的基础内容，不做营销 landing page；
- 默认入口使用明确的用户/workspace preference 存储策略；
- 默认入口 preference 使用 workspace-scoped database row，经 session principal 授权；不得只依赖未签名 cookie；
- root route 根据 preference 处理，不硬编码 Learn redirect；
- 认证失败统一进入登录流程；
- 使用现有 UI contract，不创建第二套导航状态机。

### Step 4：确认 GREEN

```bash
npm test -- packages/ui/src/workspace-navigation.test.tsx
npm run test:handler -- workspace-preferences
npm run test:browser -- workspace-navigation
npm run build
```

### Step 5：审查与提交

Commit：`feat: add equal learning exploration and library navigation`

**出口：** 构建路由清单出现 `/learn`、`/explore`、`/library`，真实浏览器测试通过。

---

## Task 10：Build the Versioned Block Editor Core

**Files:**

- Create: `apps/web/src/features/editor/`
- Create: `packages/domain/src/documents/commands.ts`
- Create: `packages/domain/src/documents/commands.test.ts`
- Create: `tests/e2e/document-editor.spec.ts`
- Modify: `packages/contracts/src/`（仅新增 editor/block schemas）
- Modify: `packages/database/src/repositories/library.ts`（仅通过现有 revision API 接线）

### Step 1：写失败测试

Domain command 测试：

- 创建 heading、paragraph、list、quote、code、math、table、media block；
- 每个 block 有稳定 ID；
- 插入、更新、删除操作保持其他 block IDs；
- undo 返回上一个 document state；
- revision command 记录 base revision 和新 blocks；
- 不允许直接改变历史 revision。

E2E：

- 创建文档；
- 编辑至少三种 block；
- 保存后刷新内容仍存在；
- undo 可恢复；
- revision history 显示新版本；
- 另一个 workspace 无法读取该文档。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/documents/commands.test.ts
npm run test:browser -- document-editor
```

### Step 3：实现

- 先完成纯 domain command；
- 再接现有 document/revision repository；
- editor UI 只支持测试覆盖的 block 类型；
- 保存使用乐观 revision/base version；
- 冲突返回可识别错误，不覆盖用户版本。

### Step 4：确认 GREEN

```bash
npm test -- packages/domain/src/documents/commands.test.ts
npm run test:browser -- document-editor
npm run test:integration -- library-repository
```

### Step 5：审查与提交

Commit：`feat: add the versioned block note editor`

**禁止：** 在本任务引入协同编辑、完整富文本插件生态或 PDF 阅读器。

---

## Task 11：Backlinks、Block References、Embeds、Tags、Properties

**Files:**

- Create: `packages/domain/src/relations/`
- Create: `apps/web/src/features/knowledge-links/`
- Create: `packages/domain/src/relations/relations.test.ts`
- Create: `tests/e2e/knowledge-links.spec.ts`
- Modify: `packages/database/src/repositories/library.ts`
- Modify: `packages/contracts/src/relations.ts`（如需要）

### Step 1：写失败测试

覆盖：

- document backlink；
- block reference；
- transclusion/embed 只保存 source identity；
- host 文档不复制引用正文；
- tag/property 查询；
- soft delete 后显示 broken link；
- restore 或 replace referenced block；
- 跨 workspace relation 被拒绝。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/relations/relations.test.ts
npm run test:browser -- knowledge-links
```

### Step 3：实现

- relation kind 使用 typed contract；
- embed 在读取时解析源内容；
- source 不存在时返回稳定 broken-link 对象；
- repository 事务内验证两端 workspace 相同；
- property/tag 查询使用现有数据模型，不造第二套标签表。

### Step 4：确认 GREEN

```bash
npm test -- packages/domain/src/relations/relations.test.ts
npm run test:browser -- knowledge-links
npm run test:integration -- library-repository
```

### Step 5：审查与提交

Commit：`feat: connect notes with backlinks and block embeds`

---

## Task 12：Global Search and Command Palette

**Files:**

- Create: `packages/contracts/src/search.ts`
- Create: `packages/domain/src/search/results.ts`
- Create: `packages/database/src/repositories/search.ts`
- Create: `apps/web/src/app/api/search/route.ts`
- Create: `apps/web/src/features/search/search-panel.tsx`
- Create: `apps/web/src/features/command-palette/command-palette.tsx`
- Create: `tests/integration/search.test.ts`
- Create: `tests/integration/handler/search.test.ts`
- Create: `tests/e2e/command-palette.spec.ts`

### Step 1：写失败测试

本任务只覆盖已经存在的 document、block、course 和 relation。exploration、card、artifact/source 的 index 扩展分别随 Task 13、Task 23 和对象存储任务加入，不能在其 schema 前伪造 fixture。验证：

- query 跨类型搜索；
- workspace 隔离；
- 结果含 type、lifecycle、course memberships；
- 分页和空结果；
- command palette 可搜索并创建 note/course；exploration 创建命令在 Task 13 后扩展；
- 键盘打开、关闭和选择命令。

Handler 测试：

- 未登录请求被拒绝；
- session principal 是唯一 workspace scope 来源；
- 请求中的 workspace ID 或 cursor 不能越权读取其他 workspace；
- query、cursor、limit 的 Zod 输入错误返回稳定错误；
- 分页边界和空结果经过 Route Handler 保持 contract 形状。

### Step 2：确认 RED

```bash
npm run test:integration -- search
npm run test:handler -- search
npm run test:browser -- command-palette
```

### Step 3：实现

- 使用 PostgreSQL full-text baseline；
- Zod contract 定义 `SearchResult`、cursor、稳定排序和授权错误；
- repository 层负责分页、workspace filter 和排序；
- command palette 只编排已有创建命令；
- 不引入 vector search。

### Step 4：确认 GREEN

```bash
npm run test:integration -- search
npm run test:handler -- search
npm run test:browser -- command-palette
npm run typecheck
```

### Step 5：审查与提交

Commit：`feat: search and create across the learning workspace`

---

# Phase 2：Free Exploration 与 Selective Promotion

## Task 13：Persist Explorations, Branches, and Scratch Blocks

**Migration：** `0008_explorations.sql`，使用 Gate 0.2 的唯一 registry，不得复用已存在的 `0001` 至 `0007`。

**Files:**

- Create: `packages/database/src/schema/explorations.ts`
- Create: `packages/database/src/migrations/0006_explorations.sql`
- Create: `packages/database/src/repositories/explorations.ts`
- Create: `packages/contracts/src/exploration.ts`
- Create: `apps/web/src/features/exploration/`
- Create: `tests/integration/exploration-repository.test.ts`
- Create: `tests/e2e/free-exploration.spec.ts`

### Step 1：写失败测试

无 course、无 goal 的用户必须可以：

- 创建 exploration；
- 增加 scratch blocks；
- 创建 conversation branch；
- 记录 hypothesis/open question；
- close 后 resume；
- 另一 workspace 无法读取。

### Step 2：确认 RED

```bash
npm run test:integration -- exploration-repository
npm run test:browser -- free-exploration
```

### Step 3：实现

- courseId、goalId 为 nullable；
- exploration 与 scratch block 有稳定 identity；
- branch 不复制 parent 内容；
- close/resume 是显式状态转换；
- 所有 repository 查询强制 workspace filter。

### Step 4：确认 GREEN

```bash
npm run test:integration -- exploration-repository
npm run test:browser -- free-exploration
npm run db:migrate
```

### Step 5：审查与提交

Commit：`feat: support goal-free learning explorations`

**Execution status (2026-08-04):** Implemented the persisted exploration contracts, PostgreSQL schema/repository, principal-bound handlers, and real Explore UI. Direct contract/typecheck/targeted lint and existing Explore model tests passed; PostgreSQL repository/handler suites are blocked by missing `DATABASE_URL`, and wrapper/browser gates are blocked by the host missing `flock` (the Playwright spec is discoverable with two tests). No commit was created.

---

## Task 14：AI Roles、Provider-Neutral Jobs 与真实 BullMQ Worker

**目的：** 首次把 Worker 从 smoke processor 推进为可重试、可幂等、可降级的 BullMQ pipeline。

**Files:**

- Create: `packages/ai/src/providers/provider.ts`
- Create: `packages/ai/src/roles.ts`
- Create: `packages/ai/src/roles.test.ts`
- Create: `packages/contracts/src/ai-jobs.ts`
- Create: `packages/database/src/schema/async-jobs.ts`
- Create: `packages/database/src/migrations/0007_async_jobs.sql`
- Create: `packages/database/src/repositories/async-jobs.ts`
- Create: `packages/database/src/schema/ai-candidates.ts`
- Create: `packages/database/src/migrations/0008_ai_candidates.sql`
- Create: `packages/database/src/repositories/ai-candidates.ts`
- Create: `apps/worker/src/jobs/exploration-chat.ts`
- Create: `apps/worker/src/queue.ts`
- Create: `apps/worker/src/worker-runtime.ts`
- Create: `tests/integration/exploration-chat-job.test.ts`
- Create: `tests/integration/queue-retry-idempotency.test.ts`
- Modify: `apps/worker/src/index.ts`
- Modify: `packages/ai/src/index.ts`
- Modify: `package.json` / `apps/worker/package.json`（仅补真实运行所需依赖）

### Step 1：写失败测试

Role contract：

- retriever、explainer、tutor、challenger、editor、examiner、collaborator、silent assistant 均有 policy；
- 输出 schema 不合法时拒绝；
- provider、model、prompt policy、sources、cost、provenance 被记录；
- candidate 不能直接 mutate confirmed asset。

Queue contract：

- 相同 idempotency key 不重复执行；
- transient error 按策略重试；
- permanent error 进入 failed/dead-letter 状态；
- AI provider unavailable 时 exploration 可继续；
- learning event 等核心同步写不依赖 AI 成功。

### Step 2：确认 RED

```bash
npm test -- packages/ai/src/roles.test.ts
npm run test:integration -- exploration-chat-job
```

### Step 3：实现

- provider 只负责请求和返回候选结构；
- role policy 在 domain/ai 包中保持 provider-neutral；
- BullMQ job payload 使用 Zod contract；
- job id 使用业务幂等键；
- retry/backoff/dead-letter 明确配置；
- Worker 只写 candidate/job state，不写 confirmed asset；
- 使用 `async_jobs` outbox 表；业务事务只写 outbox，dispatcher 负责投递 BullMQ；job claim/lease、最大重试次数、退避、dead-letter 和 replay policy 必须写入 contract；
- candidate、promotion、revision proposal 的业务 effect 必须有数据库唯一键，不能只依赖 BullMQ `jobId`；
- AI/worker repository 接受显式 job context，直接写 confirmed/published asset 必须拒绝。

### Step 4：确认 GREEN

```bash
npm test -- packages/ai/src/roles.test.ts
npm run test:integration -- exploration-chat-job
npm run test:integration -- queue-retry-idempotency
npm run worker:dev
```

Worker 启动必须输出 queue/worker ready，停止时释放 Redis connection。

### Step 5：审查与提交

- Spec review：核对八种 role、candidate-only、幂等、重试、降级。
- Quality review：核对 Worker 生命周期和失败处理。
- Commit：`feat: add switchable AI roles and durable exploration jobs`

---

## Task 15：Candidate Promotion

**Files:**

- Create: `packages/database/src/schema/promotions.ts`
- Create: `packages/database/src/migrations/0009_promotions.sql`
- Create: `packages/database/src/repositories/promotions.ts`
- Create: `packages/domain/src/promotions/`
- Create: `apps/web/src/features/promotion-review/`
- Create: `packages/domain/src/promotions/promotions.test.ts`
- Create: `tests/integration/promotion-repository.test.ts`
- Create: `tests/e2e/exploration-promotion.spec.ts`

### Step 1：写失败测试

完整场景：

1. 创建无课程 exploration；
2. 提议两个 notes、一个 open question、两个 cards、一个 task；
3. 接受一个 note 和一个 card；
4. 编辑已接受 note；
5. 拒绝其他候选；
6. 验证正式资产保留 exploration provenance；
7. 将 note 加入两个课程，不复制正文和 identity；
8. 从 note 返回 exploration。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/promotions/promotions.test.ts
npm run test:integration -- promotion-repository
npm run test:browser -- exploration-promotion
```

### Step 3：实现

- PromotionRecord 保存 source exploration、candidate identity、review action、actor 和时间；
- accept note/card 使用正式资产创建命令；
- reject 不删除 exploration；
- 只接受选中候选，不把整个 conversation 标记 confirmed；
- 资产写入和 provenance 写入在同一事务中。

### Step 4：确认 GREEN

```bash
npm test -- packages/domain/src/promotions/promotions.test.ts
npm run test:integration -- promotion-repository
npm run test:browser -- exploration-promotion
```

### Step 5：审查与提交

Commit：`feat: selectively promote exploration insights`

---

## Task 16：AI Revision Proposal 与冲突审查

**Files:**

- Create: `packages/contracts/src/revision-proposal.ts`
- Create: `packages/domain/src/revisions/proposals.ts`
- Create: `packages/domain/src/revisions/proposals.test.ts`
- Create: `apps/web/src/features/revision-review/`
- Create: `tests/integration/revision-proposal.test.ts`
- Create: `tests/e2e/ai-note-revision.spec.ts`

### Step 1：写失败测试

- proposal 包含 base revision、proposed blocks、diff、provenance、support state；
- base revision 未变化时可 review；
- 用户并发编辑后接受旧 proposal 返回 conflict；
- accept、reject、partial accept、preserve-both 均可测试；
- 接受结果只产生新 revision，不改历史。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/revisions/proposals.test.ts
npm run test:integration -- revision-proposal
npm run test:browser -- ai-note-revision
```

### Step 3：实现

- proposal 是独立对象；
- merge 使用 base revision 乐观并发检查；
- conflict 返回双方内容和可执行 resolution；
- review action 可审计；
- AI 不能绕过 proposal API。

### Step 4：确认 GREEN

同上三条测试命令，加 `npm run typecheck`。

### Step 5：审查与提交

Commit：`feat: review AI note edits before merging`

---

# Phase 3：Long-Lived Courses、Multiple Goals 与 Guidance

## Task 17：Course Requirement Profiles

**Files:**

- Create: `packages/contracts/src/course-requirements.ts`
- Create: `packages/domain/src/courses/requirements.ts`
- Create: `packages/domain/src/courses/requirements.test.ts`
- Create: `apps/web/src/features/course-settings/`
- Create: `tests/e2e/course-requirements.spec.ts`

### Step 1：写失败测试

覆盖 memory、mathematical/procedural、language、research/writing、programming/project、free-exploration 六种 profile；支持 preset、assessment disabled、未知 profile 拒绝。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/courses/requirements.test.ts
npm run test:browser -- course-requirements
```

### Step 3：实现

- contract 版本化；
- 默认 UI 只显示 preset；
- 高级权重隐藏在 developer settings；
- profile 不复制 course asset；
- assessment disabled 后派生层返回明确 disabled reason。

### Step 4：确认 GREEN

目标测试、typecheck、lint。

### Step 5：审查与提交

Commit：`feat: configure learning requirements per course`

---

## Task 18：Multiple Goals 与 Time Windows

**Migration：** `0010_goals.sql`，使用 Gate 0.2 的唯一 registry，不能静默覆盖或改名。

**Files:**

- Create: `packages/database/src/schema/goals.ts`
- Create: `packages/database/src/migrations/0010_goals.sql`
- Create: `packages/database/src/repositories/goals.ts`
- Create: `packages/domain/src/goals/effective-requirements.ts`
- Create: `packages/domain/src/goals/effective-requirements.test.ts`
- Create: `tests/integration/multi-goal-course.test.ts`

### Step 1：写失败测试

同一数学课程创建 final、entrance、interest、maintenance 四个目标，验证：

- 目标各自有时间窗口；
- 资产和历史共享；
- requirements 按版本合并；
- override 优先级正确；
- 无 active goal 时回退 course baseline；
- 过期窗口不影响当前结果。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/goals/effective-requirements.test.ts
npm run test:integration -- multi-goal-course
```

### Step 3：实现

固定顺序：

```text
course baseline
→ active goal requirements
→ current time-window modifier
→ user override
```

所有输出包含 strategy version 和 effective-at 时间。

### Step 4：确认 GREEN

目标测试、integration、typecheck。

### Step 5：审查与提交

Commit：`feat: combine multiple course goals and time windows`

---

## Task 19：Free、Advisory、Coach Guidance

**Files:**

- Create: `packages/domain/src/guidance/`
- Create: `packages/domain/src/guidance/guidance.test.ts`
- Create: `apps/web/src/features/guidance-settings/`
- Create: `tests/e2e/guidance-modes.spec.ts`

### Step 1：写失败测试

- Free 无 auto-plan、无 blocked feature；
- Advisory 建议必须确认；
- Coach 只能调整 future tasks；
- Coach 不改 history/confirmed knowledge；
- protected exploration time 不被计划占用；
- course 可覆盖 workspace default。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/guidance/guidance.test.ts
npm run test:browser -- guidance-modes
```

### Step 3：实现

- mode policy 是纯 domain rule；
- UI 只调用 policy 输出；
- 每次自动调整带 reason；
- 未配置时默认为 Free 或现有产品约定的明确默认值。

### Step 4：确认 GREEN

目标测试、E2E、typecheck。

### Step 5：审查与提交

Commit：`feat: make learning guidance independently adjustable`

---

## Task 20：Optional Onboarding

**Files:**

- Create: `apps/web/src/features/onboarding/`
- Create: `tests/e2e/onboarding-paths.spec.ts`
- Modify: `apps/web/src/app/(workspace)/`（接入入口）

### Step 1：写失败 E2E

四条路径：

- A：直接开始 free exploration；
- B：创建 course + final-exam goal；
- C：promotion 创建新 course；
- D：创建无 plan 的 knowledge-only course。

每条路径必须验证可到达 Explore/Library，且不强制 diagnostic、deadline 或 course creation。

### Step 2：确认 RED

```bash
npm run test:browser -- onboarding-paths
```

### Step 3：实现

- onboarding 是可跳过的引导，不是权限闸门；
- 保存用户选择，重复访问不会丢失；
- promotion 路径复用已有 asset identity；
- 失败时保留已创建数据，不产生半成品不可见记录。

### Step 4：确认 GREEN

E2E、typecheck、build。

### Step 5：审查与提交

Commit：`feat: offer goal-driven and free onboarding paths`

---

# Phase 4：Learning Events、Practice、SRS、Assessment、Planning

## Task 21：Append-Only Learning Events

**Migration：** `0011_learning_events.sql`，使用 Gate 0.2 的唯一 registry，不能静默覆盖或改名。

**Files:**

- Create: `packages/contracts/src/learning-events.ts`
- Create: `packages/database/src/schema/learning-events.ts`
- Create: `packages/database/src/migrations/0011_learning_events.sql`
- Create: `packages/database/src/repositories/learning-events.ts`
- Create: `tests/integration/learning-event-idempotency.test.ts`
- Create: `packages/contracts/src/learning-events.test.ts`

### Step 1：写失败测试

- typed event envelope；
- schema version；
- idempotency key 重试不重复；
- correction event 不改原事件；
- content version reference 保留；
- historical payload immutable；
- workspace/user mismatch 被拒绝。

### Step 2：确认 RED

```bash
npm test -- packages/contracts/src/learning-events.test.ts
npm run test:integration -- learning-event-idempotency
```

### Step 3：实现

重要字段结构化，低频字段使用经过 Zod 校验的 JSONB；禁止 generic unvalidated JSON-only event table。唯一约束和事务保证幂等。

### Step 4：确认 GREEN

目标测试、integration、typecheck。

### Step 5：审查与提交

Commit：`feat: record immutable personal learning events`

---

## Task 22：Practice Player 与 Attempt Capture

**Files:**

- Create: `apps/web/src/features/practice/`
- Create: `packages/contracts/src/attempts.ts`
- Create: `packages/contracts/src/attempts.test.ts`
- Create: `tests/e2e/practice-player.spec.ts`
- Modify: learning event repository only through public command/API

### Step 1：写失败测试

覆盖 multiple choice、short answer、procedural checkpoint，并记录 answer、timing、hints、confidence、error attribution。retry 不重复 attempt；看答案标记 assisted evidence。

### Step 2：确认 RED

```bash
npm test -- packages/contracts/src/attempts.test.ts
npm run test:browser -- practice-player
```

### Step 3：实现

- attempt payload 先 Schema 校验；
- 保存 attempt 同时追加 learning event；
- idempotency key 贯穿 UI retry 和 repository；
- UI 显示保存状态，网络失败不丢答案。

### Step 4：确认 GREEN

目标测试、integration event test、E2E。

### Step 5：审查与提交

Commit：`feat: capture contextual practice attempts`

---

## Task 23：Cards 与 One Personal SRS State

**Migration：** `0012_cards.sql`，使用 Gate 0.2 的唯一 registry，不能静默覆盖或改名。

**Files:**

- Create: `packages/database/src/schema/cards.ts`
- Create: `packages/database/src/migrations/0012_cards.sql`
- Create: `packages/database/src/repositories/cards.ts`
- Create: `packages/domain/src/srs/`
- Create: `packages/domain/src/srs/scheduler.test.ts`
- Create: `apps/web/src/features/review/`
- Create: `tests/integration/card-multi-goal-state.test.ts`

### Step 1：写失败测试

同一 card 加入两个 courses、三个 goals，验证只有一个 personal review state；goal 只改 priority/deadline，不复制 history。覆盖 auto、self-selected、free review、pause、archive、exclude assessment、maintain until date。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/srs/scheduler.test.ts
npm run test:integration -- card-multi-goal-state
```

### Step 3：实现

- card identity 与 course/goal membership 分离；
- review state 以 user+card 唯一；
- scheduler 是可测试 deterministic baseline；
- 不在此任务引入 FSRS 复杂模型，除非已有设计明确批准。

### Step 4：确认 GREEN

目标测试、integration、typecheck。

### Step 5：审查与提交

Commit：`feat: review shared cards with one personal schedule`

---

## Task 24：Contextual Ability Assessment

**Files:**

- Create: `packages/contracts/src/assessment.ts`
- Create: `packages/domain/src/assessment/`
- Create: `packages/domain/src/assessment/assessment.test.ts`
- Create: `tests/integration/assessment-replay.test.ts`（强制）

### Step 1：写失败测试

覆盖 recognition、recall、procedure、transfer、expression、timed stability、retention；输出仅为 stable/usable/weak/untested，附 reason codes、action、evidence snapshot 和 model/rule version。course/goal 可 disable slice。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/assessment/assessment.test.ts
npm run test:integration -- assessment-replay
```

### Step 3：实现

- 规则 baseline 配置化、版本化；
- 结果可由同一 evidence snapshot 重现；
- 不存全局 mastery percentage；
- 看答案、提示、限时、信心和重复错因按数据模型处理；
- 默认 UI 只消费精简 SummaryBand。

### Step 4：确认 GREEN

目标测试、replay test、typecheck。

### Step 5：审查与提交

Commit：`feat: derive contextual learning status from evidence`

---

## Task 25：Deterministic Planner

**Files:**

- Create: `packages/contracts/src/plan.ts`
- Create: `packages/domain/src/planning/`
- Create: `packages/domain/src/planning/planner.test.ts`
- Create: `apps/web/src/features/today-plan/`
- Create: `tests/e2e/today-plan.spec.ts`

### Step 1：写失败测试

planner 必须：

- honor time budget；
- preserve locked tasks；
- preserve protected exploration time；
- support final/entrance/maintenance goals；
- conflict 时返回 2–3 options；
- explain every task；
- allow plan disabled；
- 不把计划外学习标为 failure；
- deterministic：同样输入、strategy version 和 evidence snapshot 得到同样结果。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/planning/planner.test.ts
npm run test:browser -- today-plan
```

### Step 3：实现

- 纯 domain deterministic baseline；
- task ranking 记录 reason code；
- 输出包含 strategy version/evidence snapshot；
- UI 提供 option 选择，不强制自动接受；
- AI optimization 不在本任务内。

### Step 4：确认 GREEN

目标测试、E2E、typecheck。

### Step 5：审查与提交

Commit：`feat: plan learning without constraining exploration`

---

# Phase 5：Portability、Diagnostics 与 First-Phase Acceptance

## Task 26：Markdown Import/Export

**Files:**

- Create: `packages/domain/src/portability/markdown/`
- Create: `packages/domain/src/portability/markdown/roundtrip.test.ts`
- Create: `packages/contracts/src/portability.ts`（如统一结果契约尚不存在）
- Create: `apps/web/src/app/api/exports/markdown/route.ts`
- Create: `apps/web/src/features/library/export-menu.tsx`
- Create: `tests/integration/handler/markdown-export-route.test.ts`
- Create: `tests/e2e/markdown-export.spec.ts`

### Step 1：写失败 round-trip tests

覆盖 headings、lists、code、math、tables、attachments、links、block IDs、tags 和 unsupported feature loss report。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/portability/markdown/roundtrip.test.ts
npm run test:handler -- markdown-export-route
```

### Step 3：实现

- importer/exporter 使用 typed intermediate representation；
- 保留 source files 和 attachments manifest；
- block identity 映射可追溯；
- 不支持的语义产生结构化 loss report；
- 不声称无损。
- 导出 route 必须从 session principal 推导 workspace，不接受客户端 workspaceId；下载响应同时包含内容、manifest 和 loss report。

### Step 4：确认 GREEN

目标 domain test、`npm run test:handler -- markdown-export-route`、browser E2E、typecheck、lint。handler test 必须证明 session-derived workspace 授权以及跨 workspace 导出拒绝。

### Step 5：审查与提交

Commit：`feat: exchange notes through Markdown`

---

## Task 27：Anki Projection 与 Loss Report

**Files:**

- Create: `packages/domain/src/portability/anki/`
- Create: `packages/domain/src/portability/anki/export.test.ts`
- Create: `tests/integration/handler/anki-export-route.test.ts`
- Create: `apps/web/src/app/api/exports/anki/route.ts`
- Modify: `apps/web/src/features/library/export-menu.tsx`
- Create: `tests/e2e/anki-export.spec.ts`

### Step 1：写失败测试

导出 card content、media、tags、source links 和支持的 scheduling fields；报告 course requirements、exploration provenance、relations、unsupported review history 的损失。

### Step 2：确认 RED

```bash
npm test -- packages/domain/src/portability/anki/export.test.ts
npm run test:handler -- anki-export-route
```

### Step 3：实现

- 使用 Anki 可表达的 projection；
- media 有稳定 manifest；
- 输出 loss report；
- 不把 Anki 导出描述为完整备份。
- export route 从 session principal 推导 workspace，不接受客户端 workspaceId，并拒绝跨 workspace 导出。

### Step 4：确认 GREEN

目标 domain test、`npm run test:handler -- anki-export-route`、browser E2E、typecheck。

### Step 5：审查与提交

Commit：`feat: export cards with explicit Anki projection loss`

---

## Task 28：Complete Native Backup/Restore

**Files:**

- Create: `packages/contracts/src/backup.ts`
- Create: `packages/domain/src/portability/native/`
- Create: `packages/domain/src/portability/native/backup.test.ts`
- Create: `tests/integration/native-backup-roundtrip.test.ts`
- Create: `packages/database/src/repositories/backup-restore.ts`
- Create: `apps/web/src/app/api/backups/export/route.ts`
- Create: `apps/web/src/app/api/backups/restore/route.ts`
- Create: `apps/web/src/features/library/backup-menu.tsx`
- Create: `tests/integration/handler/backup-routes-authorization.test.ts`
- Create: `tests/e2e/native-backup.spec.ts`

### Step 1：写失败 round-trip test

备份并恢复：workspace、courses、memberships、goals、windows、documents、blocks、relations、revisions、explorations、promotions、cards、events 和 referenced file manifest。

验证：

- fresh database restore；
- schema manifest；
- migration compatibility；
- identity count；
- relation count；
- revision count；
- file manifest count。
- file byte hash、revision identity、event/card identity 和 workspace authorization。

### Step 2：确认 RED

```bash
npm run test:integration -- native-backup-roundtrip
npm run test:handler -- backup-routes-authorization
```

### Step 3：实现

- native package 有 format version 和 schema manifest；
- restore 按依赖拓扑执行；
- 外部 ID 不覆盖现有数据；
- 失败整体回滚；
- restore 结果输出 warning/loss report。
- restore API 仅允许目标 workspace principal 发起；已存在 ID 的冲突策略必须显式返回，不能覆盖。

### Step 4：确认 GREEN

目标 round-trip integration test、`npm run test:handler -- backup-routes-authorization`、browser E2E，并在新测试数据库执行真实 restore。handler test 必须覆盖 session-derived target workspace、跨 workspace export/restore 拒绝，以及冲突 ID 不会覆盖数据。

### Step 5：审查与提交

Commit：`feat: restore complete learning workspaces`

---

## Task 29：Read-only Developer Diagnostics

**Files:**

- Create: `apps/web/src/features/developer-settings/`
- Create: `packages/contracts/src/diagnostics.ts`
- Create: `tests/e2e/developer-settings.spec.ts`
- Create: `tests/integration/diagnostics.test.ts`（如需要）

### Step 1：写失败测试

默认 UI 不显示：weights、raw events、model internals。Developer Mode 显示：

- strategy inheritance；
- evidence events；
- model versions；
- task ranking；
- AI provenance；
- export diagnostics。

参数编辑必须被拒绝或不存在。

### Step 2：确认 RED

```bash
npm run test:browser -- developer-settings
```

### Step 3：实现

- 只读 diagnostics contract；
- 与用户解释使用同一 result objects；
- workspace authorization 与普通页面一致；
- Developer Mode 为显式开关，不改变领域结果。

### Step 4：确认 GREEN

E2E、integration（如有）、typecheck。

### Step 5：审查与提交

Commit：`feat: expose advanced learning diagnostics on demand`

---

## Task 30：第一阶段验收套件与发布判断

**Files:**

- Create: `tests/e2e/acceptance/final-exam-user.spec.ts`
- Create: `tests/e2e/acceptance/multi-goal-user.spec.ts`
- Create: `tests/e2e/acceptance/research-user.spec.ts`
- Create: `tests/e2e/acceptance/lifelong-user.spec.ts`
- Create: `tests/e2e/acceptance/cross-course-assets.spec.ts`
- Create: `tests/integration/acceptance/database-upgrade.test.ts`（强制；使用隔离旧库 fixture，不通过浏览器伪装迁移测试）
- Create: `docs/releases/phase-1-acceptance.md`
- Create: `docs/releases/phase-1-security-audit.md`
- Create: `docs/releases/phase-1-restore-rehearsal.md`
- Modify: `docs/operations/ci.md`（记录真实 E2E 运行方式）

### Step 1：写失败 acceptance scenarios

场景必须覆盖：

1. **Final-exam user：** 注册、建立课程/目标、创建/编辑 note、练习、查看精简 status、生成今日 plan。
2. **Multi-goal user：** 同一 course 的 final/entrance/maintenance goal 共享资产和 history，策略按时间窗口变化。
3. **Research user：** 无目标探索、source/note/relation、候选 promotion、回到 exploration。
4. **Lifelong user：** 不创建 course/goal 也能 Explore、Library、Markdown export。
5. **Cross-course assets：** 同一 document/card 加入两个 courses，identity、revision 和 review state 不复制。
6. **AI outage：** AI/queue 不可用时，已写入的 learning event、练习和规则计划仍可用。
7. **Migration safety：** 旧数据库升级后数据 identity/count/revision 保持。

### Step 2：确认 RED

```bash
npm run test:browser -- acceptance
```

预期：尚未完成的产品行为明确失败。不得把测试改成只检查静态文本来绕过失败。

### Step 3：只修第一阶段缺口

- 不为通过测试引入 Task 31+ 能力；
- 不把外部导出 loss 隐藏；
- 不放宽 workspace authorization；
- 不把 AI outage 测试删除或 skip；
- 不把 migration safety 降级为单元测试假数据。

### Step 4：完整验证

```bash
npm run lint
npm run typecheck
npm run test:handler
npm run test:integration
npm run test:browser
npm run build
```

额外验证：

```bash
npm run verify:ci
git diff --check
git status --short --branch
```

**发布安全和运维阻断项：**

- `npm audit --omit=dev --audit-level=high` 必须生成可复核报告；网络失败不是通过。若 registry 不可用，使用有日期、来源、责任人和复审日期的离线审计报告；任何可达 Critical/High 必须修复或有明确豁免。
- 记录 lockfile diff、依赖来源/许可证审查和 install lifecycle script 审查；不得把审计网络错误静默忽略。
- 在隔离数据库和对象存储完成一次 backup/restore rehearsal，校验 records、stable IDs、revisions、relations、events、card state、文件字节 hash 和 manifest；记录 RPO/RTO、失败处理和 restore 冲突策略。
- 发布前保存 migration version、commit SHA、CI run URL、Node/Playwright version、浏览器测试报告、审计报告、restore rehearsal 和残余风险。
- 灰度阶段使用 feature flag；监控 migration failure/duration、orphan/preflight count、queue depth/retry/DLQ、candidate/promotion duplicate、跨 workspace deny、backup freshness；触发阈值时暂停新功能或回滚应用版本。

### Step 5：最终审查与提交

- Overall spec reviewer：对照本计划和原设计逐项核对；
- Overall quality reviewer：检查跨任务重复、边界、迁移、幂等、降级和安全；
- 修复所有 Critical/Important 问题并重新运行全量验证；
- 创建 release acceptance 文档，记录真实命令和结果；
- Commit：`test: verify the lifelong learning phase one experience`

---

# 2. 依赖、迁移屏障和发布闸门

任务不得只依赖“目录已存在”。每个持久化任务必须先通过对应 migration barrier；每个 Web/Worker 任务必须先通过 contract barrier。实现者不得在未满足 barrier 时自行创建临时 schema、客户端 workspace scope 或第二套状态机。

## 2.1 固定屏障

| Barrier | 前置条件 | 允许开始的任务 |
|---|---|---|
| Migration-identity | Gate 0.1–0.2 通过，`0004_identity_repair.sql` 可处理已记录旧版 0003 | Gate 0.3、0.4、Task 9 |
| Navigation | Gate 0.4 通过，真实 browser server smoke 通过 | Task 9–12 |
| Asset-content | Task 9–12 通过，document/revision/relation/search API 已有真实授权边界 | Task 13–16 |
| Course-goal | Task 13–16 通过，candidate/promotion provenance 可追溯 | Task 17–20 |
| Learning-evidence | Task 17–20 通过，goal/time-window contract 固定 | Task 21–25 |
| Portability-release | Task 21–25 通过，event/card/assessment/planner schema 已锁定 | Task 26–30 |

## 2.2 可并行范围

- Gate 0.3 与 Gate 0.4 可以在 Gate 0.1–0.2 通过后并行，但两者都必须在 Task 9 前完成。
- Task 24 的纯 domain assessment RED 测试和 Task 25 的纯 domain planner RED 测试可并行设计；实现仍需等待 Learning-evidence barrier。
- Task 26 与 Task 27 的纯转换器 RED 测试可并行；用户可达 API 和授权边界不能并行绕过。
- 任何共享 `packages/contracts`、migration registry、authorization helper 或 package exports 的修改必须串行合并。

## 2.3 任务级强制边界

- 每个新增持久化实体必须同时列出 contract、schema/migration、repository、HTTP/server action、workspace negative test 和 package export；纯 domain 测试不能替代授权测试。
- 每个新增队列 job 必须同时列出 payload schema、outbox/状态表、唯一幂等约束、lease/retry/dead-letter 行为和 Redis 集成测试。
- 导出和备份必须有用户可达 HTTP 入口、workspace authorization、字节/manifest 校验和 restore 结果报告；纯 serializer round-trip 不足以通过验收。
- media block 在 Task 10 中只允许引用已存在且已授权的对象；S3 上传、对象 manifest、下载权限和 attachment API 需作为独立任务范围，不能用占位字符串声称完成。

## 2.4 执行顺序

在满足上述 barrier 的前提下，主链保持以下顺序：

```text
Gate 0.1
  → Gate 0.2
  → Gate 0.3
  → Gate 0.4
  → Task 9
  → Task 10
  → Task 11
  → Task 12
  → Task 13
  → Task 14
  → Task 15
  → Task 16
  → Task 17
  → Task 18
  → Task 19
  → Task 20
  → Task 21
  → Task 22
  → Task 23
  → Task 24
  → Task 25
  → Task 26
  → Task 27
  → Task 28
  → Task 29
  → Task 30
```

原因：

- Task 9 是所有真实页面的基础；
- Task 10–12 建立知识资产使用方式；
- Task 13–16 依赖 note/relation/search 和 candidate-only 约束；
- Task 17–20 依赖课程资产和 exploration continuity；
- Task 21–25 依赖 goals、attempts 和稳定 asset identity；
- Task 26–30 必须覆盖前面全部数据模型。

每个任务完成后必须有独立绿色提交、spec review 和 quality review。Checkpoint-1（Task 12 后）、Checkpoint-2（Task 16 后）、Checkpoint-3（Task 20 后）、Checkpoint-4（Task 25 后）必须重新运行全量相关门禁并保存结果，才能进入下一阶段。

---

# 3. 最终验证矩阵

| 不变量 | 必须有的证据 |
|---|---|
| 迁移不删除历史数据 | 旧库升级 integration test + migration runbook |
| migration 编号稳定 | migration-order test |
| lifecycle 不变量 | contract test + repository integration test |
| 三入口平等 | component test +真实 browser E2E，320/768/1440 |
| 无目标也可学习 | free exploration + library E2E |
| 文档版本可追溯 | editor revision integration/E2E |
| 关系不复制内容 | relations domain test + E2E |
| 搜索隔离且可创建 | search integration + command palette E2E |
| 探索可选择性沉淀 | promotion E2E |
| AI 不覆盖正式资产 | role/job integration + revision conflict E2E |
| 多目标共享 history | multi-goal integration |
| Guidance 可关闭 | guidance E2E |
| 学习事件追加写 | idempotency/correction integration |
| retry 不重复 attempt | practice E2E + event test |
| SRS state 不复制 | card multi-goal integration |
| assessment 可重放 | assessment replay test |
| planner 尊重预算和探索 | planner unit + today-plan E2E |
| 外部导出诚实 | Markdown/Anki loss-report tests |
| 原生备份完整 | fresh database round-trip |
| AI outage 可生存 | degradation integration/E2E |
| 默认 UI 简洁 | default/developer diagnostics E2E |
| 真实 CI 可复现 | CI workflow + local commands + release record |

---

# 4. 执行结束标准

只有同时满足以下条件，才能把 Phase 1 标记为完成：

- 所有 Gate 0.1–0.4 和 Task 9–30 都有独立绿色提交；
- 每个任务都有 RED 证据、GREEN 证据、spec review 和 quality review；
- `npm run test:handler`、`npm run test:integration`、`npm run test:browser` 不再因环境 fallback 失败；
- E2E 访问真实 Web server；
- migration 旧库升级测试证明无数据丢失；
- `npm run lint`、`npm run typecheck`、`npm run build` 通过；
- 没有 Critical 或 Important review issue 未处理；
- `docs/releases/phase-1-acceptance.md` 记录真实执行输出和已知残余风险；
- 工作区状态和提交范围清晰，没有无关文件进入任务提交。

Phase 2（Task 31+）必须重新进行设计确认，不得因为 Phase 1 完成就自动进入。
