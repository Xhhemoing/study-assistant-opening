# AIstudy 深度优化与深度调研分析

> 日期：2026-10-01。末次核对提交：`754a25628f93c6bb6b423ad26c78fe592a548406`，分支 `feat/opening-release`。
> 本文是**问题分析与研究建议，不是实施授权、完整安全审计或发布验收证明**。只新增本文，不修改业务代码、迁移、CI 或任务状态。

## 1. 核心结论

**最值得投入的不是再增加一轮功能和复杂算法，而是证明现有学习链路能恢复、能解释、成本可控，并且确实帮助用户学习。**

建议先做三件事：

1. **可靠性闭环**：修清异步任务失败后的恢复路径，完成 Opening 备份的实际恢复执行与演练。
2. **可观测、可判断**：把 readiness 从配置/结果汇总器接成真实探测，建立最小故障与费用排查能力。
3. **真实任务评测**：围绕当前课程建立解析、检索、提示质量和延迟独立练习的小型评测集，再决定多模态、向量检索、模型路由和自适应算法的投入。

当前架构仍适合模块化单体＋独立 Worker。没有证据支持现在引入微服务拆库、Kafka、Kubernetes、独立向量数据库或复杂学生模型。

### 证据标记与范围

- **[S] 源码事实**：直接核对当前代码/配置；不等于已复现线上故障。
- **[E] 实际执行**：本轮执行并观察到的结果。
- **[D] 历史记录**：仓库已有文档/运行记录；不是本轮重新验证。
- **[H] 风险或建议**：由事实推导，需要指定实验确认。
- **[T] 待验证**：未取得足够证据，不作肯定结论。

本轮覆盖 Web/Worker 入口、队列与预算、部分数据仓库、解析、备份、CI 配置及既有研究计划。没有逐行审计全部源码；没有运行浏览器、真实模型、数据库恢复、压力测试或完整测试套件；没有核验外部供应商最新价格/政策/CVE 公告。

核查期间存在其他开发活动，HEAD 从 `2efeda5` 前进到 `754a256`，工作区也有其他人的测试修改。本文不把这些未提交修改视为完成证据，也未覆盖或提交它们。

## 2. 当前能力应如何准确描述

| 范围 | 当前可核对事实 | 不能据此得出的结论 |
| --- | --- | --- |
| 任务账本 | [E] Opening：43 项，15 verified、28 planned；personal-use：12 项全部 planned | 28 项都没有实现，或实现完成率只有 15/43 |
| 隐私与发送恢复 | [S] 历史已查隐私排除；`completeTurn` 已事务内锁 workspace 并比较 epoch；Composer 已按意图复用 clientKey | 旧 RP1/RP2/RP3 漏洞仍原样存在，或所有竞态已验收 |
| Today/引用 | [S] Today 已加载真实读模型；下载服务已支持版本；引用链路已有实现 | Today 仍是固定空页，或浏览器体验已经通过 |
| 检索 | [S] `selectContext` 已过滤普通非空查询的零分非优先候选，超长块仍整块跳过 | 所有无关材料必然进入上下文，或检索语义质量已证明 |
| 备份 | [D] 2026-09-25 已记录真实 PG/MinIO 导出、加密归档与发布测试；[S/D] Opening 恢复 apply 仍是缺口 | 备份只有纯函数，或已有完整灾难恢复能力 |
| CI | [S] 已触发 `feat/opening-release` push；默认 browser 命令未选择 Opening 隔离配置 | 开发分支无 CI，或绿色默认 browser job 等于 Opening 完整验收 |
| 学习与数据安全 | [S] 已有版本、权限、候选确认、并发及学习证据测试文件 | 没有跨用户测试，或所有权限/恢复场景均覆盖并通过 |

状态入口：[Opening 账本](../superpowers/plans/opening-release/tasks.json)、[连续执行记录](../superpowers/plans/opening-release/continuation-status.md)、[运维现状](../operations/opening-release.md)。

**`planned` 与已有代码并存不自动等于账本错误。**项目有意在证据闭合前不升为 verified；真正的问题是读者难以区分“未实现”“已实现待检查”“待用户验收”。应在既有执行记录收口，而不是另建一套任务系统或直接提升状态。

## 3. 工程深度优化：按收益和风险排序

优先级含义：**P0**＝在相应高风险操作启用前解决；**P1**＝当前可用切片优先推进；**P2**＝有测量或维护压力后推进。并非每项都阻塞日常开发。

