# AIstudy 框架与算法优化调研

- 日期：2026-10-06
- 状态：exploring
- 范围：Opening 全栈框架、AI/检索/规划算法、连接器与功能闭环
- 目标：把已有架构能力沉淀为清晰背景，指出真正值得调研和优化的地方，避免直接堆叠复杂算法
- 非目标：本轮不改变产品方向、不新增 gate/baseline/contract、不做迁移或破坏性变更

## 1. 一句话结论

AIstudy 已经具备“PostgreSQL 为事实源 + Web/Worker 分离 + 程序化授权 + 预算化 AI + 可回放证据”的骨架。下一步优化不应优先替换框架或直接上复杂模型，而应解决四个真实问题：

1. web 与 worker 边界漂移；
2. 检索与算法缺少可复用评测集；
3. AI 失败恢复与预算状态机还不够完整；
4. 外部导入/回调在并发和故障恢复下的幂等性需要收紧。

## 2. 程序背景

### 2.1 产品定位

AIstudy 是面向终身学习者的学习平台，当前重点是 Opening 开学版。核心价值不是简单聊天或资料收藏，而是闭合学习链路：

- 用户导入或选择学习资料；
- 系统在授权范围内生成解释、提示、任务候选；
- 学习行为、练习、复盘与复习形成可追踪证据；
- 用户确认后进入计划、记忆或学习历史；
- 私密数据可通过 epoch 与来源排除进行撤回。

### 2.2 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Next.js App Router、React 18、Tailwind | 页面、服务端 route handler、客户端 feature modules |
| 后端 | Next.js route handlers + BullMQ Worker | HTTP 入口和后台任务分离 |
| 数据库 | PostgreSQL | 资产、事件、计划、预算、隐私、导入凭据的事实源 |
| 异步 | Redis + BullMQ | 解析、tutor turn、提醒、后续连接器任务 |
| 对象存储 | S3 兼容存储 | 原始文件、页面图像、备份对象 |
| AI | OpenAI-compatible provider + 模型目录 | 供应商中立、模型快照、预算与隐私前置 |
| 测试 | Vitest、Playwright、集成数据库隔离 | 浏览器验收由用户负责，Agent 只做非浏览器验证 |
| 包结构 | npm workspaces monorepo | domain / contracts / database / ai / config / ui 与 apps |

### 2.3 monorepo 结构

```text
apps/web        Next.js 界面、route handler、feature services
apps/worker     BullMQ worker、解析、tutor、提醒、连接器 job
packages/contracts  跨包 schema 与 API 契约
packages/domain     领域规则、指令、规划、评估策略
packages/database   Drizzle schema、migration、repository
packages/ai         provider、context selection、citation、model routing
packages/config     环境配置、模型目录、tutor 参数
packages/ui         共享 UI
```

### 2.4 主运行链路

#### 学习资料解析链路

```text
用户上传
→ web route 验证身份与 workspace
→ PostgreSQL 写 source + outbox
→ object storage 保存原始对象
→ BullMQ parse job
→ parser 生成 chunks/page image
→ replaceChunks 事务写入
→ parse_state=ready
```

关键不变量：

- source 只能由 workspace owner 访问；
- chunk 与 source/version 绑定；
- parse 失败不改变原版本；
- 正式 context 只消费 ready source。

#### Tutor / Ephemeral AI 链路

```text
用户输入
→ mode/source/page/chunk 授权
→ source version snapshot 校验
→ selectContext 选择上下文
→ memory + history + strategy 注入
→ model routing
→ budget reserve
→ privacy epoch check
→ provider call
→ provider schema validation
→ citation validation
→ page anchor validation
→ 事务写 assistant turn/candidate/help exposure
```

关键不变量：

- model route 不自动 fallback；
- citation 只能引用已提供 chunk；
- page-backed turn 必须有页面锚点；
- privacy epoch 改变后不发送、不写回；
- AI candidate 不直接改变正式状态。

#### 规划与学习证据链路

```text
course evidence / attempts / reviews
→ domain planner
→ 今日计划、任务、保护时间
→ 学习行为落库
→ eligibility/history/summary projection
→ 用户确认或手动修改
```

关键不变量：

- AI 只建议，不静默修改计划；
- locked task 与 protected exploration 不被挤占；
- 状态迁移可解释、可回放。

#### 连接器与导入链路

```text
外部系统 callback / sync
→ credential + signature + scope 验证
→ connection state/version 校验
→ import identity 幂等
→ source create/upload/parse
→ import receipt commit
```

当前 DingTalk callback 已实现签名、AES、CorpID、时间窗、scope 和 receipt 查重。剩余重点是并发与故障补偿。

### 2.5 当前安全与治理机制

