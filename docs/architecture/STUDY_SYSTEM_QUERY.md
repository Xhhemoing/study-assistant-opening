# Study 系统查询基础模块（设计对齐候选）

2026-10-19，基于 `b140d548`，目标分支 `feat/opening-release`。基础模块由 PR #69 交付；后续 `feat/study-query-evidence` 接入保存/临时聊天及显式查询开关，默认关闭，仅使用固定规则，不发起模型请求。这些切片不等于新架构已验收。自学、串讲、拔高仍须复用原教学 workspace/compiler，等待统一研究设计；没有第二套教学实现。

## 已实现边界

`contracts/opening/system-query.ts` 定义固定工具参数和结构化查询回执。`ai/opening/system-query-agent.ts` 负责选择、限额与展示；`database/repositories/opening-system-query*.ts` 是 SQL 唯一所有者。应用应从认证会话绑定 owner/workspace，再创建 reader，不能使用模型提供的作用域。工具没有 SQL、文件路径、写入或执行入口。

| 工具 | 返回的事实 | 明确保留的限制 |
|---|---|---|
| courses | 本工作区未归档课程、已保存目标字段与修订 | 不读取任意 milestone 文本；目标不证明达成 |
| learning | 有效 observation head、attempt/item 身份、当前资格、实际帮助 | 聊天不释放答案；过期投影不修复；失效祖先不返回派生记录；无掌握率 |
| recommendation | 同一技能/requirement 内调用既有 `nextLearningStep` 的规则依据 | 仅完整且不超过 10 条当前证据时推导；未读到期复测或 compiler，始终标部分结果；不是已接受的计划 |
| materials | 当前可用版本、真实 chunk/物理页与定位链接 | 聊天不释放正文；排除跨工作区/隐私撤回/不可用版本/未解析正文；服务端显式 source_review 用途才可取节选，曝光尚未判定 |
| planning | 指定本地日期已接受的计划版本、时段及任务状态 | 不生成/接受计划；派生标题和理由在未接入完整祖先许可前隐藏 |
| jobs | 本人 background/tutor 任务的真实状态和更新时间 | 不返回 payload/result/内部错误；成功不证明内容质量 |
| settings | 已保存的非秘密路由；调用进程明确注入的功能开关 | 不读取密钥、vault、环境全集、内部 prompt 或安全配置；不把保存路由等同真实模型可用/另一进程已生效 |
| teaching | 已有活动状态、生成状态、路径/内容版本 | 不返回隐藏答案、intent/body；排除撤回/不可用来源；元数据不证明教学质量 |

学习查询直接复用已有 `openingEligibilityStateQuery` 的策略版本、head、水位和 live source/help/privacy 依赖。0038 已有可重建资格投影及 CAS 修复，本模块没有另建投影，也不会调用会修复的摘要 reader。实际帮助采用同一 `resolveEvidenceAssistance`；普通 revision、人工自报不获得 deterministic 或独立复核权威。活动规则只在完整证据内按 skill + requirement 分组，不跨要求混算。

每次数据库读取处于 repeatable-read/read-only 事务，每条 SQL 最多 2 秒。读完再次检查隐私 epoch；Agent 在读前、读后、返回前检查认证上下文仍有效。回执携带 asOf、查询版本/水位、实体修订和实际 source/version lineage。版本未知、无匹配、权限/依赖不可用、过期、截断分别可见。offset 是当前快照的有界分页，不保证跨轮同一快照；不能拿两轮分页之和作为完整统计。

## 有界模型协议

Provider 使用标准 OpenAI-compatible `tools` / `tool_calls` / `tool_call_id`；验证注册名称、调用 ID、完整参数、回执配对，普通聊天拒绝未请求的工具调用。模型只选择查询步骤，其自由文本不进入权威答案；答案由服务端实际记录的摘要和证据链接构成。材料正文是非可信数据，即使包含指令也不能改变注册表、作用域或增加写权限。