### O01 · P1：队列失败后的恢复路径不够闭合

**证据 [S]**

- `packages/database/src/repositories/opening-jobs.ts`：`dispatchPending` 只读 `pending`；enqueue 抛错后把 outbox 改为 `failed`；`claim` 允许接管五分钟前的 running 记录。
- `apps/worker/src/runtime/dispatch.ts`：两条队列派发路径均设置 `attempts: 2`、`removeOnComplete: false`、`removeOnFail: false`。
- `apps/worker/src/index.ts`：每秒定时派发；定时 Promise 链未见显式错误处理和禁止重叠执行的控制。
- `apps/worker/src/parsers/docling-process.ts`：解析默认允许 900 秒；Worker handler 中未见对应数据库心跳更新。

**判断 [H]**

- Redis enqueue 一次临时失败可能让 outbox 离开正常扫描集合；需要明确谁负责重驱，而不是只增加 BullMQ attempts——未成功入队的作业还没有进入 BullMQ 重试路径。
- 数据库五分钟接管判定与十五分钟解析预算不一致。在**重复投递或另一个执行者再次 claim**的条件下，仍在工作的解析可能被接管；仅超过五分钟不会自动发生双跑。
- 完成/失败作业均保留，若无外部清理，Redis 占用会随任务增长；这不是已测出的内存泄漏。

**最小优化路径**

明确 outbox failed 重驱、published 后 Redis 丢失、运行中进程退出、旧执行者晚写四个窗口。让数据库业务状态负责是否可重做；外部模型结果未知时不得盲重发。仅在验证存在晚写窗口后，为该窗口补接管身份/心跳及写回校验，不重建通用工作流平台。

**验收**：隔离库和测试 Redis 中注入 enqueue 失败→恢复、重复投递、长解析接管、旧执行者晚完成；检查无永久悬挂、无重复业务结果、错误可排查。清理 Redis 前证明数据库幂等性不依赖保留所有历史 job。落点：I03、R06、Q03。

### O02 · P0（恢复真实数据前）：Opening 备份必须从“可导出”推进到“可恢复”

**证据 [S/D]**：`packages/database/src/repositories/opening-backup-*.ts`、`packages/database/src/storage/opening-backup-{archive,cipher}.ts`、`packages/domain/src/opening/backup-apply-plan.ts` 已覆盖多段导出/预检；[Opening 运维文档](../operations/opening-release.md)明确 restore apply executor、CLI 与演练尚未完成。旧 `backups/restore` 路由不能替代 Opening 全实体恢复证明。

**风险 [H]**：导出成功不保证旧备份在新机可恢复，更不保证期间删除的资料、记忆和派生学习证据不会复活。跨 DB/S3 的发布中断也不能仅靠对象哈希解决。

**最小优化路径**：沿 Q03/PU05 落地恢复执行器，使用现有 manifest、隐私 journal、对象版本和事务，不另外发明恢复框架。明确恢复提交点、失败清理与重入策略，保留不确定发布结果供人工检查。

**验收**：空目标环境恢复授权或合成完整样本；校验对象、归属、关系、会话和学习记录；删除发生在导出后、对象缺失、恢复进程在提交前后退出均有可解释结果。RPO/RTO 由实际数据量与演练测得，不先宣传数字。涉及迁移/破坏性恢复时记录“保留旧环境、备份位置、失败后回到哪一步”的回滚方案。

### O03 · P1：readiness 存在“没有探测也可返回 ready”的聚合漏洞

**证据 [S]**：`scripts/opening-readiness.mjs` 的 `buildReadinessReport` 遍历调用者传入的 checks，没有必需检查项集合；仅要求缺失环境项为空、没有失败检查且告警地址非空。CLI 当前把真实服务探测写为 `probe not run`。

**本轮反例 [E]**：用七个合成配置字符串、`checks: {}` 调用纯函数，无网络和持久化访问，实际返回：

```json
{"probe":"empty-checks-with-configured-strings","ready":true,"checkCount":0,"alertDelivery":"configured"}
```

这是**函数层已复现问题**，不是已发生错误发布：当前 CLI 的硬编码失败检查会阻止自身返回 ready。

