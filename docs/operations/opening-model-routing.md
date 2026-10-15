# Opening 模型目录与路由

设置入口：`/settings` → **AI 模型与供应商**。同一份模型目录与调度器服务于持久辅导、临时对话、知识图谱抽取、主讲编译和模型转写；每个用途可以有用户明确指定的主模型与备用模型。供应商、模型、密钥和路由可由工作区所有者在设置页配置，也可由部署者提供服务器目录。

除服务器目录外，工作区所有者还可以在 **自定义供应商与密钥** 面板中自行添加供应商（OpenAI 兼容 baseUrl）、模型与 API 密钥（详见下文“工作区自定义供应商”）；两类目录合并后供模型路由选择，服务器目录优先。

## 服务器配置

不设置 `OPENING_MODEL_CATALOG` 时，原 `OPENING_MODEL_*` 配置继续作为 id 为 `default` 的单一模型。原日预算开关和正价格要求保留。设置目录后，下面的原配置仍负责全工作区共享日上限：

```dotenv
OPENING_MODEL_DAILY_CAP_CENTS=1000
```

示例目录可以放在部署环境变量中，`.env` 使用单行 JSON。以下名称、地址和价格都是演示值，**不是可直接请求的模型或实时供应商报价**：

```dotenv
OPENING_MODEL_CATALOG=[{"id":"daily","label":"日常模型","providerId":"primary","providerLabel":"主供应商","modelName":"your-text-model","baseUrl":"https://your-provider.example/v1","apiKeyEnv":"PRIMARY_MODEL_API_KEY","inputCentsPerMillion":10,"outputCentsPerMillion":20},{"id":"reasoning","label":"推理模型","providerId":"secondary","providerLabel":"备用目录供应商","modelName":"your-reasoning-model","baseUrl":"https://another-provider.example/v1","apiKeyEnv":"SECONDARY_MODEL_API_KEY","inputCentsPerMillion":50,"outputCentsPerMillion":100}]
OPENING_MODEL_DEFAULT_ID=daily
PRIMARY_MODEL_API_KEY=
SECONDARY_MODEL_API_KEY=
```

- 使用 OpenAI-compatible `/chat/completions`。文本、图片和音频能力由模型声明，结构化任务要求 JSON 输出；声明不代表已完成供应商协议或质量验证。模型目录最多 32 项。
- `apiKeyEnv` 指向服务器环境中的密钥变量；通过部署环境/密钥管理工具提供值。目录不接受内联 `apiKey`，网页/API 不返回密钥、密钥变量名或供应商地址。不要把密钥放到浏览器、本地存储或提交中。
- 模型 `id`、供应商 `providerId` 保持稳定；新增或更换供应商/型号时使用新的模型 id。相同供应商 id 的展示名称必须一致。`OPENING_MODEL_DEFAULT_ID` 必须存在；省略时使用目录第一项。目录 `[]` 表示不部署模型。
- 目录地址来自受信任的部署配置；客户端不能新增地址。使用 HTTPS；本地测试允许 loopback HTTP。地址不得包含用户名、密码、查询参数或片段。
- 输入/输出价格都是**同一记账币种的分 / 百万 token**，日上限也使用这一币种的分。跨供应商原币种不同时，部署者必须先统一换算价格；系统不自动换汇，也不声称本地估价等于供应商账单。
- `supportsVision`、`supportsAudio` 默认均为 `false`，只有确实支持时才设为 `true`。`billing` 默认 `metered`，要求正数输入/输出价格和有效的付费日额度。`billing:"free_tier"` 允许价格为零，但必须提供 `dailyRequestCap`（整数 1–100000）；它不要求付费日额度为正。两种计费都必须有可用密钥。
- 将相同目录、密钥和日上限配置到 web 与 worker，重启两者。目录变化需要重启；工作区路由偏好保存后无需重启；工作区自定义供应商保存后立即生效，同样无需重启。

## 统一模型调度（M1）

