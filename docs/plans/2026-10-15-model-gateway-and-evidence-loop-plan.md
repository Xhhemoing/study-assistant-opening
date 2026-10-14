# 统一模型调度 + 证据闭环计划

**Date:** 2026-10-15
**Baseline:** `feat/opening-release` @ `649353f`；与 PR #43（`feat/adaptive-loop-v2`，自适应排程 L0/L1）并行
**Status:** M1、M2a、M2b 已完成；M3 已实现待修 3 个测试期望；M4、M5、E1、E3、E4、E5、M6 未开始，执行说明见 [`2026-10-15-gpt-handoff.md`](2026-10-15-gpt-handoff.md)；E2 暂缓
**关联：** [`2026-10-15-adaptive-learning-loop-v2.md`](2026-10-15-adaptive-learning-loop-v2.md)（PR #43，排程侧 L0–L8）、[`2026-10-14-learning-loop-closure-plan.md`](2026-10-14-learning-loop-closure-plan.md)（S1–S10）

> 编号说明：PR #43 已经用了 L0–L8（排程）。本计划用 **M**（模型调度）和 **E**（证据闭环），避免撞号。

## Outcome

1. **所有模型都在「模型供应商」里配置**：主讲编译、讲解校验、知识图谱抽取、AI 判分、规划 Agent、辅导和临时对话、转写，全部从同一份目录和同一套路由取模型。不再出现借用其他功能路由、写死桩或绕过预算的调用。
2. **一个模型一键可用**：填一次地址、密钥、模型名和价格，确认日额度，一次提交后所有用途都能用。缺少的能力（例如看图）由页面明确指出。
3. **调度器只有一个入口**：新增 AI 功能只需在用途注册表加一行；更换协议、加备用模型或改计费策略，只改调度器一处。
4. **学习证据闭环**：主讲里能作答，AI 给出判分建议，卡片复习进入证据账本，学完后询问是否标记任务完成。证据格式为以后接入 BKT 等评价模型预留好接口。

## 用户已定（2026-10-15）

| # | 决定 | 落点 |
|---|---|---|
| 1 | 学完后**询问**再标记任务完成，不自动标记 | E3；与 PR #43 L5「完成回写只提示」一致 |
| 2 | 活动和任务的关联放在 `create_intent` jsonb，不加列 | E3；clientKey 沿用 L5 的 `task:${taskId}` |
| 3 | 需要 AI 判分；以后会加入 BKT 等评价体系 | E2 判分只作建议；E5 定义评价器接口和 BKT 所需字段 |
| 4 | 卡片复习进入证据账本 | E4 |
| 5 | 所有模型由供应商配置、支持一键配置、调度器统一 | M1–M6 |
| 6 | 允许**用户明确指定**的备用模型（10-15） | §3 备用模型；只改 `call()` 一处 |
| 7 | 可以使用 Google Gemini 免费 API（10-15） | §4 免费额度计费、§5 远程转写 |
| 8 | AI 判分以后再做；先保证闭环能力和质量（10-15） | E2 延后；顺序见下 |

## 现状核查（649353f）

| 调用方 | 选型 | 预算账本 | 问题 |
|---|---|---|---|
| 持久辅导 `apps/worker/src/jobs/tutor-turn.ts:182` | `resolveTutorModel(mode)` | `runBudgetedCall` + 模型快照 | 正常，作为基准 |
| 临时对话 `apps/web/src/features/opening/tutor/ephemeral-service.ts:202` | 同上 | 同上 | web 通过 `../../../../../worker/src/runtime/budgeted-call` 跨应用相对路径引用 worker |
| 知识图谱抽取 `apps/worker/src/index.ts:87` → `build-course-knowledge.ts:157` | **借用辅导的 `explain` 路由** | **没有**：直接调用 `provider.complete` | 不计费、没有模型快照、不受日额度约束；用户改了「解释」模式的模型，抽取也会跟着变 |
| 主讲编译 `apps/worker/src/runtime/compile-teaching-unit-wiring.ts:41-55` | **桩**（固定 JSON） | 有 reservation，但没有模型快照 | 主讲内容是模板；没有模型可选 |
| 讲解校验 `packages/ai/src/opening/teaching-verifiers.ts` | 不单独调用模型 | — | 规则校验；以后如果加模型核对，需要单独的用途 |
| 转写 `services/parser/opening_parser/transcribe.py` | 本地 faster-whisper，`OPENING_WHISPER_MODEL_SIZE/PATH` 环境变量 | — | 不在供应商页显示，用户看不到是否可用 |
| PDF OCR `services/parser/opening_parser/__main__.py:38` | `do_ocr=False`，`PARSER_OCR_MODEL_DIR` | — | 同上 |
| 旧探索 `apps/worker/src/jobs/exploration-chat.ts` | 旧 `AIProvider` | — | 旧 workspace 路径，opening worker 没有接入，不在本计划范围 |