另有配置语义漂移 [S]：CLI 使用 `AI_PROVIDER_API_KEY`、`OPENING_DAILY_CAP`、`OPENING_REGISTRATION_LOCKED` 的字符串存在性，而产品分别通过模型目录/`OPENING_MODEL_*`、`OPENING_RELEASE` 决策；`"0"`/`"false"` 的非空也不证明约束已生效。

**最小优化路径**：在已有聚合器要求必要检查完整，复用产品配置解析；接真实 DB/Redis/S3/worker 业务探测。告警“已配置”与“已送达”分开，不把 URL 非空写成送达证明。

**验收**：空 checks、缺项、无效/关闭配置均不能 ready；服务不可达与 worker 不消费任务均能识别。更新最近的 `tests/tooling/opening-readiness.test.mjs`；不再新增另一套 readiness gate。

### O04 · P1：模型费用具备防护，但缺少运营对账闭环

**证据 [S]**：`opening-budget.ts` 已有原子预留、settle、unknown 保留预留；`apps/worker/src/runtime/budgeted-call.ts` 对缺 usage 保留不确定性；`tutor-model.ts` 将所选模型价格和 provider 一并解析。当前 Worker 入口未装配 unknown 对账任务，Web Opening API 中未见专门账本查询/对账入口。

**风险 [H]**：长时间未知的调用持续占用额度，用户不知道额度去了哪里；人工改库又可能错误释放实际已消费的金额。

**最小优化路径**：先提供受限只读账本：调用 ID、模型/价格快照、预留、结算、未知原因。供应商支持查询时按其真实能力对账，否则保留人工处置记录。**不做“超时自动释放”或“午夜清掉未知预留”**。

**验收**：响应丢失、usage 缺失、重复结算、跨 UTC 日结算、价格调整以及多个模型共享预算。分别统计预算占用、估计费用与供应商账单，不能把预算窗口的保守重复计入称为供应商重复扣款。落点：T01、R02、PU04。

### O05 · P1：长会话和材料列表的增长没有完整边界

**证据 [S]**：`opening-conversations.ts` 的 `listSummaries`、`listTurns`，以及 `opening-sources.ts` 的 `list` 均无列表分页；会话预览的内层 `LIMIT 1` 不限制外层会话数量。学习历史已有 `opening-learning-history-cursor.ts`，可复用设计经验。

**风险 [H]**：数据增长时数据库读取、JSON 传输、客户端渲染同时变大；模型历史有界不能限制用户浏览历史的查询成本。

**最小优化路径**：先改这三条实际读链的 cursor/limit 契约和 UI 增量加载；排序增加稳定 ID。检索则测量授权候选装载量，不只测最终输出上下文长度。`selectContext` 超长块 `continue` 的质量影响交 R03 实验，不无条件把数学题截半。

**验收**：并发新增、删除、相同时间戳下翻页不漏/不重；权限过滤不被分页绕过。用逐级增长的合成会话/材料量，记录 SQL 计划、返回字节、内存与 P50/P95。存在相关子查询不自动等于应用层 N+1；是否换 SQL/补索引由执行计划决定。落点：PA-07、T02、U03。

### O06 · P1（公网暴露前优先）：补真实 HTTP 边界，而非堆叠安全工具

**证据 [S]**：`api/auth/login/route.ts`、`register/route.ts` 直接 `request.json()`；Opening 其他入口已有 128 KiB 的 `readOpeningJsonBody`。登录路径未见应用级限流；`next.config.mjs`/middleware 未配置项目级 CSP 等策略。

**已有保护必须保留**：scrypt 密码处理、服务端会话吊销、token 哈希、HttpOnly/SameSite cookie、同源 mutation 检查、repository 授权、候选需用户决定。缺少 CSRF token 本身不能证明同源策略存在漏洞。

**最小优化路径**：确认实际公网反代/TLS/请求体配置，再补登录体积限制及账号＋来源维度的有界节流，避免永久锁定被用于拒绝服务。安全响应头按 Next 脚本、PDF/原件展示的实际需要渐进启用。依赖升级依据锁定版本对应的官方公告和可达路径，不凭版本号猜 CVE。

**验收**：大请求、持续错误登录、反代来源伪造、跨工作区材料/引用、过期 URL、已删除来源以及模型输入中的越权指令。复用现有负向授权测试，补矩阵缺项而非声称完全没有此类测试。落点：F01、Q01、R07；本轮不宣称互联网扫描或渗透测试通过。

