# 交接任务书：统一模型调度 + 证据闭环（剩余部分）

**Date:** 2026-10-15
**写给：** 接手实现的 GPT（或任何实现者）
**分支：** `claude/keen-carson-ls19ie`（远端已推送）。它包含 PR #43（`feat/adaptive-loop-v2`）的合并提交，因为迁移编号必须连续（0061 在 #43 里）。PR #43 合并进 `feat/opening-release` 之后，本分支只剩下下面这些改动。
**设计依据：** [`2026-10-15-model-gateway-and-evidence-loop-plan.md`](2026-10-15-model-gateway-and-evidence-loop-plan.md)。本文件是可执行版本；两者冲突时以本文件为准。
**必须先读：** 根目录 `AGENTS.md`（编码风格、测试分工、浏览器验收由用户负责、Conventional Commits）。

---

## 0. 用户已定的产品决定（不要改）

1. 学完后**询问**是否把任务标记完成，不自动标记。
2. 活动与任务的关联放在活动的 `create_intent` jsonb 里（`taskId`），**不加列**。
3. AI 判分（E2）**暂缓**，不要实现。以后会加 BKT 等评价模型，所以证据字段要保持完整。
4. 卡片复习要进入学习证据账本（E4）。
5. 所有模型都在「模型供应商」里配置；支持一个模型一键配置；模型调度器统一。
6. 允许**用户明确指定**的备用模型。
7. 可以用 Google Gemini 免费 API（免费额度会被 Google 用于改进产品，界面必须提示）。
8. 当前重点是闭环能力和质量。

## 1. 已完成（不要重做）

| 提交 | 内容 |
|---|---|
| `52d6f24` | **M1/M2a**：用途注册表 `packages/ai/src/opening/model-tasks.ts`（`MODEL_TASKS`）；纯逻辑调度器 `packages/ai/src/opening/model-gateway.ts`（`createModelGateway`）；读库装配 `apps/worker/src/runtime/model-gateway.ts`（`resolveTaskModel`、`createDbModelGateway`、`scopeBudget`），这是**唯一**构造 provider 的地方，ESLint 禁止在别处 import `createOpeningProvider`；`runBudgetedCall` 移到 `packages/ai/src/opening/budgeted-call.ts`；知识图谱抽取改走 `knowledge.extract` 并进入预算 |
| `45732c6` | **M2b**：主讲编译接真实模型（`teaching.compile`，开关 `OPENING_TEACHING_COMPILER_ENABLED`）；provider 增加 `outputFormat: "json"` 和 `audioParts`；编译器解析模型 JSON（`parseCompileModelOutput`），未知类型和越界 chunk id 丢弃，答案块隐藏，公式不带引用，无效回答让任务失败；工作区用 `LearningProse` 渲染 Markdown + KaTeX；修复知识抽取的 JSON 被辅导回答格式拒绝的问题 |
| `d22f2cf` | **M3（WIP）**：迁移 `0062`；`ai_settings.taskRoutes`（每个用途的主模型 + 备用模型）；备用模型只在「确定没发出」时启用（`isNotSentFailure`、`withModelFallback`）；免费额度按每日请求数限制、零成本记账（`reservationTerms`、预算仓库的 `requestCapPerDay`）；辅导回合与临时对话都接入；设置页增加「按用途指定模型与备用模型」(`task-routes-section.tsx`) 和模型表单的音频/计费/请求上限 |

## 2. 第一件事：修 3 个单元测试（M3 收尾）

这 3 个失败都是**测试期望落后于有意的改动**，不是逻辑错误。按真实行为更新断言，不要改实现来迁就旧断言。

| 测试 | 原因 | 怎么改 |
|---|---|---|
| `apps/worker/src/runtime/model-gateway.test.ts` 「prefers workspace Lant/glm …」第 80 行附近 | `createOpeningProvider` 现在多收 `supportsAudio`（工作区模型为 `false`） | 期望对象里加 `supportsAudio: false`，或改用 `expect.objectContaining` |
| `apps/web/src/features/settings/ai-settings-model.test.ts` 第 56 行 | 文案从「不会自动重试或改用其他供应商」改成了「只有你为该用途明确指定了备用模型…才会改用备用模型」 | 断言新文案；同时补一条：渲染结果包含「按用途指定模型与备用模型」（数据里给 `tasks`） |
| `apps/web/src/features/settings/provider-settings-model.test.ts` 第 31 行 | `modelRequestBody` 多了 `supportsAudio`、`billing`、`dailyRequestCap` | 更新期望；再补用例：`billing:"free_tier"` 时价格允许 0、必须有 1–100000 的请求上限 |

