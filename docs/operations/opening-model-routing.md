# Opening 模型目录与路由

设置入口：`/settings` → **AI 模型与供应商**。此设置作用于 Opening 持久辅导和临时对话；旧 mock 回复不因此成为真实模型请求。供应商目录、密钥和价格由部署者配置，网页只保存当前工作区的模型选择与辅导模式映射。

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

- 仅支持 OpenAI-compatible `/chat/completions`、文本输入及项目要求的结构化 JSON 回答。名称不代表已验证的能力、质量或协议兼容性。模型目录最多 32 项。
- `apiKeyEnv` 指向服务器环境中的密钥变量；通过部署环境/密钥管理工具提供值。目录不接受内联 `apiKey`，网页/API 不返回密钥、密钥变量名或供应商地址。不要把密钥放到浏览器、本地存储或提交中。
- 模型 `id`、供应商 `providerId` 保持稳定；新增或更换供应商/型号时使用新的模型 id。相同供应商 id 的展示名称必须一致。`OPENING_MODEL_DEFAULT_ID` 必须存在；省略时使用目录第一项。目录 `[]` 表示不部署模型。
- 目录地址来自受信任的部署配置；客户端不能新增地址。使用 HTTPS；本地测试允许 loopback HTTP。地址不得包含用户名、密码、查询参数或片段。
- 输入/输出价格都是**同一记账币种的分 / 百万 token**，日上限也使用这一币种的分。跨供应商原币种不同时，部署者必须先统一换算价格；系统不自动换汇，也不声称本地估价等于供应商账单。
- 密钥缺失、价格为零或日上限为零会显示不可用。配置仅表示具备调用条件，不代表完成真实供应商连通性和质量验证。
- 将相同目录、密钥和日上限配置到 web 与 worker，重启两者。目录变化需要重启；工作区路由偏好保存后无需重启；工作区自定义供应商保存后立即生效，同样无需重启。

## 工作区自定义供应商（BYOK）

工作区所有者可在 `/settings` 的「自定义供应商与密钥」面板中自行维护供应商、模型与密钥，无需修改服务器环境变量或重启服务：

- **能力与限制**：每个工作区最多 8 个供应商、共 16 个自定义模型；合并后（服务器目录 + 自定义）仍受 32 个模型总量上限约束，服务器目录优先。模型 id 为稳定 UUID。
- **密钥处理**：密钥用 `OPENING_CONNECTION_KEY`（AES-256-GCM，域分离为 `opening-model-provider`）加密后存库，仅写入不回读——API 只返回 `hasApiKey`、尾 4 位提示与更新时间；浏览器、本地存储和日志均不落密钥明文。轮换 `OPENING_CONNECTION_KEY` 时通过 `OPENING_CONNECTION_PREVIOUS_KEYS` 仍可解密旧密文。
- **地址要求**：远程接口必须 HTTPS（本地开发允许 loopback HTTP），不得包含用户信息、查询参数或片段。地址由工作区所有者自行填写；自托管部署应自行评估该用户对 endpoint 的控制权，可选通过部署环境限制出站网络。
- **可用性语义**：与服务器目录一致——缺密钥 `missing_key`、日上限为零 `budget_disabled`、加密不可用 `vault_disabled`；自定义模型价格为正数（分 / 百万 token），共享同一 `OPENING_MODEL_DAILY_CAP_CENTS` 日上限与费用记录。
- **API**：`GET/POST /api/opening/model-providers`、`PUT/DELETE /api/opening/model-providers/{id}`、`POST /api/opening/model-providers/{id}/models`、`PUT/DELETE /api/opening/model-providers/{id}/models/{modelId}`，仅工作区所有者可访问。
- **数据**：`0043_opening_model_providers.sql` 新增 `opening_model_providers`、`opening_model_provider_models`、`opening_model_provider_credentials` 三表（随工作区级联删除）。原生备份目前不包含这三张表；迁移服务器前请另行记录供应商配置并重新录入密钥。

## 用户设置

