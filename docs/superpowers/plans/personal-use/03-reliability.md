# Personal-use Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. 本轮只编写计划；以下复选框均不是已执行证据。

**Goal:** 在保留 43 任务、CAP01–06 和 Q03→Q01→Q02 门禁的前提下，分别证明受控试用与个人日常可依赖。
**Architecture:** 复用现有 17 表导出、对象暂存、归档加密和恢复预检；保守采用单人维护窗口、真实 PostgreSQL 事务、不可变对象、数据库提交作为可见性边界。受控试用不宣称完成备份恢复或正式发布。
**Tech Stack:** TypeScript、postgres.js、PostgreSQL、MinIO/S3、Redis、Vitest、Playwright、PowerShell 7。

## Global Constraints

- Node.js 20+；所有命令用 pwsh，脚本首行 `$ErrorActionPreference = 'Stop'`；读写文件显式 UTF8。每个新/改源码文件≤200行；不用 Bash/cmd。子包 AGENTS.md 优先。
- 本计划落盘时未运行任何产品测试、恢复、付费调用或部署。2026-09-24 证据含 9/25 续跑，是 `8d616c0` 上的脏工作树本地证据，不能代表发布 SHA。
- `2026-09-25-opening-backup-integration.md` 已存在，所指 evidence/verification.md 当前不存在；已有真实 SQL/MinIO 测试源码不等于它们已运行通过。
- `assembleOpeningBackupDraft`、`planOpeningRestoreApply` 已存在但不提供发布/apply；`opening-readiness.mjs` 主程序尚未运行实际探针，变量 `AI_PROVIDER_API_KEY/OPENING_DAILY_CAP` 也不是实际模型配置的权威键。
- 不降低鉴权、同源、owner、privacy epoch、删除排除、版本 CAS、预算预留/unknown、原件校验要求；不自动恢复凭据、登录 sessions、队列/outbox、预算或付费 jobs。
- 单一 owner：PU05独占恢复/隐私删除实现，A→B→C串行；PU06、PU08由集成者拥有。PU01只冻结共享契约；PU00统一登记工作树、迁移和服务租约。
- 迁移必须连续。PU00执行时复核磁盘仍到0026且原0027–0029未落盘，再统一重排未发布预约：恢复日志计划`0027_opening_recovery.sql`，原C01/K01/K02顺移0028/0029/0030；同步原master/subplans/interfaces与manifest的`purpose/allocatedNumber/path`后跑校验，PU01再冻结精确路径。这是拟分配方案，若任一预约已落盘则重算依赖，禁止空迁移补洞或修改已发布SQL。
- 执行者从 PU00 指定基线建 `codex/pu05-reliability`、`codex/pu06-acceptance`、`codex/pu08-delivery` 工作树；已有未提交文件须先登记保全，不复制覆盖或用 reset/clean 丢弃。

## Interfaces and ownership

PU01冻结下列 wire shape（拟新增 `packages/contracts/src/opening/recovery.ts` 和 `recovery.test.ts`，导出`privacyCheckpointSchema`）；PU05提供实现，shared index只由PU00集成者修改：
```ts
export type PrivacyCheckpoint = {
  workspaceId: string; privacyEpoch: number; journalVersion: number;
  sourceIds: string[]; memoryIds: string[]; sha256: string; exportedAt: string;
};
export type RecoveryReceipt = {
  runId: string; workspaceId: string; archiveSha256: string;
  privacyEpoch: number; journalVersion: number; objectCount: number;
  recordCounts: Record<string, number>; state: 'committed';
};
```
`sha256`只验证完整性，不认证来源。最新checkpoint来自独立受保护的隐私日志存储和operator确认的高水位（读取渠道必须owner授权，并校验恢复操作身份），不从待恢复包自证；检查workspace、单调version/epoch和可信来源，丢失最新日志或不能证明最新则拒绝apply。