另一个已知失败 `apps/worker/src/parsers/pdf-page-images.test.ts` 是环境问题（缺 `.local/docling-venv` 的 Python），与本任务无关，**不要修、不要跳过**，交付说明里写明即可。

M3 还需补的测试：
- `apps/web/src/features/settings/ai-settings-model.test.ts`：`effectiveTaskRoutes`（显式主模型 > 上方规则；备用模型缺能力时报 `不支持音频输入` 之类），`setTaskRoute`（主/备都清空时删除该键，`taskRoutes` 为空时整个字段去掉）。
- handler 测试 `tests/integration/handler/`（参考现有 ai-settings / model-providers handler 测试）：保存未知用途键 → 422；`taskRoutes` 指向不存在的模型 → 422；备用模型不可用 → 422；合法设置往返保存。

## 3. 剩余切片（按顺序）

每个切片单独提交，提交前跑第 5 节的检查。所有新 UI 只用 Tailwind + `lucide-react`，保留 aria 状态；不新增 CSS 文件或 `style` 属性。

### M4 一键配置模型 + 连通性测试

**目标：** 设置页顶部一个表单，填一次就能让所有用途可用。

后端：
- 新增 `POST /api/opening/model-providers/quick-setup`（文件 `apps/web/src/app/api/opening/model-providers/quick-setup/route.ts`）。请求体契约加在 `packages/contracts/src/opening/model-providers.ts`：
  ```ts
  { clientKey: string(8..120), label, baseUrl, apiKey, modelName,
    inputCentsPerMillion, outputCentsPerMillion, supportsVision?, supportsAudio?,
    billing?: "metered"|"free_tier", dailyRequestCap?: number|null,
    dailyCapCents?: number|null, confirmBudget?: boolean }
  ```
  用 `pricingIssue()` 校验价格与计费方式。
- **同一个事务**里完成：`lockModelProviderOwner(tx, scope)` → `insertProvider(tx, …)` → `insertModel(tx, …)`（都已从 `packages/database/src/repositories/opening-model-providers.ts` 导出）→ 写 `workspace_preferences.ai_settings`：`mode:"automatic"`、`defaultModelId = 新模型 id`、`routes` 全部 `null`、清空 `taskRoutes`、按需写 `dailyCapCents` 和 `budgetConfirmedAt`（`billing:"metered"` 时必须 `confirmBudget:true` 且 `dailyCapCents > 0`，规则复用 `apps/web/src/features/settings/ai-settings-service.ts` 的 `validateBudgetFields`）。需要在 `packages/database/src/repositories/opening-ai-settings.ts` 抽一个接收 `tx` 的写函数，不要另起事务。
- 幂等：`clientKey` 重放返回第一次的结果，不建第二个供应商。最简单的做法是在 provider 行上存 `quick_setup_key`（需要新迁移 `0063`，写回滚语句），或者用现有 label 唯一约束 + 读回。**选前者**，并在迁移注释里写清楚。
- 返回 `readAiSettings()` 的结果，前端由此显示每个用途是否可用（`tasks` + `models`）。
- 新增 `POST /api/opening/model-providers/{id}/models/{modelId}/probe`：经调度器发一次极小 JSON 请求（`outputFormat:"json"`，`maxOutputTokens: 16`，text「回复 {"ok":true}」），需要在 `MODEL_TASKS` 加 `"settings.probe": { label: "连通性测试", group: "settings", purpose: "probe" }`，并让 `ai-settings-service.ts` 的 `TASK_VIEWS` **排除** `settings` 组（它不是用户可路由的用途）。探测必须指定模型而不是走路由：给 gateway 加 `callModelDirect(scope, resolvedModel, options)` 或在 worker 侧 `resolveModelById`，保持在 `apps/worker/src/runtime/model-gateway.ts` 内。结果文案只说「本次请求成功 / 失败（原因）」，不说质量。
- 密钥只写入不回读；响应、日志、错误信息里都不能出现密钥。