| 机制 | 位置 | 作用 |
|---|---|---|
| Workspace owner scope | repository 层 | 所有读写绑定 workspace + owner |
| Privacy epoch | workspaces + AI call | 删除或排除资料后阻止旧上下文 |
| Source exclusion | privacy repository | AI 不发送被排除来源 |
| Model routing | model-routing.ts | 手动/自动路由、模型快照、不可用时失败而不是切换 |
| Budget ledger | opening_budget_reservations | reserve/release/settle/unknown 状态 |
| Citation validation | citations.ts | 拒绝伪造 chunk id |
| Page anchor | domain 策略 | page-backed turn 强制来源页 |
| Candidate-only AI | contracts/domain | AI 产物先候选后确认 |
| Import receipt | opening_import_receipts | 外部事件唯一标识 |
| Transactional outbox | opening_outbox | 正式写入与任务发布同事务 |

这些是当前项目最有价值的资产，优化时不能绕开或削弱。

## 3. 已确认的当前能力

### 3.1 框架能力

- PostgreSQL 是正式数据事实源；
- web/worker 已分离，BullMQ 可承担真实队列；
- repository 层已经普遍带 workspace 校验；
- transactional outbox 已存在；
- AI 调用不是裸调用，已有预算与隐私前置；
- source/chunk/revision/provenance 已形成版本链。

### 3.2 算法能力

- `selectContext` 有确定性词法召回；
- 中文/CJK bigram 已纳入评分；
- preferred chunk/page 可覆盖纯词法结果；
- budget-aware packing 按 chunk 粒度选择；
- 模型路由支持 manual、per-mode、workspace default、server default；
- planner 支持 scenario/tier/review/practice/protected exploration；
- 学习 summary 与 eligibility projection 已有初步投影。

### 3.3 已验证过的重点

- context selection 单测已覆盖标点、CJK、公式符号、预算、tie-break；
- tutor turn 单测覆盖 snapshot、隐私竞争、预算、unknown outcome、citation/page guard；
- budgeted call 单测覆盖 release/settle/unknown；
- DingTalk client 单测覆盖签名、解密、CorpID、时间窗、replay store；
- opening integration 测试已有隔离数据库门禁。

## 4. 需要调研和优化的地方

### 4.1 框架层

#### 问题 1：web 直接 import worker 内部实现

当前 web runtime 直接引用：

```text
apps/worker/src/runtime/tutor-model
apps/worker/src/runtime/source-page-images
apps/worker/src/connectors/dingtalk-client
apps/worker/src/connectors/dingtalk-policy
apps/worker/src/connectors/import-identity
```

短期可复用，但长期造成三个问题：

1. worker 内部实现被 web 隐式耦合；
2. web build 可能带入 worker-only 依赖；
3. 未来部署、权限和边界检查变复杂。

调研问题：

- 应该建立 `packages/opening-runtime`，还是扩展现有 package？
- 哪些模块是纯领域逻辑，哪些必须留 worker？
- S3 页面图像、model provider resolution 是否属于共享 runtime？
- 是否需要用 ESLint boundary rule 阻止 app 间互相 import？

建议方向：

- 先抽 `tutor-model`、`source-page-images`、`import-identity`、connector protocol；
- worker-specific I/O 留在 worker；
- provider/client 抽成可注入依赖；
- 不为重构一次性改大量文件，按 feature slice 推进。

#### 问题 2：BullMQ 与 PostgreSQL dispatcher 职责重叠

worker 当前既有 BullMQ worker，也有周期性 `dispatchPending` / `dispatchTutorTurns`。

需要确认：

- PostgreSQL pending 查询是恢复机制还是主调度；
- outbox publish 是否幂等；
- tutor job claim 的 CAS 是否足以防止重复执行；
- 每秒轮询是否必要；
- BullMQ redelivery 与 DB claim 是否已经有完整测试。

建议方向：

- PostgreSQL outbox 只负责事务发布；
- BullMQ 负责执行、重试和并发；
- dispatcher 只做启动恢复和丢失任务补偿；
- 明确 job idempotency contract；
- 若当前轮询是刻意设计，补 ADR，否则收敛为事件驱动。

#### 问题 3：连接器同步放在 web request 生命周期里

DingTalk callback 当前在 web route 中：

1. 校验签名；
2. 下载 attachment；
3. 上传 S3；
4. 创建 source；
5. commit receipt；
6. 再 ack。

这在慢附件或外部下载抖动时会导致请求超时、重复 callback 和不可控重试。

调研问题：

- callback ack 与业务处理是否应该解耦？
- 下载/上传/解析是否应进入 worker？
- 失败后 DingTalk 重试如何与 receipt/processing 状态联动？
- 回调 endpoint 是否需要独立限流？

建议方向：

- web 只做 signature/decrypt/routing/快速验证；
- 验证通过后写入 durable callback job；
- worker 做下载、source 创建、receipt commit；
- job 用 eventId + connectionId 做幂等；
- 不可恢复失败写 connection state/error。

#### 问题 4：本地/CI 工具链假设与 PowerShell 环境冲突

