# Opening 全计划连续执行记录

基线：feat/opening-release / 8d616c0 + 保留既有未提交改动。用户要求按计划连续推进；实现/复核模型使用 xhh-grok/grok-4.7（覆盖旧执行计划中的4.6指令）。原43任务账本和依赖不变；本文件是执行游标，不是verified证据。

## 顺序与具体切片

1. **RP1统一隐私查询**：opening-tutor-history.ts调用opening-privacy.ts:listExcludedSourceIds；unit编排测试+历史source/current/citation-only/跨workspace集成回归。已实施，主会话1 unit/28 integration + database typecheck通过，尚需合入门禁。
2. **M01记忆来源/owner准入**：opening-memory.ts、memory-policy.ts及最近测试；先阻断未授权来源/无来源进入模型，再桥接assistant candidate确认消费。不改变workspace级记忆合法可见性（contracts明确null courseId允许跨课程展示）。
3. **M01候选桥接**：核对0021/0022现有schema与既有decision接口，事务确认assistant memory candidate一次，拒绝抑制，保持版本和clientKey；需要migration时由集成者先分配，不能随意使用预留0027–0029。
4. **M02/M03**：已有epoch并发证据不等于restore完成；M02 restore依赖Q03。M03在预算/隐私/无持久化边界内实现ephemeral-service、路由、policy与测试。
5. **L01/L02/L03/P02/P03**：按04/05/06 subplan顺序补来源版本、修订、retest→task桥、真实read API与提醒状态；不将非参考核验观测投影成正式correct。
6. **U02/U03/RP3/RP4/RP6**：使用既有产品设计约束补真实UI接线与浏览器验收；上传、刷新、引用版本、记忆和计划冲突走真实API。RP4 引用链接已接；浏览器验收仍受服务阻塞。
7. **Q03/Q01/Q02/RP5**：恢复/安全/浏览器/构建/CI验收；Q03 目前只完成纯函数预检，备份导出与隔离恢复尚未开始。之后按执行计划C01/V01→C02/C03/K01→K02/P04/U04→Q04。

## 验证方式

- 每次行为改变先失败回归→根因→最小实现→同检查通过；主会话复跑并读diff，subagent报告不等于独立验收。
- unit使用 `node node_modules/vitest/vitest.mjs run --project unit <文件>`；integration/handler串行使用显式guard和loopback `aistudy_opening_test`。新integration代码用TypeScript API单独roots检查，e2e tsconfig不覆盖integration。
- 包级typecheck、定向ESLint；阶段末按aistudy-git-workflow完整门禁，不以focused pass冒充全项目pass。
- 合入验收须PR/CI绑定SHA及必要人工演练。保留未运行、失败与外部阻塞，不盲目提升tasks.json。

## 2026-09-23 U03/P03/RP3 继续切片

已实施但未提升 `tasks.json` 状态：

- U03 assistant 真实客户端接入 `saved` 与 `ephemeral` 分流；ephemeral 通过 AbortSignal，响应候选剥离且只保留当前标签页；saved job 支持 owner-scoped cancel，并在事务内将 pending assistant turn 标记为 failed；消息正文以文本渲染，回归覆盖 script 字符串不执行。
- U03 进入/刷新会话通过 owner-scoped pending-job 发现 queued/running；`outcome_unknown` 仍不自动重试；保存发送的 intent key 继续覆盖 text/mode/source/page/chunk。
- U03 新增真实候选记忆面板：模型候选仅列为待确认，confirm/reject 通过用户路由；确认记忆可删除并刷新，显示来源轮次与不删除原材料提示。
- U03 课程页接入真实 learning summary，并显示 self-report/reference-checked/model-suggestion/unknown 证据标签；Today 页接入真实 tasks/plan/reminders API，计划确认受 pending/stale guard 保护，409 保持可见且不重复提交，提醒显示 in-app、receipt、unknown、quiet、rate-limited、disabled 语义。
- Candidate listing 现在通过 conversation owner 过滤，并映射为严格 `AssistantCandidateRecord` 合约；学习 summary 增加可选 `evidenceSources`，未改变既有 migration。

本切片主会话独立复核证据：