路由契约（`packages/contracts/src/opening/ai-settings.ts`）：只能选手动模式或「按 4 个辅导模式映射」，没有其他用途。模型只有 `supportsVision` 一个能力位。核心原则「不推断、不静默换供应商、选不到就明确失败」（`packages/ai/src/opening/model-routing.ts:7-16`）保留。

包依赖：`ai → contracts, domain`；`database → ai`。所以调度器的纯逻辑放在 `packages/ai`，读库的装配放在应用层。

## 设计

### 1. 用途注册表（`packages/ai/src/opening/model-tasks.ts`）

```ts
export const MODEL_TASKS = {
  "tutor.listen":        { group: "tutor",     needs: ["chat", "json"], purpose: "tutor" },
  "tutor.hint":          { group: "tutor",     needs: ["chat", "json"], purpose: "tutor" },
  "tutor.explain":       { group: "tutor",     needs: ["chat", "json"], purpose: "tutor" },
  "tutor.think_together":{ group: "tutor",     needs: ["chat", "json"], purpose: "tutor" },
  "tutor.vision":        { group: "tutor",     needs: ["chat", "json", "vision"], purpose: "tutor" },
  "teaching.compile":    { group: "teaching",  needs: ["chat", "json"], purpose: "compile-teaching-unit" },
  "knowledge.extract":   { group: "materials", needs: ["chat", "json"], purpose: "build-course-knowledge" },
  "grading.suggest":     { group: "practice",  needs: ["chat", "json"], purpose: "grading" },
  "cards.suggest":       { group: "practice",  needs: ["chat", "json"], purpose: "cards" },
  "planning.agent":      { group: "planning",  needs: ["chat", "json"], purpose: "plan-agent" },
  "media.transcribe":    { group: "materials", needs: ["audio_transcription"], engine: "local_or_provider" },
} as const satisfies Record<string, ModelTaskSpec>;
```

每项还带 `label`（设置页文案）、`defaultMaxOutputTokens`、`reserveCents(input)`。新增 AI 功能只加一行，设置页和就绪检查自动出现这个用途。

### 2. 路由解析（扩展现有函数，不另起一套）

顺序：手动锁 → **用途映射** → **分组默认** → 工作区默认 → 合并后的服务器默认。选中模型后检查能力，缺能力时明确失败（「『看图辅导』需要支持图片的模型」），**不换模型**。

- `ai_settings` 增加可选的 `taskRoutes: Partial<Record<ModelTaskKey, modelId|null>>`。现有 `routes`（4 个辅导模式）在读取时映射到 `tutor.*`，旧数据不改写。这一项是 jsonb，**不需要 migration**。
- `selectedOpeningModelId(settings, mode, …)` 推广为 `selectedModelIdForTask(settings, task, …)`，旧函数保留成薄包装，现有测试继续通过。

### 3. 调度器（唯一入口）

```ts
// packages/ai/src/opening/gateway.ts —— 纯逻辑，依赖从外部注入
createModelGateway(deps: { loadCatalog, loadSettings, loadWorkspaceModels, budget, providerFactory })
  .resolve(scope, task)               → ResolvedModel { provider, snapshot, prices, capabilities }
  .call(scope, task, input, opts)     → ProviderOutput   // resolve + runBudgetedCall + 快照 + 错误映射
```

