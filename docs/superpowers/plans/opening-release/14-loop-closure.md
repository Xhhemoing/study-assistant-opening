# Daily loop closure, round 2 (DL5–DL10, P04a)

> 2026-10-08 在 DL1–DL4 之后做第二轮"以学习闭环为终点"的设计审查，并逐项回到代码核实。结论：即使 DL1–DL4 全部完成，日常闭环仍卡在七处——今天页不能手动加任务、练习判定永远停在"自报"、新装环境 AI 默认不可用且无说明、照片材料不可用、课表无导入界面且每次排程要手填空闲时间、没有每日自动草案、Windows 开发机没有可照做的本地端到端启动方法。本文件把它们落为 DL5–DL10 与 P04a，并给出与 C02/C03/K01/K02/P04/Q01 的排期。
>
> **为何另建文件而不续写 13：** 13 是首轮审查的四个最小修复切片，已入账且自成一组；本轮新增七项任务、修改五项既有任务的依赖并引入跨任务排期，单独成文可以让评审逐项看 diff。13 只做 DL3/DL4 的修订（DL3 的方案与验收按本轮决定重写），P04a 是 P04 的非连接器子集，正文放在本文件，11 的 P04 小节只引用。

**Global constraints:** 继承 13 与 11 的约束：复用既有服务与契约，不新造并行系统；不新增调度器服务或常驻进程；自动整理不等于自动承诺——任何改变正式计划的动作都要用户确认（[设计规格](../../specs/2026-09-12-opening-release-design.md) §3.2"接受后才改变正式计划"）；不显示掌握百分比，不宣称"稳固/掌握"。标注"需迁移"的任务只说明需要的列与约束，迁移编号与文件名由 INTEGRATOR 分配，本文不预占编号。浏览器验收按 `AGENTS.md` 由用户负责；Agent 只跑最接近改动的单元/契约/handler/integration 测试，集成测试只在隔离测试库（`OPENING_TEST_DB=1`）运行。验证命令中的 `npm run typecheck -w @aistudy/web`（以及 `@aistudy/worker`）经 `scripts/run-heavy.sh` 调用 bash（`apps/web/package.json:10`、`apps/worker/package.json:10`），在没有 bash 的 Windows 开发机上改用等价的 `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`（worker 同理，见 14 的 DL10）；`packages/*` 的 typecheck 是直接 `tsc`，可照常运行。

### DL5: Today queue quick-add and grouped queue

**Owner:** DATA+EXPERIENCE. **Depends:** DL2.
**需迁移:** 是（`opening_tasks` 增加可空 `client_key` 及按 workspace+owner 的部分唯一索引）。
**目标:** 用户不依赖 AI 就能在今天页手动加一项任务；队列按"今日已确认 / 到期补测 / 逾期 / 其他待办"分组，到期补测可见。
**为什么（已核实）:**
- 服务端可建任务：`POST /api/opening/tasks`（`apps/web/src/app/api/opening/tasks/route.ts:16-19`）→ `plan-service.ts` `createTask` → `packages/database/src/repositories/opening-retest-task.ts:127` `insertOpeningTask`，契约 `taskCreateInputSchema` 允许 `candidateId: null`、`clientKey` 可选（`packages/contracts/src/opening/planning-tasks.ts:34,38`）。但界面中 `createTask` 的调用者只有复习/重测服务，今天页没有入口。
- `insertOpeningTask` 对无候选、非重测的任务直接 `INSERT`，不使用 `clientKey`（`opening-retest-task.ts:135-154`；`opening_tasks` 无 client key 列，见迁移 0024）：响应丢失后的重试会产生重复任务，违反规格"写操作幂等"。
- `apps/web/src/features/opening/planning/today-view.tsx` 的队列是平铺列表，只有"未完成/已完成"筛选（`today-view.tsx:86`，并提示"队列包含历史任务"，`today-view.tsx:90`），不区分已确认计划内的任务、逾期任务和补测；补测与普通任务混在一起。

**方案（决定与放弃的方案）:**
- 快速添加：标题（必填，≤240 字）、时长预设 15/25/45 分钟（默认 25）、可选截止日期时间。只选日期时按用户时区当日 23:59 作为截止并显示"当日内"；不填则无截止（"没有确定时间不造截止"）。新任务不改变已确认计划，只进入"其他待办"，下一次排程（DL9 的"按建议安排"或 P04a 草案）才纳入。
- 幂等：前端为每次添加意图生成一个 `clientKey`，重试复用；服务端对 `candidateId=null` 的任务按 `(workspace_id, owner_user_id, client_key)` 去重，重放返回同一任务。**放弃**纯前端防重：网络结果未知时前端无法判断是否已写入。**放弃**借 `opening_jobs` 伪造候选再接受：语义错误且多一次写入。
- 分组规则放在纯函数 `groupTodayQueue`：今日已确认 = 今天已接受计划块引用的 pending 任务；到期补测 = `retest.recommendedAt ≤ now` 的补测任务（字段由 DL3 提供）；逾期 = `dueAt < now` 且 pending；其他待办 = 其余 pending。`recommendedAt` 在未来的补测不进入可选列表，只显示"N 项补测将于 X 日到期"。done/skipped 继续放在既有"已完成"筛选中。
- 动作入口沿用 DL2：分组只改列表呈现，完成/跳过仍在 `TaskContext`。