```text
Opening unit roots: 66 files / 380 tests passed
Focused U03/P03 unit + repository roots: 48 files / 295 tests passed
Latest focused U03/client/planning/learning roots: 14 files / 102 tests passed
Handler (isolated DB, explicit guard): opening-tutor, opening-memory-candidate,
  opening-learning-read, opening-reminders = 4 files / 18 tests passed
Web/contracts/database/domain/worker typecheck: passed
Changed-file ESLint: passed
npm run verify:ci: CI workflow contract satisfied
node scripts/validate-opening-plan.mjs: Plan structure PASS (43 tasks)

2026-09-23 additional verification and hardening:

- Fixed root `npm run typecheck`/`npm run build` nested-shell quoting on Windows/Git Bash; root `npm run typecheck` passed.
- Removed browser-bundle `node:crypto` imports from retest candidate generation and Opening upload SHA-256; Web Crypto/browser-safe paths are covered by unit tests.
- Added saved-history + ephemeral-tab message visibility and late-response-after-abort regression coverage; aligned tutor job terminal/error paths to workspace-first locking order.
- `npm test -- --project unit`: 189 files / 962 tests passed.
- `npm test -- --project unit --project contract`: 193 files passed, 981 tests passed, 12 skipped, 1 todo.
- `npm run lint`: passed. `npm run typecheck`: passed. `npm run build`: passed (worker typecheck + Next production build).
- Isolated handler tutor cancellation route: 1 file / 9 tests passed. `npm run verify:ci` passed; plan validation passed.
- Full guarded integration was attempted with explicit loopback test DB: 36 files / 187 tests passed, 4 files / 16 tests failed because Redis `127.0.0.1:6379` and MinIO `127.0.0.1:9000` were unavailable; this is environment-blocked evidence, not a product-pass claim.
- Browser upload E2E was attempted and blocked before tests because PostgreSQL `127.0.0.1:5432` was unavailable. Docker CLI is not installed locally.

## 2026-09-23 RP4 与 Q03 预检

已实施但未提升 `tasks.json` 状态：

- RP4：消息引用改为指向 `/api/opening/sources/:id/download?version=` 的版本链接；当前材料版本高于引用版本时，链接标题显示“不是当前版本”。下载服务原有版本校验与 mismatch 字段保持不变。
- Q03 仅开始纯函数切片：`validateOpeningRestore` 拒绝未知备份版本、非允许表、删除来源复活和对象哈希不一致。尚未实现数据库导出、对象打包、隔离恢复或 Docker 打包。

本切片主会话复核：

```text
Focused unit: message-list, assistant-view, source-viewer, message-model = 4 files / 33 tests passed
Focused unit: backup-policy = 1 file / 1 test passed
Changed-file ESLint: passed
Web and domain typecheck: passed
```

Known limits retained: browser rendering/upload/manual U03 loop not run; Redis/MinIO/PostgreSQL service-backed acceptance unavailable; no remote SHA/CI evidence; real model/external reminder receipt not authorized. Q03 backup/restore drill not run.

Known limits retained: browser rendering/upload/manual U03 loop not run; Redis/MinIO/PostgreSQL service-backed acceptance unavailable; no remote SHA/CI evidence; real model/external reminder receipt not authorized.
```

## Q03 后续切片：恢复预检的数据库隐私边界

本轮仅加固纯领域预检，未完成 Q03、未改变 `tasks.json` 状态：

- `backup-policy.ts` 接受 unknown 输入并 fail closed；畸形归档/缺失隐私元数据返回拒绝，不再抛出 TypeError。
- 白名单对齐实际 migration：`opening_source_chunks`、`opening_memories`、`opening_plan_drafts`；仍拒绝会话凭据、任务队列与未知表。此白名单只覆盖当前预检子集，不是完整备份导出清单。
- 删除排除覆盖无对象清单的 source 行、chunk、turn 的 source_ids/citations/source_versions；检查 workspace、记忆来源轮次缺失及 deleted memory。chunks 通过父 source 判定 workspace，不假定存在 workspace_id 列。
- 验证归档对象相对路径、哈希格式、正整数字节数；UUID 比较不区分大小写。函数不修改输入、不读写数据库。
- **边界**：`allowed` 只代表本层预检未发现问题，不是恢复授权。`actualSha256` 若来自归档本身不能充当真实校验；未来 I/O 层必须独立读取字节计算哈希、鉴权、校验完整行/关系并锁定当前删除日志。数据库导出、全表覆盖、对象一致性、apply 与隔离恢复演练仍未实现。

验证链（主会话实际执行）：

1. **失败**：先增加 `backup-privacy.test.ts`，运行 `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/backup-policy.test.ts packages/domain/src/opening/backup-privacy.test.ts` → `22 failed | 3 passed`。
2. **根因**：原实现信任静态类型，只检查 objects，未遍历数据库隐私引用；表名也与 migrations 不一致。
3. **修复**：最小扩展上述策略，结构/引用辅助函数放入 `backup-validation.ts`；未增加副作用或恢复入口。
4. **复查**：相同命令 → `2 files / 25 tests passed`。随后补充父来源归属、citation-only 记忆链、畸形引用与 UUID 大小写回归，再运行整个 Opening domain：`node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening` → `10 files / 100 tests passed`。`npm run typecheck -w @aistudy/domain` 与四个 backup 文件的定向 ESLint 均 exit 0；`node scripts/validate-opening-plan.mjs` → `Plan structure: PASS (43 tasks, acyclic dependencies, plan/evidence files present)`。

图谱同步：执行 `graphify update .`，AST 阶段显示 `1085/1085` 后命令在 120 秒超时；同时提示缺少 `tree_sitter_sql`（27 个 SQL 文件未进入图谱）。未盲目重试，也不声称图谱更新成功；表结构判断来自直接读取 migration。

交付仍需 Q03 的真实导出/隔离恢复集成测试及绑定 SHA 的 PR/CI 门禁；本轮没有运行完整构建、服务集成或浏览器验收，没有提交/推送/部署。下一切片应先实现 owner-scoped 导出与 DB+对象一致性清单，而不是直接开放 restore apply。

## Q03 来源快照与对象清单底层组件（grok 委派 + 主会话复核）

具体切片计划见 `q03-source-export-slice.md`。采用 user agent `grok-worker`（配置 `xhh-grok/grok-4.7`）；未触发模型不可用回退。run：`mudk9tuc-4f9bd7e5`（两个实现任务）、`mudkh8e7-bbe83f8a`（对象 review 修正）、`mudkkow9-27e61c88`（测试 review 修正）。最后 `mudkqluv-4401a3ef` 在 300 秒超时，但已写入 mock 类型修正；不以该 run 作为完成证明，主会话已检查产物并复跑。