单次查询最多 2 次 `callModel`、4 个实际工具调用、12 秒总等待、60,000 字符的完整模型输入、每份回执 10,000 字符、累计回执 24,000 字符。重复规范化参数停止循环；预算截断时同时丢弃正文和其 lineage，不产生缺失来源的正文。授权检查同样受等待上限约束。数据库取消是协作式，已经发送的只读 SQL 仍受 2 秒 statement timeout 限制。

没有模型、工具协议不受支持、模型无工具调用时，采用明确标记的有限规则读取；歧义课程不猜 ID。调用者没有注入 callModel 时不会发送模型请求；后续 runtime 负责安全配置与授权。本模块没有绑定任何真实模型，不会读取环境中的凭据。

这些是次数/大小/时间上限，**尚不是父交互费用预算**。后续 runtime 必须接既有 model gateway/ledger，并为每轮派生稳定 operationId；gateway 如使用一次显式 fallback，最多可能产生 4 次 provider 请求，不能把 2 次 callback 误称最多 2 次网络请求。未知结果不能自动重发。当前 provider usage 仅有 prompt/completion token，不能宣称已核算所有厂商的缓存/推理计费。

## 交付约束与后续设计

1. **交付及隐私契约。** 保存聊天在既有 completeTurn 原子事务保存回执及完整 contextSourceRefs；临时聊天只保留来源元数据，不落问题/答案。两者不把旧 history 交给查询规划器，epoch 变化时撤回旧结果。querySystem API、0074和 UI 开关在后续聊天切片同步新增，关闭时明确拒绝。
2. **实际曝光。** 材料节选可能含答案，历史作答展示也可能影响再次测量；显式 source_review 回执标 `exposure: not_assessed`，聊天 record lookup 则 withholding 正文。释放正文前，应用交付层必须复用真实帮助/曝光回执；服务端 release 与客户端 ack 必须分开，DB 提交不能原子证明 HTTP 已交付，release 先保守阻断当前独立。未解决前不可将正文查询接入正在采集独立作答的评估流程。当前无帮助、历史同题曝光和迁移新颖性是不同条件，不允许换机会洗题，也不能把正常复习永久当 assisted。
3. **预算与回放。** 父交互需统一预留/结算上限、每轮稳定标识、未知结果处理、查询快照何时刷新；不能把旧回执当当前状态，也不能以一次 operationId 代替整轮预算。
4. **决策证据。** 后续应让建议读取已保存的 decision/compiler 版本及依据，而不是把此处部分规则解释升级为完整教学策略。机会、答案修订、内部 measurement 重判和端到端重放关联进入统一证据契约；旧 answerRevision 的迟到可信重判可重算原始首答测量视图，但不能覆盖当前答案视图。有效 Assessment 按可信渠道、版本和撤回政策选择，最新自评/模型不能覆盖可信判分；普通 revision 不得借此提升权威。教学挑战池不能复用冻结评测留出池。

接入保存/临时聊天后，两条路径均须覆盖 `OPENING_ADAPTIVE_PLANNING=0/1`；基础系统查询不依赖规划开关。运行进程设置不能冒充 worker 的设置。自学/串讲/拔高仍使用现有教学编译与活动记录，分别保留接触、辅助完成、独立成功、延迟保持与迁移证据，不能仅凭四个资格 flag 宣称这些阶段完成。

## 验收范围

单元/协议测试覆盖注册表、非法/跨作用域参数、模型伪造正文、原生调用配对、重复/上限、挂起授权、取消和隐私变化。真实 PostgreSQL 测试覆盖课程/目标、fresh 与 stale 资格、实际帮助、revision 后的来源撤回、按技能的规则解释、材料物理页/节选、两类任务、非秘密设置及规划开关 0/1、已确认计划和教学元数据。