### O07 · P1：CI 名称与 Opening 实际覆盖范围应对应

**证据 [S]**

- `.github/workflows/ci.yml` → `npm run test:browser` → 默认 `playwright.config.ts`。
- `opening-workflow.spec.ts` 依赖 `OPENING_E2E=1`；`opening-release-redirects.spec.ts` 依赖 Opening 标志；所查默认 CI/config 未设置这些标志。
- `playwright.opening.config.mts` 已存在，但通过 `scripts/opening-e2e/run.ps1` 单独调用。不能说所有 Opening 测试都跳过：shell/upload 无同样的顶层 skip。

**最小优化路径**：将 Opening 隔离配置的执行范围在现有 CI 中明确化，保持独立测试库及 fixture provider；报告实际运行/skip 的 spec。保留默认套件，不通过删除历史检查掩盖问题。

**效率建议 [H]**：CI 目前未跨 run 缓存 `HF_HOME`、未上传失败报告；默认 Playwright 启服会 build Web，后续 CI build 又构建一次。先看步骤耗时，再决定按现有模型版本缓存、保留脱敏失败产物、复用同配置制品。`vitest maxWorkers: 1` 与 heavy wrapper 是小 VM 保护，不应全局取消；仅纯 unit 在 CI 上试验受控并行，DB 测试继续隔离/串行。

**验收**：以对应 SHA 的 CI 报告确认 Opening 关键流程没有条件跳过，故障产物可取且不泄漏材料/令牌。本轮未自行或委派运行 Playwright；浏览器操作与视觉验收仍由用户负责。

### O08 · P1/P2：共享逻辑跨越应用边界，重构应按实际职责做

**证据 [S]**：Web 的 `features/opening/runtime.ts` 与 `tutor/ephemeral-service.ts` 直接引用 Worker 的 `tutor-model`、`budgeted-call`、`tutor-cost`、`tutor-turn`。`today-service.ts`、`retest-service.ts` 仍包含 SQL。`auth/service.ts`、`repositories/library.ts`、`assistant-view.tsx` 分别约 1143/1373/490 行。

**判断 [H]**：比“文件超过 200 行”更值得优化的是部署边界和规则所有者：Web 的不保存路径依赖 Worker job 文件，预算、指令、数据库和生命周期容易一起耦合。

**最小优化路径**：只抽出两端真正共用的 AI 纯策略/预算调用逻辑到合适现有 package；保留 Web/Worker 各自装配，避免把依赖 SQL 的整个 job 放进 domain 或制造循环依赖。按被修改的业务边界迁移 SQL、拆分 auth/library 职责，用既有回归证明行为不变。

Drizzle schema 与原生参数化 SQL 并存不自动错误，也不能凭 grep 不见 query builder 就删除 Drizzle。应先明确迁移、schema 类型、repository 各自用途。旧 workspace/Mock/preview 路径也不能全部删除：保留真实笔记/导出等能力，先形成入口级“正式/演示/历史”清单。

### O09 · P1：删除承诺需要落到正文与派生数据的具体语义

**证据 [S]**：`opening-memory-delete.ts` 更新 memory 的 status/版本和隐私 epoch、写来源排除；`deleteSourceText=true` 时擦除关联 turn 文本，但该 UPDATE 不擦除 memory.text 本身。备份已有隐私过滤，不能称为完全没有删除设计。

**问题 [H]**：用户理解的“忘记”“不再用于 AI”“删除正文”“旧备份不复活”并不等价；一个按钮如果混用这些含义会形成隐私预期差。

**最小优化路径**：沿 M02/R07 明确保留范围和例外，追踪 memory→turn→source→候选→学习投影→备份的实际派生关系；先纠正语义，再决定哪些字段须擦除。不要删除不可变事件、授权或审计保护来简化实现。

**验收**：用合成标记文本检查删除、不保存、失败、重启、旧备份恢复后的所有应用可控持久化面；检查下一次实际 provider 输入。第三方内部留存只能核政策/账户配置，不能靠本地测试宣称“供应商已删除”。

### O10 · P2：交付与状态文档需要一次收口，不需要更多平行计划

**证据 [S/D]**：根 Dockerfile 只装配 Web，infra compose 主要是依赖服务；Opening 运维文档列出 Worker/parser 包装缺口。README 当前段仍写迁移到 0021，而目录已到 0038；TODO 与部分历史审查基线较早。根目录未见 LICENSE、CONTRIBUTING、SECURITY。