**涉及文件:** 新建 `apps/web/src/features/opening/planning/quick-add-task.tsx`、`apps/web/src/features/opening/planning/today-queue-groups.ts`、`today-queue-groups.test.ts`；修改 `packages/database/src/repositories/opening-retest-task.ts`（手动任务按 clientKey 幂等）、`packages/database/src/schema/opening-planning.ts`（`openingTasks` 表定义）、`apps/web/src/features/opening/planning/today-view.tsx`、`today-dashboard.tsx`、`tests/integration/handler/opening-plans.test.ts`。
**接口:** `groupTodayQueue(tasks: TaskItem[], acceptedBlocks: PlannedBlock[], now: Date, timeZone: string): { confirmed; dueRetests; overdue; other; upcomingRetestCount; done }`；请求体严格按 `taskCreateInputSchema`（`candidateId: null`、`clientKey`）。

**测试先行步骤:**
- [ ] 单测（红）：`groupTodayQueue` 覆盖跨时区的"今天"边界、逾期判定、未来补测只计数、已确认块引用已完成任务时归入"今日已完成"。
- [ ] handler 测试（红）：同一 `clientKey` 两次 `POST /api/opening/tasks`（`candidateId: null`）只产生一行且返回同一 id；不同 clientKey 产生两行；另一 owner 的同 clientKey 互不影响。
- [ ] 实现迁移（编号由 INTEGRATOR 分配）与仓库去重；界面快速添加表单：提交中禁用、未知结果提示"可能已添加，正在核对"并重新读取 `listTasks`，不自动重试。
- [ ] 回归：重测任务（`inputSnapshot.kind='retest'`）和助理候选任务的既有幂等路径不变。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/`；隔离库 `--project handler tests/integration/handler/opening-plans.test.ts`；`npm run typecheck -w @aistudy/web`、`npm run typecheck -w @aistudy/database`。浏览器：添加→刷新→仍在且只有一条，交用户。
**验收:** 无 AI 配置时也能加任务并在刷新、跨端后一致；重复提交不产生重复任务；四个分组与"N 项补测将于 X 日到期"提示按服务端数据显示。

### DL6: Trustworthy practice verdict with learner reference self-check

**Owner:** EXPERIENCE+DATA. **Depends:** L03,K02a.
**需迁移:** 否。
**目标:** 练习作答可以在"先交原答案、后看参考"的前提下由学习者自对照参考来源，形成 `reference_checked` 观察；帮助曝光自动带入；技能名可复用。从而让闭环第一次能产生"观察到独立完成"的证据，补测结果也不再一律"未核验"。
**为什么（已核实）:**
- `apps/web/src/features/opening/learning/attempt-form.tsx` 的提交体固定 `verdictSource: "self_report"`；`packages/domain/src/opening/evidence-eligibility.ts` 的 `evaluateCorrectness` 只在 `reference_checked` 且 `referenceCheck`（referenceId/method/checkerId/outcome、`scope='whole_answer'`、结果一致）时给出确定结论，`self_report` 一律为 unknown（原因 `verification_source_untrusted`）。因此界面上任何作答都无法成为独立完成证据，学习摘要长期停在待核对。
- 服务端已具备自对照所需结构：`packages/database/src/repositories/opening-learning-observations.ts:69` 写入时 `checkerId: scope.ownerUserId`，参考来源必须属于会话绑定来源（同文件 `:25`）；`referenceCheckInputSchema` 的 `method` 为 1–500 字自由文本（`packages/contracts/src/opening/learning-evidence.ts:15`）；观察修订契约 `observationReplacementSchema`（`packages/contracts/src/opening/learning-revisions.ts:6-10`）可携带 `verdictSource` 与 `referenceCheck`，修订仓库按上一版补齐 attemptId/problemId/itemVersionId（`packages/database/src/repositories/opening-observation-revisions.ts:71-73`，入口 `POST /api/opening/observations/revisions`）。
- 修订仓库目前允许"改答案"与"补参考核对"出现在同一次替换中（`opening-observation-revisions.ts:59-66` 只校验来源与判定来源一致），学习者可以把参考答案抄进答案再核对。
- 帮助程度靠手选，而 `packages/database/src/repositories/opening-learning.ts:67` 已有 `listDeliveredExposures(scope, sessionId)`；`opening_help_exposures.turn_id` 为 NOT NULL（迁移 0019），查看参考无法记成帮助曝光。
- 技能名每次手打：学习摘要与重测扫描都按 `skillLabel` 分组，"分数加法/分数 加法"会被拆成两个技能。

**产品规则（决定）:**
- **自对照的定义：** 学习者先提交原始答案（作为首个观察保存，结果"未核对"），再打开会话绑定的参考来源（答案页或解析），整体逐项对照后选择"全部一致/部分一致/不一致/看不懂参考"。
- **能到达的状态：** "全部一致"或"不一致"记为 `reference_checked`，`referenceCheck.scope='whole_answer'`，`method` 以 `learner_self_compare` 开头（可附"第 N 页"）。在无帮助曝光、题目身份完整时可达"观察到独立完成"——这是开学版最高的观察状态；不显示"掌握/稳固"，不给百分比；延迟后的同技能补测再次自对照成功，才构成延迟证据。"部分一致"记 `scope='partial'`，按现有资格规则保持待核对；"看不懂参考"不写修订，保持 `self_report`。
- **权重与标识：** 开学版没有数值权重，自对照与其他整体参考核对享有相同资格，但界面始终标注"自对照参考"，`method` 前缀保留来源区分，K02 的 SkillEvidence 将来可按 method 降权，而无需数据迁移。
- **依据：** PRD 与 `UX_AND_AI_POLICY` 规定正式解题必须由学习者手工完成，防代学流程为"先尝试→保留原始答案→展示解析与差异→重新完成→新情境验证"，且非目标包括"AI 自动决定所有学习事实"；`evidence-eligibility.ts` 已把"有出处的参考 + 核对者 + 整体范围"作为确定结论的条件，并不要求核对者是第三方。自对照满足"保留原始答案、对照有出处的参考"，又不让模型决定学习事实。
- **放弃的方案:** 维持只有自报——闭环永远产生不了独立证据，补测结果恒为未核验；让模型判对错——违反"AI 不决定学习事实"并消耗预算，模型核对只能作为 `model_suggestion` 展示，永不计入资格；新增 `verdictSource='self_compare'` 枚举——要改契约、资格函数与数据库检查约束，而 `method` 前缀已足以区分。

**方案:**
- 开始练习时可选择"题目来源"和"答案/解析来源"（可以是同一份材料），两者都绑定进会话来源；没有参考来源时第二步隐藏。
- 两步提交：第一步 `attempts/[id]/submit` 写原答案；第二步展示参考后经既有修订接口 `replace` 写入同一答案和 `referenceCheck`，修订原因固定为"对照参考核对"。修订仓库增加约束：替换中携带 `referenceCheck` 时 `answer` 必须与上一版相同，否则 VALIDATION。前端在第二步锁定答案输入框，服务端约束才是准绳。
- 同题再练：参考核对后同一 `problemId`/`itemVersionId` 的新作答，按"已看过答案"处理（资格计算中视作 `revealed`）。规则放在 `packages/database/src/repositories/opening-learning-evidence-context.ts` 构造资格上下文时，不新增表。
- 补测作答（DL3 携带 `retestId`）经自对照修订后，重测活动 `result` 必须反映修订后的结论。修订事务已调用 `reconcileOpeningRetestEvidence`（`opening-observation-revisions.ts:93`）；本任务先用集成测试锁定这一行为，只有测试证明结果未同步时才在该函数内补齐，不另写同步路径。
- 帮助自动带入：新增只读 `GET /api/opening/attempts/[id]`，返回 `deliveredAssistance`（会话内已送达曝光的最高级别）。表单预选该级别，用户只能调高不能调低；服务端提交时取"提交值与已送达值"中较高者。
- 技能名复用：表单技能输入提供本课程已有技能列表（来自课程学习摘要），对仅空白/全半角/大小写不同的输入提示合并到既有名称；不自动改写用户输入。
- 同时提示填写题干：没有题干的作答不会产生补测（见 DL3），表单在题干为空时显示这一后果。

**涉及文件:** 新建 `apps/web/src/features/opening/learning/reference-check-step.tsx`、`reference-check.ts`、`reference-check.test.ts`、`skill-label-options.ts`、`skill-label-options.test.ts`、`apps/web/src/app/api/opening/attempts/[id]/route.ts`、`tests/integration/handler/opening-reference-self-check.test.ts`；修改 `attempt-form.tsx`、`course-view.tsx`、`packages/database/src/repositories/opening-observation-revisions.ts`、`opening-learning-evidence-context.ts`、`packages/domain/src/opening/evidence-eligibility.test.ts`（锁定规则，不改函数语义）。
**接口:** `buildSelfCompareRevision({ observation, referenceSourceId, choice: 'match'|'partial'|'mismatch', page? })` → `ObservationRevisionInput | null`；`GET /api/opening/attempts/[id]` → `{ attemptId, sessionId, deliveredAssistance: 'none'|'hinted'|'revealed' }`。

**测试先行步骤:**
- [ ] domain 单测（红→锁定）：`method='learner_self_compare 第3页'`、`whole_answer`、无曝光 → correctness yes 且独立；`partial` → unknown；`self_report` → `verification_source_untrusted`；同题参考核对后再作答 → 不独立。
- [ ] handler 测试（红）：修订携带 `referenceCheck` 且答案改变 → 422；答案不变 → 200 且头观察为 `reference_checked`；参考来源不在会话来源中 → 422；另一 owner 不可修订。
- [ ] handler 测试（红）：已有 `hinted` 曝光时提交 `assistance='none'`，存储的帮助程度为 `hinted`。
- [ ] 集成测试：补测作答自对照修订后，`opening_retest_activities.result` 与学习摘要状态一致。
- [ ] 界面单测：第二步锁定答案、"看不懂参考"不发请求、修订请求复用同一 `clientKey`、409 提示重新读取。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/ apps/web/src/features/opening/learning/`；隔离库 `--project handler tests/integration/handler/opening-reference-self-check.test.ts tests/integration/handler/opening-learning-attempts.test.ts`；`npm run typecheck -w @aistudy/web`、`npm run typecheck -w @aistudy/database`。
**验收:** 不经模型即可形成有出处的整体核对观察；先答后看由服务端保证；帮助曝光不能被自报降低；技能名重复显著减少（以本地样本观察，不预设比例）；界面不出现掌握/稳固措辞。