新增文件：

- `packages/database/src/repositories/opening-backup-sources.ts` 与 `.test.ts`：`readOpeningBackupSources` 在单个 repeatable read/read only 事务先校验 owner，再读取 epoch、完整 workspace 删除日志及未排除的 uploaded 来源 ID/版本/大小/hash。只投影固定列，不读取正文、凭据或队列。
- `packages/database/src/storage/opening-backup-manifest.ts` 与 `.test.ts`：先验证全部输入并复制私有快照，再顺序读取真实对象摘要；核对 SHA-256 和字节数，失败不返回部分清单；不复制对象字节。
- `tests/integration/opening-backup-sources.test.ts`：真实数据库回归已编写，包含跨 workspace/owner、无来源行删除日志、外 workspace 同 sourceId 排除、pending/rejected 排除及 fixture 局部清理。未运行，不能视为集成通过。

验证/修复证据链：

1. 子 agent 报告初始 RED 为模块尚未实现；主会话独立初验 unit `2 files / 10 tests passed`，但 database typecheck 失败 `TS4104`（freeze 返回 readonly 与声明的 mutable 数组不符）。
2. 根因修复：去除不必要 freeze，保留返回契约。主 review 另发现 UUID 随机排序断言和异步等待期间输入可变风险；修正测试排序、复制私有来源快照。子 agent 报告新异步回归先 `1 failed / 8 passed`，再 `9 passed`；主会话复跑整套相关检查。
3. 主会话显式编译测试 roots 又复现 `TS2339`（mockImplementation/mockClear 不存在）；原因 storage mock 的返回类型注解抹除了 Mock 类型。改为 `Mocked<Storage>` 后，完全相同 TypeScript API roots 检查输出 `Explicit test roots: PASS (3 files + imported dependencies)`。
4. 主会话最终运行：`node node_modules/vitest/vitest.mjs run --project unit packages/database/src/repositories/opening-backup-sources.test.ts packages/database/src/storage/opening-backup-manifest.test.ts packages/database/src/storage/opening-s3.test.ts packages/domain/src/opening/backup-policy.test.ts packages/domain/src/opening/backup-privacy.test.ts` → `5 files / 46 tests passed`。`npm run typecheck -w @aistudy/database` exit 0；5 个新增 TS 文件的定向 ESLint exit 0。计划结构检查仍 PASS（43 tasks）。

本切片结束执行一次 `graphify update .`：exit 0，`13388 nodes / 29367 edges / 668 communities`，图谱文件已更新；仍警告缺失 `tree_sitter_sql` 导致 27 个 SQL 文件未提取。未安装依赖或调用付费语义标注。

本轮实测本地 `5432/6379/9000` 均 `ECONNREFUSED`，未启动服务或操作未知数据库。来源快照+对象校验不等于 DB/S3 原子备份；完整表关系/历史版本、对象字节复制、导出前后隐私日志校准、owner 最终复核和隔离恢复仍待实现。未加入运行时路由/barrel、未新增 migration、未提升 tasks 状态，未提交/推送/部署。交付还需服务集成与绑定 SHA 的 PR/CI。

## Q03 对象暂存与快照复核切片

计划：`q03-object-staging-slice.md`。本轮 grok-4.7 runs：`mudmksv1-e46966b7`（两项实现）、`mudmqcye-faf43617`（review 修正）、`mudn1xcd-16c9c9d2`（最后测试复核）；没有模型回退或提交。

- 新增 `storage/opening-backup-stage.ts` 与两个 stage 测试：私有新目录内按固定 UUID/版本路径，以 wx/0600 流式复制，校验字节数与 SHA-256；超限、短读、损坏、读/写中断均拒绝。失败只清理本次目录，清理失败单独报告，不能宣称没有残留。可信 parent 在 Windows 必须另有严格 ACL；POSIX mode 不代表已验证 Windows 隐私。
- `storage/opening-backup-manifest.ts` 提取同步验证+canonical snapshot，暂存和现有摘要验证共享规则。
- 新增 `repositories/opening-backup-current.ts` 与测试：异步前复制 scope/metadata，重新 owner-scoped 读取并比较 epoch、完整 journal 与 source ID/version/bytes/hash。顺序和合法大小写差异不影响比较；变化返回 CONFLICT，owner 失败保留 NOT_FOUND。
- 未接真实 S3 reader、未导出完整表、未实现最终发布/加密/恢复。校验返回后仍可能发生新删除，因此这不是跨 DB/S3 原子备份或删除竞态锁。

review 与验证：

