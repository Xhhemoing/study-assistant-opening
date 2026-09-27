# Personal Learning Value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Follow the frozen PU01 contract and the single-file-owner allocation below; checkbox completion is not acceptance evidence.

**Goal:** 用真实卡点验证辅导是否有用、次日能否接续，并防止把求助、自报和缺测写成已掌握。
**Architecture:** PU04先完成无网络评估器和保守学习证据规则；live评估单独受费用许可约束。PU07在PU06受控准入后观察个人短周期使用，结果供PU08决定能否日常依赖。
**Tech Stack:** TypeScript、Zod、Vitest、Node test runner、现有PostgreSQL/worker预算账本与真实opening API。

## Global Constraints

- 本计划不缩减CAP01–06范围；PU04/PU07主要验证CAP03–05，不能替代外部接入、多模态、恢复和完整交付验收。
- 本次仅制定计划；不执行付费模型、不修改业务代码、不提交、不变更旧tasks状态。实施时每文件≤200行，修改现有超长测试时先将新增资格分支放入learning-evidence.test.ts，避免继续扩张；业务文件超过上限则先按职责提取到下列新文件。
- 全部命令从仓库根目录通过`pwsh`执行；脚本首行`$ErrorActionPreference = 'Stop'`；文件读写显式UTF8；原有Bash npm包装命令不可冒称在Windows通过。
- 记录`failure → cause → fix → recheck`；缺少密钥/预算只阻塞live和PU07真实使用，不阻塞离线研发，不能把blocked改成pass。
- 个人材料、答案原文、cookie、密钥、完整提示词不进入Git或普通日志；只提交合成/经授权脱敏样本与匿名汇总。评估失败不自动重试或切付费模型。

## 已核对基线与待复现风险

- 现有：`packages/contracts/src/opening/learning.ts`含ProblemRef、HelpExposure、ObservationInput、LearningObservation；`packages/domain/src/opening/assistance.ts`按已送达帮助降级独立性；`retest-policy.ts`默认两天、最多一题，属于启发式。
- 静态风险，尚未运行失败用例：`learning-summary.ts`未检查problemId，且两侧版本皆缺失时允许升为observed_independent；`learning/read-service.ts`调用摘要时未传版本上下文；`observation-service.ts`允许客户端reference_checked在材料绑定后进入写路径，绑定不等于答案已核验。
- `learning-summary.test.ts`现有assisted样本不属于契约的hinted/revealed枚举；实施时以合法revealed负例替换并跑显式测试根类型检查，不以类型断言掩盖。
- `scripts/evaluate-opening.mjs`、`tests/evaluation/opening-cases.json`目前不存在；`opening-release/08-delivery.md` Q02描述的是拟实施评估器。
- `tests/support/opening-provider.mjs`和`tests/tooling/opening-provider-fixture.test.mjs`证明合成source块输送/引用，不能测真实答案质量；`2026-09-24-opening-isolated-acceptance/verification.md`的9月25日续验也明确fixture模型边界。
- 输入依据：`tests/fixtures/opening/parser-two-page.pdf`及README哈希可作合成输送样本；`docs/quality/opening-real-use-evidence.md`记录了先前授权BASIC_NOTIONS_LATEX_SLIDES.pdf、WolframAlpha_Guide_Mathematics_I.pdf的哈希/页数，但未形成逐式视觉金标，不假定当前文件仍存在或可上传给供应商。

## 唯一契约提案：交PU01冻结

PU01独占修改`packages/contracts/src/opening/learning.ts`、新增`learning-evaluation.ts`及对应`learning-evaluation.test.ts`、opening/index.ts与src/index.ts导出。PU04不得另建竞争版本。ProblemRef、HelpExposure复用上列真实定义；UUID与ISO日期沿用foundation校验。