所有模型调用都经过同一个调度器：`packages/ai/src/opening/model-tasks.ts` 的用途注册表 `MODEL_TASKS` 列出每种用途；`apps/worker/src/runtime/model-gateway.ts` 是唯一把配置变成 provider 的地方（服务器目录 + 工作区自定义模型 + 有效日额度 + 工作区路由），web 与 worker 共用。ESLint 禁止在其他地方直接引用 `createOpeningProvider`。新增 AI 功能时在 `MODEL_TASKS` 加一项，调用 `createDbModelGateway(sql).call(...)` 或 `.budgetedProvider(...)`，预算预留、模型快照和 `purpose` 自动记录。

当前用途：

| 用途 | 选型 | 预算 purpose |
|---|---|---|
| `tutor.listen / hint / explain / think_together` | 手动锁 → 用途主模型 → 该辅导模式映射 → 工作区默认 → 服务器默认 | `tutor` |
| `knowledge.extract`（课程知识图谱抽取） | 手动锁 → 用途主模型 → 工作区默认 → 服务器默认 | `build-course-knowledge` |
| `teaching.compile`（AI 主讲内容编译） | 同上；另需 `OPENING_TEACHING_COMPILER_ENABLED=1` | `compile-teaching-unit` |
| `media.transcribe`（音视频转写） | 同上；必须支持音频输入，且工作区选择模型转写 | `transcribe` |
| `settings.probe`（连通性测试） | 明确指定待测的自定义模型；不使用备用模型，不列入用途路由表单 | `probe` |

**行为变化：** 知识图谱抽取以前借用「解释」模式的模型且不经过预算账本；现在走自己的用途，每次抽取都有预算预留和模型快照。付费抽取受有效日额度约束，免费抽取受该模型的每日请求数约束。同一个抽取任务的重试复用一笔预留（`build-course-knowledge:<jobId>`），已结算后重放不会再次请求或计费。

## 工作区日额度 schema 上限

`openingAiSettingsSchema.dailyCapCents` 的 Zod 上限与 `OPENING_MODEL_DAILY_CAP_CENTS` 一致（`OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS` = 2_147_483_647），**不再**硬编码 2000。否则当工作区把 `dailyCapCents` 写成与大额 env 上限相同的值（例如 1_000_000）时，整段 `ai_settings` 会 `safeParse` 失败 → `invalidStoredSettings` → 回退默认设置并落到缺密钥的 legacy `gpt-4o-mini`。

写入时仍由 `validateBudgetFields` 约束：env > 0 时不得超过 env 上限；env = 0 时不得超过个人天花板 2000 分。`dailyCapCents: null` 表示跟随 env。

## 合并默认模型（env stub vs 工作区可用模型）

一般用途的路由顺序是：手动锁 → `taskRoutes[用途].primary` → 辅导模式映射（仅 tutor 用途）→ 工作区 `defaultModelId` → **合并后的服务器默认**。手动锁优先于用途主模型；每个用途的显式备用模型仍单独生效。

合并后的 `defaultModelId` 规则（`mergeOpeningCatalog` / `resolveMergedDefaultModelId`）：

1. 若 env/`OPENING_MODEL_DEFAULT_ID` 指向的模型 **availability=available**，继续用它。
2. 否则若存在 **source=workspace 且 available** 的自定义模型（例如已配置密钥与定价的 Lant/`glm-5.3`），优先选第一个可用工作区模型，而不是继续指向缺密钥的 legacy stub（常见为 id `default` / `gpt-4o-mini` → `missing_key`）。
3. 若没有可用工作区模型，仍保留请求的服务器默认 id；选型时按既有规则显式失败，不静默换供应商。

Tutor worker 与设置页 / readiness 一样，用 **有效日额度**（env 与工作区确认额度）计算付费模型的 availability；免费额度模型改由请求数上限约束。视觉能力影响图片材料，模型转写则必须明确支持音频输入。

## Hermes 运维清单（Lant + glm-5.3，勿由 agent 自行 redeploy）