1. 子 agent 初始 RED 是尚无实现模块。主 review 发现未复制 scope、journal timestamp null 可被 Date 接受、清理测试不检查残留、测试吞 assertion 等问题，要求修正。scope/null 两项子 agent 先报告可观察失败，再修复通过；去除公开 reader override，改在测试中 mock reader。
2. 补真实临时目录回归：清理后 parent 仅剩 sentinel、中途读流失败及 finally、写流失败、清理自身失败。删除吞 assertion 的代码；将原“不保留整对象”的弱测试改为诚实的多 chunk 用例，不声称测量过内存。
3. 最后一轮曾怀疑 mkdir 前打开远端流；重新读取发现上一轮实现已调整 mkdir 在前，新增断言首次即通过。该项是防回归覆盖，不虚构新发现或红绿修复。
4. 主会话独立最终验证：`node node_modules/vitest/vitest.mjs run --project unit packages/database/src/storage/opening-backup-stage.test.ts packages/database/src/storage/opening-backup-stage-failure.test.ts packages/database/src/storage/opening-backup-manifest.test.ts packages/database/src/repositories/opening-backup-current.test.ts packages/database/src/repositories/opening-backup-sources.test.ts packages/domain/src/opening/backup-policy.test.ts packages/domain/src/opening/backup-privacy.test.ts` → `7 files / 72 tests passed`。
5. `npm run typecheck -w @aistudy/database`、backup repository/storage 定向 ESLint exit 0。TypeScript API 按 tsconfig.base options 显式编译 5 个 backup unit roots + 1 个 integration root → `Explicit test roots: PASS (6 files + imported dependencies)`；计划结构仍 `PASS (43 tasks)`。

图谱同步：本切片一次 `graphify update .` exit 0，`13443 nodes / 29459 edges / 682 communities`；仍缺 SQL parser（27 SQL 文件未提取），未发起 LLM 标注。

未运行实际 DB/S3 集成、生产构建或恢复演练，不提升 Q03 状态。下一步应接真实 S3 流适配器并组装来源暂存+owner/隐私复核的失败清理流程，然后继续完整表关系导出；不得直接开放恢复或对外发布。交付仍需隔离服务验收与绑定 SHA 的 PR/CI。

## Q03 S3 reader、来源暂存编排与固定表清单

本轮计划：`q03-source-staging-integration-slice.md`。S3 reader 首次 grok 调用因 `upstream network: error reading a body from connection` 中断，按回退规则由 `luna-fast`（`gpt-5.6-luna-fast`）完成并由主会话复核；来源暂存编排由 grok 完成。之后固定表清单委派时 grok 与备用 luna 均返回 `503 Service temporarily unavailable`，该小任务由主会话完成，未盲目重试。

已完成的本地组件：

- `storage/opening-backup-reader.ts`：真实 `GetObjectCommand` 适配为惰性 `AsyncIterable<Uint8Array>`，映射 404/NoSuchKey 为 NOT_FOUND，其余读/迭代/非法 body 错误脱敏为 UNAVAILABLE；支持提前关闭、自然 EOF、source.destroy fallback，不缓存整对象。
- `repositories/opening-backup-prepare.ts`：稳定复制 scope，执行 owner-scoped inventory → 本地对象暂存 → epoch/journal/source 元数据复核；复核冲突只清理本次目录，清理失败单独报错。成功结果仍只是来源暂存，不是完整归档或恢复包。
- `repositories/opening-backup-records.ts`：固定 17 张 durable Opening 表、显式列投影、单 repeatable-read/read-only owner-scoped 查询；排除 tutor/jobs/outbox/budget/auth。source chunks 通过父来源 workspace、uploaded、版本和 privacy exclusion；turn/学习/计划派生记录增加 owner/来源隐私过滤；不导出 image object locator 和 deleted memory。快照带 privacyEpoch。

主会话 review 修正：reader 的 close-before-first-read、自然 EOF 终态、typed source error 脱敏及 close 双失败；编排 cleanup 测试改为真实 stage 成功后再触发 post-recheck cleanup；固定表查询吸收 grok 只读 review（turn owner、problem/help/acceptance 父归属、派生来源隐私、deleted memory、locator）。

验证证据：

- S3 reader/暂存/编排/固定表相关 unit：`13 files / 102 tests passed`。
- `npm run typecheck -w @aistudy/database`：通过。
- backup repository/storage 定向 ESLint、git diff --check：通过。
- 显式 TS roots（固定表实现、固定表测试、既有 guarded integration root）：`Explicit backup test roots: PASS (3 files + imported dependencies)`。
- 固定表新增文件均 <200 行。

边界与阻塞：真实 PostgreSQL `127.0.0.1:5432`、MinIO `127.0.0.1:9000` 仍 `ECONNREFUSED`；未运行真实 DB/S3 集成、完整导出、加密、隔离恢复、生产构建或发布。固定 SQL 虽有 fake transaction/查询结构测试，但不能替代 PostgreSQL 语义执行；workspace 删除竞态仍需最终发布协议。未修改 barrel、migration、路由，未提升 Q03 tasks 状态，未提交/推送/部署。

## Q03 固定表导出清单与恢复预检收口

本轮固定表任务曾委派 grok 与备用 luna，均因服务端 `503 Service temporarily unavailable` 未完成；随后主会话实现并由 grok-4.7 进行只读安全 review。review 指出并修复了 owner 相关性、citation/source version 隐私、deleted memory、memory exclusion、chunk version 和 17 表 allowlist 问题；固定查询拆为 `opening-backup-record-table-queries.ts` 与 `opening-backup-record-predicates.ts`，主入口 33 行、查询模块 127 行、谓词模块 177 行，均低于 200 行。