前端：
- 新文件 `apps/web/src/features/settings/quick-setup-panel.tsx`（+ 纯函数 `quick-setup-model.ts` 和测试），挂在 `settings-view.tsx` 里 AI 设置面板之前。
- 预设下拉只填 baseUrl 和示例模型名，**不内置价格**：
  - Google Gemini（免费额度）：`https://generativelanguage.googleapis.com/v1beta/openai`，示例 `gemini-2.5-flash`，默认勾选「支持视觉」「支持音频输入」，计费方式默认 `free_tier`、每日请求上限默认 200，并显示 `FREE_TIER_NOTICE`。
  - 其他 OpenAI 兼容：只填 baseUrl，用户自己填模型名和价格。
- 未确认日额度（按量计费）、价格不合法、远程非 https 时不提交；提交成功后清空密钥输入；同一次提交重试用同一个 `clientKey`。

验收：handler 测试覆盖事务回滚（任一步失败什么都不留下）、clientKey 幂等、响应不含密钥、免费额度不需要日额度；单测覆盖表单校验与预设填充。浏览器验收由用户做。

### E3 活动可以结束 + 学完小结 + 询问标记任务完成

后端：
- `packages/contracts/src/opening/teaching-resume.ts` 的 `teachingActivityStatusUpdateInputSchema` 允许 `"completed"`；`packages/database/src/repositories/opening-teaching-activities.ts` 的 `setStatus` 接受 `completed`（数据库 CHECK 已允许）。`completed` 之后不能再改回 `active/paused`（返回 409）。
- 新增只读小结：`GET /api/opening/teaching-activities/{id}/summary` → `{ coveredBlockIds, skippedBlockIds, attempts: {total, correct, incorrect, unverified}, openQuestions: string[], taskId: string|null }`。覆盖用 `packages/domain/src/opening/teaching-coverage.ts`，作答来自 `opening_learning_attempts`/observations（按 `activity_id`），跳过块来自 checkpoint 的 `skippedBlockIds`。`taskId` 从 `create_intent.taskId` 读。
- 活动创建：`apps/web/src/features/opening/teaching/today-activity.ts` 的创建输入允许可选 `taskId`，写进 `createIntent`；clientKey 规则沿用 PR #43 L5 卡片里的 `task:${taskId}`。**不要**为此加列。

前端（`apps/web/src/features/opening/teaching/`，注意 PR #43 L5 也改这个目录，先 `git fetch` 看 L5 是否已合并，避免同一文件两个写入者）：
- 工作区底部加「结束本次学习」按钮 → 调状态接口设为 `completed` → 显示小结卡（新文件 `activity-summary-card.tsx`）。
- 活动带 `taskId` 时，小结卡里问「把『任务标题』标记为完成？」，按钮复用 `apps/web/src/features/opening/planning/task-status-control.tsx`（`expectedVersion` 并发、409 时「重新读取」）。**未点击不调用** `updateTaskStatus`。

验收：单测：结束后渲染小结、带 taskId 才出现询问、未点击不更新任务；handler/集成：`completed` 后再 `active` → 409，小结计数正确。

### E1 主讲内作答 + 对照答案核对

- 新文件 `apps/web/src/features/opening/teaching/inline-attempt.tsx`（+ 测试），在 `block-renderer.tsx` 的 `question` 分支使用，替换现在「本页不本地判分」的只读提示。
- 复用现有接口与客户端 `apps/web/src/features/opening/client/learning-client.ts`：先建/复用 learning session（带 `activityId`），再提交 attempt，再写 observation。身份与版本捕获照抄 `apps/web/src/features/opening/learning/attempt-form.tsx`，**不要复制判分逻辑**。
- 提交前**不展示** `answer_key`；提交后通过服务端读取同一 prompt 后紧跟的 `answer_key` 块（需要一个只在已提交 attempt 后返回答案的接口，例如 `GET /api/opening/teaching-activities/{id}/answer-key?blockId=…&attemptId=…`，服务端校验 attempt 属于该活动且已提交）。
- 核对步骤复用 `apps/web/src/features/opening/learning/reference-check.ts`：用户对照后选择「我答对了 / 我答错了」，记 `verdictSource: "reference_checked"`；跳过核对记 `unverified`，**不能**记成 incorrect。
- 答错的观察会按现有逻辑入队复测（`packages/database/src/repositories/opening-learning-observations.ts:149`），不用另写。
- 不出现「你已掌握」之类文案；不输出掌握百分比。