项目脚本大量依赖 `bash scripts/run-heavy.sh`。Windows 环境没有 `bash` 时，`npm run lint/typecheck/test/build` 不能直接执行。

调研问题：

- `run-heavy.sh` 是否只是 VM 调度优化？
- 是否应有 `run-heavy` 的 Node 或 PowerShell 实现？
- CI 是否继续使用 Unix-only 脚本？
- 开发者文档是否明确 Windows 可用命令？

建议方向：

- 不降低 CI 质量；
- 把 heavy runner 抽成脚本参数化实现；
- 至少给 Windows 提供非调度的 fallback 脚本；
- 保持测试数据库和浏览器验收门禁不变。

### 4.2 算法层

#### 问题 1：检索缺少评测集和效果基线

当前 `selectContext` 是词法召回 + preferred page/chunk + budget packing。它确定、便宜、可解释，但不能证明：

- 中文长问题是否稳定命中；
- 多来源混合时是否丢关键 chunk；
- preferred page 是否会挤掉强相关上下文；
- 预算内质量是否优于简单 baseline；
- Recall@k、Precision@k、MRR、P95 到底是什么水平。

调研问题：

- 是否先建 50–100 条真实课程问题评测集？
- 评测集如何处理隐私数据？
- 应该用固定 JSON fixture 还是本地可回放数据库？
- 何时值得引入 pgvector？

建议方向：

- 先做 evaluation harness，不直接改检索；
- 指标至少包括 Recall@k、Precision@k、MRR、citation hit、P95；
- 与三个 baseline 对比：blank-query 顺序选择、preferred-only、当前 selectContext；
- 若 pgvector 只在评测集中带来稳定收益，再做 migration ADR；
- 引入 embedding 时必须记录 model/version/sourceVersion，失败退回词法。

#### 问题 2：Tutor 上下文预算与输入成本缺少统一控制

当前限制包括：

- `maxContextCharacters = 12000`
- `MAX_PROVIDER_CHUNKS = 64`
- history max chars/turns
- maxOutputTokens

但缺少统一策略回答：

- 12k 字符在不同 token 化模型下成本差异多大？
- page image 与 text context 的预算如何合并？
- 高优先级 chunk 是否应该直接占用固定预算？
- history 与 context 同时接近上限时如何取舍？

调研问题：

- 是否应该把 character budget 升级为“估算 token budget + hard character cap”？
- 视觉模型应如何计算 page image 成本？
- provider 差异是否需要 per-model context limit？

建议方向：

- 短期只做配置化：`maxContextCharacters`、`maxHistoryCharacters`、`maxImagesPerTurn`；
- 中期加 provider-neutral token estimator；
- 不让模型自行决定是否截断；
- 所有截断保留 deterministic reason/trace。

#### 问题 3：AI 失败恢复策略不完整

`OpeningProviderError` 有 `retryable` 字段，但主调用链没有统一消费它。

`runBudgetedCall` 现在只区分：

- 未发送错误 release；
- 超时/网络 markUnknown；
- malformed response 可能已计费 markUnknown；
- usage 缺失 markUnknown。

缺少明确的：

- 哪些错误可以安全重试；
- 是否保留同一 requestId；
- unknown outcome 是否允许 reconcile；
- retry 前是否重新检查 privacy epoch；
- retry 间隔和上限。

调研问题：

- provider 429/503 是否应自动 retry？
- 请求已到达但响应丢失是否绝对禁止重试？
- 同 requestId 重试如何与 budget ledger 幂等配合？
- 是否需要 reconciliation job？

建议方向：

- 只对 `UNSENT_CODES` 或明确 retryable 且未发出请求的错误重试；
- 最多 2 次，使用 exponential backoff；
- 同一 requestId 让 budget ledger replay；
- 每次重试前重新检查 privacy epoch 和 source snapshot；
- 超时/响应丢失不允许盲目重试，交给显式 reconcile；
- 不做跨模型 fallback。

#### 问题 4：planner 优先级与价值函数缺少可验证假设

当前 planner 的顺序规则清晰：

1. locked tasks；
2. protected exploration；
3. reviews；
4. scenario-specific weak/untested/usable tier；
5. budget packing。

这适合当前阶段，但还无法回答：

- 先做复习还是先补薄弱点收益更高；
- `estimatedMinutes` 是否真实；
- stable/usable/weak 状态是否应该影响时长；
- 考前场景是否应该降低长期复习优先级；
- 不同 goal kind 是否需要不同排序。

调研问题：

- 是否先做一周用户 A/B 记录：接受、完成、跳过、修改；
- 是否需要把 planner reason 从文案升级为结构化 reason codes；
- 是否应该引入 weighted shortest job first 或简单 utility score？
- 如何避免把主观优先级包装成伪科学模型？

建议方向：