在 hermes `/opt/aistudy/.env.production`（web + worker 相同）由 PM 设置并重启。密钥只进密钥库/该文件，**永不进 git**：

| 键 | 作用 |
|---|---|
| `OPENING_MODEL_CATALOG` | JSON 数组；推荐一项 `id=lant-glm-5-3`，`providerId=lant`，`providerLabel=Lant`，`modelName=glm-5.3`，`baseUrl`=OpenAI 兼容根路径，`apiKeyEnv=LANT_API_KEY`，正数 `inputCentsPerMillion` / `outputCentsPerMillion`，Tutor 看图时设 `supportsVision:true` |
| `OPENING_MODEL_DEFAULT_ID` | `lant-glm-5-3`（须存在于目录） |
| `LANT_API_KEY` | 由 `apiKeyEnv` 引用的真实密钥（勿写入目录 JSON） |
| `OPENING_MODEL_DAILY_CAP_CENTS` | 付费模型日额度（分）；为 0 时不开放付费调用，已配置免费模型仍受请求数上限约束 |
| 可选 legacy `OPENING_MODEL_*` | 未设 `OPENING_MODEL_CATALOG` 时退化为 id `default`；若密钥为空会 `missing_key`。有工作区 BYOK 可用时合并默认会偏向工作区模型 |

也可不改服务器目录，仅在网页「自定义供应商与密钥」配置 Lant/`glm-5.3` 并开启确认工作区日额度；合并默认会优先该可用工作区模型。部署流程见 `docs/operations/hermes-deployment.md`（本任务不执行 redeploy）。

## 工作区自定义供应商（BYOK）

工作区所有者可在 `/settings` 的「自定义供应商与密钥」面板中自行维护供应商、模型与密钥，无需修改服务器环境变量或重启服务：

- **能力与限制**：每个工作区最多 8 个供应商、共 16 个自定义模型；合并后（服务器目录 + 自定义）仍受 32 个模型总量上限约束，服务器目录优先。模型 id 为稳定 UUID。
- **密钥处理**：密钥用 `OPENING_CONNECTION_KEY`（AES-256-GCM，域分离为 `opening-model-provider`）加密后存库，仅写入不回读——API 只返回 `hasApiKey`、尾 4 位提示与更新时间；浏览器、本地存储和日志均不落密钥明文。轮换 `OPENING_CONNECTION_KEY` 时通过 `OPENING_CONNECTION_PREVIOUS_KEYS` 仍可解密旧密文。
- **地址要求**：远程接口必须 HTTPS（本地开发允许 loopback HTTP），不得包含用户信息、查询参数或片段。地址由工作区所有者自行填写；自托管部署应自行评估该用户对 endpoint 的控制权，可选通过部署环境限制出站网络。
- **可用性语义**：缺密钥为 `missing_key`、加密不可用为 `vault_disabled`；付费模型缺正价格或有效日额度时不可用。免费额度模型允许零价格，必须有每日请求上限。所有用途共享同一工作区账本；付费调用累计费用，免费调用累计该模型的请求数。
- **API**：`GET/POST /api/opening/model-providers`、`PUT/DELETE /api/opening/model-providers/{id}`、`POST /api/opening/model-providers/{id}/models`、`PUT/DELETE /api/opening/model-providers/{id}/models/{modelId}`，仅工作区所有者可访问。
- **数据**：`0043_opening_model_providers.sql` 新增 `opening_model_providers`、`opening_model_provider_models`、`opening_model_provider_credentials` 三表（随工作区级联删除）。原生备份目前不包含这三张表；迁移服务器前请另行记录供应商配置并重新录入密钥。

## 用户设置