实现边界：单个 `repeatable read, read only` 事务，owner gate 首先执行；固定 17 张 durable 表显式字段读取，排除 jobs/outbox/budget/tutor/auth；对象定位字段不导出。来源、chunk、turn、学习、候选、memory、problem/help、plan acceptance 均通过 owner、上传版本和 privacy exclusion 关系过滤。`opening_turns.citations` 按 migration 的 JSONB 类型处理（此前 Drizzle schema 的 text 不一致风险保留为需真实 DB 核验项）；无效 source_versions/citation lineage 不进入导出查询。该函数仍只是 record inventory，不是 OpeningBackup 包，也未写数据库或恢复。

领域恢复预检同步加固：接受 UUID[] 或 JSON 文本数组；citations 要求合法 sourceId 和非负安全整数 sourceVersion；source_versions 要求 UUID key + 非负安全整数 value；chunk source_version 必须匹配 included source；memory source turns 必须属于 workspace backup；17 表允许名单扩展完成，jobs/outbox/budget/tutor/auth 继续拒绝。纯函数不接 DB/HTTP。

证据链：

1. 先写固定表失败回归，模块不存在时 unit `0 tests`，随后实现。
2. 主会话 review 发现数据库实际 migration 0017 为 JSONB citations、直接查询谓词存在自相关风险、文件超过 200 行；按失败→根因→修复拆分 helper，并补 citation/source-version、outer alias、lineage 测试。
3. 领域 version regression 首次失败 `1 failed`（citation-only fixture 缺 sourceVersion），补全 fixture 后通过；显式 test roots 首次暴露 `TS2322`（测试把 version literal 1 当作 2），改为 unknown object 形态后通过。一次 ESLint 失败为命令拼写不存在的 `opening-backup-predicates.ts`，改用真实 `opening-backup-record-predicates.ts` 后通过。
4. 最终主会话验证：相关 backup unit `14 files / 115 tests passed`；`npm run typecheck -w @aistudy/database`、`npm run typecheck -w @aistudy/domain`、backup repository/predicate/domain 定向 ESLint 和 `git diff --check` 均通过；显式 TypeScript backup test roots `15 files + imported dependencies: PASS`。

真实 PostgreSQL 仍不可用，以上 SQL 未执行；不能把 fake transaction/query-shape 测试当作数据库集成通过。尚未完成完整备份封装、对象 manifest 与 DB records 的最终一致性协议、加密发布、隔离恢复、恢复 apply 和生产构建；不提升 Q03 tasks 状态，不提交/推送/部署。下一步应在隔离 PostgreSQL/MinIO 可用后先运行固定表集成与隐私删除回归，再组装 versioned OpeningBackup 包，最后才进入 restore preview/apply。

## Q03 记录与对象一致性草稿组装切片

本轮继续推进 Q03，但仍未提升任务状态、未接运行时入口：

- 新增 `packages/domain/src/opening/backup-compose.ts` 与 `backup-compose-validation.ts`。纯函数将 `readOpeningBackupRecords` 的 17 张固定表、删除日志与来源暂存快照/对象清单组装为 version 1 `OpeningBackup` 草稿。
- 组装前 fail closed 校验 privacy epoch、workspace、完整固定表集合、所有表的 workspace 归属、chunk 父来源/version、`opening_privacy_exclusions` 与两个删除日志的一致性、来源元数据、对象集合/哈希/字节数/固定 archive path/真实 `actualSha256`。
- 组装结果丢弃 `actualSha256`，深复制表和删除日志；随后仍调用 `validateOpeningRestore`。`allowed` 仍只是结构与隐私预检，不是 restore authorization。
- `OpeningBackupRecordSnapshot` 现在携带从固定 privacy-exclusion 表投影出的 ISO deletion journal，便于后续数据库 inventory 与 staged object snapshot 汇合。
- 未加入 domain runtime barrel；未加入 export route、archive writer、加密、publish lock、restore apply 或自动清理。成功草稿仍不代表 DB+S3 原子快照。

证据链：

1. **失败**：先写 `backup-compose.test.ts`，模块不存在时 Vitest 报 `Cannot find module './backup-compose'`。
2. **根因/修复**：实现最小纯组装器；随后独立 review 发现 journal 未绑定 exclusion 表、对象路径/实际 hash 可缺失、未知/外 workspace 表延迟到 preview、重复 journal 可绕过比较；补充回归并拆出校验辅助模块。
3. **复查**：Q03 相关 unit `15 files / 124 tests passed`；`npm run typecheck -w @aistudy/domain` 与 `npm run typecheck -w @aistudy/database` 通过；backup domain/database 定向 ESLint 与 `git diff --check` 通过。
4. `graphify update .` 成功：`13587 nodes / 29774 edges / 687 communities`；仍警告缺少 `tree_sitter_sql`，27 个 SQL 文件未提取。

边界仍保留：真实 PostgreSQL `127.0.0.1:5432`、MinIO `127.0.0.1:9000` 尚未可用；未执行固定 SQL、DB/S3 集成、完整 archive、加密发布、隔离恢复或 apply。下一步仍应先在隔离服务可用时运行固定表/隐私删除集成，再设计一致性发布协议；不提交/推送/部署，不修改 `tasks.json`。

## Q03 数据库侧草稿编排切片

在纯组装器之后，继续把数据库侧 inventory 与暂存编排接起来，仍未提升任务状态：