- 先收集 planner decision log；
- 记录 plan version、input snapshot、offered/completed/skipped；
- 不直接引入复杂知识追踪；
- 若数据不足，保留 deterministic tier；
- 只在 7/30 天验证设计通过后考虑 utility/FSRS 类增强。

#### 问题 5：知识追踪和学习状态仍需语义补强

已有学习证据、attempt、review、observation 和 projection，但还没有形成可解释的知识追踪模型。

调研问题：

- 状态 stable/usable/weak 如何由正确率、尝试次数、提示暴露、时间衰减共同决定？
- 跨课程考点是否允许共享证据？
- 短期内错误率上升应视为噪声还是状态变化？
- 是否需要多维能力（概念、流程、计算、迁移）而不是单一状态？

建议方向：

- 先定义 evidence schema，而不是先选 BKT/DKT/Bayesian KT；
- 做小规模 replay evaluation：用历史 attempt 预测下一次表现；
- 模型输出必须保留解释与证据引用；
- AI 只解释状态，不直接改状态。

### 4.3 具体功能层

#### 问题 1：DingTalk callback 幂等仍不是原子优先

当前流程先 SELECT receipt，后导入 source，再 commit receipt。串行正确，但并发下可能重复创建 source。

失败场景：

```text
同一 eventId 两个 callback
→ 同时 SELECT 都不存在
→ 两个都创建 source
→ 后续 receipt commit 才发现 unique conflict
```

调研问题：

- 是否用 `INSERT ... ON CONFLICT DO NOTHING` 抢占 receipt？
- 抢占后下载失败是否需要 processing 状态？
- 已存在 receipt 是否直接返回 duplicate？
- 是否允许 source 与 receipt 同事务创建？

建议方向：

- 首道幂等放在 DB unique constraint；
- 使用原子 insert receipt claim；
- claim 成功后处理导入；
- 失败标记 processing/failed，可重试或清理；
- 不依赖应用层 SELECT 作为唯一防重。

#### 问题 2：source chunks 索引与批量写入

`opening_source_chunks` 已有 `UNIQUE(source_id, source_version, page)`，repository 查询按 source/version/page 排序。当前每 chunk 一次 INSERT，导入大 PDF 时可能放大事务时间。

调研问题：

- 是否需要 named covering index？
- 大文档是否应使用 multi-values insert？
- chunk text 上限是否足以约束 parse 输出？
- 是否需要导入前预估行数和字节？

建议方向：

- 补 named unique index，不改变语义；
- multi-row insert 按 100–500 行分批；
- 保留事务原子性；
- 一次 parse 只允许一个版本；
- 失败时仍整体回滚。

#### 问题 3：backup 与导入链路的一致性

backup 已覆盖大量正式表，但外部 import receipt/cursor 的恢复语义需要继续审计。

调研问题：

- connection credentials 是否仍不进入 backup；
- receipt 缺失是否表示外部事件可重新导入？
- cursor 与 receipt 冲突时以谁为准？
- revocation 后 backup 恢复是否会复活连接？

建议方向：

- 对 import/cursor/connection 做恢复演练清单；
- 凭据不进 backup，只记录可恢复流程；
- 恢复后外部同步必须重新授权或重新验证；
- receipt 语义写入 operations 文档。

#### 问题 4：学习历史与计划执行缺少统一交互闭环

今日计划已有展示、锁定、保护探索和状态推进，但缺少完整反馈：

- 用户跳过任务的原因；
- 任务完成后对后续计划的修正；
- 学习历史中“为什么推荐这个任务”的追溯；
- 提醒是否真正促成行动。

调研问题：

- 是否给 plan task 增加 decision log？
- reason 是否要结构化？
- 提醒送达后多久打开/完成任务算有效？
- 手动修改是否应反向训练 planner？

建议方向：

- 短期只做前端可见的 task reason 与修改入口；
- 后端记录 offered/completed/skipped；
- 不自动惩罚跳过；
- 用户手动调整优先于算法。

#### 问题 5：自定义模型供应商体验与安全边界

模型目录支持服务器目录和 workspace 自定义 provider。后续需要明确：

- API key 加密、展示、备份策略；
- 自定义 provider URL 的 SSRF 防护；
- per-provider/per-workspace 成本限额；
- key rotation；
- provider error 是否展示给用户足够诊断信息。

建议方向：

- key 只加密落库，不在 UI 回显；
- URL 校验与现有 provider 一致：HTTPS 或显式 loopback；
- 所有模型保留 snapshot；
- 失败时不自动换 provider；
- 预算仍按 workspace 汇总。

## 5. 优先级

### P0：影响正确性或当前任务可信度

1. DingTalk callback 原子幂等；
2. DingTalk integration 测试修复（真实 43 字符 base64 AES key）；
3. AI retry/reconcile 状态机；
4. worker/web 共享 runtime 边界；
5. 明确 BullMQ 与 PostgreSQL dispatch 的职责并补 ADR。

### P1：明显提升效果但需要数据