**最小优化路径**：

- 以一次空机启动检验 Web＋Worker＋Python/model cache，不把 Web `/api/health` 当作 Worker 正在消费的证明。
- 在既有 continuation/operations 中区分已实现、最近验证、待用户验收；不将本报告变成新权威账本。
- 开源分发前由负责人确认许可证、模型/依赖分发条款与安全反馈方式；个人本地开发不因此停工。
- 迁移没有 down 文件不自动构成缺陷。破坏性变更用已记录的前向修复或恢复方案，必须能演练；不要机械生成不可逆数据的伪回滚脚本。

## 4. 深度调研：需要回答具体决策，而不是继续收集工具名单

承接现有 [R01–R08 研究队列](opening-plan-research-backlog.md)，不再扩展一套 R09+ 编号。以下是建议深化方式，**不是已经完成外部研究**。

| 主题 / 优先级 | 真正要决定的问题 | 最小实验、指标与停止条件 |
| --- | --- | --- |
| **R01 解析 / 高** | 数字 PDF、扫描件、PPTX、手写公式分别能可靠提取什么？公式增强是否值得额外资源？ | 同一批授权/合成页比较轻量文本提取、当前 Docling、按需页图。分别统计物理页定位、关键符号错误、人工修正负担、每页耗时和峰值 RSS。符号可靠性不足则保留原件＋请用户确认，不把“非空文本”算识别成功。 |
| **R02 模型与路由 / 高** | 固定合格模型是否比多模型任务映射更好？hint/explain/listen 的质量标准是什么？ | 固定题集盲评提示越级、数学错误、引用支持、拒答；延迟/费用包括失败和未知预留。固定模型与显式路由比较，只有重复结果支持收益才升级；模型自评不能替代人工判定。 |
| **R02 多模态与账单 / 高** | 具体 endpoint 能否实际接收页图、返回结构化答案与 usage？未知调用能否查询？ | 当前 `packages/ai/src/opening/provider.ts` 明确拒绝非 text_only，先验证真实图像授权传输、公式识别、usage 字段、价格/币种/版本和无 usage 路径。无预算授权只测 fake 网络故障，不调用付费服务。 |
| **R03 检索 / 高** | 中文问题＋英文材料＋公式编号，关键词基线失败在哪里？全文/BM25/混合召回哪个真正改善？ | 先标 gold source/page/chunk 及“无答案”查询，训练/调参与留出集分开。报告 Recall@k、引用语义支持、拒答、P95 和重索引成本；先最便宜的基线，不因文档数量达到某值就上 pgvector。 |
| **R04 学习价值 / 高** | 用户得到答案、带帮助完成、独立解题、延迟迁移，能否真正区分？ | 由学科人员核验题面/参考答案/变式，记录帮助曝光、题族与时间；观察延迟新题、漏测和用户负担。单用户先做时间序列/重复任务比较，不宣称群体因果收益或全课程掌握率。 |
| **R06 恢复与容量 / 高** | 数据库状态、BullMQ、S3 之间哪些操作可以安全重放？真实机器能承受多少并发？ | 明确 enqueue/commit/模型送达/写回各窗口，做 kill/restart、Redis 中断、对象缺失与接管实验。先证明唯一业务结果和未知费用可追踪，再测 backlog、pool wait、RSS、恢复时间；不先建设工作流平台。 |
| **R07 隐私与部署主体 / 高** | 单人自托管还是共享服务？谁管 key、endpoint、费用和删除？不保存承诺覆盖哪些系统？ | 画真实数据流，核具体供应商 endpoint/账户等级的保留、训练用途、区域条款；用合成 canary 查应用落盘。BYOK 只有确需网页管理时才研究加密主密钥、轮换、SSRF 与租户隔离。 |
| **R05 记忆调度 / 后置** | FSRS 是否适合当前内容？BKT/IRT 是否有足够题目与纵向数据可辨识？ | 保留规则基线，将记忆卡与理解/证明题分开；按时间和题族隔离数据。具备概率输出才评估校准/Brier 等指标，另报延迟表现和复习负荷；数据不足不训练个体模型。 |
| **R08 日程与 Today / 中** | 真问题是估时不准、计划太多、时间未知，还是贪心排程不足？ | 用真实约束及冲突集测硬约束、超预算、遗漏与计划变动；由用户记录找到下一步、拒绝计划、跨课切换的困难。只有重复出现基线无法处理的冲突才比较求解器；不以完成任务数量代替学习收益。 |

