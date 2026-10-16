# 学习闭环剩余实施计划与验收机制

基线：2026-10-16，`feat/opening-release`，`cb5a68c42f82a2e127e736afca8ca83cdf15c3ae`。已合并基线的最终完整 CI 为 38911719890。Astra 子代理负责研究与独立评审，Codex 主代理编写和验证。本轮没有运行本地浏览器或调用付费模型。以下“已实现”只表示代码存在并已读过，不表示 Hermes 部署或真实学习收益已验收。本计划是后续切片的执行顺序，不是全部已交付的声明。

## 一、实际实现矩阵（编码前基线）

| 能力 | 状态 | 已有源码证据 / 真正缺口 |
|---|---|---|
| 作答、核对、观察修订及有效 head | 已实现 | `packages/database/src/repositories/opening-learning-attempts.ts`、`opening-learning-observations.ts`、`opening-observation-revisions.ts`；资格由 `packages/domain/src/opening/evidence-eligibility.ts` 判定。自述/模型建议不等于 verified；修订不覆盖原记录。E1 自动数学评价不是此资格 evaluator。 |
| 要求与当前版本隔离 | 已实现 | `adaptive/skill-identity.ts`、`adaptive/assemble-snapshot.ts`、`planning/learner-snapshot-service.ts` 和 0065；以 course/requirement/label 组合，未归属的历史独立保留。并非稳定跨版本技能身份。 |
| 观察→规则草案→选择确认→任务→学情主讲 | 已实现 | `adaptive/propose-tasks.ts`、`planning/adaptive-draft.ts`、`planning/plan-service.ts`、`opening-plan-accept.ts`、`teaching/activity-service.ts`、`apps/worker/src/runtime/compile-teaching-unit-wiring.ts`。未确认不建任务，snapshot 输入与版本已参与草案比较。 |
| L5 开始、完成、跳过 | 已实现基础 | `task-row-actions.tsx`、`task-status-control.tsx`、`task-status-action.ts`；卡片和补测单独执行流；OCC、未知结果先核对、旧响应保护已有。尚无结构化反馈原因与事件历史。 |
| L5 推迟 | 部分实现 | contracts `planning-tasks.ts` 已有 `notBefore`/`taskDeferInputSchema`；PATCH `/api/opening/tasks/[id]` 分流至 `plan-service.deferTask` 和 `opening-plans.ts:231`；前端行入口尚缺。 |
| L5 不适合 | 部分实现 | `adaptive-draft-preview.tsx:58` 只执行 `select(key,false)`；理由、跨刷新持久性、后续建议适应均未实现。不可将取消勾选计作负面学习证据。 |
| L5 低打扰/局部重排 | 部分实现 | `shouldOfferReplan` 纯函数已有，应用未接；`hasNewerSuggestion` 已防自动跳变。`plan-service.ts:443` 有源修订 delta adapter，但只排选中任务并生成全日草案，未保留其他已接受块，无公共 delta route；直接接它会丢安排或产生冲突。 |
| 负担规则 | 已实现一部分 | `propose-tasks.ts`：最多3条、80%空余容量预算、同日去重、连续2天跳过减半、3天暂停。历史只有 status，尚不能区别学生跳过与系统撤销。 |
| L8 三组指标 | 未实现专用闭环接口 | 旧 `settings/diagnostics-panel.tsx`、通用 `contracts/diagnostics.ts` 与 budget/job 记录可复用；没有专用 loop-metrics、统一口径及历史反馈。不可把 mock diagnostics 当真实 opening 指标。 |
| E1 窄题自动评价 | 未实现 | 已有 reference self-check、observations/revisions、资格与 source lineage，是接入基础。不存在矩阵维数/运算评分器与服务器自动评价事实通道。 |
| 阶段成果 | 未实现 | `courseGoalSchema` 只有 targetDate/weeklyMinutes；`course-goal-form.tsx` 已能编辑它们。分钟属于投入，不能代替阶段能力成果。 |
| L3b 教练自动确认/撤销 | 部分实现 | prefs 有 coach 与预算；`adaptive/autonomy.ts` 的 decideCoachAutoAccept 有测试但无生产调用。缺 POST/worker 接线、关闭来源、受条件限制的撤销、摘要；GET 不得加自动确认。 |
| L7a 对话→同一可确认草案 | 部分基础、链路未实现 | tutor 已输出 task/memory candidates，`apps/worker/src/jobs/tutor-turn.ts:295` 按模式过滤；已有 action digest/source delta、PlanDraft 接受拒绝。对话没有已确认计划/课表的有界只读上下文和统一 structured intent→PlanDraft 转换。不是从零重做候选机制。 |
| I2/BKT | 接缝已有，基础事实缺口由另一会话负责 | `estimators/types.ts`、`skill-evidence.ts` 保留 firstAttempt:null；rules estimator 可复用现行资格。尚无稳定 skillRef、服务器首次作答、shadow持久预测。另一会话当前负责这些及独立延迟测验/实验日志，本轮不抢写。 |