PU05拟新增数据库内部接口（`Sql`来自postgres；`OpeningScope={workspaceId,ownerUserId}`已存在）：
```ts
export type RecoveryLease = { runId:string; worktree:string; expiresAt:string };
export type RecoveryPaths = { privateRoot:string; archivePath:string };
export type RecoverySecrets = { readPassphrase():Promise<string> };
export type RecoveryResult = { ok:true; receipt:RecoveryReceipt } |
  { ok:false; code:'FORBIDDEN'|'BUSY'|'STALE_PRIVACY'|'NONEMPTY_TARGET'|
    'INVALID_ARCHIVE'|'STORAGE_FAILED'|'DATABASE_FAILED'|'CLEANUP_FAILED' };
export declare function publishOpeningBackup(sql:Sql, scope:OpeningScope, paths:RecoveryPaths,
  secrets:RecoverySecrets, lease:RecoveryLease):Promise<RecoveryResult>;
export declare function applyOpeningRestore(sql:Sql, scope:OpeningScope, paths:RecoveryPaths,
  checkpoint:PrivacyCheckpoint, secrets:RecoverySecrets, options:{confirmLocalRestore:true; lease:RecoveryLease}):Promise<RecoveryResult>;
```
口令从交互隐藏输入/进程内 secret provider 传入既有cipher函数；不放CLI argv、环境日志、receipt或备份本身。lease字符串不是鉴权，函数核验PU00租约记录和实际停写状态。

## PU05 — Recovery and operational safety

**Depends:** PU00（baseline/资源租约/迁移分配）、PU01（共享契约冻结）。父账本只有一个PU05 owner；A0、A1、B1、B2、C1、C2各自有red→green与独立review，不把它们合并成一个不可验证大包。

### PU05A0: 先建立不会被旧备份回滚的删除资格

**Modify existing:** `packages/database/src/repositories/opening-memory-delete.ts`、`opening-privacy.ts`；纯规则 `packages/domain/src/opening/backup-policy.ts`、`backup-apply-plan.ts`及对应`.test.ts`。
**Create:** `packages/database/src/repositories/opening-privacy-journal.ts`、`tests/integration/opening-privacy-journal-repository.test.ts`；迁移使用PU00 manifest登记并由PU01冻结的精确路径并记录在账本，新增表 `opening_privacy_journal`、`opening_recovery_runs`。
**Interface:** `readTrustedPrivacyCheckpoint(sql,scope):Promise<PrivacyCheckpoint>`；日志字段`workspace_id,sequence,privacy_epoch,kind(source|memory),entity_id,deleted_at`，唯一`(workspace_id,sequence)`，不存文本/密钥/账号。
- [ ] 先写真实DB失败例：无sourceIds记忆删除后旧备份仍含memoryId；回滚删除事务后无新日志；并发删除序号不重复；跨owner无读写；篡改/回退/外包checkpoint拒绝。
- [ ] 跑 `node node_modules/vitest/vitest.mjs run --project integration tests/integration/opening-privacy-journal-repository.test.ts`，记录实际失败及根因，不能仅断言函数被调用。
- [ ] 最小实现：workspace-first `FOR UPDATE`→memory CAS→tombstone+epoch+日志同一`sql.begin`提交；无source记忆也记memoryId。迁移回填现有deleted记忆和source exclusions；日志从业务备份之外独立保留，删除完成状态明确区分“本地已生效”和“离机日志已同步”。
- [ ] 最新日志不同于包内journal时默认拒绝旧包恢复；需重新生成满足最新排除的包，不能静默放宽现有`JOURNAL_DRIFT`。保留纯domain规则，SQL/存储只放database层。
- [ ] 原命令green后验证迁移顺序、事务中断和日志恢复；离机日志未获持久确认时阻止日常可依赖准入。回滚停用新恢复入口、保留日志表与tombstone，禁止逆删隐私历史。

### PU05A1: 复用9/25真实导出切片并补齐证据

**Reuse existing plan:** `docs/superpowers/plans/2026-09-25-opening-backup-integration.md`，不新造第二套导出器。
**Existing files:** `tests/integration/opening-backup-records-{repository,json-repository,snapshot-repository}.test.ts`、`opening-backup-records-fixture.ts`、`opening-backup-compose-repository.test.ts`；`packages/database/src/repositories/opening-backup-record-{table-queries,predicates,privacy}.ts`只修实际复现问题。
- [ ] 依原计划运行完整17表非空关联、双principal、陈旧/仅citation lineage、malformed JSON、deleted/excluded memory与MinIO真实字节测试；先red，记录cause，再最小fix后重跑原命令。
- [ ] 覆盖归档反序/重复/并发读取、错误口令、篡改、缺对象、暂存时版本/删除变化及sentinel不被清理；不mock SQL或业务API。
- [ ] 写 `docs/superpowers/evidence/2026-09-25-opening-backup-integration/verification.md`，记录实际工作树SHA/差异、命令、结果、日志与清理；通过只代表draft/archive，仍不代表发布或恢复。