无写入调用图为 `SYSTEM_QUERY_TOOLS → runSystemQuery → createScopedOpeningSystemQueryReader → read-only transaction → fixed SELECTs`；学习分支另读 `openingEligibilityStateQuery / readOpeningLearningEvidenceContexts`，调用纯 `resolveEvidenceAssistance / summarizeObservations / nextLearningStep`。不调用 `readOpeningCourseLearningSummary` 或任何 repair/command repository。真实 PG 逐一运行八类工具，检查 transaction_read_only=on 及 pg_stat_xact_user_tables 的执行前后写计数增量为零；另检查 stale policy 未被修复。

代表性问题包括“我现在学到哪里”“为什么建议我继续诊断”“原文在哪一页”“后台任务成功了吗”“什么模型设置已生效”“今天的计划是什么”。当前测试验证真实数据与安全控制，mock 模型只验证协议和调度，不验证模型选择质量、回答效果或学习收益。后续聊天切片的独立审查、完整 CI 和用户浏览器验收另记；真实 API 由主线程安全交接后单独测试。M4 的 2–4 周受控学习试验不能当日完成。没有生产数据写入或部署。

## 与统一研究稿的对应及偏差

已读取 Library `libfile_3289c6deab3c8191a83e58ffa13831ae`《Study 智能学习系统架构设计 2026-10-19》全部 1379 行/22 页文本。此文件是其 A0 查询 PR 的实现映射，不替代统一计划，不把研究稿当验收。

| 统一报告要求 | 当前对应文件与状态 | 下一增量 |
|---|---|---|
| owner 授权、纯读取、数据源可信边界 | `opening-system-query.ts`、`opening-system-query-learning.ts`；复用现有投影、纯 domain 逻辑 | 当前仅 owner，不声称已有共享 role/ACL、冻结留出池用途隔离；接入前验证所有检索源的用途及祖先版本准入 |
| EvidenceBundle 的 purpose/permissionRevision、可信级别、cursor | `contracts/opening/system-query.ts` 现有回执带 epoch/水位/来源/实体修订和完整性 | 兼容适配统一 EvidenceBundle；明确 owner/用途及精确证书只覆盖所声明域；offset 尚不是跨轮绑定快照 cursor |
| 当前答案/原始首答测量分离、可信 Assessment 选择 | 当前查询只读 effective head 和既有资格，不实现新测量归约 | A1–A3 扩机会/答案及测量修订；迟到可信重判修正原始首答，不覆盖新答案；自评/模型不覆盖可信评分 |
| release/ack、独立/历史曝光/迁移新颖性 | 聊天 record lookup 仅元数据，正文/答案 withheld；显式 source_review 仍未接入聊天 | 释放正文前完成 release/ack；不以数据库提交证明客户端收到；挑战池与正式测评池隔离 |
| 完整 provider receipt 与父交互额度 | `provider.ts` 支持原生 calls；`system-query-agent.ts` 有次数/字符/时间上限 | C1/C2 补结束原因/原始 usage/真实超额与晚账务，再由 C3 接 gateway，不能误称已有父预算 |
| 两轮/四工具、真实 tokenizer 与能力表 | 当前代码常量为两轮/四工具，字符预算；不支持时有限预检索 | 已统一报告的两轮起点；能力表、真实 tokenizer/usage 和质量验证仍待完成 |
| 查询实际闭环、单元三模式 | PR69 是后端基础；后续切片接现有聊天/API，含0074，固定规则且默认关闭 | 原生模型接线仍须 C1/C2；三态/唯一 reducer 及核验内容通过 A1–A4/B1–B3 后，沿 B4/A5 复用原 compiler/workspace 接一个单元三模式；本轮未实现这些后续能力 |

2026-10-19 独立审查修复：未接受的 version 0 计划返回 unknown；教学引用取与 contentVersion 匹配的已发布 spec.source_refs，并核对该确切版本的可用性，缺 spec/版本不猜当前版本。八类结果改为精确 schema 的判别联合，拒绝额外字段、虚构工具名和非法资格。末次权限查询也使用只读事务、2 秒 statement timeout，全读取链受 12 秒截止控制，并在 await 后复查取消；native calls 仅接受成功的 tool_calls 结束状态。定向 76 项 unit、17 项真实 PG 与 Contracts/AI/Database 类型检查通过；独立复审和新 head 的完整 CI 仍需另核对。

