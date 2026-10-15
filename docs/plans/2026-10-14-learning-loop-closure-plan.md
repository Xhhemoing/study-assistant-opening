# 学习闭环修复计划：从「建课能学」到「排了能做完」

**Date:** 2026-10-14
**Baseline（部署线）:** `study-assistant-opening/feat/opening-release`，Hermes 部署 SHA `8b500e6`
**Inputs:** 探针账号「高数冷启动」实测过程与 `PROCESS-AND-ANALYSIS.md`（用户侧）
**Status（2026-10-15 核对）:** #42（`649353f`）已合入 S1–S7、S9、S10（含 S5 seed）；S8 在当前隔离 checkout 实现并验证，未提交/合并/部署。下方根因表保留原始观测。
**重要：** 本计划所有落点在 `feat/opening-release`。`feat/jingwei-core`（`c924faa`）**不含** `8b500e6`/`#33`/`#39`/`#40`，在其上修复无效。

## Outcome

新账号在没有任何垫数数据的情况下，走「建课 → 挂材料 → 排进今日 → 开始学习 → 看到主讲内容 → 标记完成 → 次日顺延」这条路径，每一步都有明确结果或明确失败原因，不出现死按钮、死状态和谎报的可用性。

## 实测现象与代码根因对照

| # | 实测现象 | 根因（release 线） | 优先级 |
|---|---|---|---|
| 1 | 活动摘要恒为「今日主题学习」，与高数无关 | `teaching/today-activity.ts:96` 摘要写死；`StartLearningContext` 无 `courseId`/`sourceIds`，`buildStartLearningCreateInput` 不写课程与材料 | P0 |
| 2 | materials=available 恒真 | 空 `requestedIds` → `probeMaterialsAvailability` 直接返回 `available`（`packages/domain/src/opening/teaching-resume.ts:104-114`） | P0 |
| 3 | 「生成结果待核对」后始终无可用讲义 | 编译跑完落在 `needs_check`（`apps/worker/src/jobs/compile-teaching-unit.ts:297`），提升路径要求 `isTeachingValidationEnabled()`（`:347`）；而 UI 准入只认 `ready`（`teaching/teaching-workspace.tsx:42-50`） | P0 |
| 4 | 「继续学习」顶部 CTA 无任何反应 | `planning/today-dashboard.tsx:201-207` 已有活动时只 `setSelectedActivity` 后 return | P0 |
| 5 | 断点卡「继续学习」→「等待主讲内容」，重试无效 | `teaching-workspace.tsx:410` 未进 `in_flight` 分支（`failed`/`cancelled`/`needs_check` 被 `teaching-resume.ts:83-88` 映射成 `ready`），落 L415-429 设 `waitError`；`重试拉取 client-init` 重跑同一 404 路径 | P0 |
| 6 | 队列待办无「标记完成」，一直挂 1 项 | `planning/today-view.tsx` 的 `TodayTaskList` 行只有 `onSelect` 按钮，无 `TaskStatusControl`；唯一渲染点 `assistant/task-context.tsx:17` 在助理页 | P0 |
| 7 | 冷启动今日为 `no_settings`，无推荐草案 | `planning/plan-service.ts:180-185`；`planning_settings` 仅由显式 `putPlanningSettings` 写入，无首启默认 | P1 |
| 8 | 课程页无「排进今日」入口 | 与 7 同源；`720dde9`（`feat/course-seed-today-plan`）已实现未合并 | P1 |
| 9 | 队列任务与主讲/助理未接线 | 无「开始此项」入口；`task.id` 未进入 activity `createIntent` | P1 |
| 10 | `.txt` 被拒 | 三层同时拒绝：`inbox/upload-dropzone.tsx:8` accept 串、`inbox/upload-state.ts` `BY_EXTENSION`、`packages/contracts/src/opening/sources.ts` `sourceMimeSchema` | P2 |
| 11 | 队列显「正在解析」但材料已「可以用于提问」 | 文案读 `uploadState/parseState`（`upload-state.ts:87`），可用性读 chunks 存在性（`packages/database/src/repositories/opening-learning-facts.ts:102-103`）。两者不同源 | P2 |
| 12 | `provider request failed` 与 `provider outcome unknown` | 前者为 HTTP 非 2xx（`packages/ai/src/opening/provider.ts:163`/`:187`，阶段 A 那次大概率 429/402）；后者为超时/网络或预算账本重放（`:178`/`:203`），走 `apps/worker/src/jobs/tutor-turn.ts:246` `markUnknown`，目前无对账与收敛 | P2 |
| 13 | 正式版不能注册 | `features/opening/access-policy.ts`：`allowRegistration = !openingRelease`；服务端 route 二次校验。设计如此，非缺陷 | — |

