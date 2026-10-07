# Daily study loop gaps (DL1–DL4)

> 2026-10-07 对"能否完成一次完整的每日学习闭环"做只读审查（今天入口→学习→练习→复习→记录→次日调整）。正式 `/opening` 入口的今天、材料、辅导、观察与计划已读写真实服务端，但有四处缺口不在既有任务覆盖范围内：复习卡片仍走 Mock、课程页目标/指导模式仍走 Mock、普通任务无法在界面完成/跳过、重测提议无人触发且补测作答不携带 `retestId`。本文件把它们落为最小修复切片；审查是静态分析，结论仍需各任务的运行证据闭环。
>
> 2026-10-08 第二轮审查（[14](14-loop-closure.md)）：DL3 按决定重写提示来源、建议时间语义、今天页接受方式与依赖；DL4 依赖调整为排在核心闭环之后；新增 DL5–DL10 与 P04a 见 14。

**Global constraints:** 复用既有服务与契约，不新造并行系统：任务状态复用 `PATCH /api/opening/tasks/[id]`；重测复用 L02 worker `retest` 处理器与 F03 jobs/outbox；记忆卡复用既有 cards 仓库（`packages/database/src/repositories/cards.ts`）与 `packages/domain/src/srs/scheduler.ts`。本批次预计不新增迁移；若实现中证明必须新增，编号由 INTEGRATOR 分配。正式入口不得经 `lib/data/mock`、`useStudyProvider` 或 localStorage 承载正式学习记录（[设计规格](../../specs/2026-09-12-opening-release-design.md)"数据与版本"行）。浏览器验收按 `AGENTS.md` 由用户负责；Agent 只跑最接近改动的单元/契约/handler/integration 测试。DL 是基础闭环修复，不提前实现 P04 多源归并、U04 ≤3 行动面或 K02 SkillEvidence；它们落地时复用本批次接口。验证命令中的 `npm run typecheck -w @aistudy/web`（以及 `@aistudy/worker`）经 `scripts/run-heavy.sh` 调用 bash（`apps/web/package.json:10`、`apps/worker/package.json:10`），在没有 bash 的 Windows 开发机上改用等价的 `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`（worker 同理，见 14 的 DL10）；`packages/*` 的 typecheck 是直接 `tsc`，可照常运行。

### DL1: Opening entry no-Mock closure for review, practice, goals and guidance

**Owner:** EXPERIENCE. **Depends:** L03,U03.
**Goal:** 正式入口及其可达页面不再展示或写入 Mock/localStorage 学习数据；尚未迁移的旧 Mock 学习页在 opening 模式下不可达。
**Why:**
- `apps/web/src/features/opening/shell/opening-shell.tsx:66` 顶栏"复习卡片"链接到旧 `/learn/review`；该页 `features/review/review-session.tsx` 经 `lib/data/react.ts:80` 的 `createMockProvider()`+localStorage 取卡，卡片来自 `lib/data/mock/seeds.ts` 种子。
- `/learn/practice/[itemId]` 从 Mock 取题（`features/practice/practice-player.tsx:52`；README 已知限制同样记录）。`apps/web/src/middleware.ts` 的 `LEGACY_OPENING_REDIRECTS` 只匹配精确 `/learn` 与 `/explore`、`/preview` 前缀，`/learn/review`、`/learn/practice/*`、`/learn/goals*`、`/learn/exams`、`/learn/marketplace` 在 opening 模式仍可直接打开，与 L03"Production opening mode redirects legacy demo routes"要求不符。
- `/opening/courses/[id]` 渲染 `features/courses/course-detail.tsx`，其中 `useStudyProvider()` 读写 `listGoals()`、`getGuidanceMode()`/`setGuidanceMode()`（Mock 本地存储）。服务端虽有 `course_goals` 表（`packages/database/src/schema/goals.ts`），但没有仓库写路径或 API；opening 侧（`planDay`、tutor、L02）也没有任何消费者读取指导模式。
- `tests/contract/opening-no-mock.test.ts` 只扫描 `features/opening` 与 `app/api/opening`，且只匹配字面 `createMockProvider`、`/lib/data/mock`，经 `lib/data/react` 间接引入 Mock 的共享组件因此逃过检查。