- `runBudgetedCall` 从 `apps/worker/src/runtime/budgeted-call.ts` **原样搬到 `packages/ai`**（依赖本来就是注入的），worker 保留 re-export，并去掉 web 对 worker 的相对路径引用。
- 读库装配只有一处：`apps/worker/src/runtime/model-gateway.ts` 的 `createDbModelGateway(sql)`，替代 `resolveTutorModel`，web 和 worker 共用。
- `providerFactory` 按模型的 `protocol` 选择适配器；现在只有 `openai_chat`（`createOpeningProvider`）。以后加其他协议只改这个工厂。
- **防绕过**：ESLint `no-restricted-imports` 禁止在 `packages/ai/src/opening/gateway.ts` 以外直接引用 `createOpeningProvider` 和 `runBudgetedCall`。这道检查直接防住「知识抽取绕过预算」这类问题重现，成本是一条 lint 规则。
- **备用模型（已定，M3 落地）**：每个用途可选一个**用户明确指定**的备用模型，`taskRoutes[task] = { primary, fallback? }`。只在两种情况下切换：请求**确认未发出**（连接失败、401/403、429、模型不可用、缺能力），或预算账本已释放该预留。发出后结果未知（超时、断网）**不切换**，避免重复计费，仍按 `markUnknown` 处理。切换时新开一次预留和模型快照，回合上标注「已改用备用模型 X」。没有指定备用模型时，行为与现在相同：明确失败。逻辑只在 `call()` 里实现。

### 4. 模型能力与一键配置

- 模型记录增加 `capabilities`：`chat`、`json`、`vision`、`audio_transcription`。迁移 `0062` 给 `opening_model_provider_models` 加 `capabilities text[] NOT NULL DEFAULT '{chat,json}'`，`supports_vision=true` 的行回填 `vision`。服务器目录 JSON 增加可选的 `capabilities`，缺省时与旧行为一致。
- **一键配置**：`POST /api/opening/model-providers/quick-setup`，需要 `clientKey` 保证幂等。请求包含：
  `{ label, baseUrl, apiKey, modelName, inputCentsPerMillion, outputCentsPerMillion, capabilities?, dailyCapCents, confirmBudget: true, clientKey }`
  在**同一事务**内完成：建供应商、写入加密密钥、建模型、`ai_settings` 设为自动模式并以新模型为默认、清空用途映射（全部跟随默认）、确认日额度。返回每个用途是否可用及原因。
- **连通性测试**：`POST /api/opening/model-providers/{id}/models/{modelId}/probe`，经调度器发一次极小的 JSON 请求，计入预算（purpose `probe`），结果只说「本次请求成功/失败（原因）」，不声称质量或能力已验证。
- 供应商预设只给 baseUrl 和示例模型名，**价格由用户填写**，不内置报价（与现有文档「不代表实时报价」一致）。
- **Google Gemini 免费额度（已定）**：预设 baseUrl `https://generativelanguage.googleapis.com/v1beta/openai/`（OpenAI 兼容，支持 JSON 输出、图片和音频输入）。免费额度按 token 计价是 0，而现在「价格必须为正数」会让它显示 `pricing_missing`。因此模型增加 `billing: "metered" | "free_tier"`：
  - `free_tier` 允许价格为 0，改用**每日请求数上限**（用户填写，默认 200）约束。预算账本照常记录每次预留，金额为 0；日额度为 0 时不会把免费模型判成 `budget_disabled`。
  - 选择 `free_tier` 时页面明确提示：**Google 免费额度的输入和输出可能被用于改进其产品，并可能经人工审阅**，不要用于隐私材料。工作区里标记为隐私排除的材料本来就不会发送（`listExcludedSourceIds`），这一点保持不变。
  - 部署前确认 Hermes 能访问 `generativelanguage.googleapis.com`；访问不了时只能在本地或其他服务器使用。
  - `billing` 与 `capabilities` 放进同一个 0062 迁移（`billing text NOT NULL DEFAULT 'metered'`，`daily_request_cap integer NULL`，`input/output_cents_per_million` 的 CHECK 放宽为 `metered` 时 >0、`free_tier` 时 ≥0）。
- 现有约束不放宽：确认日额度、价格必须为正数、HTTPS、密钥只写入不回读、工作区最多 8 个供应商 / 16 个自定义模型。

### 5. 转写和 OCR 纳入同一页面