1. 检索 evaluation harness；
2. context token/char/image 统一预算；
3. planner decision log 与结构化 reason；
4. source chunks 批量写入与 named index；
5. backup/import/cursor 恢复演练。

### P2：等证据成熟再做

1. pgvector 或 hybrid retrieval；
2. utility planner / weighted scheduling；
3. BKT/DKT/Bayesian KT；
4. semantic cache；
5. 复杂 reranker。

## 6. 统一调研路线

### 第一步：边界与正确性（1–2 个切片）

- 修复 DingTalk 测试与并发幂等；
- 抽出 web/worker 共享 runtime；
- 写 job/queue 职责 ADR；
- AI retry 只处理明确未发送错误。

验收：

- 集成测试可重复通过；
- 并发重复 callback 不产生第二个 source；
- provider retry 不破坏预算 ledger；
- web 不再直接 import worker 内部路径。

### 第二步：算法可测量（1 个切片）

- 建小型 retrieval evaluation set；
- 记录当前 selectContext baseline；
- 加 planner offered/completed/skipped decision log；
- 不改变默认推荐。

验收：

- 每次算法变更可跑同一评测；
- 输出 Recall@k/Precision@k/MRR/P95；
- planner 行为可回放。

### 第三步：功能闭环（按需）

- DingTalk callback → durable job；
- source chunks 批量写入；
- task reason/decision UI；
- backup import 恢复演练。

验收：

- 慢附件不阻塞 callback ack；
- 大文档解析事务时间下降；
- 用户能理解任务推荐原因；
- 恢复后连接器不复活授权。

### 第四步：算法升级（证据驱动）

- pgvector；
- hybrid retrieval；
- planner utility；
- knowledge tracing；
- semantic cache。

进入条件：

- 有真实数据评测；
- 新算法优于当前 baseline；
- 失败可退回确定性方案；
- 不削弱隐私、授权、预算和引用校验。

## 7. 明确不建议现在做的事

1. 不直接替换 Next.js；
2. 不引入微服务拆分；
3. 不用图数据库替代当前关系模型；
4. 不在无评测集时上 pgvector；
5. 不用 DKT/BKT 替代现有确定性状态；
6. 不做 provider 自动 fallback；
7. 不把浏览器验收交给自动化 Agent；
8. 不为了性能删除 privacy epoch、scope、citation、budget 或 outbox；
9. 不新增未解释的 hash/gate/baseline；
10. 不把 AI 候选当作正式状态。

## 8. 关键验证命令

单元测试：

```pwsh
$ErrorActionPreference = 'Stop'
npx vitest run --project unit packages/ai/src/opening/context.test.ts
npx vitest run --project unit apps/web/src/features/opening/tutor/ephemeral-service.test.ts apps/worker/src/jobs/tutor-turn.test.ts
npx vitest run --project unit apps/worker/src/connectors/dingtalk-client.test.ts apps/worker/src/connectors/dingtalk-policy.test.ts apps/worker/src/jobs/sync-dingtalk.test.ts
```

集成测试：

```pwsh
$ErrorActionPreference = 'Stop'
$env:OPENING_TEST_DB = '1'
$env:OPENING_TEST_DATABASE_URL = 'postgres://aistudy:aistudy@127.0.0.1:5433/aistudy_opening_test'
npx vitest run --project integration tests/integration/opening-dingtalk.test.ts
```

类型检查：

```pwsh
$ErrorActionPreference = 'Stop'
npx tsc -p packages/ai/tsconfig.json --noEmit
```

说明：浏览器验收不由 Agent 执行，必须由用户完成；集成测试必须使用隔离测试库。

## 9. 交付时的证据口径

- 只报告实际运行过的命令和结果；
- 不把静态审查写成测试通过；
- 不把待浏览器验收标记为通过；
- 不因本次调研新增 baseline 或 gate；
- 不伪造性能或检索效果数据；
- 任何算法升级前先有失败场景和可回退路径。


## 10. 后续决策点

| 决策 | 选项 | 建议倾向 |
|---|---|---|
| web/worker 公共代码归属 | 新建 opening-runtime / 扩展 ai+database | 先按 slice 抽公共 runtime，不建大而全包 |
| queue 职责 | BullMQ 主调度 + DB 恢复 / DB 主调度 + BullMQ 执行 | BullMQ 执行 + DB outbox/claim，恢复触发用补偿 job |
| retrieval 升级 | 继续词法 / pgvector / hybrid | 先评测，hybrid 最可能先受益 |
| AI retry | 不重试 / 同 requestId 有限重试 / reconcile job | 同 requestId 有限重试未发送错误 + 显式 reconcile |
| planner 增强 | 保持规则 / decision log / utility | 先 decision log，后 utility |
| callback 处理 | 同步 web / durable worker job | durable worker job |
| DingTalk receipt | SELECT 后 commit / atomic claim | atomic claim |