## 已定决策

- **S2 走「放开 UI 准入」路线**（用户 2026-10-14 决定）：`generateStatus ∈ {ready, needs_check}` 且 blocks 非空即进 workspace，页内以「待核对」明示来源未校验。不通过打开 `OPENING_TEACHING_VALIDATION_ENABLED` 来把状态推到 `ready`——后者依赖 worker 常驻与校验预算，作为试跑配置并行验证，不作为修复前提。

## 切片与文件所有权

同一文件只允许一个写入者。建议两条实现支线：

- **支线 A（活动接线）**：S1、S2、S3、S7 —— 主要触及 `teaching/*`、`planning/today-dashboard.tsx`
- **支线 B（队列与状态机）**：S4、S6、S8 —— 主要触及 `planning/today-view.tsx`、`packages/domain`、`apps/worker`
- 串行：S5（合并既有分支）、S9、S10（触及 `packages/contracts`，需串行分配）

---

## 任务卡 S1 — 活动带上课程与材料

```text
目标 / 用户可见结果：
从课程页或今日队列发起学习时，创建的教学活动绑定该课程与被选中的材料。
活动摘要显示课程/任务名，而非固定「今日主题学习」；resume 的 materials gate 反映真实材料可用性。

范围 / 允许修改文件：
apps/web/src/features/opening/teaching/today-activity.ts
apps/web/src/features/opening/teaching/today-activity.test.ts
apps/web/src/features/opening/planning/today-dashboard.tsx
apps/web/src/features/opening/client/api.ts（如需透传字段）

约束 / 必须保留的行为：
- clientKey 幂等语义不变（`today-topic:<date>` / `today-resume:<date>:<conversationId>`）。
- sourceIds 上限 32、去重排序，沿用现有 `buildStartLearningCreateInput` resume 分支的写法。
- 无课程无材料时行为与现在一致，不新增必填参数。
- 创建活动的 `createIntent` 不新增会导致同日重放冲突的字段（同日重放返回既有活动）。
```

**验收指标（全部须实际执行）**

| 指标 | 检查 |
|---|---|
| 单测：摘要反映课程 | `npx vitest run --project unit apps/web/src/features/opening/teaching/today-activity.test.ts` 中新增断言：传 `courseTitle:"高等数学"` ⇒ `intentSummary` 含「高等数学」且不含裸「今日主题学习」 |
| 单测：材料随活动写入 | 同文件断言 `sourceIds` 按去重排序写入，且长度≤32 |
| 单测：gate 不再是恒真 | 断言「请求 1 个不可用 source」⇒ `probeMaterialsAvailability` 返回 `unavailable`，非 `available`（此条证明接线生效） |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 集成 | `npm run test:integration -- tests/integration/opening-tutor-turn.test.ts` 无新增失败 |
| 真机观测（用户） | 创建高数活动后，活动摘要为高数相关；断点卡 `materials=` 不再恒为 available |

---

## 任务卡 S2 — needs_check 视为可用但待核对