1. 登录后进入 `/settings`，等待模型目录读取完成。先确认需要的模型显示“已配置”。
2. 可按供应商筛选模型。筛选只缩小选项，不替换已选模型。
3. **手动选择**：选择一个明确模型并保存。所有辅导模式使用它；不跟随之后变化的服务器默认模型。手动锁定单独保存在 `manualModelId`，不会改写自动模式的默认模型或四项映射。
4. **按辅导模式自动选择**：设置默认模型，再按需为倾听、提示、解释、共同思考分别指定模型。未指定的模式使用工作区默认模型；工作区默认未指定时跟随服务器默认模型。界面显示最终生效规则。切到手动、保存后再切回自动，原来跟随服务器默认的空值、明确指定的自动默认及四项映射都保持原值。
5. 保存后，新请求在实际选型时读取偏好；排队但尚未选型的请求也读取新设置。已选型或已发送请求继续使用原模型、价格与费用记录，不中途换模型。
6. 在助理中分别发送一条持久对话与临时对话，确认响应。自动模式分别切换辅导模式验证映射。实际供应商效果和浏览器交互由用户验收。

自动模式执行用户可见的确定性映射，不推断问题难度、回答质量或置信度。只有用户为该用途明确指定了备用模型，且主模型请求确定未发出时，才会尝试该备用模型一次；详见下节。恢复默认不会保证服务器默认模型可用，仍须检查状态。损坏的已存偏好会阻止请求，设置页允许重新保存或恢复。

## 数据与费用

`0036_opening_ai_settings.sql` 为 `workspace_preferences` 新增可空 `ai_settings`，为 `opening_budget_reservations` 新增可空 `model_snapshot`。`ai_settings` 保存 `manualModelId`、自动模式的 `defaultModelId`、四项 `routes`、可选用途级 `taskRoutes` 和 `transcription`。本功能早期缺少 `manualModelId` 的手动偏好在读取时由旧 `defaultModelId` 正规化；显式为空或损坏的手动选择仍阻止调用，不自动补成可用。按既有迁移流程先执行 `npm run db:migrate`，再运行新应用；测试迁移只使用隔离数据库。

每次请求解析一次模型，把其目录 id、供应商 id、真实 model name 和输入/输出价格随费用预留保存；provider 调用与结算使用同一份选择。快照不含密钥、供应商地址、提示词或回答正文。同一 requestId 不允许换模型/价格后复用。工作区日预算继续汇总所有模型的已用费用和未知结果预留，切换模型或供应商不会清零；未知结果不自动释放费用或发起重试。

## 备份范围

设置页的“原生备份”（`/api/backups/export`，`aistudy-native` 格式）目前不包含 `workspace_preferences`，因此不备份这里的模型选择与路由。迁移服务器前请另行记录手动模型、自动默认模型和四项映射，并同步部署服务器模型目录；不要把密钥写入这份选择记录。

Opening 档案另一路径会从该工作区的 `ai_settings` 导出经过既有 schema 校验的模型 ID 和路由设置，拒绝密钥、地址等额外字段。数据库快照到 Opening 档案写入/读取的往返测试只验证归档内容保留，不代表网页原生备份已经覆盖这些设置，也不代表完整恢复或数据库恢复执行已经完成。恢复后的模型仍须在目标服务器目录中存在并具备可用配置；服务器密钥不会随档案迁移。
## 回退

应用回退时保留追加列及已保存费用记录；不要删除已记录的 `model_snapshot` 或预算预留。旧版应用对新增 JSON 设置、免费模型和卡片来源隐私的支持需要单独检查。若要停止全部外部调用，需要同时停用免费模型/相关任务；仅把付费日额度设为零不会关闭免费调用。迁移 0062/0063/0064 的回退条件见下文。

仅撤销某工作区的选择时，使用设置页“恢复服务器默认设置”；它清空该工作区的 `ai_settings`，不修改其他偏好或任何费用记录。移除数据库列不是应用回退的必要步骤；若未来确需收缩 schema，应另做备份和数据保留审查。

## 验收与尚未覆盖