## 11. 深度扩展：Study 证据与教学干预闭环

> 本节补充吸收外部建议文档《Soul 与 study-assistant-opening 借鉴与实施建议》中与 Study 有关的部分。该文档是外部设计建议，不是本仓库的正式变更授权；Soul/FaultEvolve 相关内容只作为设计启发，不引入其实现或跨项目数据共享。下文所有“建议新增”均为待调研/待决策项，不是已实现能力。

### 11.1 外部建议中最值得吸收的核心

外部建议的正确主线不是“更智能地判断用户学会了”，而是把学习过程变成可核查证据链：

```text
材料片段与版本
→ 初次作答
→ 帮助是否送达 / 是否提交前暴露
→ 参考核验
→ 反馈、复盘或探索
→ 后续独立作答
→ 延迟无帮助复测
```

这句话可以直接作为 Study 方向的验收口径：

- **不优化即时答对率本身**；
- **不把模型自评当作掌握度**；
- **不把帮助后复制的答案当作独立成功**；
- **优先证明“提示有效”的后续独立迁移效果**；
- **未知证据保持 unknown，不用默认成功填充**。

### 11.2 项目已有基础比外部建议更接近落地

当前代码已经有较严格的证据门槛，不需要另建“智能内核”：

| 已有能力 | 代码落点 | 对 Study 闭环的意义 |
|---|---|---|
| Evidence eligibility 四维判定 | `packages/domain/src/opening/evidence-eligibility.ts` | 独立作答、核验正确、当前版本适用、延迟复测资格分开判定 |
| 帮助时间与提交时序 | `evidence-eligibility-timing.ts` | 提交前提示、提交后反馈、答案暴露、送达缺失不会混为一谈 |
| 参考核验身份 | `referenceCheck` + `evaluateCorrectness` | reference source/method/scope/checker/outcome 必须匹配，模型自称答对不算核验 |
| 内容版本适配 | `evaluateVersion` | 旧证据不能自动继承到新题目版本 |
| 延迟协议 | `evaluateDelayedCheck` | 太早复测或旧答案暴露会判 no/unknown |
| 历史修正链 | observation revisions + effective head | 修正不是新作答，不推进原始提交时间 |
| 学习摘要投影 | `learning-summary.ts` / `learning-summary-aggregate.ts` | 用完整组计数得出状态，代表样本只解释，不决定结论 |
| 复测活动状态机 | `retest-activity.ts` | proposed/accepted/in_progress/completed/declined 等状态可回放 |
| 计划与任务并发保护 | `opening-plans.ts` | 任务完成与复测活动在同一事务/锁序下协调 |
| Tutor 策略注入 | `strategy-registry.ts` + `opening_turns.strategy_template_id` | 当前只有 default strict citation，已具备策略版本化雏形 |
| 记忆准入 | `memory-policy.ts` | candidate 不进 context，temporary 有过期，confirmed 才是稳定上下文 |

关键结论：**已有资格判定是学习真实性的门槛，不是掌握度模型。** 这与外部建议一致，应继续保留。

### 11.3 需要深度研究的新问题

#### A. Learning Episode：如何做投影而不是第二套历史

外部建议提出 Learning Episode，应理解为“证据链读模型”，不是新的总学习记录表。

建议研究：

1. 以 `attemptId` 为轴连接：
   - source/item version；
   - user turn / tutor turn；
   - help exposure；
   - observation；
   - reference check；
   - revision；
   - delayed retest activity。
2. 输出只读投影：
   - `episodeId`
   - `courseId`
   - `requirementKey`
   - `skillLabel`
   - `attemptId`
   - `itemVersionId`
   - `sourceRefs`
   - `helpEvents`
   - `referenceCheck`
   - `observationId`
   - `eligibility`
   - `revisions`
   - `retestActivity`
   - `delayedOutcome`
3. 不复制事实，不修改 eligibility；
4. 服务端必须复用 `evaluateEvidenceEligibility`；
5. 界面按 evidence timeline 展示，不展示“掌握度百分比”。

待验证问题：

- 是否应先做 repository read SQL，还是先在 domain 纯函数里聚合？
- 缺失 turn/help/reference 时如何表达？
- Episode 与 revision history、observation effective head 如何排序？
- 隐私删除后 Episode 是否应该只剩 anonymized skeleton 还是完全不可见？

建议最小验收：

- 用户能看到“这道题的完整学习过程”；
- 每个步骤都能跳到来源或证据；
- 系统错误/材料错误/解析失败不会显示为学生能力不足；
- 内容版本变化后不把旧成功伪装成新版本通过。

#### B. 教学策略卡与概念卡分离

当前 `strategy-registry.ts` 只有 `default-strict-citation`，是严格引用策略，不是教学策略。

建议将两类对象分开：