```ts
import type { ProblemRef, HelpExposure, LearningObservation, LearningSummary, Scope } from '@aistudy/contracts';
export type LearningEvidenceContext = {
  problem: (ProblemRef & { sessionId: string; courseId: string }) | null;
  sourceStates: Record<string, { recordedVersion: number | null; currentVersion: number | null; permitted: boolean }>;
  deliveredHelp: HelpExposure[];
  referenceCheck: { observationId: string; problemId: string; referenceSourceId: string;
    sourceVersion: number; outcome: 'correct' | 'incorrect' | 'unverified';
    method: 'deterministic_reference' | 'human_reference'; checkedAt: string } | null;
  attempt: { problemId: string; sessionId: string; kind: 'new_item' | 'same_item' | 'unknown';
    startedAt: string; submittedAt: string } | null;
};
export type SummarizeOptions = {
  byObservationId?: Readonly<Record<string, LearningEvidenceContext>>;
  dueRetestSkillLabels?: ReadonlySet<string>;
};
// Domain produces this existing function with the new options; defaults fail closed.
export function summarizeObservations(rows: readonly LearningObservation[], now: string, opts?: SummarizeOptions): LearningSummary[];
export type EvaluationCase = { id: string; provenance: 'synthetic' | 'redacted_real';
  category: 'incorrect_derivation' | 'unsupported_proof' | 'ambiguous_handwriting' | 'english_term' | 'missing_source' | 'emotional_support';
  mode: 'hint' | 'explain' | 'listen' | 'think_together'; question: string;
  source: { fixturePath: string; sha256: string; version: number; physicalPage: number | null } | null;
  reference: { text: string; basis: string } | null; offlineResponsePath: string;
  mustAbstain: boolean; mustNotReveal: boolean };
export type CaseReview = { caseId: string; reviewer: string; reviewedAt: string;
  correctness: 'supported' | 'incorrect' | 'unverified'; sourceSupport: 'supported' | 'unsupported' | 'not_applicable';
  helpLeak: boolean; actionable: boolean | null; safeAbstention: boolean; reason: string };
export type CaseResult = { caseId: string; status: 'pass' | 'fail' | 'manual' | 'blocked';
  errorCode: string | null; review: CaseReview | null; responseArtifact: string | null;
  latencyMs: number | null; settledCents: number | null; reservedUnknownCents: number | null;
  budgetEvidence: { tutorJobId: string; requestId: string; reservationId: string | null;
    state: 'absent' | 'reserved' | 'completed' | 'released'; readAt: string } | null };
export type EvaluationReport = { version: 1; mode: 'offline' | 'live'; runId: string;
  revision: string; dirty: boolean; caseSetSha256: string; model: string | null; currency: string | null;
  status: 'pass' | 'fail' | 'manual' | 'blocked'; results: CaseResult[] };
export type OfflineResponseFixture = { caseId: string; text: string; errorCode: string | null;
  citations: Array<{ sha256: string; version: number; physicalPage: number | null }>; review: CaseReview | null };
export type EvaluationRunInput = { mode: EvaluationReport['mode']; cases: EvaluationCase[]; reviews: CaseReview[];
  runCase: (entry: EvaluationCase) => Promise<Omit<CaseResult, 'review' | 'status'>>;
  metadata: Omit<EvaluationReport, 'mode' | 'status' | 'results'> };
export type PilotAttemptRecord = { problemId: string | null; observationId: string | null; localRecordRef: string | null;
  startedAt: string; submittedAt: string; timingSource: 'server' | 'self_report' };
export type PersonalUsePilotEntry = { episodeId: string; courseId: string; sourceId: string; sourceVersion: number;
  conversationId: string; occurredAt: string; resumedAt: string | null;
  initialIndependentAttempt: PilotAttemptRecord | null; delayedAttempt: PilotAttemptRecord | null; delayedDueAt: string | null;
  helpful: 'yes' | 'no' | 'skipped'; extraBurdenSeconds: number | null;
  newItem: 'not_offered' | 'skipped' | 'attempted'; independentEvidence: 'verified' | 'self_report' | 'unverified' | 'not_observed';
  delayedCheck: 'not_offered' | 'accepted_not_due' | 'missing' | 'assisted' | 'incorrect' | 'verified_correct';
  failureIds: string[] };
```

PilotAttemptRecord至少包含problemId/observationId/localRecordRef之一；localRecordRef只引用已存在的私有记录，不复制答题文本。时间必须ISO且submittedAt≥startedAt；缺事实用null，不补造。资格输入只能由服务端可信事实组装，不接收浏览器提交的context/referenceCheck；模型建议也不能充当referenceCheck。当前没有可信核验记录入口时referenceCheck=null，合法返回needs_check。不为得到绿色结果新增自动评分器或迁移。