关键路径：L5反馈事实 → L8可核对分母/负担观测 → 小范围低打扰重排 → 真实使用反馈 → 教练开关。E1可在独立窄题范围并行准备；I2接口由另一会话交付；L7a和教练都复用经过验证的同一接受事务。不得自动合并 #51/#48/#46。

## 二、分阶段编码计划

### S1：L5a任务反馈与推迟（本轮编码）

用户结果：完成可直接标记，跳过/推迟可选一个原因；推迟至工作区明天；刷新后事实仍在，未来诊断能区分“没时间”与“不合适”。不改变学习观察或已接受计划。

1. 扩展 `contracts/src/opening/planning-tasks.ts` 既有 status/defer 输入，可选 `feedback.reason` 枚举（建议 time_short/too_hard/too_easy/not_relevant/other/prefer_not_say）；无需必填自由文本。完成可不填，不能诱导学生把“完成”当作“掌握”。所有服务器归属字段禁止客户端设置。
2. 新建规划侧反馈表与 repository：workspace/owner、taskId、结果taskVersion、action、reason、server recordedAt；任务origin、suggestionKind、course/requirement由已锁定任务推导。唯一约束 `(task_id,resulting_version,action)`；旧客户端无理由时事件 reason=null。新 migration 号在编码时取主干最新且与 I2会话协调。可选原因与事件来自真实动作，不能回填历史未知原因。
3. 在 `opening-plans.ts` 状态与 defer 写事务中同时插事件；defer 需改为 transaction，状态/事件任何失败均回滚；沿用已有 workspace/learning/retest锁顺序，不引入反向锁。既有 OCC 重发可能409，应称“不重复写”，不能称“同请求重放200”。要提供成功重放必须显式增加clientKey+payload一致性并共用同一写路径，不能偷偷更换既有语义。
4. `task-status-action.ts` / `task-status-control.tsx` 接可跳过原因选择，队列任务的 `task-status-control.tsx` 加推迟入口，以共享同版本写入锁，客户端复用 PATCH；以 resolveLocalDayBounds(next local date) 求明日00:00。刷新通道复用 TaskQueueRefreshContext；版本/请求世代保护旧响应。
5. 新表同步补 backup manifest/read/apply、恢复、workspace删除/隐私策略测试。只存结构化原因和内部ID，不存答案/材料/聊天正文。
6. 检查就近 domain/web/database unit+handler/PG事务测试、受影响包typecheck和改动eslint；既有CI保留。应用回滚停用新增UI/反馈写入，表保留；只有确认无新数据才DROP，不在发布回滚中删反馈。

### S2：L5b建议“不适合”与局部重排

建议反馈独立于任务反馈：任务尚未创建时必须能保存。输入 `draftId, suggestionKey, expectedDraftVersion, reason, clientKey`；服务端从该owned持久草案取建议身份，拒绝客户端自造course/requirement。唯一请求键重放同payload成功、不同payload冲突；反馈只影响当前建议/短期抑制，同一技能其他要求不受影响。默认“不适合”只抑制当天，不永久判定学生能力；“太难/太易”先作为显式待调整偏好，不修改 mastery。

低打扰：shouldOfferReplan按服务器当前时间、任务、接受块计算，返回一个非模态入口；拒绝后相同计划版本/触发原因不反复提示；自然开始/结束节点展示。不要在GET自动接受或偷偷替换计划。请求重排必须显式POST，使用 server acceptedVersion 和受影响任务集合；部分外域ID不能被静默过滤成成功。

`plan-service.proposeDeltaPlan` 不能原样外露。新路径必须固定历史、进行中、用户锁定、未受影响未来块，先从可用时间减去固定占用，再planDay剩余候选，输出完整前后diff。确认事务在同一计划版本锁内核对固定块逐字来自当前accepted；本次移动块才做未来时段/未完成校验。现 `opening-plan-accept.ts:64–76` 对全体块做过期/pending判断，需明确固定块规则，否则拼回历史会失败。严禁客户端preserved标记绕过校验。优先实现可解释的最小变更，空余不足留unscheduled，不挤课表/睡眠/已开始任务。