**Approach（审查后取舍）:** 不为目标/指导模式补一套服务端 API：两者在开学版没有消费者，补 API 只会制造"已保存却不影响任何行为"的设置。opening 模式下移除这两块，考试日期继续由既有课程设置承担；目标驱动的安排归 P04。复习卡片真实化由 DL4 承担，本任务先切断指向 Mock 的入口。
**Modify:** `apps/web/src/middleware.ts`、`apps/web/src/features/opening/access-middleware.test.ts`、`apps/web/src/features/opening/shell/opening-shell.tsx`、`apps/web/src/features/courses/course-detail.tsx`（opening 分支不调用 `useStudyProvider`）、`apps/web/src/features/courses/course-study-actions.tsx`（如需去掉 `goalCount`）、`tests/contract/opening-no-mock.test.ts`、`tests/e2e/opening-release-redirects.spec.ts`（只补路径清单，由用户运行）。
**Interfaces:** `legacyOpeningRedirectPath(pathname)` 扩展为前缀规则；`/learn/courses*` 保持现状（既有测试断言其不重定向，opening 课程页另有入口）。

- [ ] 先写失败测试：`access-middleware.test.ts` 断言 `/learn/review`、`/learn/practice/x`、`/learn/goals`、`/learn/goals/new`、`/learn/exams`、`/learn/marketplace` 在 opening 模式重定向到 `/opening/today`，`/learn/courses/123` 仍返回 null。
- [ ] 契约扫描改为从 `apps/web/src/app/(opening)` 页面入口出发，沿相对与 `@/` import 递归收集可达文件，禁止命中 `lib/data/mock`、`createMockProvider`、`lib/data/react`；先确认当前因 `course-detail.tsx` 失败（红）。
- [ ] `course-detail.tsx` 的 opening 分支去掉目标区与指导模式区及其 provider 调用；旧平台路径行为不变，既有旧平台测试保持绿。必要时拆成 opening/legacy 两个小组件，不改旧平台逻辑。
- [ ] 顶栏移除 `/learn/review` 链接（DL4 完成后改指 `/opening/cards`）；其余快捷入口不在本任务范围。
- [ ] 验证：`node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/access-middleware.test.ts`；`node node_modules/vitest/vitest.mjs run --project contract tests/contract/opening-no-mock.test.ts`；`npm run typecheck -w @aistudy/web`。重定向浏览器清单交用户验收。

**Acceptance:** opening 模式下，从 `/opening/*` 可达的页面不读写 Mock/localStorage 学习数据；旧 Mock 学习页统一重定向；扩展后的可达性契约扫描为绿。

### DL2: Complete or skip a task from the Today queue

**Owner:** EXPERIENCE. **Depends:** P02,RP6.
**Goal:** 用户能在今天页把当前任务标为完成或跳过，状态写入服务端，并在队列、计划概览和提醒中一致反映。
**Why:** 服务端已完整：`apps/web/src/app/api/opening/tasks/[id]/route.ts`（PATCH）→ `features/opening/planning/plan-service.ts` `updateTaskStatus` → `packages/database/src/repositories/opening-plans.ts` `updateTaskStatus`（版本 CAS、与重测活动同序加锁、终态冲突返回 409）；客户端 `features/opening/client/api.ts:338` 也已有 `updateTaskStatus`。但没有任何界面调用它（`today-view.tsx` 只提示"计时与浏览不会自动标记完成"），普通任务因此永远停在 pending，"已完成"视图只会被补测作答间接填充。

**Approach:** 纯界面切片，不改 API 与仓库。动作放在已选任务的 `TaskContext`（`features/opening/assistant/task-context.tsx`）而不是队列行，避免误触；沿用 `task-reminder.tsx` 的单次请求、不自动重试、版本缺失即禁用的模式。
**Create:** `apps/web/src/features/opening/planning/task-status-action.ts`、`apps/web/src/features/opening/planning/task-status-action.test.ts`（界面需要时再加 `task-status-control.tsx`）。
**Modify:** `apps/web/src/features/opening/assistant/task-context.tsx`、`apps/web/src/features/opening/planning/today-view.tsx`、`apps/web/src/features/opening/planning/today-dashboard.tsx`（完成后刷新队列与概览）。
**Interfaces:** `createTaskStatusAttempt(update, { taskId, expectedVersion }, status: 'done'|'skipped', now)`；请求体严格按 `taskStatusUpdateInputSchema`（`status`、`expectedVersion`、`at`）。