## PU04：辅导质量与学习证据边界

**Owner:** LEARNING；**依赖:** PU00基线→PU01契约；独立于任何付费配置。**交付:** offline门禁、待人工评分live报告、学习摘要保守规则。

**现有文件（PU04独占）:** `packages/domain/src/opening/learning-summary.ts`及`.test.ts`；`apps/web/src/features/opening/learning/{observation-service,read-service}.ts`及各`.test.ts`；`tests/integration/handler/{opening-observations,opening-learning-read}.test.ts`。
**拟新增（PU04独占）:** `packages/domain/src/opening/learning-evidence.ts`及`.test.ts`；`scripts/evaluate-opening.mjs`；`scripts/opening-evaluation/{runner,scoring,live-driver,operator-budget-reader}.mjs`；`tests/tooling/opening-evaluation.test.mjs`；`tests/integration/opening-evaluation-budget-read.test.ts`；`tests/evaluation/opening-cases.json`；`tests/evaluation/opening-responses.json`；`docs/quality/personal-learning-evaluation.md`。
**只读复用:** `packages/domain/src/opening/{assistance,retest-policy}.ts`、`packages/database/src/repositories/opening-learning.ts`、`apps/worker/src/runtime/budgeted-call.ts`及其测试；需要改worker/DB时提交具体失败证据给PU01/集成者重新分配，禁止抢写。
**跨任务界线:** PU02只读这里的学习结果并负责接续体验，不改本节服务/domain文件；PU06消费offline报告与live阻塞项；PU08消费PU07结论。

### PU04-A：先复现，再关闭错误提升路径

- [ ] 在现有summary测试中使用已有obs工厂添加最小失败例；正常合法升档样本必须提供完整服务端context，不靠旧空options通过：
```ts
it('does not promote a client-claimed reference without server evidence', () => {
  const row = obs({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', skillLabel: 'algebra',
    assistance: 'independent', outcome: 'correct', verdictSource: 'reference_checked',
    referenceSourceId: '44444444-4444-4444-8444-444444444444' });
  expect(summarizeObservations([row], NOW)[0]?.status).toBe('needs_check');
});
```
- [ ] 运行下列unit命令，保存首次失败；若已通过，记录反证并避免无必要修改。为handler补“同workspace、已绑定source、伪造reference_checked仍不获得可信核验”的失败例，不只测跨用户拒绝。
- [ ] 新纯函数`qualifyLearningEvidence(row:LearningObservation,context:LearningEvidenceContext|undefined):'independent'|'needs_check'|'excluded'`：仅problem/session/course/attempt对应、new_item、无该次已送达帮助、correct可信核验、reference版本与所有关联材料版本存在且一致/有权限时独立；不信任客户端correct/independent声明。
- [ ] 来源明确过期/删除/无权限→excluded；缺版本、缺problem映射、缺可信核验、同题复述、unknown帮助、仅模型判断→needs_check。被排除证据不作为学不会；空记录返回[]；due仅标needs_review，不将缺测变incorrect。
- [ ] observation-service对public reference_checked请求返回现有VALIDATION→HTTP400，提示尚未完成参照核验；保留self_report/model_suggestion。历史reference_checked通过新摘要资格降级，不改原记录、不追溯宣称错误答案。
- [ ] read-service无可信组装器时显式传空byObservationId；保留所有权检查、读取错误与空态。预留可选依赖`loadEvidenceContexts(scope:Scope,rows:readonly LearningObservation[]):Promise<Record<string,LearningEvidenceContext>>`，未提供时不得调用虚假核验器；该依赖只在read-service本地类型定义，Scope复用contracts。
- [ ] 回归矩阵：hinted/revealed正确；请求失败未送达；同题换session伪装新题；未来新题不继承旧题帮助；自报正确；模型称正确；不支持证明；版本缺失/漂移/删除；客户端伪造参照；重复记录；修订冲突；逾期未测与未上传。每个分支固定ID，保持原有幂等/权限断言。

### PU04-B：可重复离线集，不伪装质量实测