### 三个贯穿研究的关键约束

1. **问题身份比掌握分数先行**：同题、同技能新题、看过答案与未见变式必须可区分。已有 attempt/help/provenance 能力应先验证完整，不为新模型另造学生画像。
2. **引用存在不等于支持结论**：现有 source/version/chunk 身份验证应保留；后续重解析导致锚点失效时，先定义迁移与失效展示，再决定是否需要更复杂 CitationIdentity。不能仅为“稳定”新增一层 hash。
3. **体验研究与运行测试分工**：用户完成浏览器/手机上的上传→指定材料→提问→引用→隔天续学；Agent 可做数据/协议/纯规则检查。未收到用户结果就写“待用户浏览器验收”。

研究结果应更新到原 R-ID：原始来源/版本、支持证据和反例、样本与硬件、实际结果、采用或回退决定。已有文档中的论文、价格或版本主张本轮未外部复核，不照抄成新的已证结论。

## 5. 需要撤回或降级的初步判断

以下校正用于防止把本次长时间探索中的猜测写进后续计划：

| 初步判断 | 校正后的结论 |
| --- | --- |
| BullMQ 没写 extendLock，超过默认锁时长就必然重投 | **不成立。**已核对安装的 `node_modules/bullmq/dist/cjs/classes/worker.js`：Worker 默认有自动续锁逻辑。O01 指的是另一层数据库心跳/接管与故障窗口，不是 BullMQ 缺省不续锁。 |
| 默认预算 0 导致无限调用；ephemeral 默认允许 100000 cents | **不成立。**模型目录把 cap≤0 标为 budget_disabled；ephemeral 的 100000 是测试 override 路径的备用值，生产读取目录。不能作为生产绕过证据。 |
| Worker config 价格是 0，因此实际费用结算永远是 0 | **不成立。**生产 `resolveTutorModel` 提供所选模型和价格，`tutor-turn` 优先使用该结果。缺 usage 也不是自动按 0 结算。 |
| 所有跨用户测试缺失；所有 Opening browser spec 在 CI 跳过 | **过度概括。**已有负向测试；CI 缺口限定为未选择隔离配置及带条件的工作流/重定向用例，不抹去 shell/upload 等覆盖。 |
| 本地始终无 PG/Redis/MinIO，备份只有预检 | **已过时。**9 月 25 日运维记录已有隔离服务与导出验证；本轮没启动它们，不能断言当前可用或不可用。恢复 apply 仍需独立证明。 |
| 历史 planner 的反例就是当前 Opening planner 的 bug | **未建立调用关系。**Opening `plan-service.ts` 使用 `planDay`，不是旧 `buildTodayPlan`；旧反例应在复用旧模块时处理，不当作当前 Opening 已复现故障。 |
| React 19 违反“React 18-compatible syntax”；大文件均违反硬性 200 行上限 | **不成立。**兼容语法不等于锁 React 版本；当前根约定把约 200 行视为职责审查提示，不要求机械拆分。 |
| 已确认 Next 15.5.21 存在某个特定未修漏洞 | **本轮没有完成这种确认。**只核定锁定版本；历史设计文档的外部安全基线主张需回到官方公告和可达路径核验。 |
| 无 down migration、无 Sentry、没有 CSRF token 都是漏洞 | **不成立。**应分别检查可恢复的升级方案、实际可排障能力、现有 cookie＋Origin 保护；工具名称不是安全或质量证明。 |

此外，Feishu adapter 当前需要注入 transport；生产装配只传 credential，故“填 key 就能外发”不成立。它属于已知未启用连接器能力，不应误报为已发生提醒丢失。Python 解析采用一次性子进程，线程 join 超时也不能直接推导成常驻服务持续线程泄漏，须检查子进程退出/清理链路。

## 6. 建议推进顺序与验收方式