### DL7: AI readiness checklist, in-app daily cap and unknown reservation reconciliation

**Owner:** AI+DATA. **Depends:** T01,T03.
**需迁移:** 否（额度存入既有 `workspace_preferences.ai_settings` JSON；预算表沿用既有列与状态值）。
**目标:** 首次使用时一眼看到 AI 为何不可用以及怎么修；owner 可在设置页设置每日额度（有安全默认值与上限）；结果未知的预留在超时后被对账，不再永久占用额度；预算按用户本地日计算。
**为什么（已核实）:**
- 模型可用性枚举为 `available/missing_key/budget_disabled/pricing_missing/vault_disabled`（`packages/contracts/src/opening/ai-settings.ts:38`）；`apps/web/src/features/settings/ai-settings-service.ts` 的 `dailyCapCents` 只来自环境变量目录（`loadOpeningModelCatalog`），`OPENING_MODEL_DAILY_CAP_CENTS` 默认 0（`packages/config/src/opening-model.ts:7`），预算仓库也以这一全局值构造（`apps/worker/src/index.ts:64`、`apps/web/src/features/opening/runtime.ts:97`），新装环境全部模型为 `budget_disabled`，用户只能改 `.env` 并重启，界面没有解释。
- `packages/database/src/repositories/opening-budget.ts` 的 reserve 统计"任意时间的 `reserved` 行 + 今天创建或更新的 `completed` 行"，日界为 UTC（北京时间 08:00）；`markUnknown` 只返回行、保持 `reserved`（文件注释写明"until reconciliation"，但没有对账实现）。一次 worker 崩溃就永久占用一份 `OPENING_TUTOR_RESERVED_CENTS`（默认 100，`packages/config/src/opening-model.ts:32`）额度。
- `scripts/opening-readiness.mjs` 已有 providerConfigured/dailyCap 检查，但只面向运维脚本；`/api/opening/health`（`apps/web/src/app/api/opening/health/route.ts`，探针在 `scripts/opening-readiness-probes.mjs`）对外只汇总 database/redis/storage/workerBacklog。