可在非浏览器测试中验证 schema、鉴权范围、映射、价格归属、预算幂等与跨模型累计。设置页操作、响应式显示、真实供应商连通性及回答质量仍需用户验证。供应商价格/币种政策、协议与留存承诺、质量和成本自动路由策略继续由现有专家研究任务维护；此实现不据此作已验证声明。

## 显式备用模型与未知结果

在「按用途指定模型与备用模型」里设置 `primary` / `fallback`；主、备均清空时删除该用途键，整个映射为空时省略 `taskRoutes`。未知用途、目录中不存在的模型、不可用或不支持用途输入的备用模型会被服务端拒绝。

`withModelFallback` 仅在确定未发出的失败使用用户指定的备用模型：选型不可用、额度或请求次数不足、明确的认证/限流/媒体拒绝、已释放的预留重放。没有显式备用模型就保留原失败。超时、网络中断、未知执行结果和已占用的执行权都不会触发备用调用；也不会在多供应商间循环尝试。

主请求沿用原 operationId，备用请求使用 `<operationId>:fallback`，各自保留实际模型和费用快照。未知结果保留诚实的未知状态及费用预留，不能当作零费用失败。主讲与转写等新模型任务都必须通过注册表和调度器，不直接构造 provider。

## 一键配置与连通性测试

在 `/settings` 顶部「一键配置模型」填写供应商名称、地址、密钥、模型名与能力。按量计费填写实际正价格，并确认正整数日额度；免费额度填写每日请求上限。提交会在同一事务内创建供应商、加密密钥、模型和工作区设置：设为自动模式、使用新模型作默认、清空旧的模式/用途映射。某一步失败不会留下半套配置。

`POST /api/opening/model-providers/quick-setup` 的 `clientKey` 标识同一次提交。结果明确失败时可修正表单再提交；结果未知（网络中断、无法解析成功响应或可能已提交的服务错误）时，保留原始 payload 和同一 `clientKey`，锁定表单，只允许「确认上次配置结果」。此时不能用新草稿覆盖未决请求，也不自动重试。确认成功后释放快照并清空密钥输入；幂等重放不重复创建供应商，也不重新覆盖后来保存的设置。未决快照只在当前组件内存中保留，不写入浏览器存储；刷新会丢失该临时快照，刷新本身不确认上次结果，恢复操作前应先检查现有供应商与设置。

密钥只写入加密存储，不从 API 回读，不写日志、浏览器存储或 Git。表单仅在明确结束本次提交后恢复编辑；不要把未知结果直接当作未保存而重新创建第二套配置。

Google Gemini 免费额度预设只预填 `https://generativelanguage.googleapis.com/v1beta/openai`、示例型号 `gemini-2.5-flash`、视觉/音频声明和请求上限 200；200 是表单起点，不代表 Google 对该账户的实际配额。预设不内置付费价格，型号和协议能力仍需用户确认。其他 OpenAI 兼容预设只提供地址，模型与实际价格由用户填写。

自定义模型的 `POST /api/opening/model-providers/{id}/models/{modelId}/probe` 经同一调度器和预算账本发出极小 JSON 请求。探测明确使用该模型，不跟随辅导路由或备用模型；一次探测计入相应费用或免费请求数。结果仅说明本次请求成功或失败，不证明回答质量、音频能力或所有供应商功能可用。

## 免费额度与 Hermes 网络

免费额度（如 Google Gemini API 免费额度）的输入和输出可能被供应商用于改进其产品，并可能经人工审阅；不要用于隐私材料。界面使用 `FREE_TIER_NOTICE` 明示这一点。材料隐私排除和隐私 epoch 检查继续生效；选择免费模型不扩大材料授权范围。

`billing:"free_tier"` 的账本金额为零，仍有预留、执行权、快照、幂等与未知结果记录。`dailyRequestCap` 是每工作区、每模型、按工作区规划时区计算的每日请求上限；跨用途累计，未释放的请求和已完成请求都计数。同一 operationId 的幂等重放不再占一次；到达上限后只可能使用该用途明确指定的可用备用模型。模型转写每个音频片段算一次调用。