首版不需要复杂优化器：保持未受影响未来块、只填补错过/释放时段已能完成最小闭环。上下移作为之后同一草案preview→确认的能力，不改变accepted直至确认。

### S3：L8三组诊断与真实使用采集

新增 `domain/opening/adaptive/loop-metrics.ts` 纯函数、真实scope聚合repository、`GET /api/opening/plans/metrics?days=14`（days有上限）、settings只读面板。GET不写表、不调模型；开关关保持原约定404。不是统一总分。

每项返回 value、numerator、denominator/sampleSize、windowStart/End、timeZone、metricVersion、dataStatus、excludedReasonCounts；零分母为null，“尚未采集”区别“0次”。分位数/中位数不伪造分子；明确样本数与单位。

| 组 | 可立即计算 | 需要未来采集/另一会话 |
|---|---|---|
| 运行可靠性 | 按job类型终态成功/失败/unknown；预算已结算花费与仍保留unknown分开；草案接受冲突按reason；评价拒判、恢复结果 | 请求级失败分母若无事件只能从新增采集开始，不能把现存成功行当全请求成功率；延迟需真实开始结束时间 |
| 学习结果 | eligible独立核对作答覆盖、unknown占比、需求范围内下一次合格作答等待时间；现行资格与版本理由 | 延迟独立新题/迁移结果、firstAttempt、预测校准读取I2/BKT只读接口；没有有效样本时明确“证据不足” |
| 负担与控制 | 完成/跳过/推迟/不适合原因；建议生成→确认比例；局部重排采纳/拒绝；建议总分钟与用户覆盖 | “展示→采纳”必须有展示事件才可这样命名；当前只能称生成建议采纳率；教练撤销率在上线后才有分母；主观负担按可选每周一次简短反馈 |

口径陷阱：同任务出现在多个accepted版本只计一次、草案重算同key去重、分母不得计未向用户提供的失效草案；若无法区分只报告明确“生成建议”口径。任务当前status不是某历史窗口当时status，反馈事件可重建新数据；旧数据标legacy/unknown。needs_review→下次作答延迟需报告未发生的右删失样本，不能只展示完成者中位数。自我核对与确定性评价分层呈现，不能均标“客观正确”。按当前版本资格重算的报告应标as-of时间，变化不算原始事实被篡改。

### S4：E1窄题确定性评价

先选矩阵维数、加法、标量乘法、乘法等可严格定义题型；数学规格必须结构化、版本化，不能从自由文本猜隐含条件。新增 `domain/opening/evaluation/*` 纯函数，输出 correct/incorrect/abstain + reasonCodes + evaluatorVersion；部分正确属于评价细节，不在未完成整体评价时伪造整题correct。整数/有理数用精确表示，浮点只按题目明确公差，拒NaN/Infinity/超大维数/解析歧义。

结果通过服务端评价适配器绑定现有 attempt、problem/itemVersion、requirement、原答案revision、材料版本。可信评分事实由服务器写，不能复用客户端可写的referenceCheck.method标签假冒自动判分；若扩展 verdictSource/资格policy应与另一会话共享接口协调，保持旧资格逻辑兼容。开始时版本与提交时/写回时版本都需核验，材料撤销后不落有效结论。评价与observation/revision原子接入，使用原观察链，不建平行学习历史。

拒判：unsupported_type、ambiguous_input、missing_spec、version_changed、resource_limit、conflicting_reference；写unverified并显示可手动核对，不能当错。争议先标评价不可用于后续资格，保留原始结果与争议；解决走现有revision重新计算有效head，不覆盖过去。学生要求改判不等于直接写correct。对于自定义/非结构化题，继续现有参考核对路径。

### S5：阶段成果

扩展 `courseGoalSchema` 可选milestones，先限小数量，id、title、目标日期可空、明确成功标准、可选scope引用；existing JSON prefs可容纳，不预设必须迁移。首版是用户可编辑成果与证据链接，不自动发“已掌握”证书。完成标准包括“何种独立表现/作品”；分钟/活动完成不自动达成。课程范围引用与材料资格由服务器验证；成果规则改变时保留已有证据和版本，状态重新待核对。旧客户端patch不能静默抹掉新增字段。