**决定:**
- **一项任务而不是两项：** 就绪清单中的"预算"项、设置页额度和对账都依赖同一个"有效额度 + 今日已用"计算；拆开会先交付一个报错数字的清单。图片视觉输入属于解析管道，单列为 DL8。
- **存储：** `ai_settings` JSON 增加可选 `dailyCapCents: number|null` 与 `budgetConfirmedAt: string|null`；旧行缺字段即视为未设置。不新建表。**放弃**仅环境变量（用户不可见、需重启）与新建预算设置表（为一个整数做迁移）。
- **授权：** 经 `requireOpeningScope` 的 owner 写既有 `PUT /api/opening/ai-settings`；不接受客户端提供的 owner 或 workspace。
- **有效额度** `resolveEffectiveDailyCap({ envCapCents, workspaceCapCents, confirmed, ceilingCents })`：环境值 > 0 且未设工作区值 → 环境值；环境值 > 0 且已设 → `min(环境值, 工作区值)`（界面只能调低运维上限）；环境值 = 0 且未设 → 0（默认关闭，安全默认）；环境值 = 0 且已设并经确认 → `min(工作区值, 内置个人上限 2000 分)`，且要求默认模型定价已配置。开启时弹窗明示"每天最多约 ¥X"，确认后写 `budgetConfirmedAt`。目录合并（可用性）、web 预留和 worker 预留只调用这一函数。
- **对账：** reserve 事务内先做惰性清扫——`state='reserved'` 且创建时间早于"提供方超时 × 最大尝试次数"的保守阈值（默认 30 分钟）的行，按预留金额转为 `completed`（悲观计费：提供方可能已扣费），然后再统计。**放弃**释放为 `released`（可能少计真实费用）与新增后台定时任务（违反无新调度器约束）。
- **日界：** `completed` 只按创建时间归入用户本地日（默认 `Asia/Shanghai`，与提醒 worker 的时区来源一致），不再用 `updated_at`，避免对账行被计入两天。
- **就绪清单：** 新增 `GET /api/opening/ai-readiness`，只返回布尔与计数：已有可用密钥的模型、默认模型定价、有效额度与今日已用/剩余、近 24 小时被对账的未知调用数、是否有支持图片的模型（供 DL8）、worker 积压是否正常。助理空状态与设置页显示，每项给出"去哪里修"。不输出任何密钥或连接串。

**涉及文件:** 新建 `packages/ai/src/opening/effective-cap.ts`、`effective-cap.test.ts`、`apps/web/src/app/api/opening/ai-readiness/route.ts`、`apps/web/src/features/opening/assistant/ai-readiness.tsx`、`tests/integration/opening-budget-reconcile.test.ts`；修改 `packages/contracts/src/opening/ai-settings.ts`、`apps/web/src/features/settings/ai-settings-service.ts`、`ai-settings-panel.tsx`、`ai-settings-model.ts`、`packages/ai/src/opening/catalog-merge.ts`、`packages/database/src/repositories/opening-budget.ts`（额度改为按工作区解析）、`apps/worker/src/index.ts` 与 `apps/web/src/features/opening/runtime.ts`（预算仓库构造处，不再传全局值）。
**接口:** `resolveEffectiveDailyCap(...) → { capCents, source: 'env'|'workspace'|'min'|'disabled' }`；`GET /api/opening/ai-readiness → { items: { key, ok, detail }[] }`（detail 不含秘密）。