- 新增 `packages/database/src/repositories/opening-backup-compose.ts`：`assembleOpeningBackupDraft(sql, scope, parentDirectory, reader)` 先 owner-scoped 读取固定表 records，再复用 `prepareOpeningSourceBackup` 完成对象暂存+快照复核，最后调用纯 `composeOpeningBackupDraft`。
- scope 在任何 IO 前复制并校验；caller 后续修改不影响两次读取。owner gate 拒绝（NOT_FOUND）不触发暂存；复核冲突原样透传，清理责任保持在 prepare。
- 组装失败（含 `JOURNAL_MISMATCH` 等全部 fail-closed code）时删除本次暂存目录后返回结构化失败；清理失败脱敏为 `staging cleanup failed`，不会伪装成 compose 结果。成功草稿由 caller 持有目录，无自动过期。
- 该函数仍不是 archive writer、发布、restore apply 或 DB+S3 原子快照；删除竞态与发布协议边界不变。未加入 database barrel（备份组件继续不进运行时导出）；`composeOpeningBackupDraft` 仅从 `@aistudy/domain` 包内导出供 database 层引用，web 路由不变。

证据链：

1. **失败**：先写 `opening-backup-compose.test.ts`，模块不存在时 Vitest 报 `Cannot find module './opening-backup-compose'`；随后运行暴露 `composeOpeningBackupDraft is not a function`（barrel 挂错模块路径），修正导出来源后通过。
2. 测试使用真实临时目录 + `node:fs/promises` rm boundary：验证顺序（records→prepare）、NOT_FOUND 不暂存、冲突透传不清理、JOURNAL_MISMATCH 后目录只剩 sentinel、清理失败脱敏且不吞错、caller 修改 scope 不影响已复制的 scope。
3. **主会话复查**：Q03 相关 unit `16 files / 130 tests passed`；全量 `npm test -- --project unit` 为 `205 files / 1094 tests passed`；`npm run typecheck -w @aistudy/domain` 与 `npm run typecheck -w @aistudy/database` 通过；新改文件定向 ESLint 与 `git diff --check` 通过。

边界仍保留：真实 PostgreSQL/MinIO 不可用，固定 SQL 与对象流仍未在真实服务上执行；未实现 archive writer、加密发布、隔离恢复、restore apply；未提交/推送/部署，未修改 `tasks.json`。下一步仍是在隔离服务可用时运行固定表与隐私删除集成，再设计版本化发布/加密协议。

## Q03 归档容器切片（archive writer/reader）

继续 Q03，仍未提升任务状态、未接运行时入口：

- 新增 `packages/database/src/storage/opening-backup-archive.ts`：固定容器格式 `MAGIC | 8 字节元数据长度 | 元数据 JSON | 按声明顺序拼接的对象字节`，无新依赖（纯 node:fs/stream/crypto）。
- `writeOpeningBackupArchive(backup, staging, destination)`：写入前逐个独立流式校验暂存对象字节数与 SHA-256（缺失/损坏拒绝）；写临时文件后 rename 提交；用 `wx` 探测保证不覆盖既有归档；失败清理本次临时文件。
- `readOpeningBackupArchive(destination)`：解析 magic/长度/元数据（限制 64MiB，拒绝截断与未知格式）；按元数据区间惰性读取对象字节，读取时独立计算 SHA-256，区间末尾与元数据哈希比对，不匹配抛 `object verification failed` 并关闭句柄；未声明路径拒绝；`close()` 幂等。
- 边界：元数据内声明的哈希从不作为证据，reader 独立验证实际字节；归档仍是未加密本地文件，加密/发布/隔离恢复在后续切片；写成功不代-表 DB+S3 快照一致。

证据链：

1. **失败**：先写 `opening-backup-archive.test.ts`，模块不存在时 Vitest 报 `Cannot find module './opening-backup-archive'`。
2. 首版实现被测试抓住两个真实缺口：Windows rename 会覆盖已存在文件（不覆盖语义失效）；读取区间未独立验哈希（篡改字节不可见）。分别以 `wx` 目标探测与迭代内独立 SHA-256 修复。
3. **主会话复查**：归档 unit `3 tests passed`；Q03 全聚焦回归 `17 files / 133 tests passed`；`npm run typecheck -w @aistudy/database` 通过；定向 ESLint（修掉未用导入与 generator 无 yield）与 `git diff --check` 通过；实现 193 行，低于 200 行约定。

真实 PostgreSQL/MinIO 仍不可用；未实现加密、发布协议、隔离恢复、restore apply；未提交/推送/部署，未修改 `tasks.json`。

## Q03 恢复 apply 计划器切片（纯 domain）

继续 Q03，未提升任务状态、未接运行时入口：

- 新增 `packages/domain/src/opening/backup-apply-plan.ts`：`planOpeningRestoreApply(backup, currentDeletionJournal, { confirmLocalRestore })` 纯函数产出恢复批次计划。
- fail-closed 链：缺 `confirmLocalRestore === true` → `REQUIRES_EXPLICIT_CONFIRMATION`；结构/隐私预检失败 → `PREFLIGHT_REJECTED`（含删除来源、deleted memory、未知表、foreign workspace、hash mismatch）；journal 集合/时间戳分歧被预检或 journal 比对拒绝，不产生计划。
- 计划按迁移外键固定顺序排列 17 张 durable 表（sources→chunks→conversations→turns→candidates→sessions→problem/help/observations→memories→exclusions→tasks/timetable/hard_blocks→plan_state→drafts→acceptances），附每表行数与 objectCount；队列/预算/tutor/auth 表永不出现。
- 明确边界：计划不是执行，也不是授权；执行器仍须在自己的事务内重新校验 journal，且绝不恢复凭据、会话、队列、预算或重放付费任务。