### S6：L3b教练

保持默认关闭；只有用户选择coach且预算明确时运行。复用 decideCoachAutoAccept，但通过显式POST或幂等worker，不在Today GET内。补 server closeSource=learner/system、acceptance origin与撤销信息；由同一accept事务执行，遵循学生确认/锁定不改、今日/预算/材料/时段资格。

撤销必须是条件事务：只撤销该自动版本产生且未学习、未关闭、未改动的任务和安排；出现后续学生操作则拒绝整批恢复或给明确受限差异，绝不复活已完成任务。系统撤销仍保留同日去重，但不进入连续跳过惩罚。并发undo/学习开始必须锁/版本序一致；摘要提供实际变更与剩余不可撤销原因。是否开放由真实负担观测决定，30%撤销率只是排查信号，不是科研阈值。

### S7：L7a对话进入草案

不做多步Agent。单次有界意图提取+服务器确定性校验：候选只含允许的任务/顺序/时间偏好，不允许模型生成可直接写入的courseId。服务器提供owned course候选及当前任务/接受计划/课表的必要摘要并映射ID；未知/歧义需用户选择。模型失败/超预算不写任务，仍保留普通聊天与手动入口。沿用runBudgetedCall、receipt、source/privacy admission与PlanDraft预览接受/拒绝，聊天只展示同一draftId/version，接受同样OCC。对话文本不直接变成长期偏好或学习事实。

## 三、I2/BKT接口与所有权

另一会话独占：稳定技能/单元身份、服务器firstAttempt、独立延迟测验、持久化事前预测/实验日志及相应migration/Attempt/Observation改造。本轮不实现替代历史、重复预测表或BKT参数。主代理只需明确只读投影接口，等合入后适配：scope、stableSkillRef可空、requirementKey、attemptId/itemFamily+version、submittedAt、firstAttempt三态、independence/当前版本资格、observation有效head、historyRevision；shadow预测含predictionAt/historyCutoff、modelVersion、probabilityCorrect、结果关联。

firstAttempt（该稳定题身份首次提交）与 independentAttempt（无已交付提示/答案）是两个事实；首次也可被提示，后续独立提交也不是首次。历史不能证明时null。BKT潜在掌握概率不等于下一题答对概率；仅shadow，不反写observation、不直接改调度、不自动免测。实时分析读其原记录，统计缓存可重算且无authority。

## 四、执行验收矩阵

| 面向 | 正例 | 反例/竞争 | 通过标准 |
|---|---|---|---|
| 权限 | owner在本workspace操作/读指标 | 别人task/draft/course混入；部分合法ID混合 | 全部拒绝、无半写、无外域信息泄露 |
| 反馈原子性 | 状态/defer与一条事件同时落库 | 插事件故障、并发done/skip、旧版本请求 | 获胜操作唯一；失败完整回滚；不新增observation |
| 幂等 | 有key接口同请求返回原结果 | 同key不同payload；无key旧版本重发 | 前者冲突，后者OCC冲突且无重复；UI不自动重发未知请求 |
| 时间 | 上海次日、DST23/25小时日 | 负时段、跨日、已过时段、推迟后当日又排入 | 正确workspace local day；无过去/约束重叠安排 |
| 重排 | 错过/释放时间后用户点击预览并接受 | acceptedVersion变化、学习开始、课表变化、旧UI响应 | 保留固定块；不复活任务；冲突可读；旧响应不覆盖 |
| 低打扰 | 新原因给一个入口、拒绝后不反复提示 | 每刷新重排、同技能跨要求误抑制、系统撤销计惩罚 | 0静默修改；0重复干扰（同版本同原因）；范围准确 |
| 版本资格 | exact版本/有效head参与当前结果 | 旧材料、撤回、隐私排除、观察修订、伪造自述correct | unknown/no按理由排除；不借用别的要求证据 |
| E1 | 每个支持题型等价表达正确及明确错误 | 歧义/缺规格/超资源/恶意表达式/不支持/答案编辑 | 支持域oracle完全一致；不支持全部拒判；不eval任意代码 |
| 争议 | 改判生成revision、读模型只用有效head | 并发改判、旧head结果迟到 | 原始事实保留；只有一条有效链；争议不当作错或掌握 |
| 指标 | 手算fixture得到明确分子/分母 | 重算草案、跨版本重复task、零样本、删失 | 与人工手算一致；null≠0；样本和缺失明示 |
| 成本/隐私 | L5/L8零模型请求；有限查询和窗口 | 无界days、正文泄露、恢复后重复、删除残留 | 无付费API；scope有界查询；备份恢复和删除测试通过 |
| 回滚 | 开关关闭/旧客户端/旧可空数据 | 新数据被旧客户端patch清空 | 旧行为可用，事实不丢，新增读模型可停用 |