### PU05B / B1: 维护窗口下的DB与对象发布协议

**Modify existing:** `packages/database/src/repositories/opening-backup-{compose,records,sources}.ts`（提取可接收同一`TransactionSql`的内部读取，保留旧公开接口）、现有archive/cipher失败测试。
**Create:** `packages/database/src/repositories/opening-backup-publish.ts`、`opening-recovery-runs.ts`、`packages/database/src/storage/opening-recovery-storage.ts`、`tests/integration/opening-backup-publication.test.ts`、`scripts/opening-backup.ts`。
- [ ] 先写失败点矩阵：锁前/锁后删除、普通表写入、对象更改、归档完毕前崩溃、DB提交前/后丢响应、相同runId重试、缺最新日志、cleanup失败。断言提交前不可发现、提交后完整可读、重复运行只有一个receipt。
- [ ] 默认方案：租约独占且web/worker写入已停；真实事务固定`REPEATABLE READ`，先workspace owner锁，再按固定顺序对17表及journal取`SHARE`表锁；所有读取用同一个tx，不能嵌套调用各自开启事务的旧reader。`lock_timeout=5s`、事务/存储总时限120s，超限失败退出维护窗口，不能产生半包。
- [ ] 在锁保护期间暂存并重新计算每个不可变source/version对象的hash，写加密归档；S3使用不可覆盖的新runId key、私有ACL，读取凭据不允许修改已提交对象。没有对象存储分布式事务承诺。
- [ ] `opening_recovery_runs`保存runId、owner/workspace、archive哈希、epoch/journalVersion、计数、state；归档完成/验证后同一DB事务写`committed`，DB commit为唯一发布可见性点。列出/下载只接受committed登记；孤立对象/文件是不可发布垃圾，不能当最近成功备份。
- [ ] CLI成功返回receipt后才允许operator取得加密包；独立隐私日志快照必须同时可恢复并晚于最后确认删除。提交丢响应按runId查receipt，不重复导出/覆盖；source更新需生成新version，未知写入来源存在就拒绝维护租约。
- [ ] 重跑publication与A1；回滚关闭新CLI/发现入口，保留旧已提交包与登记。失败清理仅删除租约runId目录/key，清理失败返回`CLEANUP_FAILED`及脱敏runId，不能掩盖原始失败。

### PU05B / B2: 真正的restore apply（先预检，后事务）

**Create:** `packages/database/src/repositories/opening-restore-apply.ts`、`opening-restore-rows.ts`、`packages/domain/src/opening/restore-row-validation.ts`及`.test.ts`、`scripts/opening-restore.ts`、`tests/integration/opening-restore-apply.test.ts`、`opening-backup-privacy.test.ts`。
- [ ] 先写失败测试：非空目标、错owner/workspace、未知字段/表/version、坏FK、孤儿引用、数值越界、伪造actualSha256、旧journal、无source已删记忆、对象失败、SQL中途失败、重复runId与并发apply。
- [ ] 显式本地`--confirm-local-restore`与可信checkpoint必需；新空DB+新空bucket由租约登记。只bootstrap新owner/workspace，显式映射旧owner到新owner；不从包恢复users/sessions/API keys。非空目标不提供force/merge。
- [ ] 先完成整包解密认证和实际字节hash，再对17表完整字段/枚举/FK/owner/lineage逐项验证；插入列与表固定allowlist、参数化SQL，不把包key拼成SQL；重建object locator，不信任旧bucket/key/url。
- [ ] 对象先写目标不可变namespace并验证；事务内workspace-first锁、重读可信最新journal/epoch、固定依赖序插入17表及receipt。所有行一个真实transaction；失败rollback行并按lease清理对象，不能以多次独立commit假装原子。
- [ ] 不恢复job、outbox、预算、队列、tokens；不自动创建解析/模型/提醒任务。未完成对话/任务展示为需用户重试；付费provider默认关闭，operator单独配置与显式新请求才可恢复调用。
- [ ] 通过apply+privacy真实DB测试后review；回滚保持旧实例停写前状态不变，丢弃新测试目标只由该lease owner执行；不自动切换运行实例，不把恢复演练等同实际部署。