1. 登录后进入 `/settings`，等待模型目录读取完成。先确认需要的模型显示“已配置”。
2. 可按供应商筛选模型。筛选只缩小选项，不替换已选模型。
3. **手动选择**：选择一个明确模型并保存。所有辅导模式使用它；不跟随之后变化的服务器默认模型。手动锁定单独保存在 `manualModelId`，不会改写自动模式的默认模型或四项映射。
4. **按辅导模式自动选择**：设置默认模型，再按需为倾听、提示、解释、共同思考分别指定模型。未指定的模式使用工作区默认模型；工作区默认未指定时跟随服务器默认模型。界面显示最终生效规则。切到手动、保存后再切回自动，原来跟随服务器默认的空值、明确指定的自动默认及四项映射都保持原值。
5. 保存后，新请求在实际选型时读取偏好；排队但尚未选型的请求也读取新设置。已选型或已发送请求继续使用原模型、价格与费用记录，不中途换模型。
6. 在助理中分别发送一条持久对话与临时对话，确认响应。自动模式分别切换辅导模式验证映射。实际供应商效果和浏览器交互由用户验收。

自动模式只执行用户可见的确定性映射，不推断问题难度、模型能力或模型回答的置信度。所选模型被移除或不可用时停止该请求；不自动重试、不静默换供应商。先选择可用模型或“恢复服务器默认设置”，再由用户重新发起请求。恢复默认不会保证服务器默认模型可用，仍须检查状态。损坏的已存偏好会阻止请求，设置页允许重新保存或恢复。

## 数据与费用

`0036_opening_ai_settings.sql` 为 `workspace_preferences` 新增可空 `ai_settings`，为 `opening_budget_reservations` 新增可空 `model_snapshot`。不更新旧行，不改变入口/学习偏好。`ai_settings` 分别保存 `manualModelId`、自动模式的 `defaultModelId` 和四项 `routes`。本功能早期缺少 `manualModelId` 的手动偏好在读取时由旧 `defaultModelId` 正规化；显式为空或损坏的手动选择仍阻止调用，不自动补成可用。按既有迁移流程先执行 `npm run db:migrate`，再运行新应用；测试迁移只使用隔离数据库。

每次请求解析一次模型，把其目录 id、供应商 id、真实 model name 和输入/输出价格随费用预留保存；provider 调用与结算使用同一份选择。快照不含密钥、供应商地址、提示词或回答正文。同一 requestId 不允许换模型/价格后复用。工作区日预算继续汇总所有模型的已用费用和未知结果预留，切换模型或供应商不会清零；未知结果不自动释放费用或发起重试。

## 备份范围

设置页的“原生备份”（`/api/backups/export`，`aistudy-native` 格式）目前不包含 `workspace_preferences`，因此不备份这里的模型选择与路由。迁移服务器前请另行记录手动模型、自动默认模型和四项映射，并同步部署服务器模型目录；不要把密钥写入这份选择记录。

Opening 档案另一路径会从该工作区的 `ai_settings` 导出经过既有 schema 校验的模型 ID 和路由设置，拒绝密钥、地址等额外字段。数据库快照到 Opening 档案写入/读取的往返测试只验证归档内容保留，不代表网页原生备份已经覆盖这些设置，也不代表完整恢复或数据库恢复执行已经完成。恢复后的模型仍须在目标服务器目录中存在并具备可用配置；服务器密钥不会随档案迁移。
## 回退

应用回退时保留这两个新增可空列及已保存费用记录；旧版应用会忽略它们，原 `OPENING_MODEL_*` 环境变量继续提供旧版单模型调用。不要删除已记录的 `model_snapshot` 或预算预留来回退。若需要先停止外部调用，可按既有部署方式将日上限设为零并同步重启 web 与 worker。

仅撤销某工作区的选择时，使用设置页“恢复服务器默认设置”；它清空该工作区的 `ai_settings`，不修改其他偏好或任何费用记录。移除数据库列不是应用回退的必要步骤；若未来确需收缩 schema，应另做备份和数据保留审查。

## 验收与尚未覆盖

可在非浏览器测试中验证 schema、鉴权范围、映射、价格归属、预算幂等与跨模型累计。设置页操作、响应式显示、真实供应商连通性及回答质量仍需用户验证。供应商价格/币种政策、协议与留存承诺、质量和成本自动路由策略继续由现有专家研究任务维护；此实现不据此作已验证声明。