- `media.transcribe` 的引擎分两种：本地 faster-whisper（默认，由服务器环境变量配置，页面只读显示可用性）和供应商模型（带 `audio_transcription` 能力的 OpenAI 兼容 `/audio/transcriptions`）。
- 远程转写（已定可用 Gemini）：带 `audio_transcription` 能力的模型通过 chat completions 的 `input_audio` 内容块发送音频，要求返回带时间段的 JSON 转写，复用 `parse-media` 现有的分段存储和「用户已修正的分段不覆盖」规则。按上面的 `free_tier` 规则计数；音频按 20 MB / 段切分；仍沿用隐私排除和隐私 epoch 检查。用户在供应商页选择引擎：本地 faster-whisper（默认）或某个具备该能力的供应商模型。
- PDF OCR 目前关闭，只在页面显示「未启用」，不在本计划里打开。

### 6. 证据闭环（E 系列）

- **E1 主讲内作答**：`question` 块改成内联作答，复用 learning-sessions / attempts / observations 接口（session 已经带 `activity_id`）。提交后展示 `answer_key`，接上现有核对步骤（`learning/reference-check.ts`），核对后记为 `verdictSource=reference_checked`。
- **E2 AI 判分建议（延后，10-15 决定）**：通过 `grading.suggest` 用途调用模型，输出 `{ verdict, rubricHits[], confidence, rationale }`，写成独立的 observation revision，`verdictSource=model_suggestion`。按现有资格规则，**这条记录不能单独让 `verifiedCorrect=yes`**；页面显示「AI 认为…（建议）」，用户可以采纳为核对结果，或者不采纳。判分快照和模型快照都入库，便于以后回放。
- **E3 活动收尾**：状态接口开放 `completed`（数据库约束本来就允许）。学完后显示小结（用 `teaching-coverage` 汇总讲了什么、做了几题、还有哪些没解决），并询问「把『X』标记为完成？」，复用 `TaskStatusControl` 的 `expectedVersion`。`taskId` 放在 `create_intent`。提示框由 PR #43 L5 负责；本计划只提供接口和小结数据。
- **E4 卡片进入账本**：迁移 `0062` 同时给 `cards` 加可空的 `course_id`、`skill_label`。有课程的卡片每次评分写一条 observation：`again → incorrect`、其他评分 → `correct`，`verdictSource=self_report`，维度 `recall`，clientKey 为 `card-review:<eventId>` 保证幂等。没有课程的卡片只保留 SRS，不写账本，因为 observation 的 `course_id NOT NULL`。从错题生成卡片（`cards.suggest`）时自动带上课程和技能。
- **E5 评价器接口（BKT 预留）**：`packages/domain/src/opening/estimators/` 定义 `SkillStateEstimator { version, estimate(evidence[]) → { state, reasons[] } }`。现在的 `learning-summary` 包装成 `rules-1`。BKT 以后作为 `bkt-1` 以**影子方式**运行：只记录结果，不影响页面，等校准指标达标后再切换（ALGORITHM_MAP「复习调度」「能力评价」两行的门槛）。为此保证每条证据带有 BKT 需要的字段：知识点 id（`requirementKey`/节点）、题目 id（`item_version_id`）、是否首次作答、`assistance`、`verdictSource`、时间戳。**不输出掌握百分比**，与 V2 章程一致。

## 切片

| # | 切片 | 负责 | 依赖 | 迁移 |
|---|---|---|---|---|
| M1 | 用途注册表 + 调度器 + 搬迁 `runBudgetedCall`；辅导和临时对话改走调度器，行为不变 | Claude | — | 无 |
| M2 | 知识抽取改用 `knowledge.extract` 并进入预算；主讲编译接真实模型（`teaching.compile`，沿用 `OPENING_TEACHING_COMPILER_ENABLED`） | Claude | M1 | 无 |
| M3 | `taskRoutes` + 能力字段 + 设置页按分组显示用途映射 | Claude（契约、迁移）→ Grok（设置页） | M1 | 0062（能力） |
| M4 | 一键配置接口 + 连通性测试 + 设置页一键表单 | Claude（接口）→ Grok（表单） | M3 | 无 |
| M5 | 转写纳入供应商页：本地 faster-whisper 或 Gemini 音频转写 | Claude（worker 适配）→ Grok（选择界面） | M3 | 无 |
| M6 | lint 防绕过规则 + 更新 `docs/operations/opening-model-routing.md` | Claude | M2 | 无 |
| E1 | 主讲内作答 + 对照答案核对 | Grok | PR #43 L5 先合并（`teaching/*` 归 L5） | 无 |
| E2 | AI 判分建议（**延后**） | — | M1、E1 | 无 |
| E3 | 活动 `completed` + 学完小结数据 | Claude | — | 无 |
| E4 | 卡片进入账本 + 错题生成卡片 | Claude | M1（`cards.suggest`） | 0062（cards 两列） |
| E5 | 评价器接口；`rules-1` 包装；BKT 字段完整性测试 | Claude | E1、E4 | 无 |