- [ ] 新建12个固定ID合成例，每类至少2例；包含正确/错误对照、能引用但不支持结论、题干混入预期关键词、错页/旧版、hint直接给答案、模糊手写拒判、英语术语误译、倾听擅自安排任务。reference由确定答案或逐步人工校对产生；不使用待测模型给自己建立金标。
- [ ] `opening-cases.json`只含EvaluationCase；`opening-responses.json`是OfflineResponseFixture[]，包含固定文本/引用/错误和已核对合成review；正常基线输出均应符合rubric，负向响应由测试逐例变异并断言fail，不能把故意错误的响应混入预期绿色离线基线。真实材料先留本地私有目录，确认授权并脱敏后才能新增redacted_real；记录sha256、物理页与取样理由，禁止挑掉失败样本。
- [ ] runner导出`runEvaluation(input:EvaluationRunInput):Promise<EvaluationReport>`；reviews按caseId合并，重复或孤立review直接拒绝。scoring导出`scoreCase(entry:EvaluationCase,result:CaseResult):CaseResult`，schema验证全部输入。
- [ ] 先写Node测试：offline使fetch抛错仍可完成；缺review→manual；incorrect/unsupported/helpLeak→fail；mustAbstain却给确定答案→fail；结果缺失→blocked；合成PASS始终mode=offline。先跑红，再实现严格枚举和报告，不按HTTP200、引用存在、流畅程度判质量。
- [ ] 聚合优先fail>blocked>manual>pass，report.status=pass仅当每例pass；报出各类分母、失败数、未评数，禁止仅给平均分。正确性无可核对参照→unverified/manual，保存理由而非补模型评分。
- [ ] 在`personal-learning-evaluation.md`记录人工rubric：结论正确、步骤有效、引用支持、hint不泄露关键解答、适当承认未知、下一步可执行；人工评分者必须真实标名和时间，未获独立复核时明确单人判读。

### PU04-C：live是单独门禁，默认关闭

- [ ] CLI支持`--cases <json> --output <json> --mode offline|live`；live额外要求`--allow-paid --approval <private-json>`。approval为`{scope:'PU04'|'PU07',provider,model,currency,maxRunCents,maxDailyCents,maxPilotCents,maxCalls,expiresAt,approvedBy}`；必须由用户明确许可记录产生，代理不可自行填approvedBy。
- [ ] 默认所有上限=0。供审批的建议封顶为单轮200、日200、整个试点1000 cents，maxCalls=12；币种须与供应商账单/现有CENTS配置一致，未明确币种/正价格/有效密钥/有效期均blocked，不能把建议当许可。
- [ ] live-driver只经既有真实opening API提交TurnInput并轮询已保存turn，不直接调用provider。配置实际baseURL和owner cookie留私有环境；不得复用fixture key/模型/虚高fixture预算；服务器现有reserve/settle/markUnknown仍是最终花费关口。
- [ ] 每次调用前live-driver读取下述operator快照，以本轮/当日/试点已计入额+本次保守预留分别检查许可封顶；服务端仍原子reserve。持久manifest保存run/pilot全部API返回jobId并跨重启读取；丢失manifest、缺历史关联、未知费用、并发付费使用或适配器未实现均blocked，不可重启清零。
- [ ] 401/429、超时、取消、返回损坏、usage缺失、结算失败、预算不足均写具体状态；结果不确定保留预留，停止下一付费调用，人工核账后再决定。无隐式重试、无自动备用模型；部分报告可恢复读，但不得自动续费调用。
- [ ] 先用fake fetch/真实隔离预算账本测许可缺失=0调用、cap越界=0新增调用、未知费用占额度、重复clientKey不重复收费；获许可后才对六类各至少一个真实模型样本运行，缺手写/来源能力单项blocked，不能用纯文本样本代替。
- [ ] live输出默认manual，人工逐条核对来源/步骤后才评分。全部关键错误为0且六类全部有实际判读才可记此次集合pass；不是总体准确率、不是学习成效或CAP01–06全验收。