后续证据切片：所有回执绑定服务端 purpose、workspace/principal、owner 角色及 permissionRevision（owner grant身份与privacy epoch，不冒充通用ACL计数器）；查询不接受模型改变用途/主体。逐根读取完整修订祖先的捕获版本，未知版本不使用今天的版本代填；祖先版本变化、不可用或捕获缺失时不返回派生记录。默认 system_record_lookup 不释放材料正文/历史答案；source_review 仅为服务端显式用途，不接入聊天。两轮调度与权限/用途不匹配反例已覆盖；严格输出契约与PR69审查修复共同保留。

## 保存/临时聊天切片（待独立审查与CI）

`OPENING_SYSTEM_QUERY=0` 是独立于 adaptivePlanning 的服务端默认值。开启后，经认证的 capabilities 才显示“查询系统记录”复选框。只有显式 querySystem=true 才进入查询路径；关闭开关时两条 API 返回409，不把查询意图退回普通模型聊天。同一 clientKey 不能在查询与普通意图间重用。现有普通聊天增加“历史内容不证明当前系统状态”的提示。

保存路径沿现有 conversation/turn/job，worker 在 RAG、记忆、教学帮助、模型路由及预算前分流；查询成功在现有事务内保存文本、完整 context_source_refs 和严格 receipt。接收回执前重核 owner、privacy epoch、确切来源可用性及 intent，取消/撤权任务不能发布旧结果。回执是 asOf 时刻的记录快照，重开聊天不是重新查询。AI 排除保留用户历史，材料删除则沿现有规则同时隐藏衍生文本与 receipt。

临时路径在加载模型 catalog/存储/预算前分流。0074 新表只保存 owner/workspace、request id、epoch、来源版本、时间戳，不保存问答/候选/学习记录，不伪造0元模型账单。24小时后历史准入立即失效；worker 维护任务每轮最多删除1000条过期元数据。该记录只证明服务端准备了回复，不证明 HTTP 送达。它不进入备份/恢复；保存聊天的 query intent/receipt 进入现有备份，并验证授权作用域、完整 lineage 和受保护正文禁令。

生产默认只运行有限意图规则，receipt 明确 `mode=deterministic / native_tools_not_enabled`，不读取密钥、不发起真实模型请求，不以缺密钥为模型失败。材料查询先选择一个来源和物理页，或用引号提供原文关键词；多份材料匹配会要求选择，不按整句猜检索词。规划支持一个真实ISO日期及今天/明天/后天/昨天等明确相对日期，以服务端工作区时区解析；无日期、无效日期、星期或范围表达要求补充，不静默查今天。课程绑定优先来自保存会话或显式临时课程，并由实际 SQL 重新鉴权；未绑定时只允许从未截断且自第一页起的实际课程候选唯一解析，不能把最后一页单条当作全库唯一。“我有哪些任务”要求区分后台状态与某日学习计划，不把后台成功等同学习完成。不覆盖任意系统问答、全部待办汇总、notes、复习队列、历史材料正文、费用汇总或持久化决策。

验证包括真实 PostgreSQL 的 saved/ephemeral 闭环及 adaptivePlanning=0/1、幂等与意图冲突、无模型/RAG/预算调用、只存临时元数据、24小时过期、来源变化/撤回/owner变更、查询到写回间的privacy竞态、资产删除隐藏、真实备份执行器往返。HTTP 覆盖显式查询、非法类型/伪造作用域、关闭开关与 no-store。PR69 的 `fa322b89` 完整 CI39216797557成功；不能将它当本后续切片的CI结果。