| 顺序 | 一次交付的切片 | 交付证据 |
| --- | --- | --- |
| 1 | **O03 readiness 正确聚合＋真实最小探测** | 空/缺检查反例变为失败态；真实不可达和 worker 不消费可识别；最近 tooling 单测及实际探测结果 |
| 2 | **O01 一个恢复窗口**，优先临时 enqueue 失败后重驱 | 定向 Worker 单测＋隔离 Redis/PG 故障注入；不同时改全部状态机 |
| 3 | **O02 Opening 恢复执行与演练** | 空目标恢复、删除不复活、中断/重入与回滚记录；必要人工确认，不使用用户数据库做测试 |
| 4 | **O04 只读费用账本**，并行 **O06 公网边界** | 真实账本关联、未知状态解释、限流/请求体/权限负例；不先开放 BYOK |
| 5 | **O05 一条列表分页链＋O07 CI 覆盖收口** | 分页性质回归、测量数据、绑定 SHA 的 CI；浏览器仍待用户验收 |
| 6 | **R01–R04 一门课的评测闭环** | 授权样本、人工依据、失败清单、延迟独立结果；再决定多模态和检索升级 |
| 7 | **O08/O10 按热点重构和包装交付** | 行为保持回归、空机启动与已有门禁；研究不佳则保留简单方案 |

不建议按“再审查全仓库→再写总计划→重新实现已存在 RP 修复”的顺序推进。也不把待用户浏览器验收当成所有开发的前置阻塞。

## 7. 本轮实际检查与复核入口

### 实际执行与未执行

- [E] `git rev-parse HEAD`、差异文件/状态核对；任务 JSON 计数见第 2 节。
- [E] `graphify query "opening worker recovery backup restore readiness pagination model routing"` 成功返回子图，但 542 节点结果被截断；仅用于定位，结论回到源码核对。
- [E] readiness 纯函数反例已执行，输出见 O03；**证明当前不理想行为，不是修复测试通过**。
- [E] 文档检查：`Markdown check: PASS (1 file, 16 local links, 2 fenced blocks, no trailing whitespace)`。新文件 `git diff --no-index --check` 未报告空白错误；退出码 **1** 表示与空文件存在新增差异，不记作退出 0。另提示 Git 后续可能将 LF 转为 CRLF。
- [E/T] 按仓库约定执行一次 `timeout 180s graphify update .`，退出 **124**（超时），未盲目重跑。日志显示 1415/1415 文件 AST 提取完成，但整体更新未确认完成；另有 39 个 SQL 文件缺 `tree_sitter_sql`、8 个文件无节点及社区标签变化警告。**缺 SQL 依赖不等于超时根因**，本轮未定位后续阶段耗时，未安装依赖或启用付费标签生成。
- 未运行产品 unit/integration/handler 全套、lint/typecheck/build、浏览器、模型或恢复演练；纯文档交付仅做文档与 diff 检查。不引用历史通过数充当本轮结果。

readiness 反例可在仓库根用 Node.js 复核，无服务、网络、密钥或数据库操作：

```bash
node --input-type=module -e 'import { buildReadinessReport } from "./scripts/opening-readiness.mjs"; const env=Object.fromEntries(["DATABASE_URL","REDIS_URL","S3_ENDPOINT","S3_BUCKET","S3_ACCESS_KEY_ID","S3_SECRET_ACCESS_KEY","ALERT_WEBHOOK_URL"].map(k=>[k,"synthetic-value"])); const r=buildReadinessReport({env,checks:{}}); console.log(JSON.stringify({probe:"empty-checks-with-configured-strings",ready:r.ready,checkCount:Object.keys(r.checks).length,alertDelivery:r.alertDelivery}));'
```

### 既有文档入口

- [Opening 总计划](../superpowers/plans/2026-09-12-opening-release-implementation.md)与[personal-use 执行映射](../superpowers/plans/personal-use/execution.json)：沿原任务推进，不修改范围。
- [PA 计划审查](opening-plan-audit.md)、[真实使用审查](opening-real-use-audit.md)、[9 月 21 日审查综合](../plans/2026-09-21-review-synthesis.md)：保留历史发现，使用本轮源码校正现状。
- [研究队列](opening-plan-research-backlog.md)、[算法地图](../brainstorm/ALGORITHM_MAP.md)：研究结果回写原入口。
- [全栈演进设计](../design/2026-09-20-opening-frontend-review-plan.md)：可观测性、引用和检索方向是建议，不自动等于新任务批准。
- [Opening 运维](../operations/opening-release.md)、[迁移操作](../operations/database-migrations.md)、[CI 说明](../operations/ci.md)：发布/恢复以对应 SHA 与实际运行证据为准。