**只读本地operator费用适配器（PU04独占，上列新文件；不是新产品API）:**
```ts
import type { Sql } from 'postgres';
import type { Scope, CaseResult } from '@aistudy/contracts';
export type OperatorBudgetSnapshot = { readAt: string; workspaceId: string;
  jobs: Array<{ tutorJobId: string; userTurnId: string; assistantTurnId: string; jobStatus: string;
    evidence: NonNullable<CaseResult['budgetEvidence']>; amountCents: number | null;
    settledCents: number | null; reservedUnknownCents: number | null }>;
  runCountedCents: number; pilotCountedCents: number; dailyCountedCents: number;
  unresolvedTutorJobIds: string[]; unlinkedReservationIds: string[] };
export function createOperatorBudgetReader(sql: Sql): {
  read(input: { scope: Scope; runTutorJobIds: readonly string[]; pilotTutorJobIds: readonly string[] }): Promise<OperatorBudgetSnapshot>;
};
```
- [ ] 只连接显式配置的本地`OPENING_EVALUATION_READONLY_DATABASE_URL`；验证只读事务/连接，参数化SELECT并核对workspaces.owner_user_id与conversation归属。禁止调用reserve/release/settle、改schema/worker或从应用默认DATABASE_URL回退；配置未实现/未授予→blocked。snapshot.readAt取同一只读事务的数据库时钟。
- [ ] 已核对真实关联：保存turn API的jobId→`opening_tutor_jobs.id`（不是opening_jobs）；校验该行workspace_id/conversation_id以及user_turn_id/assistant_turn_id，再以`opening_budget_reservations.request_id='tutor:' || job.id`和同workspace/purpose=tutor关联reservation.id。request_id唯一；schema只有reserved/completed/released，markUnknown保持reserved，不能找不存在的unknown状态或usage表。
- [ ] 读取completed.amount_cents作为settledCents（当前worker settle写入的账本结算额，非供应商账单核对）；reserved全部保守计reservedUnknownCents；released计0但保留receipt。absent/查不到job/多重或跨scope关联→blocked且费用字段null，绝不推算settledCents或把缺值写0。offline费用字段null；reserved直到明确结算/释放前不得下次live调用。
- [ ] run/pilot合计对各自manifest的jobId去重，reserved+completed计入；daily复用现有账本UTC规则：全workspace所有reserved（含旧日）+completed且created_at或updated_at处于UTC当日。非本试点预留也计daily；关联遗漏/未知job返回阻塞，不可仅统计成功案例。CaseResult的budgetEvidence和费用字段只能来自对应jobs行。
- [ ] 新隔离集成测试覆盖真实job→reservation关联、completed/remaining-reserved/released/absent、跨owner拒绝、run/pilot去重、跨UTC日迟结算、未知旧预留、manifest丢失与只读写入拒绝；先红后实现。只用测试连接建fixture，reader连接保持只读；生产配置验证不得创建测试记录。

**通过命令（每条外部命令立即检查退出码，红绿用同一条）:**
```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/learning-summary.test.ts packages/domain/src/opening/learning-evidence.test.ts apps/web/src/features/opening/learning/observation-service.test.ts apps/web/src/features/opening/learning/read-service.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
node --import tsx --test tests/tooling/opening-evaluation.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
node --import tsx scripts/evaluate-opening.mjs --cases tests/evaluation/opening-cases.json --output .local/personal-use/offline-report.json --mode offline
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Previous verification command failed; record failure before continuing' }
```
以下两条另在PU00提供的隔离服务环境串行执行；不得拿默认DATABASE_URL试跑。PU06负责完整集成门禁和显式test roots编译；不能以unit代替handler。
```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project handler tests/integration/handler/opening-observations.test.ts tests/integration/handler/opening-learning-read.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Learning handler verification failed' }
node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-evaluation-budget-read.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Read-only evaluation budget integration failed' }
```
**PU04回退:** 失败时关闭live、保留原材料/会话与自报记录、摘要保持needs_check；只回退本任务代码，不清除历史证据或释放unknown预算；无schema迁移。

## PU07：短周期个人使用试点

**Owner:** PILOT（单人真实使用者+记录整理agent）；**依赖:** PU04 offline完成、PU06受控准入通过、有效真实模型配置/费用许可；PU08等待PU05+PU06+PU07。PU05恢复托底可并行，但PU06至少须确认原件导出和故障后可停止；恢复演练未完成时只能用可替换材料、保留原件外部副本，不称日常可靠。
**拟新增且PILOT独占:** `docs/quality/personal-use-pilot.md`（协议与复盘）；`docs/superpowers/evidence/personal-use/pilot-summary.md`（脱敏结论）。逐次PersonalUsePilotEntry写`.local/personal-use/pilot.jsonl`，实际答案/手写图只引用现有source，不复制进报告；不新增产品埋点/评分页面/数据库字段。