| 对象 | 目的 | 不允许做的事 |
|---|---|---|
| 概念卡 | 定义、来源、例子、反例、前置条件、可检验问题 | 不能由策略成功自动改写 |
| 观察记录 | 某次作答事实和 eligibility | 不能变成概念正确性的绝对证明 |
| 教学策略卡 | 适用的误解模式、教学动作、暴露风险、验证方法、例外 | 不能伪装成教材结论 |
| 策略适用记录 | 某次策略在某个 course/requirement/skill 上的使用与结果 | 不能跨用户汇总成“对所有学生有效” |

策略卡建议字段（草案，不是最终 contract）：

```text
strategyId
version
displayName
applicableCourseKinds / requirements / skills
misconceptionTags
instructionSuffix
exposureRisk: hint | revealed_answer
validationPlan:
  protocolId
  earliestAtRule
  priorAnswerPolicy
  primaryMetric: delayed_unassisted_success
  guardMetrics: burden | refusal | over_scaffolding
knownExceptions
sourceRefs
status: candidate | active | retired
```

核心研究问题：

- 策略是否只按 course/requirement/skill 作用域，暂不做用户画像？
- 用户能否看见“为什么这次用了这个策略”？
- 策略失败如何写入负面经验而不惩罚用户？
- 策略候选是否必须走用户确认，而不是自动在线切换？

建议先从 2–3 个显式策略开始，例如：

1. 先问后给下一步提示；
2. 只解释概念，不改写答案；
3. 要求学生用自己的话复述后再给例子。

每个策略都要有独立验证协议，不能因为用户喜欢而晋升。

#### C. 错因：从用户标签升级为候选解释

旧 Practice 域已有：

```text
concept / misread / calculation / steps / time / other
```

Opening 学习域尚未形成等价的错因模型。建议不要直接复制为“能力缺陷”，而应作为候选解释。

错因分类草案：

| 类型 | 示例 | 不应推导出的结论 |
|---|---|---|
| prerequisite_gap | 前置概念缺失 | “这个学生学不会” |
| strategy_gap | 步骤选择错误 | “永久低能力” |
| representation_gap | 题意、图示或表达误读 | “概念错误” |
| execution_slip | 计算、书写、操作疏漏 | “概念缺失” |
| material_error | 材料/参考答案/OCR/解析错误 | “学生错误” |
| ai_output_error | 模型编造、幻觉、错误引用 | “学生错误” |
| system_failure | 网络失败、提交丢失、解析失败 | “认知反证” |
| evidence_unknown | 历史缺失、版本缺失、帮助历史不完整 | “默认正确” |

研究问题：

- AI 是否只输出候选错因，用户是否可改？
- 多个错因并存时如何排序？
- 错因是否必须链接到 source chunk、turn 或 reference check？
- 材料/模型/系统错是否应阻断策略学习，而不是统计为学生错误？

建议验收：

- 错因是可解释候选，不是人格标签；
- 用户可纠正；
- 纠正保留原始 AI 建议；
- 后续策略检索不能把 `material_error`、`ai_output_error`、`system_failure` 归为学生能力不足。

#### D. “提示有效”的正式定义

外部建议的核心指标很准确：提示有效不是用户当时满意，而是之后仍能独立解决。

建议定义一个可评估结果链：

```text
initialAttempt
→ help exposure（hint / revealed）
→ postHelpAttempt
→ delayedUnassistedAttempt
→ transferAttempt
```

主要指标：

1. `delayed_unassisted_success`
2. `transfer_success`
3. `no_answer_copying`
4. `burden`: 时间、轮次、任务数
5. `refusal_or_over_scaffolding`: 拒答率、答案直接暴露率

禁止作为主指标：

- 即时答对率；
- 对话轮次增加；
- 用户满意度单独决定；
- 模型自评“理解了”。

研究问题：

- delayed check 的 2/7 天是配置实验，不是先验结论；
- transfer 题如何证明“合适新题”？
- prior answer exposure 是否阻断 primary metric？
- hinted 与 revealed 是否必须分开统计？
- 样本不足时是否必须显示“未知效果”？

#### E. Planner 与学习证据的关系

当前 planner 是确定性规则，evidence eligibility 已经能判断独立/核验/版本/延迟，但两者尚未形成完整闭环。

建议研究三层：

1. **证据驱动输入**
   - `observed_independent`
   - `needs_check`
   - `needs_review`
   - `historicalSuccess`
   - `historicalIncorrect`
   - `unverified`
2. **Planner decision log**
   - `plannerVersion`
   - `evidenceSnapshotId`
   - `offeredTasks`
   - `acceptedTasks`
   - `completedTasks`
   - `skippedTasks`
   - `reasonCodes`
3. **反馈规则**
   - 用户跳过不自动惩罚；
   - 手动调整优先于算法；
   - due check 优先于新练习；
   - 策略候选只提出，不自动执行。

需要明确：`evidenceSnapshotId` 当前在 planner 里是简单 fingerprint，不是完整数据库快照。若用于可回放评估，应研究完整 input snapshot 或至少可重建输入集合。