测试分层：domain边界纯函数；handler认证/schema/错误；真实PG约束、锁、并发、rollback、backup/restore；受影响包类型/lint。测试数据使用合成场景仅证明工程行为。保留现有CI的浏览器检查，不在本地运行或委派浏览器；用户验收必须列入口、前提、步骤、预期并标“待用户浏览器验收”。

真实使用采集：先3天验证事件是否可信和可用，再7–14天观察建议/负担趋势；不把完成率当学习收益。每天只需正常使用自动产生的结构化事实，用户可每周一次可选负担评价；不为凑样本插入大量诊断。真实教学正确性建立独立人工标注集（支持题型、错因、等价、歧义等分层），开发集与留出集分开，条件允许双人标注仲裁。评分同时报告已判样本误判率与覆盖率，防止全部拒判伪装高准确。

真正学习收益：由I2机制收集延迟无提示、未见同技能题和迁移题，建议预先设7天与约28天窗口、相同学习时间预算、明确对照及最小有意义差异。单人数据只能说明个人可行性/趋势，不能宣称因果增益。缺失、区间过宽、题族重复或版本不可比较时标证据不足。BKT比较简单均值/近期正确率，Brier/logloss/校准与误报掌握分层；以学生/题族/时间划分，所有预测在当前结果之前，不能随机拆同题多技能行造成泄漏。

## 五、须明确与可自行决定

实施前必须确认的跨会话事项只有：I2实际分支/共享文件所有权与migration编号、只读字段语义；若S4要动同一资格契约，需统一接入方案。其余不能阻塞S1。

产品决策在对应切片启用前明确：E1首批题型及谁审核参考答案；阶段成果如何由学生确认；真实试验的时长/时间预算/对照、何时开启coach；Hermes部署连接与feature flag启用。不要为尚未准备启用的功能提前反复索要权限。

可自主采用的常规默认：原因可选无自由文本、完整metrics默认14天并有上限（本轮L8a记录面板默认7天、上限90天）、零分母null、结构化服务器时间、OCC/现有锁序、模型失败保守降级、不修改用户已接受计划、仅局部调整、兼容可空历史、默认关闭自动coach。新表/字段应服从实际失败场景，不引入通用事件总线或额外baseline/gate框架。

## 六、研究来源（原始研究/官方）

1. Soderstrom & Bjork (2015), Learning Versus Performance，作者实验室全文：https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/11/soderstorm_ra_learningvsperformance.pdf 。即时表现不能代替延迟保持/迁移。
2. IES/WWC Organizing Instruction and Study to Improve Student Learning：https://ies.ed.gov/ncee/wwc/practiceguide/1 。间隔、提取等建议的证据强度不同；具体产品调度仍需试验。
3. pyBKT官方：https://github.com/CAHLR/pyBKT 。本地拟合预测；潜在掌握与答对概率分开；外部/内部编码需明确适配。
4. Badran & Preisach, Addressing Label Leakage in Knowledge Tracing Models：https://arxiv.org/abs/2403.15304 。同题多知识点展开可能泄漏标签。
5. Zheng等，Judging LLM-as-a-Judge：https://arxiv.org/html/2306.05685v4 。位置/长度/推理偏差，人类偏好一致不等于学科评分正确。
6. NIST比例置信区间：https://itl.nist.gov/div898/handbook/prc/section2/prc241.htm 。小样本应报告合适区间；100条零错误仍非零风险。多条同学生/同题族不能当独立样本。

以上具体产品阈值、阶段顺序及接口均为基于源码与研究的工程建议，不是文献证实的统一最佳值。

## 附：S1备份/隐私精确接缝