### PU05C / C1: 可重复的隔离恢复演练

**Create:** `scripts/opening-recovery-drill.ps1`、`tests/integration/opening-recovery-drill.test.ts`、`tests/tooling/opening-recovery-drill.test.mjs`、`docs/superpowers/evidence/personal-use/pu05-recovery.md`。
- [ ] 编写red断言`expect(receipt.state).toBe('committed')`、源/目标17表逐表计数与规范化业务值相等、所有对象真实字节/hash相等、已删source/memory永久缺席、jobs/outbox/凭据恢复量为0；原实例仍可查询且sentinel存在。
- [ ] drill脚本拒绝任意目标URL：仅新增恢复专用DB `127.0.0.1:15432/aistudy_opening_restore_test`、bucket `opening-restore-<runId>`、Web `127.0.0.1:3101`；独立guard验证scheme/host/port/name且拒绝query/hash，不能放宽现有F01/E2E guard。
- [ ] 从合成17表+有效PDF+已删除记忆起点备份，关闭原进程，恢复到新空目标；新登录session验证原件下载、引用/对话/记忆/计划，fixture provider完成新学习环，重启后再验。全过程外网模型/提醒调用0。
- [ ] 运行 `pwsh -NoProfile -File scripts/opening-recovery-drill.ps1`；记录源/目标标识、runId、SHA、时间线、hash/计数、RPO/RTO实测值、故障注入和失败清理。个人使用目标RPO≤24h、RTO≤60min，未测/超限均blocked，不虚报SLA。
- [ ] owner在finally关闭自身3101/任务服务、清理restore namespace及明文目录、保留加密证据；只在pid/startTicks/executable匹配时停进程，未知监听者不接管。清理失败必须非0退出并列出待清理runId。

### PU05C / C2: 费用、运行探针与运维托底

**Modify existing:** `scripts/opening-readiness.mjs`、`tests/tooling/opening-readiness.test.mjs`、`docs/operations/opening-release.md`；**Create:** `scripts/opening-readiness-probes.mjs`、`tests/tooling/opening-readiness-probes.test.mjs`、`apps/web/src/app/api/opening/health/route.ts`及`route.test.ts`。
- [ ] red案例包括缺required check但空checks误绿、过期heartbeat、伪registration env、未来/过期archive、未配置/未送达alert、无key/零cap、日志含凭据；生产HTTPS不得以loopback fixture豁免。
- [ ] 基于实际`loadEnv/loadOpeningModel`与`OPENING_MODEL_API_KEY/OPENING_MODEL_DAILY_CAP_CENTS`探测DB/Redis/私有storage canary、worker心跳、owner、实际注册403、HTTPS、committed backup freshness；公开health只返回粗粒度状态，详细探针限本地operator。
- [ ] `buildReadinessReport`维持fail-closed并验证required check全集；alert配置≠送达，注入alert失败并记录实收ack才可宣称有人接收。缺付费密钥/授权目的地时保持blocked，不能发送未经授权外部消息。
- [ ] 复用预算repository与budgeted-call，验两并发不能超cap、发送前失败释放、发送后unknown保留；默认paid cap=0，真实评测必须PU07明确授权预算。不得因restore清空或补算历史费用使cap放松。
- [ ] 运维默认每日一次已提交加密备份、24h新鲜度、7日每日+4周每周保留、每月合成恢复演练；删除日志独立持久化且不随旧备份淘汰，旧包清理登记可追踪。这些是拟实施运行约定，不是已设置的定时任务。
- [ ] 重跑tooling/probes/预算回归；真实探针、发送回执、恢复演练与未配置项写运维册。第三方故障时关闭新增付费调用，保留原件与可读学习记录，展示明确降级状态。

## PU06 — Cross-module local integration and controlled trial