验收：单测：提交前 HTML 不含答案文本；集成：活动内作答产生的 observation 的 `activity_id` 等于该活动，答错后有 `retest` job。

### E4 卡片复习进入证据账本

- 迁移 0062 已给 `cards` 加了 `course_id`、`skill_label`。
- 卡片创建接口（`packages/contracts/src/reviews.ts` 的创建 schema、`packages/database/src/repositories/cards.ts`、`apps/web/src/features/opening/cards/create-card-dialog.tsx`）支持可选 `courseId`、`skillLabel`；服务端校验课程属于本工作区且未归档。
- 评分（`packages/database/src/repositories/cards-grade.ts` 的 `gradeCard`）：卡片有 `course_id` 时，在**同一事务**里写一条 observation：`again → incorrect`，`hard/good/easy → correct`，`verdictSource: "self_report"`，`assistance: "independent"`，技能用卡片的 `skill_label`，clientKey `card-review:<学习事件 id>`（重放不重复写）。没有课程的卡片只保留 SRS，不写账本。
- 从错题建卡：观察详情（`apps/web/src/features/opening/learning/observation-revision-card.tsx` 附近）加「做成记忆卡片」，打开现有创建对话框并预填题干/参考答案、课程、技能。可选的 AI 建议正反面：在 `MODEL_TASKS` 加 `"cards.suggest": { label: "记忆卡片建议", group: "practice", purpose: "cards" }`，经调度器 `call()`，`outputFormat:"json"`，结果只预填表单，用户确认后才创建。
- 资格规则不变：`self_report` 不能产生 `observed_independent`（`packages/domain/src/opening/evidence-eligibility*.ts` 已保证，加测试证明）。
- 备份：确认 `cards` 的新列进入 opening 备份/恢复（参照 PR #43 对 `opening_tasks.course_id` 的处理：`opening-backup-record-table-queries.ts`、`opening-backup-apply.ts`、`opening-backup-course-records.ts`）。

验收：集成：评分写入一条 observation、重放不重复、无课程卡片不写；`self_report` 不让技能变成 `observed_independent`。

### E5 评价器接口（为 BKT 预留）

- 新目录 `packages/domain/src/opening/estimators/`：
  ```ts
  export type SkillEvidence = { observationId; courseId; skillLabel; requirementKey: string|null;
    itemVersionId: string|null; firstAttempt: boolean; outcome; assistance; verdictSource; occurredAt };
  export interface SkillStateEstimator { readonly version: string;
    estimate(evidence: readonly SkillEvidence[]): { state: "unobserved"|"needs_check"|"needs_review"|"observed_independent"; reasons: string[] } }
  ```
- `rules-1`：包装现有 `packages/domain/src/opening/learning-summary.ts` 的判定，结果必须与现在完全一致（用现有 fixtures 做对照测试）。
- 加一个测试，检查从数据库读出的证据（`packages/database/src/repositories/opening-learning-evidence-context.ts` 一带）能填满 `SkillEvidence` 的每个字段；缺字段时测试失败。
- **不要**实现 BKT，不要改页面显示，不要输出百分比。

### M5 转写引擎选择（本地或 Gemini）

- `MODEL_TASKS` 加 `"media.transcribe": { label: "音视频转写", group: "materials", purpose: "transcribe", needs: ["audio"] }`。
- `ai_settings` 加可选 `transcription: { engine: "local" | "model" }`（`packages/contracts/src/opening/ai-settings.ts`），默认 `local`。`engine:"model"` 时用 `media.transcribe` 的路由（主模型 / 备用模型照常）。
- 新文件 `apps/worker/src/parsers/model-transcribe-adapter.ts`：签名与 `createPythonTranscribeAdapter` 返回的函数一致（`(input, signal) => Promise<MediaSegment[]>`）。把音频转成 wav/mp3、按约 20 MB 切段，每段经调度器 `call()` 发 `audioParts`，`outputFormat:"json"`，要求返回 `{segments:[{startMs,endMs,text}]}`，校验时间单调、文本非空，偏移累加。operationId `transcribe:<jobId>:<段序号>`。
- `apps/worker/src/index.ts` 里 `parse-media` 的 `transcribe` 依赖按工作区设置选择本地或模型适配器；隐私排除和隐私 epoch 检查沿用 `parse-media` 现有逻辑；「用户修正过的分段不覆盖」规则不变。
- 设置页在任务路由区下面加「转写引擎」单选；选「模型」时若 `media.transcribe` 没有支持音频的可用模型，提示并禁止保存。