```text
目标 / 用户可见结果：
内容已发布（blocks 非空）但状态为 needs_check 的活动可以进入学习空间，页内明确标注
「主讲内容待核对」，不再卡在「等待主讲内容」。

范围 / 允许修改文件：
apps/web/src/features/opening/teaching/teaching-workspace.tsx
apps/web/src/features/opening/teaching/teaching-workspace.test.ts
apps/web/src/features/opening/teaching/resume-card.tsx（文案）

约束 / 必须保留的行为：
- blocks 为空或 clientInit 缺失时仍然拒绝渲染，不伪造讲义。
- failed / cancelled / stale 不因本改动变成可用。
- 不把 needs_check 在库里改写为 ready；不碰 worker 状态机。
- 「待核对」提示须可被测试断言（建议 data 属性或 role=status）。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：needs_check + 非空 blocks ⇒ 可用 | `npx vitest run --project unit apps/web/src/features/opening/teaching/teaching-workspace.test.ts`；`isTeachingWorkspaceContentUsable(needsCheckActivity, clientInit())` 为 true |
| 单测：needs_check + 空 blocks ⇒ 不可用 | 同文件，`clientInit({blocks: []})` 为 false |
| 单测：failed ⇒ 仍不可用 | 同文件，`generateStatus:"failed"` 为 false |
| 单测：待核对提示存在 | `wait_init` 渲染结果不含该提示；workspace 渲染结果包含 `data-*` 或 role=status 标记 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 探针号点击「继续学习」不再停在「等待主讲内容」；进 workspace 后可见「待核对」标注 |

---

## 任务卡 S3 — 编译器关闭时不谎报

```text
目标 / 用户可见结果：
编译器未开启时，新建活动不显示「主讲内容已就绪」；「生成主讲内容」按钮按 capabilities 显隐，
不再点击后返回 503。

范围 / 允许修改文件：
apps/web/src/features/opening/teaching/activity-service.ts
apps/web/src/features/opening/teaching/activity-service.test.ts
apps/web/src/features/opening/teaching/teaching-workspace.tsx（按钮显隐，须与 S2 协调，同支线串行该文件）
apps/web/src/features/opening/teaching/today-activity.ts（canRequestTeachingCompile 增加开关入参）

约束 / 必须保留的行为：
- 服务端 503 继续作为最后一道防线保留（客户端隐藏不等于服务端放行）。
- 编译器开启时行为与 #33 一致：活动 `queued` + 同事务入队 + outbox。
- 不得为通过测试而放宽 server 端 `requestCompile` 的 503。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：关闭时状态诚实 | `activity-service.test.ts` 断言编译器关闭 ⇒ UI 侧状态标签不是「主讲内容已就绪」 |
| 单测：关闭时按钮不可用 | `canRequestTeachingCompile` 在开关关闭时返回 false |
| 单测：开启时仍入队 | 既有断言 `create(scope, input, { enqueueCompile: true })` 保持通过 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 编译器关闭部署下，wait_init 面板不再出现可点却必失败的按钮 |

---

## 任务卡 S4 — 队列行接完成控件

```text
目标 / 用户可见结果：
今日队列每个待办行直接可以「标记完成」/「跳过」，不必进入助理页。完成后待办计数下降。

范围 / 允许修改文件：
apps/web/src/features/opening/planning/today-view.tsx
apps/web/src/features/opening/planning/today-view.test.ts
apps/web/src/features/opening/planning/today-queue-groups.ts（如需分组态）

约束 / 必须保留的行为：
- 复用 `planning/task-status-control.tsx` 的 `TaskStatusControl`：版本并发（expectedVersion）、
  跳过二次确认、`unknown`/`rejected` 时显示「重新读取」全部保留，不重写。
- 行本身仍是选择按钮；新增控件不得嵌套在 `<button>` 内（HTML 非法，会破可访问性）。
- 成功后须触发 `TaskQueueRefreshContext` 的重读，让待办计数与已结束列表同步。
- `doneView`（已结束）列表不渲染完成控件。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：待办行渲染控件 | `npx vitest run --project unit apps/web/src/features/opening/planning/today-view.test.ts` 断言待办行静态标记含「标记完成」 |
| 单测：已结束行不渲染 | 同文件，`doneView` 下不含「标记完成」 |
| 单测：无嵌套交互元素 | 断言行内不存在 `<button>` 直接后代 `<button>`（可用渲染字符串或 role 查询） |
| 单测：成功后重读 | mock `updateTaskStatus` 成功后断言刷新回调被调用 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 集成 | `npm run test:integration -- tests/integration/opening-plan.test.ts`（如存在对应文件）无新增失败 |
| 真机观测（用户） | 队列勾完成 ⇒ 待办 N → N-1；「已结束」列表出现该项；刷新页面后状态保持 |

---

## 任务卡 S5 — 合并部署课程种子切片

```text
目标 / 用户可见结果：
冷启动无 planning_settings 时，Today 提供「用默认作息生成本日计划」；课程页提供「设为今日计划」；
执行后今日队列出现一个课程种子任务。