部署前由运维确认 Hermes 的 web 与 worker 能通过正常 TLS 验证访问 `generativelanguage.googleapis.com:443`；使用其他供应商时也确认其实际 API 域名。网络放行和真实密钥验证属于部署/用户验收，本轮本地测试不建立 Hermes 或 Google 实际连通的结论。

## 本地或模型转写

工作区设置 `transcription.engine` 默认 `local`，沿用本地 Python/Whisper 配置；选择 `model` 时，使用 `media.transcribe` 的主模型及显式备用模型，必须有支持音频输入的可用选择。设置页提示问题并禁止保存，服务端也校验；能力未声明不能靠模型名称推断。

模型适配器使用 FFmpeg 转为 16 kHz、16-bit 单声道 WAV，按 10 分钟分片并检查每片不超过 20 MiB；因此两种引擎都仍需要本地媒体处理工具。每片通过调度器发 `audioParts` 和 JSON 输出要求，operationId 为 `transcribe:<jobId>:<片段序号>`。返回段落必须有有效、单调不重叠的时间和非空文本，再累加片段偏移；无效 JSON 或越界段落失败，不填造转写内容。

转写每次外发前检查隐私状态，写回前再次检查版本与隐私 epoch。已由用户修正的分段保留，不被模型结果覆盖。模型转写不等于本地处理，音频会发送到所选供应商。

## 评价器与证据边界

`packages/domain/src/opening/estimators/` 定义 `SkillStateEstimator`；当前 `rules-1` 直接包装既有 `summarizeObservations`，显式接收资格上下文、评估时间与到期复测事实。每次只评估同一工作区、课程、要求和技能的一组证据；页面展示未切换，未实现 BKT，不输出掌握百分比。

证据保留 observation/course/skill/requirement/item-version 标识、结果、帮助程度、判定来源、原时间与完整资格输入。`firstAttempt` 当前在没有可靠历史来源时为 `null`，不能把读取列表第一项或一次修订伪装成首次作答。`self_report`、`model_suggestion` 不会单独产生「独立正确」；缺参考核对、帮助历史、来源版本或隐私资格也不会被标量标签覆盖。

## 卡片复习、来源隐私与备份范围

关联课程的卡片复习在同一事务内更新 SRS、写复习事件并写一条学习观察；`again` 记为 incorrect，`hard/good/easy` 记为 correct，来源始终为 `self_report`。相同事件重放不会重复写观察。未关联课程的卡片仅保留 SRS。所有者与课程工作区必须匹配，归档课程不能新增关联卡片或接收新评分证据。

错题草稿只预填当前有效错误记录的题干与参考内容，由用户编辑并确认创建。请求只提交 `observationId` 等业务字段，不接受客户端指定来源身份；服务端从完整观察修订链、来源版本键、参考材料及关联笔记中捕获来源 ID，保存到 `cards.source_ids`。超过 32 份材料时明确拒绝，不截断来源；这里保留的是来源身份，不伪造卡片文本的历史版本资格。旧的关联笔记卡片在复习时也继承其笔记来源。

读取、列表、复习队列、评分、导出共用来源准入规则：来源缺失、位于其他工作区、已排除或删除时，不继续暴露派生卡片正文。复习观察继承完整来源 ID，后续排除材料时该观察也不能作为无来源文本进入历史或备份。评分先取得工作区学习历史锁，再锁卡片与后续事实，与材料排除采用同一顺序。

Opening 档案导出 `source_document_id IS NULL` 且来源可用的卡片，保留课程、技能、`source_ids`、SRS 状态及复习事件；卡片可由观察派生，也可能是手工独立卡，不能仅凭没有笔记关联就省略其材料来源。关联笔记卡片仍走 native 档案，连同笔记和其来源凭据一起保留。两种导出都会过滤受排除材料派生的卡片与对应复习事件。