- [ ] 先写失败单测：同一显示版本只发一次请求；409 显示"任务已更新，请重新读取"且不自动重试；网络结果未知时锁定并提示核对；`version` 缺失时禁用并说明；400/404 明确报错。
- [ ] 界面：pending 任务提供"标记完成"与"跳过"（跳过需二次确认）；done/skipped 只显示状态，不提供回退（服务端不支持撤销，本任务不扩 API）。成功后重新读取 `listTasks`/`getToday`，不在前端乐观改写计划块。
- [ ] 重测来源任务：完成按钮附提示"建议先完成补测作答"（入口由 DL3 提供）；重测活动终态规则以服务端 409 为准，前端不复制规则。
- [ ] 验证：`node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/ apps/web/src/features/opening/assistant/`；回归 `tests/integration/handler/opening-plans.test.ts`（无服务端改动时仅作回归）；`npm run typecheck -w @aistudy/web`。浏览器流程交用户：选任务→完成→刷新后仍在"已完成"。

**Acceptance:** 普通任务可完成/跳过，刷新与跨端一致；版本冲突和未知结果不产生重复写入；不存在客户端伪完成。

### DL3: Close the retest loop with transactional scan enqueue and retest-bound attempts

**Owner:** DATA+EXPERIENCE. **Depends:** L02,P02,DL2,DL5.
**Goal:** 记录练习观察后自动生成（仍需用户审核的）延迟重测提议，提示取自原题干；用户在今天页内联接受或忽略；接受后的补测任务到建议时间才出现在"到期补测"，进入作答时携带 `retestId`，从而关闭重测活动并把任务置为完成。
**Why（已核实）:**
- 生产代码中没有任何地方创建待执行的 `retest` 作业：`apps/worker/src/jobs/retest-candidate.ts` 的处理器只在测试中被直接调用（`apps/worker/src/jobs/retest-candidate.test.ts`、`apps/web/src/features/opening/learning/read-service.test.ts`）；`opening_jobs` 中的 `retest` 行只由 `packages/database/src/repositories/opening-retests.ts:115` 以 `state='succeeded'` 写入，是提议记录而非待处理作业；通用 `enqueue` 的唯一调用者是提醒（`features/opening/planning/reminder-service.ts`）。worker 已注册 `retest` 队列与处理器（`apps/worker/src/index.ts`、`apps/worker/src/runtime/queue.ts`），`dispatchPending` 按 outbox `payload.kind` 投递，所以只缺"谁来入队"。
- 处理器的提示来自作业 payload 的 `promptsBySkill`（`retest-candidate.ts`），领域规则只为同时有 sourceIds 与提示的技能生成提议（不编造题干）；而作答题干已存于 `opening_problem_refs.stem_snapshot`（`attempt-form.tsx` 在填写题干时提交 `problem.stemSnapshot`），入队方必须从这里取提示。
- 接受提议时 `apps/web/src/features/opening/learning/retest-service.ts:42-59` 以 `payload.prompt` 作任务标题并固定 `dueAt: null`，建议时间只写入 `inputSnapshot.dueAt` 与重测活动的 `recommended_at`（`packages/database/src/repositories/opening-retest-task.ts:163-171` 调用 `insertAcceptedRetestActivity` 时以 `candidate.dueAt` 作 `recommendedAt`；列定义见迁移 0030）；任务读模型与规划器都不读取它，补测在接受当天就会被排入计划，失去"延迟"的意义。
- `apps/web/src/features/opening/learning/attempt-form.tsx` 的提交体只有 `clientKey/answer/outcome/assistance/verdictSource`，web 源码中 `retestId` 零引用；而关闭重测活动并把任务置 done 的逻辑只在 `packages/database/src/repositories/opening-learning-observations.ts` 的 `input.retestId` 分支。
- 任务读模型（`packages/contracts/src/opening/planning-tasks.ts` 的 `taskItemSchema`、`opening-plans.ts` 的 `mapTask`）不返回重测来源，今天页无法知道某任务是补测、属于哪门课和技能。待审核提议目前只出现在独立的 `/opening/review` 页（`apps/web/src/app/(opening)/opening/review/page.tsx` → `features/opening/planning/review-view.tsx`，经 `review-service.ts` 调用 `listRetestCandidates`/`acceptRetest`/`discardCandidate`）和助理的"接受到期重测"动作（`features/opening/assistant/assistant-view.tsx:547`），今天页看不到。