#### F. Retest 与 Episode 的衔接

复测活动已经能记录 accept/start/complete/decline/skip/snooze，但还缺少与 Episode 的天然展示关系。

建议研究：

- 复测候选如何引用初始 Episode；
- 复测题目是否必须满足 `usableForDelayedCheck=yes`；
- 提前复测是否允许，但结果只标 unknown；
- completed retest 没有观察时是否只保持 `unverified`；
- 复测失败是否回写错因候选；
- 复测成功是否只提升 evidence count，不直接宣称 mastery。

#### G. AI Tutor 的教学安全边界

Tutor 已有候选-确认、citation、page guard、memory candidate 隔离。Study 扩展后仍必须保留：

- AI 不写学习历史；
- AI 不把用户标记为“掌握/未掌握”；
- AI 不把讲解后的答案复制当作成功；
- hint/explain 产生的 help exposure 继续记录；
- 私密来源撤销后，旧 Episode 不能继续作为可用证据。

应新增研究项：

- AI 输出的“错误解释”是否可以作为错因候选；
- AI 是否可以建议“先尝试独立完成”，并避免直接给答案；
- 模型策略后缀如何版本化；
- 策略变化是否需要 A/B 或 shadow run，而不是直接在线切换。

### 11.4 建议的 Study 实验路径

#### Phase S0：现状盘点

1. 列出 attempt → observation → help → reference → revision → retest 的完整表关系；
2. 标记哪些字段在旧数据中为 NULL；
3. 明确 unknown 不补默认值；
4. 检查 UI 是否暴露 eligibility reason codes。

#### Phase S1：单 Episode 投影

1. 先做只读 API / service；
2. 连接材料、作答、帮助、核验、复测；
3. 输出 evidence timeline；
4. 不新增正式事实表。

#### Phase S2：错因候选

1. 在 Opening learning domain 加候选错因；
2. AI 只建议，用户确认；
3. 系统/材料/AI 错不进学生能力统计；
4. 保留原始候选与用户纠正。

#### Phase S3：策略卡

1. 只先加 2–3 个静态策略；
2. 每个策略带版本和验证协议；
3. Tutor instruction 拼接策略后缀；
4. 记录 strategyTemplateId 到 turn（已有）；
5. 不做自动选择。

#### Phase S4：策略效果评估

1. 用 delayed unassisted success 做主指标；
2. 与当前 default strict citation 比较；
3. 分 hinted/revealed；
4. 分 requirement/skill；
5. 样本不足显示 unknown；
6. 不自动晋升。

#### Phase S5：Planner 反馈

1. 记录 offered/completed/skipped；
2. 结构化 reason；
3. 用户手动调整优先；
4. 之后才讨论 utility。

### 11.5 不应照搬外部建议的部分

1. **不引入 FaultEvolve 沙箱/自动进化循环**；
2. **不让 Soul 或其他项目共享原始学习数据**；
3. **不把树搜索作为默认教学流程**；
4. **不复制其 REFUTED/证伪语义**；
5. **不把学习过程变成无人值守 Agent 搜索**；
6. **不因外部报告立即改 PRD 或删掉现有保守机制**。

### 11.6 Study 深度研究决策表

| 决策 | 可选项 | 建议倾向 |
|---|---|---|
| Episode 存储 | SQL projection / materialized table / domain-only aggregate | 先只读 projection，不建第二历史表 |
| eligibility 复用 | 调用现有函数 / 复制新算法 | 只调用现有函数 |
| 错因模型 | 继续旧 Practice enum / Opening 候选解释 / 机器学习分类 | 先候选解释 + 用户确认 |
| 策略卡存储 | 现有 strategy registry 扩展 / 新 package / DB 表 | 先扩展 domain registry，再决定持久化 |
| 策略选择 | 手动 / deterministic rule / model routing | 先手动 + deterministic rule，不做自动模型选择 |
| 效果指标 | 即时答对 / delayed unassisted / satisfaction | delayed unassisted 为主，其他为辅助 |
| 延迟间隔 | 固定 2 天 / 可配置协议 / FSRS | 可配置协议，FSRS 暂缓 |
| 策略晋升 | 手动 / 预定义实验 / 自动 | 手动或预定义实验，不自动晋升 |

### 11.7 最小验收清单

1. 一道题能从材料版本追溯到最终复测；
2. 提示提交前/后、是否送达、是否答案暴露都有明确状态；
3. 参考核验缺失时显示 unknown；
4. 修订不推进原始作答时间；
5. 旧版本证据不会被显示为当前版本通过；
6. 复测活动状态可回放；
7. 用户能看到推荐原因，并且可以跳过/纠正；
8. AI 策略建议不自动改写学习事实；
9. 策略效果样本不足时显示未知；
10. 系统失败、AI 幻觉和材料错误不会归因于学生能力不足。