证据链：

1. **失败**：先写 `backup-apply-plan.test.ts`，模块不存在报 `Cannot find module './backup-apply-plan'`。
2. 测试修正两处自身断言（预检先于 drift 拒绝属 fail-closed 正确行为；`sessions` 子串误伤 `opening_sources`），不放松安全断言。
3. **主会话复查**：计划器 unit `5 tests passed`；Q03 全聚焦回归 `18 files / 138 tests passed`；domain/database typecheck 通过；实现 83 行，低于 200 行约定；定向 ESLint 与 `git diff --check` 通过。

真实 PostgreSQL/MinIO 仍不可用；未实现加密、发布、隔离恢复执行器（apply executor）、restore drill；未提交/推送/部署，未修改 `tasks.json`。

## Q03 归档加密信封切片

继续 Q03，未提升任务状态、未接运行时入口：

- 新增 `packages/database/src/storage/opening-backup-cipher.ts`：对已生成归档文件的外层信封加密，格式 `OPENING-ENC-V1 | u16 salt len | u16 nonce len | salt | nonce | ciphertext | 16 字节 GCM tag`；AES-256-GCM，密钥由口令 scrypt（N=2^15, r=8）派生，盐/nonce 每文件随机，口令永不写入文件。
- 加密按 256KiB 分块流式处理；tag 由实现显式追加（实验确认 Node 的 GCM cipher stream 不会自动把 tag 写入文件，这是本次测试抓住的第二个真实缺陷）。
- 解密 fail-closed：magic/长度校验、tag 前置读取、整体验证通过后才发布输出；错误口令、任意字节篡改、截断均拒绝且不产生目标文件；`wx` 探测修复了首个真实缺陷（探测残留 0 字节目标文件，失败路径污染输出目录）；输出已存在拒绝覆盖；临时文件失败即清理。
- 边界：口令强度与传递方式是调用方责任；密钥与备份分离由调用方架构保证（口令不落在同一介质）。这不是密钥管理服务，也不是发布协议。

证据链：

1. **失败**：先写 `opening-backup-cipher.test.ts`，模块不存在报 `Cannot find module './opening-backup-cipher'`。
2. 首版 stream pipeline 被测试抓住两个真实缺陷：GCM tag 未自动写入文件（解密永远失败）；`wx` 探测残留 0 字节目标文件。改为手动 FileHandle 写入（update→final→tag）与探测后删除。中途多个 Node stream 语义疑问用独立脚本验证后才落入实现。
3. **主会话复查**：信封 unit `3 tests passed`；Q03 全聚焦回归 `19 files / 141 tests passed`；database typecheck、定向 ESLint（修掉未用变量）、`git diff --check` 通过；实现 133 行。

真实 PostgreSQL/MinIO 仍不可用；apply 执行器需真实数据库，暂不打开；未提交/推送/部署，未修改 `tasks.json`。

## Q03 就绪检查与运维手册切片

继续 Q03 create 清单中可在无服务环境完成的最后两项，未提升任务状态：

- 新增 `scripts/opening-readiness.mjs` 与 `tests/tooling/opening-readiness.test.mjs`：就绪报告 fail-closed 聚合 —— `ready:true` 要求全部检查绿 **且** 告警目的地已配置；未配置告警目的地时如实输出 `alertDelivery:"unconfigured"` 与“监控存在但无人接收”的提示，不隐藏。输出仅元数据，凭证/用户内容永不打印。
- 修复过程抓住两个测试自身问题：`registrationOpen.ok:false`（注册已关闭是好状态）改为 `registrationLocked.ok:true` 语义；`failing` 断言从全等改为前缀匹配（实现带 detail 更有信息量）。fixture 默认 `ALERT_WEBHOOK_URL` 与 T1 断言矛盾也已修正。
- TDD 链：先写 5 项 tooling 测试（模块不存在 RED），实现后两次断言修正均由失败驱动，最终 `node --test "tests/tooling/*.test.mjs"` 32/32 通过（含既有 ci-workflow/eslint-scope）。
- 新增 `docs/operations/opening-release.md`：运维手册如实记录本地已实现/被阻塞清单、就绪检查用法、备份恢复边界（草稿非原子快照、`allowed` 非授权、元数据哈希非证明、离机副本必须信封加密）与五项被阻塞验收（真实模型、外部提醒、浏览器 E2E、恢复 drill、绑定 SHA 的 CI）。
- 一次性观察到 29 文件组合运行中出现 1 个存储测试偶发失败；隔离复跑与 3 次重复运行均全绿（系统临时目录并发冲突特征，非产品代码缺陷），已如实记录。

验证：tooling 32/32；Q03 相关 unit `29 files / 226 tests passed`（含 3 次稳定复跑）；database typecheck、定向 ESLint、`git diff --check` 通过。真实 PostgreSQL/MinIO 仍不可用；apply 执行器、CLI 包装、Docker 打包、CI SHA 证据仍被阻塞；未提交/推送/部署，未修改 `tasks.json`。