**Depends:** PU00、PU01既有安全门禁、PU03、PU04；可在PU05未完成时执行，只使用合成/脱敏数据，原件另存。不提升Q01/Q02/Q03状态，不放行敏感持久采集。
**Existing:** `tests/e2e/opening-workflow.spec.ts`、`opening-shell.spec.ts`、`opening-release-redirects.spec.ts`、`scripts/opening-e2e/*`、`tests/integration/opening-fixture.ts`。
**Create:** `tests/integration/handler/personal-use-loop.test.ts`、`tests/integration/personal-use-concurrency.test.ts`、`tests/e2e/opening-personal-use-continuity.spec.ts`（现有`playwright.opening.config.mts`只匹配`opening-*.spec.ts`）、`docs/superpowers/evidence/personal-use/pu06-controlled-trial.md`。
- [ ] 先写端到端失败用例：真实上传→异步解析→选择出处→辅导→观察→记忆候选确认/拒绝→计划接受→新复测→关闭重开恢复；断言真实DB行、版本和下载字节，不仅HTTP200或截图。
- [ ] 交叉负例：匿名/另一owner、stale版本409、失联重试幂等、删除与worker回写竞争、无来源不标mastered、记忆未确认不当事实、临时对话不落盘、零预算/unknown不重付费、parse失败仍能取原件。
- [ ] 同步测试390×844与1440×900键盘/刷新/后台中断/计划冲突；复用现有fixture provider，但不mock业务API/数据库，不把fixture质量等同真模型教育质量。
- [ ] handler测试直接调用真实route handler并连接隔离DB；若使用`OpeningFixture.request`必须另启同测试库的Web并设置`OPENING_WEB_BASE_URL`，不能误连默认3000。执行下方隔离命令，截图/trace与错误日志脱敏；受控准入要求以上安全与主环全绿、无待处理P0/P1，明确展示未完恢复/真实模型/外部提醒/部署项及原件另存方法。
- [ ] 退出条件：权限或隐私失败立即停受控试用；缺恢复只允许可丢弃测试资料，不保留唯一原件。完整CAP01–06范围不删减，PU06通过只能记录`controlled-trial-local`。

## Shared isolated commands and service lease

PU00为上述三工作树分配一个全局排他服务租约，包含owner/worktree/runId/pid/startTicks/端口/数据库/bucket/到期与清理归属；integration/handler会触发TRUNCATE，不并行使用同库。lease锁跨工作树而非只写各自.local。
默认已有服务：PG15432、Redis16379、MinIO19000/19001、Web3100、fixture18081；E2E库`aistudy_opening_e2e`、integration库`aistudy_opening_test`。恢复3101仅C1租约使用。端口冲突停止，不杀未知进程。
```powershell
$ErrorActionPreference = 'Stop'
# 先由PU00取得租约；运行者在本工作树启动任务自有服务。
$primaryFailure=$null; $cleanupFailed=$false
try {
  pwsh -NoProfile -File scripts/opening-e2e/services.ps1 start
  if ($LASTEXITCODE -ne 0) { throw 'Service start failed' }
  $json = node --input-type=module -e 'import { buildOpeningE2eEnvironment } from "./scripts/opening-e2e/environment.mjs"; console.log(JSON.stringify(buildOpeningE2eEnvironment({})));'
  if ($LASTEXITCODE -ne 0) { throw 'Environment build failed' }
  foreach ($e in ($json | ConvertFrom-Json -AsHashtable).GetEnumerator()) { [Environment]::SetEnvironmentVariable($e.Key,$e.Value,'Process') }
  $env:NODE_ENV='test'; $env:OPENING_RELEASE=$null; $env:OPENING_E2E=$null
  $env:OPENING_MODEL_API_KEY=''; $env:OPENING_MODEL_DAILY_CAP_CENTS='0'; $env:OPENING_TEST_DB='1'
  $env:OPENING_TEST_DATABASE_URL='postgres://opening:opening-local-test@127.0.0.1:15432/aistudy_opening_test'; $env:DATABASE_URL=$env:OPENING_TEST_DATABASE_URL
  node node_modules/vitest/vitest.mjs run --project integration --project handler
  if ($LASTEXITCODE -ne 0) { throw 'Guarded integration/handler failed' }
} catch { $primaryFailure=$_ } finally {
  pwsh -NoProfile -File scripts/opening-e2e/services.ps1 stop
  $cleanupFailed=($LASTEXITCODE -ne 0)
}
if ($primaryFailure) { if ($cleanupFailed) { Write-Warning 'Owned cleanup also failed' }; throw $primaryFailure }
if ($cleanupFailed) { throw 'Owned cleanup failed' }
# 待上个租约完全清理后，runner另取相同服务独占租约。
pwsh -NoProfile -File scripts/opening-e2e/run.ps1
if ($LASTEXITCODE -ne 0) { throw 'Browser or cleanup failed' }
```
每个工具命令要检查exit code；捕获主失败与finally清理失败两份证据。日志用`Set-Content -Encoding UTF8`或明确UTF8重定向；不把`.env`复制进隔离配置；旧历史logs不覆盖新结果。