Opening 恢复先恢复材料再恢复卡片，检查归档内来源关系并在事务内按当前删除/排除事实再次准入。Native 恢复校验卡片关联课程、笔记均属于目标工作区；有 Opening 材料来源的卡片需要原工作区和仍可用的材料，native 档案本身不恢复 Opening 材料。新档案必须显式保存 `sourceIds`；历史 pre-0064 手工卡片可没有该字段，但不能借导入剥离目标中已有卡片的来源。旧档案加当前删除事实不能复活已排除的派生正文。

## 0062 / 0063 / 0064 迁移与回退

`0062_opening_model_routing_and_card_evidence.sql` 增加模型音频/计费/请求上限、允许零金额预算记录，并给卡片增加课程/技能字段。`0063_opening_model_quick_setup.sql` 增加 `quick_setup_key` 与工作区内唯一索引，保护一键配置幂等。`0064_card_source_lineage.sql` 增加 `cards.source_ids uuid[] NOT NULL DEFAULT '{}'`，保存派生卡片来源身份。先迁移再运行新应用。

优先回退应用并保留追加 schema 和真实费用/证据。旧版本若不能读取新增 `taskRoutes` / `transcription` 设置或免费模型，需要先备份并单独迁移兼容设置；保留密钥加密材料与预算记录。不要按 0062 的历史回滚注释删除免费模型或把零费用改成 1，这会丢配置或改变账本事实。

0063 在应用已经回退、不再执行一键配置后，可移除幂等标识（不删除供应商、模型或费用记录）：

```sql
BEGIN;
DROP INDEX opening_model_providers_quick_setup_key_idx;
ALTER TABLE opening_model_providers DROP COLUMN quick_setup_key;
COMMIT;
```

0062 仅在备份完成且没有需要保留的新字段数据、没有免费模型或零金额历史记录时才适合收缩 schema。否则保留该迁移，另行制定不改变历史事实的数据迁移。满足这些前提时，逆向结构变更是：

```sql
BEGIN;
ALTER TABLE opening_model_provider_models
  DROP CONSTRAINT opening_model_provider_models_pricing_check,
  ADD CONSTRAINT opening_model_provider_models_input_cents_per_million_check CHECK (input_cents_per_million > 0),
  ADD CONSTRAINT opening_model_provider_models_output_cents_per_million_check CHECK (output_cents_per_million > 0),
  DROP COLUMN daily_request_cap, DROP COLUMN billing, DROP COLUMN supports_audio;
ALTER TABLE opening_budget_reservations
  DROP CONSTRAINT opening_budget_reservations_amount_cents_check,
  ADD CONSTRAINT opening_budget_reservations_amount_cents_check CHECK (amount_cents > 0),
  DROP CONSTRAINT opening_budget_reservations_reserved_amount_cents_check,
  ADD CONSTRAINT opening_budget_reservations_reserved_amount_cents_check CHECK (reserved_amount_cents IS NULL OR reserved_amount_cents > 0);
ALTER TABLE cards DROP COLUMN course_id, DROP COLUMN skill_label;
COMMIT;
```

0064 的来源身份属于隐私约束，默认保留。只回退代码却恢复到不检查卡片来源的旧版本，同样会移除保护。不能把派生卡片的 `source_ids` 清空来满足回退条件；先保留带来源的备份并制定兼容读取方案。只有目标中不存在任何材料派生卡片、也无 Opening 来源笔记关联卡片，且已回退相应代码时，才可评估以下结构回退；它不会删除卡片或改写来源：

```sql
BEGIN;
LOCK TABLE cards IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM cards c WHERE cardinality(c.source_ids) > 0
      OR EXISTS (SELECT 1 FROM opening_note_provenance p WHERE p.document_id = c.source_document_id)
  ) THEN
    RAISE EXCEPTION 'retain card lineage protection while derived cards exist';
  END IF;
END $$;
ALTER TABLE cards DROP COLUMN source_ids;
COMMIT;
```

以上为运维回退说明，本轮未对生产执行迁移、回滚或部署。浏览器与真实供应商验收仍由用户完成。