下列7日/延长7日、3个episode、2次接续/反馈、30秒和2分钟均是待用户采用的建议性操作阈值，未测得有效、不是学习研究结论或承诺目标；冻结后变更须说明理由，不能为通过而事后调宽。

- [ ] 启动前冻结7个日历日观察窗口（不是开发工期）；从PU06准入和配置有效后首个真实求助日算D0。仅一门当前真实课程、一份已授权材料、一个自然卡点；先前课件仅作候选，不存在/不适合卡点时继续准备而不伪造内容。
- [ ] D0按平常方式求助，不强制做题录入或知识树；保存真实会话/材料位置。每个自然episode最多一次可跳过反馈“有帮助/没帮助”，extraBurdenSeconds为可选粗略自报，不精密计时、不要求每题记录。
- [ ] D1或下一实际学习日用PU02入口接续，记录是否找到同会话/原材料、是否需重复说明；不以同一天刷新冒充次日继续。遇到技术故障停止该episode，回到原件/普通笔记，failureId交回所属owner。
- [ ] 用户愿意时才做一个未暴露答案的新题；先独立尝试再看帮助，已看答案/提示如实标记。由已存在problemId/observationId或私有localRecordRef标识题目，记录initialIndependentAttempt的开始/提交时刻及时间来源；可验证独立性必须有不同problemId、材料出处与可核对参照，缺任意项只记self_report/unverified。不会自动把报告判读写回产品reference_checked。
- [ ] 用户接受后建议约两天后的延迟检查，可改期/跳过；记录delayedDueAt及delayedAttempt引用和开始/提交时刻；实际间隔=delayedAttempt.startedAt−initialIndependentAttempt.submittedAt，按秒计算并报告日期/时区与self_report限制，缺任一端点则间隔未知，不用dueAt代替实测；同时记录是否用帮助。到期没做=missing，拒绝/未提供=not_offered，绝不算incorrect或从统计分母悄悄删除；未到期=accepted_not_due。
- [ ] 仅汇总自然发生的最少3个episode（允许同一卡点多次继续）及至少2次跨日接续机会；不为达标增加练习。7日后不足则“继续观察”，最多延长7日一次；仍不足则结束试点、结论证据不足，不给用户催学任务。
- [ ] **通过（仅个人可用性）:** 至少3个episode、2次实际跨日接续均找到正确材料/会话；至少2次有明确有帮助反馈且至少2次填写负担估计；已填额外负担中位≤30秒；无严重来源/隐私/错误升档/费用事件。跳过反馈不算yes，样本不足不pass。
- [ ] **继续观察:** 自然机会不足、反馈缺失、延迟缺测、只有自报改善或独立新题未做；分别列分母与原因。可用性可通过但学习效果仍“未建立”；独立/延迟的有限正确观察也不是因果效果、持久掌握或泛化证明。
- [ ] **停止:** 一次越权/数据泄露/费用超额/帮助后误标独立；一次有来源反证的关键数学错误被自信当作正确；或最近3次中2次额外记录负担>2分钟/用户明确不愿继续。立即禁用live，保留原件与最小故障记录，修复回归通过后由用户决定是否新开试点。
- [ ] 结束时删除非必要私有评估副本；保留用户主动保存的学习材料和正常会话，撤销试点专用cookie/许可。总结只含日期范围、案例匿名ID、分母、帮助/缺测/错误、账本结算额+仍预留费用（不是供应商账单核对）、回退执行情况与PU08建议。

**验收与交接:** PILOT真实填写记录；agent只能校验完整性和整理，不能代用户宣称有帮助。PU07交付`pass/observe/stop`及独立的`learning_effect:not_established|limited_observation`，缺密钥/许可则`not_started`；不得把未启动算通过。PU08结合恢复证据、实际合并SHA对应CI/PR和手动验收作最终交付判断，本文不能提供这些尚未发生的证据。