- 数据库：`opening-backup-records.ts` 的 OPENING_BACKUP_TABLES、`opening-backup-record-table-queries.ts` 的静态owner/workspace查询、`opening-backup-apply.ts` 的 OPENING_RESTORE_ROW_COLUMNS、`opening-backup-empty-namespace.ts` 的namespace计数。
- 领域：`backup-compose-validation.ts` BACKUP_TABLES、`backup-policy.ts` TABLE_ALLOWLIST及关系验证、`backup-apply-plan.ts` APPLY_ORDER（反馈在opening_tasks之后）。旧备份缺新表应继续作为空数组读取，不强制要求历史数据。
- 单task_id外键只能证明任务存在。导入信任边界仍需验证feedback.workspace/owner等于目标task.workspace/owner；非法跨workspace/owner的引用必须在写入前拒绝。导出join owned task，勿将作用域检查全留给调用者。
- 测试：export→restore→反馈指标一致；恢复后原动作重试不增事件；仅反馈非空的namespace不能被误判为空；伪造task引用导入无半写；workspace/user/task删除级联；不恢复jobs/keys等既有禁用项。
- 首卡元数据不包含题目/答案/skill label/任务标题，不需要凭空新增“材料exclude就抹掉时间反馈”政策；当前任务也允许继续存在。不得将反馈当绕过source privacy向模型传材料的通道。以后新增source正文或派生内容才需对应隐私准入。
- 现场核查时Git基线末号0065；BKT PR #61 已发布0066_opening_measurement.sql；本分支逐字保留其纯DDL前置依赖，反馈表使用未部署的新0067_opening_plan_feedback.sql。没有导入BKT功能代码或合并其分支；其已有测量记录仍按原插件JSON/数据库备份范围保留。

## 本轮交付边界与手工验收

本轮实现 S1 与 L8a：真实任务动作事件、可选结构化原因、工作区明日推迟与取消、已推迟队列、近7天只读记录。L8a仅是负担与控制数据的第一部分，不等于完整S3。完成次数仅统计手动标记入口（不含补测自动完成），不等于唯一任务完成率，取消推迟单列resumed；无skip/defer样本时原因填写率为null。旧客户端无feedback仍可用，同状态正确版本保持no-op，旧版本重发409且不重复记事件。推迟及取消推迟的相同值请求也是no-op，不升版本、不记事件。

待用户浏览器验收（自动检查通过后执行）：

1. 登录 → 今日学习队列 → 待办「跳过」：原因可留空，取消无写入；选择原因再确认后变为已跳过，刷新仍一致。
2. 待办「推迟到明天」→ 可选原因 → 确认：进入「已推迟」折叠列表，不再自动选为当前任务；已确认日历安排保留。展开后「取消推迟」，任务回到可选队列。
3. 工作区时区与设备时区不同时，推迟按工作区下一日00:00；DST前后按23/25小时日，不按固定24小时。
4. 快速重复点击或并行窗口处理同一版本：只一项成功；冲突提示重新读取。模拟网络断开时先核对状态，不自动重发。
5. 设置 → 高级 → 规划反馈记录 → 读取近7天：核对手工操作次数/原因，取消推迟独立显示；空数据不表示学习成绩为零。

线上部署、真实学习内容质量、3天自用和延迟学习收益仍分别验收，不以CI代替。

本轮自动验收覆盖：`opening-plan-feedback-repository.test.ts`（真实状态/反馈回滚、关联补测回滚、scope、空操作、手算分母）、`opening-plan-feedback-concurrency.test.ts`（两独立连接及pg_locks证明真实重叠）、`opening-plan-feedback-backup.test.ts`（真实恢复executor、旧包缺表、伪造owner、删除级联）、`opening-adaptive-planning-data.test.ts`（鉴权与schema）、`opening-reminders.test.ts`（推迟前后到期/入队/旧版本投递拒绝）。本地容器无法以非root运行PG且ptrace受限，以上真实PG/handler测试必须在既有CI中执行，不能标记为已通过。

推迟同时约束Today、补测到期、提醒列表/入队及投递前重验；边界到达时恢复到期资格。已发送或结果未知的提醒历史仍保留，旧版本不可再次投递。

本轮本地检查：相关61文件550项、提醒32项通过；全量unit/contract首轮522文件3884项通过，发现另一处迁移清单断言与缺失本机默认PDF Python路径。迁移断言已同步0066/0067并与semantic-writers回归共23项复测通过；PDF使用受支持的PARSER_PYTHON指向已有pypdfium2运行环境后1项通过。全量命令未重新执行，不能表述为当前提交完整CI成功。另11项skip/1项todo保留原真实使用占位。contracts/database/domain/web类型检查、全部改动TS文件lint、server-boundary、计划结构、连续67个迁移清单及新增测试的额外类型检查已通过；PG/handler和浏览器仍按上述机制验收。