范围 / 允许修改文件：
不新写代码。把 `feat/course-seed-today-plan`（顶提交 720dde9，基线 f3b2743）合入
`feat/opening-release`，然后按 docs/operations/hermes-deployment.md 部署。

约束 / 必须保留的行为：
- 合入前确认 release 线自 f3b2743 起未改动同 8 个文件，若有冲突按 release 线现状适配，不改种子语义。
- 不修改既有测试期望以迁就冲突。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 分支状态 | `git merge-base --is-ancestor f3b2743 720dde9` 为真（已确认），合并后 `git log --oneline -1 feat/opening-release` 含该提交 |
| 单测 | `npx vitest run --project unit apps/web/src/features/opening/planning/seed-today-plan.test.ts apps/web/src/features/courses/course-study-actions.test.ts` 全绿 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 部署就绪 | `bash infra/deploy/deploy-hermes.sh deploy` 后 `/api/health` 返回 `status:"ok"` |
| 真机观测（用户） | 新号建课后课程页出现「设为今日计划」；点击后今日队列出现课程任务；无设置时 Today 出现默认作息按钮 |

---

## 任务卡 S6 — 修状态机映射与无效重试

```text
目标 / 用户可见结果：
生成失败/取消不再被显示为「jobGate=ready」；wait_init 的「重试拉取 client-init」在没有在飞任务时
给出可执行的下一步（重新生成或返回），不再是无限循环。

范围 / 允许修改文件：
packages/domain/src/opening/teaching-resume.ts
packages/domain/src/opening/teaching-resume.test.ts
apps/web/src/features/opening/teaching/teaching-workspace.tsx（wait_init 分支）

约束 / 必须保留的行为：
- `queued`/`generating` ⇒ in_flight；`unknown` ⇒ unknown；`stale` ⇒ stale 不变。
- 不改 worker 侧任何状态写入。
- 文案不得宣称内容已就绪或已失败，除非状态确实如此。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：failed/cancelled 不再映射为 ready | `npx vitest run --project unit packages/domain/src/opening/teaching-resume.test.ts` 断言 `mapGenerateStatusToJobGate("failed")` 与 `("cancelled")` 不等于 `"ready"` |
| 单测：既有映射不回退 | queued/generating/unknown/stale 断言保持通过 |
| 单测：wait_init 出口 | mock 无在飞任务时，面板提供可重整旗鼓的操作（断言按钮存在且调用 `requestTeachingCompile`） |
| 类型检查 | `npm run typecheck -w @aistudy/domain` 与 `-w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 失败活动打开时显示真实原因，且有可执行出口 |

---

## 任务卡 S7 — 主 CTA 不再空操作

```text
目标 / 用户可见结果：
已有活动时点顶部主 CTA（「继续学习」）产生可见结果：进入/展开学习空间或滚到断点卡，
而不是静默 return。

范围 / 允许修改文件：
apps/web/src/features/opening/planning/today-dashboard.tsx
apps/web/src/features/opening/planning/today-dashboard-activity.test.ts

约束 / 必须保留的行为：
- 无活动时行为不变：创建活动并选中。
- 创建失败时的错误提示保留。
- 不引入新的路由；沿用现有 workspace 展开/聚焦机制。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：已有活动 ⇒ 有可见状态变化 | `npx vitest run --project unit apps/web/src/features/opening/planning/today-dashboard-activity.test.ts` 断言点击后进入非 card 相位或聚焦标记变化 |
| 单测：无活动 ⇒ 仍创建 | 既有断言保持通过 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 点「继续学习」有明确跳转或展开动作 |

---

## 任务卡 S8 — unknown 收尾（可与 S6 并行评估，建议后置）

```text
目标 / 用户可见结果：
`provider outcome unknown; usage reconciliation pending` 的回合不会永久悬挂：有最小对账或超时收敛，
UI 提供「重新提问」。