**Approach（审查后取舍）:**
- 入队放在观察写入事务内（`opening-learning-observations.ts` 的 `insertObservation`），采用与解析作业相同的 transactional outbox 写法（`opening-sources.ts:179`：同事务写 `opening_jobs` 与 `opening_outbox`），不放在 `attempts/[id]/submit` 路由：路由在提交后再入队会在响应丢失或进程退出时漏队，且 `POST /api/opening/observations` 等其他观察入口也需要同样触发。
- 幂等键按"课程+观察"：`retest-scan:<courseId>:<observationId>`，与提议行键 `retest:<id>` 不冲突；处理器已有批量上限、重复活动与 `retestSuggestionsEnabled` 偏好检查，重复投递无副作用。扫描作业 payload 不含 `kind:'task'`，`opening-review-candidates.ts` 的过滤保证它不会被当成待审核提议，需回归测试锁定。
- 提示来源：扫描处理器按课程+技能取该技能最近一次作答的 `stem_snapshot` 组装 `promptsBySkill`，提示文案为"隔天重做原题（先不看之前的答案）：<题干>"。没有题干的技能不生成提议，不用技能名或模型生成的题目代替；DL6 的作答表单在题干为空时提示这一后果。
- 建议时间是"最早可做时间"而不是截止：不写入 `opening_tasks.due_at`。`planDay` 把 `dueAt` 当截止、会把任务排进截止前最早的空档，写进去会把延迟重测提前到当天。改为在任务投影中提供 `retest.recommendedAt`（取重测活动 `recommended_at`），`planDay` 跳过 `recommendedAt` 晚于计划日结束的补测；DL5 的分组只在到期后把它列入"到期补测"。**放弃**写 `dueAt`（语义相反）与新增 `not_before` 列（活动行已有该时间，无需迁移）。
- 接受方式：今天页内联显示待审核的补测提议，复用 `review-service.ts` 的 `loadReviewItems`/`createReviewActions` 与 `review-card.tsx`（只取 retest 来源），用户点"接受"或"忽略"，经既有 `POST /api/opening/retests/[id]/accept` 与 `POST /api/opening/retests/[id]/discard` 落库，不另写接受逻辑。**放弃**"自动加入任务 + 撤销"：助理协作模式与[设计规格](../../specs/2026-09-12-opening-release-design.md) §3.2 要求"接受后才改变正式计划"，且任务没有撤销/删除 API，撤销只能变成"跳过"，会污染完成记录。
- 携带 `retestId` 的作答不再触发新扫描，避免补测完成即刻再生补测；下一次普通观察再触发。
- 任务读模型增加可选只读投影 `retest: { candidateId, activityId, courseId, skillLabel, prompt, recommendedAt } | null`（关联 `opening_retest_activities.task_id`，提示取自已存 `inputSnapshot`）；契约导出由 INTEGRATOR 合入。

**Create:** `tests/integration/opening-retest-scan-enqueue.test.ts`、`apps/web/src/features/opening/learning/retest-attempt.ts`、`apps/web/src/features/opening/learning/retest-attempt.test.ts`、`apps/web/src/features/opening/planning/retest-proposals.tsx`（组合既有 `review-card.tsx` 与 `review-service.ts`）。
**Modify:** `packages/database/src/repositories/opening-learning-observations.ts`、`packages/database/src/repositories/opening-plans.ts`（`mapTask`/`listTasks` 投影）、`packages/contracts/src/opening/planning-tasks.ts`、`apps/worker/src/jobs/retest-candidate.ts`（从题干快照组装提示）、`packages/domain/src/opening/day-planner.ts`（跳过未到期补测）、`apps/web/src/features/opening/learning/attempt-form.tsx`、`apps/web/src/features/opening/learning/course-view.tsx`、`apps/web/src/features/opening/assistant/task-context.tsx`、`apps/web/src/features/opening/planning/today-view.tsx`。
**Interfaces:** 补测入口 `/opening/courses/<courseId>?retest=<candidateId>#course-practice`；`LearningAttemptForm` 接受可选 `retest`（预填技能与提示，提交时附 `retestId`）。服务端已接受 candidateId 或活动 id，并校验课程与技能一致（`opening-learning-observations.ts` 的 retest 活动查询）。`planDay` 对带 `retest.recommendedAt` 的任务按计划日结束时刻判断是否可排。