**0062 放什么：** 模型表的 `capabilities`、`billing`、`daily_request_cap` 和放宽后的价格 CHECK，以及 cards 的 `course_id`、`skill_label`，都是新增列或带默认值的列，放在同一个迁移里。必须排在 PR #43 的 0061 之后，所以 **PR #43 合并后再开 0062 的分支**。回滚：先把 `billing='free_tier'` 的模型删除或改成正价格，再 `ALTER TABLE opening_model_provider_models DROP COLUMN capabilities, DROP COLUMN billing, DROP COLUMN daily_request_cap;` 并恢复原 CHECK（`> 0`）；`ALTER TABLE cards DROP COLUMN course_id, DROP COLUMN skill_label;`。

**顺序（10-15 调整：先闭环能力和质量）：**
1. **M1 → M2**：统一调度器，知识抽取进入预算，主讲编译接真实模型。主讲有了真实内容，其他环节的质量才测得出来，这也是 V2-16 试跑的前提。与 PR #43 剩下的 L2/L3 并行，文件不重叠。
2. **E3**：活动能结束，学完询问是否标记任务完成。
3. **E1**：主讲内作答 + 对照答案核对（等 PR #43 L5 合并）。
4. **M3 → M4**：用途映射、备用模型、免费额度计费、一键配置。Gemini 免费额度从这里开始可用。
5. **E4 → E5**：卡片进入账本，评价器接口。
6. **M5**：转写引擎选择。
7. E2（AI 判分）和 PR #43 的 L7（规划 Agent，使用 `planning.agent` 用途）延后。

**文件所有权：** `packages/contracts`、`packages/ai/src/opening/gateway.ts`、迁移由 Claude 写；`teaching/*` 在 PR #43 L5 合并前归 Grok L5；设置页面板（`apps/web/src/features/settings/*panel.tsx`）在 M3/M4 交给 Grok。

## 任务卡（交给 Grok 的部分）

### M3-UI 用途映射面板

```text
目标：/settings「AI 模型与供应商」按分组（辅导 / 主讲 / 材料 / 练习 / 规划）列出 MODEL_TASKS，
每项可选「跟随默认」或指定模型；显示最终生效模型与不可用原因（缺能力 / 缺密钥 / 预算）。
范围：apps/web/src/features/settings/ai-settings-panel.tsx、ai-settings-model.ts（+ .test.ts）
约束：
- 用途列表来自 GET 响应中的 tasks 字段，不在前端写死。
- 旧 4 个辅导模式的选择保持原值，切换手动/自动不丢映射（沿用现有测试）。
- 缺能力的模型在下拉框中置灰并注明原因，不得隐藏。
- 只用 Tailwind + lucide-react；保留 aria 状态。
```

| 指标 | 检查 |
|---|---|
| 生效规则 | `ai-settings-model.test.ts`：用途映射 > 分组默认 > 工作区默认 > 服务器默认，四层各一例 |
| 能力置灰 | 单测：没有 `vision` 的模型在 `tutor.vision` 下拉中 `disabled`，并带原因文案 |
| 旧映射不丢 | 现有手动/自动往返测试不修改且通过 |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 浏览器 | 待用户浏览器验收 |

### M4-UI 一键配置表单

```text
目标：设置页顶部「一键配置模型」：地址、密钥、模型名、输入/输出价格、日额度 + 确认勾选，一次提交；
成功后显示各用途可用性，并提供「测试连接」。
范围：apps/web/src/features/settings/provider-settings-panel.tsx、provider-settings-model.ts（+ .test.ts）
约束：
- 未勾选确认日额度时不提交；价格必须为正数；地址非 HTTPS（非 loopback）时提示并拒绝。
- 提交使用同一个 clientKey，失败重试不产生第二个供应商。
- 密钥输入框提交后清空，不写 localStorage。
- 「测试连接」结果文案只说本次请求成功/失败与原因，不说「模型可用于教学」等质量结论。
```