## 需要外部条件的验收

付费/真实模型预算与密钥、真实邮箱/钉钉账号授权、真机/媒体样本、远端CI运行及部署仍需对应配置/授权。默认仅本地离线实现与隔离测试；不提交/推送/部署、不访问生产数据。无法以本地替代的项目保持blocked，不缩减用户批准范围、不宣称所有计划完成。

## 2026-09-25 隔离验收完成与下一切片

本段更新此前“本地服务不可用”的历史游标。计划 `../2026-09-24-opening-isolated-acceptance.md` 已完成本地切片，完整命令、红绿链和边界见 `../../evidence/2026-09-24-opening-isolated-acceptance/verification.md`。

- 已使用任务专属 PostgreSQL 15432、Redis 16379、MinIO 19000/19001、Web 3100、fixture provider 18081；数据只在隔离测试库，未读取生产库或调用付费模型。
- 新浏览器断言暴露并修复：loopback 重定向 host 变化导致 Cookie 丢失；解析 job 失败未写 source 终态；模型 fixture 被用户问题中的词错误满足。失败回写通过事务、workspace-first lock、CAS、owner/epoch/version/exclusion 约束；原件保留。
- 主线程实际复跑：unit 209 files / 1112 tests；integration 43 files / 224 tests；handler 23 files / 87 tests；tooling 59 tests；Opening browser 8 tests + isolated Next production build，全部通过。数据库/Web/worker/E2E/显式测试 roots 类型、全仓库 lint、计划结构与 diff 检查通过。根 npm Bash 包装器未因此被标记通过。
- 独立只读质量复核无待修发现。图谱更新一次成功：13749 nodes / 30076 edges / 682 communities；缺 SQL parser 的 27 个 SQL 文件和 7 个空节点元数据文件仍未入图，无付费语义调用。
- 最终六个任务端口均关闭，owned-service manifest 为零。证据是当前 `8d616c0` 之上的工作树运行结果，不是可发布 SHA；未提交、推送、部署或修改 tasks.json 状态。

下一步应推进 Q03：在现已可用的隔离服务上补固定 17 表导出与隐私关系的真实 SQL 回归，完成 DB/对象一致性发布协议，再实现恢复 apply 与隔离恢复演练。完整 legacy 浏览器、真实模型质量、外部提醒、Docker/fresh-machine 安装、绑定 SHA 的 PR/CI 仍需各自验收，不再把服务缺失当作当前阻塞。

## 2026-09-25 Q03 真实导出与对象回归切片

本段接续 `2026-09-25-opening-backup-integration.md`。真实 PostgreSQL/MinIO 已验证固定17表、owner隔离、来源/引用/学习会话/记忆过滤、实际MVCC锁等待快照、草稿→归档→加密→解密字节一致性，以及对象暂存期间的删除/版本/清单变化拒绝与清理。

- 修复真实SQL阻断（JSON别名遮蔽导致text=uuid）、异常candidate形状放行、filtered session后代遗漏、非法memory UUID cast、空provenance与restore规则不一致、citation字符串版本、大写UUID误过滤及异步scope突变。
- 31个新增聚焦integration通过；全unit 209 files /1112 tests、全integration 47 files /255 tests通过。database/domain/web及6个显式测试roots类型、全仓库lint通过。全unit暴露的editor测试1ms漂移已固定测试Date；cipher单测1MB深比较超时已改为同等逐字节Buffer.equals，未提高超时阈值。
- 独立只读review三项发现全部先真实复现后修复并复核关闭。完整failure→cause→fix→recheck及测试fixture修正见 `../../evidence/2026-09-25-opening-backup-integration/verification.md`。
- task-owned PostgreSQL/Redis/MinIO已停止；未提交、推送、部署、访问生产或调用付费模型，未修改tasks状态。最终图谱数字在证据文件记录。

下一步保持原Q03范围：设计并实现DB历史快照+对象hash一致性、发布时隐私栅栏和并发不覆盖文件发布；随后恢复apply及新空库/存储隔离恢复演练、CLI与packaging。不能把此次加密往返当作恢复演练，也不能把workspace锁描述为覆盖所有写入的全库锁。原有真实模型、外部提醒、完整legacy browser、Docker/fresh-machine及release-SHA CI验收仍未因此完成。

## 2026-09-25 排他文件修复收尾与新执行入口

排他文件发布切片已本地完成：parent独立跑备份unit 24 files/170 tests、真实DB/MinIO integration 4 files/31 tests、5个显式测试roots类型、database类型和6文件lint通过。归档/加密/解密以自有临时文件加排他hard-link发布；已发布清理失败与未发布明文残留分别报告。完整红绿链与边界见 `../../evidence/2026-09-25-opening-backup-publication/verification.md`。短写、sync错误、Windows ACL和DB发布/恢复协议仍未完成。

用户已指示转入 `../2026-09-25-personal-use-multi-agent.md`：先PU00逐路径冻结隔离基线，再PU01契约，之后PU02与PU04并行。旧publication B–F移交PU05，不继续抢跑。该新计划明确允许在独立集成树形成逐路径本地snapshot提交；此前“不提交”的执行约定不再阻止该指定本地基线步骤，但原树/index仍受保护，push/部署/付费权限没有扩大。原43任务与CAP范围不变。