## PU08 — Daily-reliable acceptance and exact-SHA delivery

**Depends:** PU05+PU06+PU07；既有43任务及CAP01–06范围保留。分别判定“基础五项日常可靠M4”和“扩展完成M5/Q04”，不能把M5外部能力变成M4新增依赖。PU06局部绿不能跨过Q03→Q01→Q02，Q04仍按原范围独立验收。
**Reuse plans:** `opening-release/08-delivery.md`、`11-proactive-acceptance.md`、`docs/operations/ci.md`。**Create:** `docs/superpowers/evidence/personal-use/pu08-release-decision.md`；按Q03原计划创建缺失`infra/docker/Dockerfile.opening-web`、`Dockerfile.opening-worker`、`compose.opening.yml`、`opening.env.example`。
- [ ] Q03先验证PU05真实恢复/隐私日志/预算与探针，构建分离web和parser-worker镜像、非默认凭据、私有服务绑定、健康/资源限制；干净机器安装与升级回滚演练。已安装本地二进制可运行不能替代fresh-machine证据。
- [ ] 然后Q01对完成Q03的候选版本运行完整跨模块安全/并发/故障矩阵，再Q02运行桌面/移动/真机、真实模型质量与实际费用采样；PU07证据必须标同版本适用性及M4/M5归属；M4不凭fixture宣称真模型质量，M5不凭手动导入宣称外部集成完成。质量报告含样本出处、分母、失败/延迟/费用，不推断广泛教育效果。
- [ ] 集成者运行`node scripts/validate-opening-plan.mjs`（仍43）、tooling、verify:ci、lint、typecheck、unit/contract、integration/handler、完整browser与build；Windows直接node替代命令记录为直接检查，Bash依赖根包装器未通过则不得写PASS。
- [ ] 经授权提交/推送后，PR/CI必须绑定最终发布SHA；在`opening-release/08-delivery.md` Q03处记录GitHub Actions quality job URL+SHA+结果（遵循ci.md，不能另造替代引用）。代码/SHA变更使旧门禁失效，应重跑受影响完整序列。
- [ ] M4基础日常可靠要求五项主环、安全门禁、实测RPO/RTO、离机加密备份+独立最新隐私日志、可接收运维告警、真实预算/质量及SHA证据。P03外部提醒未实证时明确“提醒受限”，按原验收边界保留blocked项，不能伪报P03完整通过。M5/Q04另核CAP01–06、外部账号/媒体/主动能力；M5 blocked不自动否定已被独立证明的M4，但不得合并宣称全部完成。
- [ ] 交付报告逐项列PASS/FAIL/BLOCKED、exact SHA、命令/PR/CI/手验链接、failure→cause→fix→recheck、迁移与停写回滚。回滚先停写，保留隐私journal高水位和加密包，再回退应用或恢复到新实例；不回退删除记录、不自动重放付费jobs。
- [ ] 本轮计划不授权commit/push/部署/购买/外部消息。执行阶段按已有授权边界推进；无发布SHA/远端CI只交本地可审阅结果，不宣称M4日常可依赖或已部署；M5未完成必须保留独立状态。

## Parallel-write exclusions

PU05独占`opening-memory-delete.ts`、`opening-privacy.ts`、全部新recovery实现和其测试；PU01仅contracts新shape，shared exports/迁移/registry/package配置由PU00统一写。PU06测试可与PU05开发并行，但同一隔离服务/库只能串行租用；PU08须等待前置证据。运维册、08-delivery、tasks.json、CI配置与最终evidence索引只由集成者收口，子agent不各自改状态。图谱由父任务完成后统一更新一次，生成物不提交。