范围 / 允许修改文件：
apps/worker/src/jobs/tutor-turn.ts
apps/worker/src/jobs/reconcile-unknown-turns.ts（新增，若走对账）
apps/web/src/features/opening/assistant/*（重试入口）

约束 / 必须保留的行为：
- 不伪造成功、不自动重发已发出的请求（非幂等，可能重复计费）。
- 保留 `markUnknown` 的诚实语义；收敛只改变「可否由用户重新发起」。
- 无对账依据时不得把 unknown 直接置为 failed（会误报失败）。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：收敛有界 | 新增测试断言超过窗口后状态收敛为可重试，且不早于窗口 |
| 单测：不自动重发 | 断言收敛路径不调用 provider |
| 类型检查 | `npm run typecheck -w @aistudy/worker`、`-w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 出现该错误后可自行重新提问，不再永久卡住 |

**S8 实现与前期交接记录（2026-10-15）：**

- 原 job、turn 和预算保留 unknown；复用预算已有的 30 分钟保守惰性对账，不新增后台重发或改变费用记录。60 秒仅为 UI 的重新提问等待窗口，从服务器 `job.updatedAt` 起算，刷新不重置，不表示费用已结清。
- 窗口结束后「重新提问」只恢复原问题及辅导模式；已有不同草稿需确认替换，再由用户按发送发起新请求。普通网络未确认的原样重试仍复用原 clientKey。
- 修复最新 unknown 的刷新发现、晚到轮询覆盖新状态，以及同事务/同时间消息的稳定配对；恢复前重读消息并确认同一个 unknown job，跨标签页导致状态变化时要求重新读取。新回合完成后不再恢复旧 unknown。
- 前期独立实现阶段执行过相关单测 91 项、真实 PostgreSQL repository 回归 15 项、tutor handler 接口回归 9 项、浏览器传输夹具回归 4 项（含 390px 窄屏、刷新、冷却边界、草稿保护、晚到轮询与跨读取状态变化），并完成当时的 web/database/worker 和 E2E 类型检查、改动文件 lint。这些是此前阶段结果，不能算作 Claude 续作整合后的本次验收；历史浏览器夹具没有调用真实模型，也不能代表真实 AI、材料上传、计费与教学效果通过。
- 整合后仅运行非浏览器验证，最新浏览器验收按根目录 `AGENTS.md` 交由用户。复验入口为 `/opening/assistant`：遇到最新未知回答后，等待 60 秒，点击「重新提问」应只填回原问题；确认后再发送。本地 MinIO 固定工件不可访问、PDF 所需 Python 解析环境尚未就绪，相关端到端路径仍受阻，不能据此前夹具结果宣称可用。

---

## 任务卡 S9 — `.txt` 支持（或明确拒绝）

```text
目标 / 用户可见结果：
用户上传 .txt 的行为与产品定位一致：要么接受并按文本解析，要么在拒绝文案中说明只支持 Markdown。

范围 / 允许修改文件：
apps/web/src/features/opening/inbox/upload-dropzone.tsx
apps/web/src/features/opening/inbox/upload-state.ts
packages/contracts/src/opening/sources.ts（+ 对应测试）

约束 / 必须保留的行为：
- 三层必须一致：任一层放行而其余拒绝即为缺陷。
- `resolveUploadMime` 对「声明了未知 MIME」的行为不得放宽到「未知即接受」（安全边界）。
- 不重命名文件类型（现有注释明确「never renamed to PDF」）。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：三层一致 | 分别断言 dropzone 准入、`resolveUploadMime`、`sourceMimeSchema` 对 `text/plain` 的结论一致 |
| 单测：未知 MIME 仍拒绝 | 断言 `application/x-unknown` 被拒 |
| 类型检查 | `npm run typecheck -w @aistudy/web`、`-w @aistudy/contracts` 退出码 0 |
| 真机观测（用户） | 上传 .txt 得到与决定一致的结果与文案 |

---

## 任务卡 S10 — 解析文案与可用状态同源

```text
目标 / 用户可见结果：
「可以用于提问」与「正在解析」不再互相矛盾：同一材料在两个入口显示一致的状态。

范围 / 允许修改文件：
apps/web/src/features/opening/inbox/upload-state.ts
apps/web/src/features/opening/inbox/*.test.ts

约束 / 必须保留的行为：
- 诚实机器语义保留：queued/not_started 不显示为失败；running 显示正在解析；aged queued 显示可能较慢。
- 「可以用于提问」的条件仍须以 chunks 存在为准，不得放宽为「上传即可用」。
```

**验收指标**

| 指标 | 检查 |
|---|---|
| 单测：状态—文案映射表 | 覆盖 `uploaded+ready`、`uploaded+queued`、`uploaded+running`、`failed`、`unsupported`、非 uploaded 六种输入 |
| 单测：与可用性判据同源 | 断言文案为「可以用于提问」时，同一 record 满足 chunks 存在前提（用共享谓词函数，不复制条件） |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 真机观测（用户） | 同一材料在队列与材料页文案一致 |

---

## 执行顺序

1. **第 0 步（前置）**：在 `feat/opening-release` 拉修复 worktree。当前 `feat/jingwei-core` 工作树不含部署线代码。
2. **S5** 先合并部署（零新开发、测试已就绪），让冷启动那一半先通。
3. **支线 A**：S1 → S2 → S3 → S7（S2/S3 都改 `teaching-workspace.tsx`，须串行该文件）。
4. **支线 B**：S4 → S6（S8 后置）。
5. **串行**：S9 → S10（`packages/contracts` 归属按 Codex 协作约定串行分配）。
6. 每条切片完成后按 `docs/operations/codex-team.md` 做一次独立审查，再交付用户浏览器验收。

## 证据分层（沿用项目约定）

工程通过 ≠ 真实模型通过 ≠ 用户浏览器验收 ≠ 学习效果已知。上表所有「真机观测」项统一标记 **待用户浏览器验收**，在未获反馈前不得记为通过。本计划不含浏览器自动化执行，按根目录 `AGENTS.md` 的浏览器验收分工由用户负责。

## 回滚

- 全部切片为前端/领域层改动，无 migration。回滚 = `git checkout <旧提交>` → push → `bash infra/deploy/deploy-hermes.sh deploy`（源码级部署天然可回退）。
- S5 合并为快进式叠加，回退到 `f3b2743` 即恢复合并前状态。

## 三轮体验迭代（2026-10-15）

以下三轮根据此前实际笔记保存、窄屏导航与专注操作，以及随后对源码和失败路径的检查推进；每轮列出的 10 项均已落实到整合后的代码。它们记录具体问题与最终行为，不表示 30 项都经过新一轮浏览器验收。当前整合后只运行非浏览器验证；最新页面交互、视觉、响应式和真机验收依根目录 `AGENTS.md` 交由用户。此前传输夹具结果不代表真实 AI 或上传链路通过；MinIO 工件不可访问、PDF 所需本地 Python 环境未就绪的阻塞仍在。

### 第一轮：减少入口干扰，让当前操作有明确反馈

| # | 体验问题 | 已落实的行为 |
|---|---|---|
| 1 | 切换材料页课程后，上传仍可能沿用进入页面时的旧课程 | 上传使用当前选择的课程，减少材料挂错课程的风险。 |
| 2 | 参考核对要求打开材料，却缺少可定位的入口 | 提供绑定版本的参考材料链接；没有保存版本时明确说明无法定位，不冒充当前版本就是原参考。 |
| 3 | 今日空状态与顶部同时争夺「开始学习」主操作 | 空状态保留一个主要开始入口，减少重复按钮。 |
| 4 | 今日页快捷入口铺满首屏，学习动作不突出 | 次要入口收进可展开区域，并去掉重复课程入口。 |
| 5 | 计划概览默认展开，挤压当前学习内容 | 概览可折叠，首屏优先显示当前要做的事。 |
| 6 | AI 配置状态说明在窄屏占用过多空间 | 用简短状态呈现主要信息，详细原因按需展开。 |
| 7 | 在对话框中按 Escape，可能连专注模式一起退出 | 专注模式尊重内层对话框已处理的退出操作，一次按键处理当前层级。 |
| 8 | 专注计时器设置打开后，关闭方式和键盘落点不清楚 | 支持点击外部或 Escape 关闭，关闭后焦点回到计时器按钮。 |
| 9 | 输入框只是不可用时仍显示加载动画，让人误以为正在请求 | 加载反馈与实际发送状态对应，普通禁用状态不再冒充处理中的请求。 |
| 10 | 笔记筛选没有匹配结果时缺少直接恢复列表的操作 | 空结果提供「清除筛选」，可直接回到可用笔记列表。 |

### 第二轮：保护输入和阅读进度，减少重复操作

| # | 体验问题 | 已落实的行为 |
|---|---|---|
| 1 | 卡片评分返回较晚时，可能错误推进已经刷新的复习队列 | 过期评分结果不再改变新队列或其他卡片，当前复习位置保持一致。 |
| 2 | 无到期卡片时只能返回今日，无法直接继续制卡 | 空状态提供前往助理制卡的入口。 |
| 3 | 已按课程筛选材料，但统计仍混入其他课程 | 统计跟随当前课程范围，列表和数字表达同一批材料。 |
| 4 | 复制回答后缺少短暂的完成反馈，切换内容后还可能残留旧状态 | 显示短暂的复制成功提示，并在内容切换后清除。 |
| 5 | 新消息到达时强制滚到底，打断向上阅读 | 用户接近底部时继续跟随；向上阅读时保留位置，并提供跳到新消息的操作。 |
| 6 | 回答尚未结束或仍需恢复确认时，快捷问题仍可点击 | 暂停这些快捷入口，避免误触形成另一条请求。 |
| 7 | 中文输入法尚在组词时就触发内容搜索 | 等组合输入确认后再搜索，避免临时拼写引起请求和结果闪动。 |
| 8 | 创建课程时离开页面会丢失已输入内容 | 草稿在当前浏览器会话内按用户和工作区隔离保存；成功创建后清除。 |
| 9 | 课程创建错误不够明确，连续点击还可能重复提交 | 保留输入并按失败状态提示下一步，同一次创建处理中阻止重复提交。 |
| 10 | 清除课程搜索时，已选择的归档范围也可能被重置 | 只清除搜索词，保留用户当前的归档筛选。 |

### 第三轮：统一工作台，补齐失败后的安全出口

| # | 体验问题 | 已落实的行为 |
|---|---|---|
| 1 | 开发预览反复热更新后可能因数据库连接耗尽而卡住 | 开发模式复用认证运行时及其连接池，减少刷新开发页面导致的连接累积；该项属于开发预览体验修复。 |
| 2 | 笔记保存依赖鼠标操作，连续保存又可能产生并发请求 | 支持 Ctrl/Cmd+S，同一保存尚未结束时不重复提交。 |
| 3 | 新建笔记长时间无响应时没有出口，直接重试又可能重复创建 | 设置等待上限；结果不能确认时引导返回知识库检查，不提供会立即再建一份的重试。 |
| 4 | 课程页与知识库标题区域各用一套排版，页面切换缺少一致性 | 使用统一的页面标题组件，整理标题、说明和主要操作的位置。 |
| 5 | 窄屏顶部工具栏与导航重复显示卡片、复习等入口 | 收起顶部重复入口，保留主要内容和导航空间。 |
| 6 | 移动导航一次铺开太多工具，按钮拥挤 | 保留四个核心入口，其余放进「更多」面板，仍可访问全部工具。 |
| 7 | 从学习工作台进入设置后，返回或继续打开高级项会跳离原上下文 | 增加工作台内设置入口，并让设置、高级设置及相关链接保留对应路径。 |
| 8 | 偏好读取失败后仍可能把初始默认值保存回服务器 | 只有成功读取后才允许保存；保存期间锁定相关输入，避免覆盖尚未读到的真实设置。 |
| 9 | 明显超限或空文件也会先读取完整文件再告知失败 | 在读取内容前先检查大小和空文件，尽早给出可操作的上传反馈；实际提交仍使用真实内容摘要。 |
| 10 | 快速添加任务的提交结果未知时，收起再打开会丢失原输入和请求身份 | 保留待确认提交及草稿，重新打开后先核实原请求，避免换一个身份重复创建任务。 |

用户最新浏览器复验可按三组操作进行：先从 `/opening/today` 检查窄屏导航、专注和次级入口；再从 `/opening/library`、`/opening/courses` 验证笔记保存、筛选与课程草稿；最后在 `/opening/assistant`、`/opening/cards`、`/opening/settings` 检查消息阅读、未知结果恢复、复习和偏好保存。真实模型与上传复验需先补齐对应模型配置、MinIO 和 Python 解析依赖；未反馈前均保持「待用户浏览器验收」。