- [ ] 先写失败集成测试（隔离测试库，`OPENING_TEST_DB=1`）：提交一次普通观察后，同事务内存在一条 `kind='retest'` 的待处理作业及对应 outbox 行；同 clientKey 重放不产生第二条；观察事务回滚时作业也不存在；扫描作业不出现在 `GET /api/opening/retests` 的提议列表中。
- [ ] 实现入队后，在测试内直接调用 worker 处理器（不启动 Redis worker），断言产生不超过 1 条提议、提议提示包含该技能最近作答的题干；无题干的技能不产生提议；提议可经 `POST /api/opening/retests/[id]/accept` 成为任务，经 `discard` 后不再出现。
- [ ] domain 单测（红）：`planDay` 不排入 `recommendedAt` 晚于计划日的补测，到期当天正常排入；普通任务的 `dueAt` 截止行为不变。
- [ ] 任务投影：`listTasks` 对重测来源任务返回 `retest` 字段（含 `recommendedAt`），其余任务为 null；`opening_tasks.due_at` 对补测任务保持 null；契约单测覆盖 strict 解析。
- [ ] 界面：今天页显示待审核提议（接受/忽略，单次请求、不自动重试）；选中到期补测任务时 `TaskContext` 显示"开始补测"，进入课程练习区并预填；`attempt-form` 提交附 `retestId`；成功后任务在队列中变为已完成（由服务端置 done，前端只重新读取）。
- [ ] 验证：隔离库运行（`.local/opening-e2e/check-service-tests.ps1` 或显式 `OPENING_TEST_DB=1` 与独立测试库 URL，启动方式见 DL10）`--project integration tests/integration/opening-retest-scan-enqueue.test.ts tests/integration/opening-retest-task-bridge.test.ts` 与 `--project handler tests/integration/handler/opening-learning-attempts.test.ts tests/integration/handler/opening-retest-accept.test.ts`；`node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/retest-candidate.test.ts packages/domain/src/opening/ apps/web/src/features/opening/learning/ apps/web/src/features/opening/planning/`；`npm run typecheck -w @aistudy/database`、`npm run typecheck -w @aistudy/web`。

**Acceptance:** 观察→提议（提示为原题干）→用户在今天页接受→建议时间之前不进入计划、到期后出现在"到期补测"→补测作答→任务完成，全链路以真实数据库行断言；提议仍需用户确认，不自动生成任务；没有题干时不生成提议；K02 后续在此闭环上补 SkillEvidence 与 `nodeId`，不另造重测入队。

### DL4: Opening memory cards on the real cards and reviews API

**Owner:** EXPERIENCE. **Depends:** DL1,U03,DL3,DL6. 2026-10-08 调整：记忆卡片是可选附加，排在核心闭环（DL3 补测、DL6 可信判定）之后，避免与二者争用 `today-dashboard.tsx` 与今天页入口。
**Goal:** 在 opening 入口提供可选的记忆卡片：用户从自己的材料或辅导回答制卡，按既有 SRS 规则复习，数据只存服务端。
**Why:** 现有 `/learn/review` 的卡片来自 Mock 种子（`apps/web/src/lib/data/mock/seeds.ts:163`），`apps/web/src/lib/data/persist-review.ts` 每次列队时把本地卡复制到 `/api/cards`；`POST /api/cards` 的唯一调用者就是这个包装器，用户无法从自己的材料制卡。服务端链路本身是真实的：`/api/cards`、`/api/reviews` → `packages/database/src/repositories/cards.ts`（`cards-grade.ts` 调用 `packages/domain/src/srs/scheduler.ts` 的 `scheduleReview`），且与 opening 路由使用同一会话主体（`features/opening/runtime.ts` 的 `requireOpeningScope` 内部即 `requirePrincipal`）。