| 指标 | 检查 |
|---|---|
| 校验 | 单测：未确认额度、价格 ≤ 0、http 远程地址都不调用接口 |
| 幂等 | 单测：重试两次 clientKey 相同 |
| 密钥 | 单测：成功后表单状态中不再保留 apiKey |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 浏览器 | 待用户浏览器验收 |

### E1 主讲内作答

```text
目标：工作区「试一试」块可以直接作答；提交后显示参考答案，引导对照核对；结果进入证据账本并触发复测候选。
范围：apps/web/src/features/opening/teaching/block-renderer.tsx、新增 teaching/inline-attempt.tsx（+ .test.ts）
约束：
- 复用 learning-sessions / attempts / observations 现有接口与 LearningAttemptForm 的身份/版本捕获逻辑，不复制判分。
- 提交前不展示 answer_key；没有 answer_key 时只记录「尚未核对」。
- 核对复用 reference-check 步骤，verdictSource=reference_checked；跳过核对不得记为 incorrect。
- 不在本地判分；不得出现「你已掌握」类文案。
```

| 指标 | 检查 |
|---|---|
| 不提前泄露答案 | 单测：提交前渲染结果不含 answer_key 文本 |
| 证据写入 | 集成：`tests/integration/opening-*attempt*` 新增用例，活动内作答产生 observation，其 `activity_id` 等于当前活动 |
| 复测触发 | 集成：incorrect 的核对结果入队 `retest` job |
| 类型检查 | `npm run typecheck -w @aistudy/web` 退出码 0 |
| 浏览器 | 待用户浏览器验收 |

## 验证（Claude 负责的切片）

- **M1**：现有 `tutor-turn`、`ephemeral-service`、`budgeted-call`、`model-routing` 测试**不改期望**且通过；新增 gateway 单测，覆盖用途 → 模型 → 快照 → 预留的同一份选择，以及缺能力时明确失败并且不调用 provider。
- **M2**：`build-course-knowledge` 集成测试断言产生 `purpose=build-course-knowledge` 的预留并带模型快照；日额度为 0 时抽取明确失败而不是静默调用。编译器开关开启时调用 `teaching.compile` 路由的模型；关闭时与现在一致。
- **M4**：handler 测试覆盖一键配置事务（任一步失败时全部回滚）、clientKey 幂等，以及响应和日志都不含密钥。
- **E2/E4/E5**：资格规则测试证明 `model_suggestion` 和卡片的 `self_report` 都不能产生 `observed_independent`；卡片评分重放不重复写 observation。
- 类型检查：`npm run typecheck -w @aistudy/{contracts,ai,domain,database,web,worker}`；单测用 `--project unit` 指定相关文件。

证据分层不合并：工程通过 ≠ 真实模型通过 ≠ 用户浏览器验收 ≠ 学习效果已知。

## 待你决定

1. ~~备用模型~~：已定支持，见 §3。
2. ~~远程转写~~：已定可用 Gemini，见 §5。
3. **AI 判分的采纳方式**（E2 延后，届时再定）：用户点「采纳」后是否等同于 `reference_checked`？建议**不等同**，另记为 `model_suggestion_accepted`，让以后的 BKT 能区分这两种来源。代价是 `verdict_source` 的 CHECK 约束要在 0062 里多加一个值；等同的话不用改约束。

## 回滚

- M 系列：调度器只是搬迁和统一入口，回滚就是还原代码；`taskRoutes` 是可选 jsonb 字段，旧版本会忽略。编译器真实模型沿用 `OPENING_TEACHING_COMPILER_ENABLED`。
- E 系列：判分、卡片入账各自加开关（`OPENING_GRADING_SUGGEST`、`OPENING_CARD_EVIDENCE`，默认关闭）；关闭后不再写入，已写的 observation 保留（账本只追加）。
- 0062：只新增列，关闭开关后不必回滚迁移；需要回滚时用上面的 DROP COLUMN 语句。