部署前即使开关为0也须先应用0074（普通读写已使用新列）。回滚：先关闭开关并停止新提交/worker，取消排队查询并完成或取消正在运行的查询，再启旧 worker；旧 worker 不认识 query_system，不能让它消费遗留查询。保留新增列、表及已有来源元数据，不执行DROP或删除生产记录。关闭开关与回滚均不改变已保存的学习/费用数据。本轮未部署。

用户浏览器验收待完成：在测试环境迁移0074后分别以 OPENING_SYSTEM_QUERY=0/1、OPENING_ADAPTIVE_PLANNING=0/1 登录 `/opening/assistant`；检查开关关闭时无复选框，开启后查询“模型设置”、绑定课程的“我的作答核验了吗”、所选材料“在哪页”，切换保存/临时并刷新。预期可见 asOf、真实记录/定位链接及限制说明；无答案正文、学习记录或模型费用新增。保存模式重开显示原快照，临时模式刷新不恢复问答；重新查询才获取新状态。截图、视觉及交互由用户完成。

### PR70 独立审查修复：恢复与临时保存

回执的 data、evidence（含定位URL）中每一 source/version 均须属于本结果 sourceRefs，再完整归入外层 context_source_refs；链接不允许重复/冲突来源参数。恢复只接受 system_record_lookup，禁止把 source_review 或其节选伪装成保存聊天。删除日志的 opaque 扫描包含整个 system_query，不能通过清空外层refs隐藏已删来源。旧异常JSON的历史显示会保守隐藏，素材删除检测也扫描嵌套来源及链接；列表摘要不展示未经核实的查询正文。查询快照不进入普通模型历史，避免旧导入回执被当作当前状态。

临时查询的24小时provenance只用于历史准入，本批不支持据此存笔记或做卡片：消息携带明确类型，两个按钮禁用并说明原因，草稿准备也拒绝，不再误启用后返回NOT_FOUND。复制仍可用；需要保留查询时选择保存会话。普通临时导师消息的显式保存路径保持原有授权/来源校验。

真实PG反例覆盖 lookup隐藏已删来源、source_review节选、仅URL引用、无journal的schema-valid source_review、实际恢复拒绝/安全恢复读取，以及旧JSON来源仅在data/evidence/href时的删除后隐藏；两项临时保存操作有非浏览器回归。日期默认今天、多对象定位与受控意图解析另属本轮新增审查范围；未修复并复核前不把固定规则称为任意系统问答。

### PR70 F3：有限意图解析与受控 planner 接线

`system-query-intent.ts` 负责有限问法、相对日期及明确不支持/追问；`system-query-routing.ts` 负责日期、当前绑定、唯一候选的语义准入，PR69 engine继续负责八类严格schema、权限用途、来源、取消及两轮/四工具限制。原生planner提出今天替代明天、猜选课程/材料、替换绑定版本或用非首页单条伪装唯一对象时，服务端拒绝，不执行那个读取。未知问法在未提供planner时明确追问，不默认改查课程。回执新增可选clarification并显示提示。

`createDbSystemQueryService(...,{planner})` 与 ephemeral runtime 的受信构造选项现在把callback接入原PR69 `callModel`；HTTP输入不能注入这个选项。planner获得服务端日期/时区/绑定和实际工具结果，不获得旧history；自由正文仍不成为答案。测试用模拟模型走真实PG的saved Worker handler与ephemeral runtime，两轮实际读取并验证错日期/对象/权限边界。**生产bootstrap仍未注入模型gateway**，也未读取任何真实密钥；真实模型、供应商协议/质量、完整provider receipt、原子父预算及晚账务仍属C1/C2与并行升级计划后续，不由模拟通过证明。

并行协调：`codex/study-upgrade-20261019@ad4c668` 基于本PR的93e455f5；复用相同0074 blob，本批不占其计划的0075–0078。后续W1.7需保留19ac815恢复/临时保存修复及本F3路由改动，不能从旧93快照覆盖。仅核对该仓库合法远端refs，未访问其他私有会话目录。