**Approach（审查后取舍）:** [设计规格](../../specs/2026-09-12-opening-release-design.md)把开学版"复习"定义为可解释重测队列，记忆卡只是"后续记忆卡适配，不当理解诊断"。因此：不改 SRS 算法，不新建卡片表或 API，不把卡片评分写入学习观察或证据资格；界面上"记忆卡片"与"补测"分开命名。制卡出处复用已有片段保存：`POST /api/opening/snippets` 返回 `documentId`（`packages/database/src/repositories/opening-note-provenance.ts` 的 `saveSnippet`），作为 `sourceDocumentId`。到期卡片进入每日安排属于 P04，本任务只在今天页显示到期数量入口。
**Create:** `apps/web/src/app/(opening)/opening/cards/page.tsx`、`apps/web/src/features/opening/cards/cards-client.ts`、`apps/web/src/features/opening/cards/cards-client.test.ts`、`apps/web/src/features/opening/cards/card-review-view.tsx`、`apps/web/src/features/opening/cards/create-card-dialog.tsx`。
**Modify:** `apps/web/src/features/opening/assistant/message-actions.tsx`（"制成卡片"）、`apps/web/src/features/opening/shell/opening-shell.tsx`（顶栏入口改指 `/opening/cards`）、`apps/web/src/features/opening/planning/today-dashboard.tsx`（到期数量链接）、`apps/web/src/middleware.ts`（DL1 重定向的 `/learn/review` 改指 `/opening/cards`）。
**Interfaces:** `createOpeningCardsClient(fetchImpl)`：`createCard({front,back,sourceDocumentId})` → `POST /api/cards`；`listDue(mode)` → `GET /api/reviews?mode=`；`grade({cardId,grade,idempotencyKey})` → `POST /api/reviews`。HTTP 错误即错误，不回落 Mock；`idempotencyKey` 绑定一次评分意图，重试复用。

- [ ] 先写失败单测：客户端在 503 时抛错而非返回示例卡；评分重试复用同一 `idempotencyKey`；DL1 的可达性契约扫描覆盖新页面。
- [ ] 制卡：在助理回答操作中提供"制成卡片"，先保存片段取得 `documentId`，用户编辑正反面后提交；空正反面不可提交；失败保留输入。
- [ ] 复习页：读取服务端到期队列，正面→揭示→四档评分（沿用 `ReviewGrade`）；空队列、加载失败、未登录各有明确状态；不显示掌握百分比。
- [ ] 今天页：有到期卡时显示"N 张记忆卡片到期"链接，不把卡片写入任务或计划。
- [ ] 回归：卡片评分不产生 `opening_learning_observations` 行（handler 级断言）；旧平台 `tests/integration/handler/reviews.test.ts` 保持绿。
- [ ] 验证：`node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/cards/`；`node node_modules/vitest/vitest.mjs run --project contract tests/contract/opening-no-mock.test.ts`；隔离库 `--project handler tests/integration/handler/reviews.test.ts`；`npm run typecheck -w @aistudy/web`。浏览器流程交用户。

**Acceptance:** 卡片只来自用户自己的输入或材料片段并保存在服务端；SRS 调度复用 domain 规则；与重测、学习证据严格分开；跨端刷新一致。

## 与既有任务的关系（2026-10-07 审查结论；2026-10-08 已按 14 调整账本）

- **L03：** 其"opening 模式重定向旧演示路由"与"无 Mock"验收已标 verified，但重定向只覆盖精确 `/learn`，契约扫描不覆盖共享组件；DL1 是对该验收的补齐，不回退 L03 状态。
- **K02：** "完成重测关闭对应 due 项"建立在 DL3 的入队与 `retestId` 绑定之上；K02 只增加 SkillEvidence/`nodeId` 自适应，不另写入队。2026-10-08 起参考自对照判定、帮助自动带入与技能名复用拆入 DL6，K02 依赖增加 DL3、DL6。
- **P04/U04：** 到期补测（DL3）与到期记忆卡数量（DL4）是 P04"纳入到期复习"的输入；U04 的"今天≤3 行动"落地时可以替换 DL2 的按钮位置，但必须继续调用同一 `PATCH /api/opening/tasks/[id]`。P04 中不依赖连接器的每日草案已拆为 P04a（见 14），P04 依赖增加 P04a。
- **Q01：** 其完整流程"plan proposal/accept -> retest"需要 DL3 才能在真实链路上跑通；2026-10-08 经用户确认，Q01 依赖改为 U03,Q03,DL3,DL6,DL7,DL10（理由见 14 的"对既有任务的修订"），`08-delivery.md`、总计划行与 `tasks.json` 已同步。
- 建议顺序：DL1、DL2、DL5 先行（DL10 同期）；DL3 在 DL2/DL5 后（共用 `task-context.tsx`/`today-view.tsx`）；DL4 移到核心闭环（DL3、DL6）之后。完整排期见 14 的"闭环优先级与排期"。