**测试先行步骤:**
- [ ] 单测（红）：有效额度四种组合、未确认时为 0、超过内置上限截断、定价缺失时为 0。
- [ ] 集成测试（红）：35 分钟前的 `reserved` 行在下一次 reserve 时变为 `completed` 且只计入其创建所在的本地日；5 分钟前的 `reserved` 不受影响；北京时间 00:30 与 07:59 的调用计入同一天。
- [ ] handler 测试：未登录 401；负数、非整数、超过上限的额度 422；保存后 `GET /api/opening/ai-settings` 的可用性与 worker 使用同一额度。
- [ ] 契约测试：旧 `ai_settings` 行（无新字段）仍可解析。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit packages/ai/src/opening/ apps/web/src/features/settings/`；隔离库 `--project integration tests/integration/opening-budget-reconcile.test.ts` 与 `--project handler` 下 ai-settings 相关测试；`npm run typecheck -w @aistudy/ai`、`npm run typecheck -w @aistudy/web`；worker 类型检查按 DL10 的无 bash 等价命令。
**验收:** 新装环境首次打开助理即看到缺什么、怎么修；owner 能在界面开启有上限的额度；单次崩溃不会永久吃掉额度；预算日界与用户日一致。

### DL8: Photo sources as direct vision input

**Owner:** PIPELINE+AI. **Depends:** I02,T03.
**需迁移:** 否（`opening_source_chunks.image_object_key` 已存在）。
**目标:** 学生拍的作业/板书照片（JPEG/PNG/WebP）上传后可用于辅导：支持图片的模型直接看原图；不支持时明确报错，绝不在没看到图片的情况下作答。
**为什么（已核实）:**
- 上传已允许照片：`packages/contracts/src/opening/sources.ts:12-14` 白名单含 `image/jpeg/png/webp`，上传控件接受 `.png,.jpg,.jpeg,.webp`（`apps/web/src/features/opening/inbox/upload-dropzone.tsx:8`）。
- 但 `apps/worker/src/jobs/parse-source.ts` 只解析 md/html（`:29`）与 pdf/pptx（`:43`），图片、ppt 等标记为 `unsupported`，上传的照片因此无法用于辅导。
- 页图读取 `apps/worker/src/runtime/source-page-images.ts:21` 中 `if (!rows.length || rows[0]!.mime !== "application/pdf") continue;`，非 PDF 一律跳过；辅导只在 `supportsVision` 且有当前页时附图（`apps/worker/src/jobs/tutor-turn.ts:136`）。
- `packages/database/src/repositories/opening-source-chunks.ts:9` 的 `replaceChunks` 在所有分块文本为空时抛出"source has no readable text"；`opening_source_chunks` 的 `text` 为 NOT NULL（可为空串），且有 `image_object_key` 列（迁移 0020）。
- `packages/ai/src/opening/context.ts` 的 `selectContext` 按文本打分，但 `preferPage` 命中仍优先，空文本分块可以被选中。

**方案:**
- 解析：`image/jpeg|png|webp` 生成第 1 页分块，`image_object_key` 指向原件（长边超过 2048 像素时另存缩放派生对象），文本为本地 OCR 结果（解析服务已有 OCR 模型时）或空串；`replaceChunks` 在分块有 `imageObjectKey` 时允许空文本。解析状态复用既有取值。
- 读取：`apps/worker/src/runtime/source-page-images.ts` 对 `image/*` 来源直接返回第 1 页图片。
- 模型：所选模型 `supportsVision=false` 且来源只有图片时，辅导返回明确错误"当前模型不能看图，请在设置中选择支持图片的模型"（就绪清单由 DL7 显示）；不降级为纯文本作答。
- HEIC：已被拒绝——上传白名单不含 HEIC/HEIF（`sources.ts:9-24`），前端对 `.heic` 解析不出 MIME（`apps/web/src/features/opening/inbox/upload-state.test.ts:22`）。本任务只把拒绝提示改为"请导出为 JPG 后上传"，不引入 HEIC 解码依赖。
- **放弃**只做 OCR（丢失图示和手写结构）与把图片转 PDF（多一个依赖，结果相同）。

**涉及文件:** 修改 `apps/worker/src/jobs/parse-source.ts`、`apps/worker/src/runtime/source-page-images.ts`、`packages/database/src/repositories/opening-source-chunks.ts`（`replaceChunks`）、`apps/worker/src/jobs/tutor-turn.ts`（纯图片来源的视觉能力检查）、`apps/web/src/features/opening/inbox/upload-state.ts`（HEIC 提示）；新建 `apps/worker/src/jobs/parse-image-source.test.ts`、`tests/integration/opening-image-source.test.ts`。
**接口:** 不新增 API；`SourceChunk` 读模型已含图片键。

**测试先行步骤:**
- [ ] worker 单测（红）：PNG 来源解析为 1 个分块、带图片键、状态非 `unsupported`；HEIC 被拒并给出提示。
- [ ] 单测（红）：`replaceChunks` 对"空文本 + 图片键"成功，对"空文本且无图片键"仍抛错；`selectContext` 在 `preferPage=1` 时选中空文本图片分块。
- [ ] 集成测试：非视觉模型 + 纯图片来源 → 明确错误且不结算费用；视觉模型 → 请求体含图片（用测试适配器断言，不调用真实模型）。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit apps/worker/src/jobs/ packages/ai/src/opening/`；隔离库 `--project integration tests/integration/opening-image-source.test.ts`；`npm run typecheck -w @aistudy/web`，worker 类型检查按 DL10 的无 bash 等价命令。真实模型看图效果单列为用户验收。
**验收:** 照片材料可以引用为"第 1 页"并被视觉模型读取；不支持看图时有明确提示，不出现"看不到图却作答"。

### DL9: Timetable import, default free time and one-tap plan

**Owner:** EXPERIENCE+DATA. **Depends:** P01,P02,DL5.
**需迁移:** 是（`workspace_preferences` 增加 `planning_settings` jsonb，保存学期第一周周一、节次时间、每日可用窗口与用餐/睡眠时段）。
**目标:** 用户导入一次课表、确认一次学期设置后，每天排程不再手填空闲时间：默认空闲时间由课表与预设推导，"按建议安排"一键生成草案并在确认后生效。
**为什么（已核实）:**
- `PUT /api/opening/timetable`（`apps/web/src/app/api/opening/timetable/route.ts`）没有任何界面调用（唯一调用方是服务端 `plan-service.ts:67` 的 `saveTimetable`）；P01 已交付 `apps/web/src/features/opening/timetable/xlsx-reader.ts`，但其 `parseTimetable(path)` 通过 `read-excel-file/node` 按文件路径读取（`xlsx-reader.ts:23-25`），只能在 Node 中运行。
- `expandWeekSessions(rows, { weekOneMonday, periodTimes, timeZone })` 需要的学期设置没有任何持久化位置；`workspace_preferences` 现有列来自 0005/0031/0032/0036，没有可承载它们的字段（`ai_settings` 语义不同，不混放）。
- `apps/web/src/features/opening/planning/plan-service.ts` 的 `proposePlan` 直接用请求体 `free` 调 `planDay(tasks, body.free)`，从不读取课表；每次排程都要用户输入时间块。

**方案:**
- 导入：把 `parseTimetable` 中"表格行→`WeekSession`"的映射抽成纯函数 `parseTimetableSheets(sheets)`，Node 入口保留；浏览器端用同一依赖的 `read-excel-file/browser` 读取用户选择的文件（`apps/web/package.json:37` 已依赖 `read-excel-file`，其 `exports` 含 `./browser`，不新增依赖）→ 预览（周次/星期/节次/课程）→ 用户确认 → `PUT /api/opening/timetable`。原始 xlsx 不上传到对象存储（不是学习材料，且含个人信息）。**放弃**服务端解析 xlsx（多一条上传路径与隐私面）。
- 学期设置：第一周周一、节次时间（提供常见 45 分钟节次模板，可编辑）、每日窗口默认 07:30–22:30、午餐 12:00–13:00、晚餐 17:30–18:30、睡眠 23:00–07:00；存服务端 `planning_settings`，跨端一致。**放弃** localStorage（跨端不一致，且违反正式数据不落本地的约束）。
- 默认空闲时间：纯函数 `deriveDayBlocks(date, settings, sessions, hardBlocks)` 产出 class/meal/sleep 与 free 块（free = 窗口减去其余块）。`proposePlan` 的 `free` 改为可选，缺省时服务端推导；显式传入时行为不变。
- 预设："课表空档（默认）""今晚 19:00–22:00""只排 1 小时"，可在提议前微调。
- "按建议安排"卡片：一键提议 → 显示与当前已确认计划的差异（新增/移动/未安排）→ "确认"调用既有 accept（版本 CAS）。从不自动接受。

**涉及文件:** 新建 `packages/domain/src/opening/day-blocks.ts`、`day-blocks.test.ts`、`apps/web/src/features/opening/timetable/timetable-import.tsx`、`semester-settings-form.tsx`、`apps/web/src/features/opening/planning/suggest-plan-card.tsx`、`apps/web/src/app/api/opening/planning-settings/route.ts`、`tests/integration/handler/opening-planning-settings.test.ts`；修改 `apps/web/src/features/opening/timetable/xlsx-reader.ts`（抽出纯映射函数）、`xlsx-reader.test.ts`、`plan-service.ts`（`free` 可选）、`packages/database/src/repositories/opening-plans.ts`、`today-dashboard.tsx`、设置页入口（`apps/web/src/features/settings/settings-view.tsx`）。
**接口:** `GET/PUT /api/opening/planning-settings`（owner 限定，strict schema，HH:mm 校验）；`deriveDayBlocks(...) → TimeBlock[]`；`POST /api/opening/plans` 的 `free` 可省略。

**测试先行步骤:**
- [ ] domain 单测（红）：第 N 周课程落在正确日期；跨午夜睡眠块；节次缺失时间时报校验错误而不是猜测；无课日 free = 窗口减去用餐。
- [ ] handler 测试（红）：未设学期设置时省略 `free` → 422 且提示先完成设置；设置后省略 `free` → 草案与显式传入推导结果相同；另一 owner 读不到设置。
- [ ] 界面单测：导入预览可取消、确认后才写课表；"按建议安排"不会在未确认时改变已确认计划。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/ apps/web/src/features/opening/timetable/ apps/web/src/features/opening/planning/`；隔离库 `--project handler tests/integration/handler/opening-planning-settings.test.ts tests/integration/handler/opening-plans.test.ts`；`npm run typecheck -w @aistudy/web`、`npm run typecheck -w @aistudy/database`。用脱敏合成课表 fixture，不提交用户真实课表。
**验收:** 导入课表并确认学期设置后，日常排程只需"按建议安排→确认"两步；课表、设置与计划跨端一致。

### P04a: Daily auto draft from existing tasks, due retests, timetable and carry-over

**Owner:** EXPERIENCE+DATA. **Depends:** DL2,DL3,DL9.
**需迁移:** 否（复用计划草案表；"一天一份"由事务级 advisory lock 加查重保证，不加唯一索引）。
**目标:** 每天第一次打开今天页时，已经有一份基于既有任务、到期补测、课表空闲和昨日未完成顺延的推荐草案，用户确认/调整/拒绝即可。
**为什么:** P04 的"纳入到期复习和可用时间、默认一份推荐计划、超容量列出未安排项"不依赖邮箱/钉钉，却被 C02/C03/K02 整体阻塞；而 DL2/DL3/DL9 落地后这部分已有全部输入。拆出后闭环无需等待连接器。
**方案:**
- 触发：当天第一次读取今天页时惰性生成。现有 `proposePlan` 只把 `propose_client_key` 写入草案行，不按它去重（`packages/database/src/repositories/opening-plans.ts:231-239`；迁移 0024 该列无唯一约束），所以 `ensureDailyDraft` 在一个事务内先取 `pg_advisory_xact_lock`（按工作区+日期），再查当天 `propose_client_key = auto-draft:<本地日期>` 的草案，存在即返回，不存在才提议；**放弃**为此加唯一索引（需迁移，且手动提议允许同日多份草案）。不新增定时任务（11 的"无新调度器服务"约束）。已有当天已确认计划时不生成，只显示"有 N 项新任务未排入"。
- 输入：pending 任务；`recommendedAt` 不晚于当日结束的补测（DL3）；DL9 推导的空闲时间；昨日已确认计划中仍为 pending 的任务优先排入并标注"顺延自昨天"。理由在读模型中由任务状态计算，不额外存储。
- 输出：一份推荐草案，不给多方案选择墙；放不下的列为"未安排"，附"明天优先"或"缩短时长"的建议，由用户决定。
- 用户动作：确认 = 既有 accept；调整 = 修改后再提议并确认；拒绝 = 既有 reject。三者都按既有草案状态记录，用于后续评估（不预设节省比例）。永不自动接受；未处理的 `draft` 状态草案（状态取值见迁移 0024：draft/accepted/rejected）不会被接受，次日生成新草案，确认时仍走既有版本 CAS。
- 与 P04 的分工：P04 在 P04a 的草案构建器上增加多源候选（邮件/钉钉/课程资料）、K02 卡点与来源修订去重，不另写排程入口。

**涉及文件:** 新建 `packages/domain/src/opening/daily-draft.ts`、`daily-draft.test.ts`、`apps/web/src/features/opening/planning/daily-draft-card.tsx`、`tests/integration/handler/opening-daily-draft.test.ts`；修改 `plan-service.ts`（`ensureDailyDraft`）、`apps/web/src/app/api/opening/today/route.ts`、`today-dashboard.tsx`。
**接口:** `buildDailyDraftInput({ tasks, yesterdayAccepted, dueRetests, freeBlocks, now, timeZone }) → { orderedTaskIds, reasons }`；`ensureDailyDraft(scope, date)` 幂等，返回既有或新建草案。

**测试先行步骤:**
- [ ] domain 单测（红）：顺延任务排在最前并带原因；未到期补测不入草案；超容量项进入未安排；无空闲时间时不占睡眠。
- [ ] handler 测试（红）：同一天两次打开只产生一份草案；当天已确认计划时不生成；并发两次请求只有一份；拒绝后当天不再自动生成。
- [ ] 界面单测：卡片三个动作分别调用既有 accept/reject 与重新提议，失败不乐观更新。

**验证命令:** `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/ apps/web/src/features/opening/planning/`；隔离库 `--project handler tests/integration/handler/opening-daily-draft.test.ts tests/integration/handler/opening-plans.test.ts`；`npm run typecheck -w @aistudy/web`。
**验收:** 连续数天使用时，每天第一次打开今天页即有一份可解释的草案；所有正式计划变化都经过用户确认。

### DL10: Windows local end-to-end runbook and readiness self-check

**Owner:** INTEGRATOR+QA. **Depends:** I03,T01.
**需迁移:** 否。
**目标:** 在没有 bash/Docker 的 Windows 开发机上，按文档即可启动 PostgreSQL、Redis、MinIO、解析服务、worker 与 web，跑完"上传→解析→辅导→作答→补测"一次，并用只读自检确认就绪。
**为什么（已核实）:** 根 `package.json` 的 `typecheck/lint/test/test:integration/build` 等脚本（`package.json:18-24`）与 `apps/web`、`apps/worker` 的 `typecheck/build/test` 都经 `scripts/run-heavy.sh` 调用 bash，此机器没有 bash；`packages/*` 的 typecheck 是直接 `tsc`；根 `dev`、`worker:dev`、`preview:start` 与 worker 的 `dev`（`tsx watch src/index.ts`）不依赖 bash。`.local` 下已有 `pgsql`、`redis8/redis-server.exe`、`minio.exe`、`docling-venv` 与多套数据目录（`pgdata`、`miniodata`、`opening-e2e` 等），但启动方式只散落在进程记录与个人脚本中。解析服务需要 `PARSER_PYTHON`（`.local/docling-venv/Scripts/python.exe`）与 `PARSER_CWD`（`services/parser`）。`docs/quality/2026-10-05-opening-repo-review.md` 记录 15432 测试库被另一分支线共享（MIGRATION_UNKNOWN_HISTORY）。
**决定:**
- **新建运维任务，不并入 Q03：** Q03 是 Docker 生产镜像、备份恢复与运行监督；本机无 Docker，把 Windows 开发运行并进去会让 Q03 无法验证或被稀释。
- **MinIO：** 开发用独立实例监听 9000，数据目录与 e2e 的 19000 分开；把 `.env` 指向 19000 会与 e2e 对象共享，只作为文档中的临时替代，并注明风险（本任务不修改 `.env`）。
- **测试库：** 集成测试使用独立端口、独立数据目录的 PostgreSQL 实例，库名必须为 `aistudy_opening_test`（F01 守卫要求 `OPENING_TEST_DB=1` 且为本机回环上的该库，见 `tests/integration/opening-fixture.ts:20-28`），不复用共享的 15432。
- **Q01 依赖 DL10：** Q01 的 handler/integration 门禁需要在隔离服务上运行，本机的可重复启动方式由 DL10 提供。

**交付:** `docs/operations/opening-local-windows.md`（启动顺序、端口、数据目录、日志位置、停止方式、常见故障）与只读自检 `scripts/opening-local-check.mjs`：检查各端口可连、`/api/opening/health` 中 database/redis/storage/workerBacklog 均为正常、必需环境变量"已设置/未设置"（只输出布尔，不输出值）、`PARSER_PYTHON` 路径存在、DL7 就绪接口结果。
**内容要点:** PostgreSQL（`.local/pgsql/bin/pg_ctl` 管理开发数据目录与独立测试实例）；Redis（`.local/redis8/redis-server.exe`，端口与 `.env` 一致）；MinIO（`.local/minio.exe server <开发数据目录> --address :9000 --console-address :9001`）；worker（`npm run worker:dev`）；web（`npm run dev`）；无 bash 等价门禁：`node node_modules/typescript/bin/tsc -p <包>/tsconfig.json --noEmit`、`node node_modules/vitest/vitest.mjs run --project <项目>`、`node node_modules/eslint/bin/eslint.js <路径>`。
**涉及文件:** 新建 `docs/operations/opening-local-windows.md`、`scripts/opening-local-check.mjs`、`scripts/opening-local-check.test.mjs`；修改 `docs/operations/opening-release.md`（在"Readiness checks"下加链接）。

**测试先行步骤:**
- [ ] `node --test scripts/opening-local-check.test.mjs`（红）：给定伪造的健康 JSON 与端口探测结果，自检输出逐项结论；输出中不得出现环境变量的值（用含秘密样式字符串的假环境断言）。
- [ ] 实现自检脚本；用户在本机按文档启动后运行自检，记录各项结果作为证据。

**验证命令:** `node --test scripts/opening-local-check.test.mjs`；用户运行 `node scripts/opening-local-check.mjs` 并保存输出。Agent 不在本任务中启动或停止服务。
**验收:** 用户仅按文档即可在本机完成一次端到端流程；自检全部通过或明确指出缺失项；文档与脚本不泄露任何秘密。

## 对既有任务的修订（2026-10-08 已改账本）

- **DL3：** 依赖改为 L02,P02,DL2,DL5；补测提示取自作答题干快照；建议时间作为"最早可做时间"而非截止；今天页内联接受/忽略提议；补测作答绑定 `retestId`。详见 [13](13-daily-loop-gaps.md) 的 DL3 小节。
- **DL4：** 依赖改为 DL1,U03,DL3,DL6，排在核心闭环之后；记忆卡片是可选附加，不与补测或学习证据争用今天页入口。
- **K02：** 依赖改为 K01,K02a,L02,T03,DL3,DL6。自对照判定、帮助自动带入与技能名复用不需要知识结构，拆入 DL6 后不再被 K01 阻塞；K02 在其上补 SkillEvidence、`nodeId` 与自适应。
- **P04：** 依赖改为 P04a,C02,C03,K02,P02,M01。非连接器的每日草案由 P04a 先交付；P04 仍需要 C02/C03 作为邮件/钉钉候选来源，所以保留这两项依赖。
- **Q01：** 依赖改为 U03,Q03,DL3,DL6,DL7,DL10。完整流程"plan proposal/accept -> retest"需要 DL3；观察核对需要 DL6；"unconfigured provider and budget exhaustion"故障用例以 DL7 的就绪与有效额度为准；在本机隔离服务上运行门禁依赖 DL10。
- **M3（每天用得起来）：** 扩为 P01-P03 + U03 + DL1–DL3、DL5–DL7、DL9、P04a。DL8 补的是 M1"能提交材料并求助"的照片路径，按排期推进但不回改 M1 已有验收；DL4 为可选附加，DL10 是 Q01 的运行前提。
- **C02/C03：** 保持 active，依赖与状态不变；只在推荐顺序上排在 DL1–DL3 之后，已在进行的工作不被阻塞。

## 闭环优先级与排期

| 顺序 | 任务 | 理由 | 可并行 |
|---|---|---|---|
| 1 | DL1、DL2、DL5 | 去 Mock、完成/跳过、手动加任务是每天都会碰到的最小闭环；DL5 需迁移，尽早交给 INTEGRATOR 分配编号 | 三者文件不重叠部分并行；DL5 在 DL2 合入后改 `today-view.tsx` |
| 1′ | DL10 | 文档与只读自检不改产品代码，越早越能让后续任务在本机跑集成测试 | 与 1 并行 |
| 2 | DL3 | 观察→提议→接受→补测→完成的主链路；依赖 DL2/DL5 的今天页分组 | — |
| 3 | DL6 | 让作答和补测第一次产生可核对的证据，否则闭环只是在记录"自报" | 与 4 并行 |
| 4 | DL7、DL8 | 新装环境 AI 可用性与照片材料；AI+DATA 与 PIPELINE+AI 分属不同所有者 | DL7 可提前到 1′ 同期开始 |
| 5 | DL9 | 课表导入与默认空闲时间，需迁移 | — |
| 6 | P04a | 每日自动草案，消费 DL3 与 DL9 | — |
| 7 | DL4 | 可选的记忆卡片，放在核心闭环之后 | 与 8 并行 |
| 8 | C02、C03（继续 active）→ K01 → K02 → P04 → U04 | 扩展能力在已跑通的闭环上增量叠加 | C02/C03 与 K01 并行 |
| 9 | Q03 → Q01 → Q02 → Q04 | 先打包恢复，再集成负向/并发，再真机与最终验收 | — |

人力分配上，闭环任务（1–6）优先于 C02/C03/K01；C02/C03 已有进行中的工作照常推进，不因本排期回退状态或改依赖。