验收：单测：分段偏移、无效 JSON 失败、`supportsAudio:false` 时路由报错；不要在测试里发真实网络请求。

### M6 收尾文档

- `docs/operations/opening-model-routing.md`：补用途表（新增的用途）、备用模型规则、免费额度（含 Google 数据使用提示和「部署前确认 Hermes 能访问 `generativelanguage.googleapis.com`」）、一键配置、转写引擎、0062/0063 回滚。
- `docs/plans/2026-10-15-model-gateway-and-evidence-loop-plan.md` 顶部 Status 更新为各切片实际状态。
- `docs/STATUS.md` 只改本任务那一行。
- `.env.example` / `infra/docker/opening.env.example`：服务器目录 JSON 示例里加 `supportsAudio`、`billing`、`dailyRequestCap` 字段的说明（注册表在 `packages/config/src/registry.ts`，有模板生成测试，改完跑它）。

## 4. 不变量（违反即不合格）

- 新的 AI 功能**只能**通过 `MODEL_TASKS` + 调度器调用模型；不要在别处 `createOpeningProvider`，不要绕过预算账本。
- 备用模型只在请求**确定没发出**时启用；超时/断网/未知结果绝不切换，也不自动重发。
- 免费额度：零成本预留必须带每日请求上限；按量计费的调用永远是正数金额。
- 模型输出是不可信数据：JSON 先校验再用；引用只能是提供给模型的 chunk id；`answer_key` 在客户端隐藏。
- 不输出掌握百分比；`self_report`、`model_suggestion` 不能单独让证据变成「独立正确」。
- 不删除或跳过已有测试；不改测试期望来掩盖真实失败（第 2 节那 3 个是行为有意变更）。
- 迁移只追加、写回滚注释、编号连续；每个迁移都更新两处「迁移列表」测试：`packages/database/src/repositories/opening-teaching-resume-surface.test.ts` 和 `apps/web/src/features/opening/teaching/resume-service.test.ts`。
- 密钥不进日志、响应、localStorage、git。
- 浏览器验收（Playwright、截图、真机）由用户负责，不要运行；交付里写「待用户浏览器验收」和操作步骤。

## 5. 如何验证

```bash
npm ci
# 单测：只跑改动相关的文件
npx vitest run --project unit <相关测试文件或目录>
# 类型检查：改到哪个包跑哪个
npm run typecheck -w @aistudy/{contracts,ai,domain,database,config,worker,web}
# lint：改动文件
npx eslint <改动文件>
# 集成 / handler 测试需要 Postgres，数据库名必须是 aistudy_opening_test
export OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://<user>@127.0.0.1:<port>/aistudy_opening_test
npx vitest run --project integration tests/integration/<相关文件>
npx vitest run --project handler tests/integration/handler/<相关文件>
```

本分支在 `d22f2cf` 时实际跑过并通过的：
- 集成：`opening-budget`、`opening-model-providers.repository`、`opening-budget-matrix/races/reconcile/scope`、`opening-tutor-turn`、`opening-knowledge`、`opening-compile-teaching-unit-worker-wiring`（共 8+ 个文件）；
- handler：`opening-model-providers`、`opening-ephemeral`；
- 单测：`packages/ai`、`packages/config`、`packages/contracts`、`apps/worker`、`apps/web/src/features/opening/tutor`、`apps/web/src/features/settings`，除第 2 节的 3 个和 PDF 环境问题外全部通过。

## 6. 交付格式

每个切片一个提交（Conventional Commits，如 `feat(settings): one-click model setup (M4)`），说明里写：改了什么、实际跑过的检查和结果、迁移与回滚、待用户浏览器验收的入口与步骤。不要创建 PR，除非用户要求。
