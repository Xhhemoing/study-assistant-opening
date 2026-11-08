# Opening Release Operations

Scope: the Opening release slice (43-task plan in
`docs/superpowers/plans/opening-release/`). This page records what operators
must run, what is verified, and what stays blocked. Release acceptance evidence is always bound to
an exact commit SHA; a claim without a SHA is not evidence.

## 0108 release / rollback boundary (2026-11-08, not executed)

[#230](https://github.com/Xhhemoing/study-assistant-opening/pull/230), frozen at
`8ab660eefb3c7c5edcc32cf8df7847a5086cd21d`, adds
`0108_opening_knowledge_confirmations.sql`. The approved sequence is to complete
the first migration-free safe release of this round **before merging #230**.
Merge is not migration approval: each migration execution and migration-bearing
deployment still needs explicit user approval for its exact SHA, target and
operation. Only the PM arranges merge/deploy; the existing 2A ownership boundaries
are unchanged. This page grants no production or real-data operation authority.

Before requesting approval, follow
[database-migrations.md §8](database-migrations.md#8-0108-跨版本兼容与回退操作方案尚未执行):
read-only inventory of migration IDs and historical checksums against the upgrade
and rollback artifacts; a backup tied to exact versions and recovery time point;
integrity checks and an authorized restore rehearsal into a fresh empty isolated
database; named backup/recovery owners and original authorization. Keep real
connection details and evidence in private operations records. A backup timestamp
or CI result alone does not establish recoverability, and restoring an earlier
backup can lose subsequent learning records.

The canonical runner is not a read-only probe. At mainline
`be641ce61c15c3a85a4e5ce7ea613c53321bc79f`, it bootstraps the registry before
validation and rejects an already registered, unknown 0108 with
`MIGRATION_UNKNOWN_HISTORY`. Retaining the table does not make that old deployment
pre-step pass. Conversely, #230's normal knowledge `replace()` and confirmation
paths require the new table even when no confirmations exist yet.

Old snapshot readers can parse the existing `supported` / `needs_check` fields,
but old writers do not maintain #230's confirmation preservation/revocation rules.
An application rollback is **not** a database rollback or proof of semantic
compatibility. See §8.3 for the table/confirmation/reader matrix and §8.4 for the
failure branches. Cross-0108 rollback remains **blocked pending an independent H
compatibility fix** that preserves registry/checksum validation and confirmation
semantics (or prevents unsafe writers), its exact-head review/CI, and separate
deployment approval. Do not skip the migration pre-step, DROP the confirmation
table, edit `schema_migrations`/checksums, or overwrite real learning data with
`pg_restore` to force a rollback.

This is an unexecuted runbook, not evidence that 0108, a backup, rehearsal,
rollback or recovery has run. Browser acceptance remains with the user; this
change does not claim it passed.

## D4 + restored D5 candidate: reader and rollback boundary (2026-11-08)

This candidate combines frozen integration
`23fba100bfa18fd1f89bd1ede107394ae36e1474` with mainline
`1e511bc0f09d02f52d97be165597c6d3ab9bfe8d`. It writes
`next-learning-step-6` (restored D5 assisted success plus evidenced D4 cycles).
Span receipts explicitly support v1 with execution-1 and v2–v6 with execution-2;
first-learning explanations explicitly recognize v1–v6. Historical operation
replays retain their saved decision and activity, not a recomputed v6 decision.
An unknown version is not current authority: span decision decoding returns
unknown, and first-learning explanations remain readable but conservatively
report `policy_version_not_revalidated`. Known older receipts may report
`policy_changed`; none of these read paths rewrite historical receipts.

After the candidate writes an exam run's new `conversion` receipt, rolling the
application back to `1e511bc0f09d02f52d97be165597c6d3ab9bfe8d` is **not a
lossless application rollback**. That version's strict old parser rejects the
new field; sprint access and forecast evaluation of the affected saved state
can fail. Preserving the stored facts does not preserve access through that old
reader. Retain the conversion, original attempt, answer and exposure facts;
restore access by moving forward to a compatible reader, not by deleting the
field, rewriting history or restoring an older database.

Likewise, an older application that does not recognize a v6 receipt must treat
its policy conservatively as unknown/not current (or `policy_changed` where
supported), without synthesizing an old-policy receipt or restoring the database.
These are candidate compatibility limits, not evidence of a completed rollout
or rollback. Exact-head review/CI and separate merge/deployment authorization
remain required; this section grants neither operation.

## System query default (2026-10-21)

`OPENING_SYSTEM_QUERY` now defaults to `1` when unset, including on existing
deployments after this version is installed. Authenticated saved and temporary
chat can automatically route record questions through the existing owned,
read-only query service. To keep this feature disabled, retain explicit
`OPENING_SYSTEM_QUERY=0` in both Web and Worker environments. This does not enable
adaptive planning or remove confirmation from plan/teaching proposals. Existing
authorization, source/privacy checks and model budget limits remain in force.
Earlier default-off release records below describe their original versions.

## Status snapshot (2026-09-25, local only)

Implemented locally and covered by unit tests. The earlier default-port service
blocker is now removed by isolated PostgreSQL/Redis/MinIO. Source/storage and
application integration checks plus the Opening browser workflow have run locally;
this does not establish a complete backup/restore drill. Commands and boundaries:
`docs/archive/superpowers/evidence/2026-09-24-opening-isolated-acceptance/verification.md`.

- Owner-scoped backup source inventory, object staging, snapshot recheck
  (`packages/database/src/repositories/opening-backup-*.ts`,
  `packages/database/src/storage/opening-backup-{manifest,stage,reader}.ts`).
- Fixed 17-table durable record export with privacy filters
  (`opening-backup-records*.ts`), now covered by real PostgreSQL owner/privacy/lineage regressions.
- Pure compose/preflight/apply-plan domain rules
  (`packages/domain/src/opening/backup-*.ts`).
- Archive container read/write with independent hash verification
  (`opening-backup-archive.ts`) and passphrase envelope encryption
  (`opening-backup-cipher.ts`).
- Readiness aggregation rules (`scripts/opening-readiness.mjs`).

Not implemented yet (blocked or deliberately deferred):

- Isolated restore **drill** (fresh empty DB/S3 namespace + learning-loop verify)
  and packaging image/compose green. Opening-scoped transactional row/object
  **apply executor** now exists for confirm + validated backup + empty-namespace
  + `sql` (`packages/database/.../opening-backup-apply.ts`; Data slice ACCEPT
  2026-10-09 — see `q03-restore-apply-accept.md`). Dry-run / denied paths stay
  `mutated: false`; secrets/API keys/sessions never restored; pending jobs
  cancelled in-tx. CLI without a DB handle still reports deferred. Live S3
  object restore, full live export→archive→apply E2E, and compose-fresh empty
  namespace remain open. Shared `aistudy_opening_test` is populated (not an
  empty-DB drill target). Docker CLI may be absent on some boxes.
- Full backup CLI **DB+S3 export** path. Thin local publish CLI exists
  (`scripts/opening-backup.ts` → archive/cipher, fail-closed if staging
  incomplete) but does not assemble a live owner-scoped export end-to-end.
- Docker **image build / compose up / packaging gates** green. Scaffold paths
  exist (`Dockerfile.opening-*`, `compose.opening.yml`, `opening.env.example`);
  packaging success is not deploy. See
  `docs/archive/superpowers/evidence/2026-10-09-opening-release/q03-packaging-gaps.md`.
- CI-run evidence for the release SHA (see `docs/operations/ci.md`).

## Real export validation (2026-09-25)

The real PostgreSQL/MinIO draft-to-encrypted-archive path now passes: 31 new
focused integration cases, with the full local suites at 209 unit files / 1112
tests and 47 integration files / 255 tests. See
`docs/archive/superpowers/evidence/2026-09-25-opening-backup-integration/verification.md`.
Scope capture, malformed lineage, filtered-session descendants, citation version
types and case-insensitive references are covered. Deleted and unsourced memories
are omitted under the existing restore provenance rules; preserving handwritten
memories needs a separate provenance contract. This is not an apply/drill or a
publication protocol. Local evidence identifies the dirty worktree over its base
SHA and does not replace release-SHA CI.

## Local production preview

Use the precompiled server for daily manual use rather than `next dev`:

```bash
npm run preview:build
npm run preview:start -- --hostname 127.0.0.1 --port 3100
```

The build uses `.next-preview` and `tsconfig.preview.json`; development `.next`
and isolated E2E `.next-opening-e2e` remain separate. Stop the development web
server before building on a memory-constrained machine. Keep the existing Worker
and PostgreSQL/Redis/S3 services running; preview does not reset, seed, or migrate
the database and does not start a Worker.

The launcher loads the root `.env`, then the optional ignored `.env.preview`,
then inherited environment overrides. Set `PUBLIC_BASE_URL` to the preview origin
and retain the existing database, bucket, authentication secret, and cookie name.
For HTTP loopback use `SESSION_COOKIE_SECURE=false`; do not carry this setting
into HTTPS deployment. Next.js also loads its normal web environment files.
`OPENING_E2E=1` is rejected by the preview launcher.

Code changes do not update a running preview: stop it, rebuild, and restart.
Default `npm run preview` builds and starts on port 3000. Browser interaction
acceptance belongs to the user; successful HTTP shell responses are not acceptance.
These are local preview commands, not replacements for release CI gates.

### FACDA 恢复材料的结论与复验（2026-10-19）

用户提供的 `study-facda-final-ui-recovery-evidence.zip` 和
`study-facda-ui-recovery-and-unexecuted-cases-evidence.zip` 针对 `facda242b`：
登录 POST 200 已记录，`/opening/today` 最终编译耗时 2243.9 秒（3691 modules）。
编译完成后的浏览器观察超时，因此页面渲染、自动查询 GUI 和 ST001–004 均不能记为通过。
原 Web 曾退出，退出原因未确定；恢复后也缺少资源快照，不能认定 OOM。
本轮本地优化基于 `6c4a4ea8`，本地未取得 `facda242b` 对象，不等同于复现该候选版本。

验收环境优先使用上面的预编译预览，构建成功后再开始用户浏览器验收。
隔离 E2E 环境仍保留 `OPENING_E2E=1` 及原数据库、Redis、存储和认证配置；
停止该测试 Web 后，在 `apps/web` 目录用同一环境先执行 `next build`，成功后执行 `next start`；
不要为了使用 preview 脚本关闭隔离开关。
`Ready`、端口监听、登录 200 和编译完成分别说明不同阶段；都不替代目标页面可操作。
Today 的加载提示只覆盖路由可用后的等待，不能保证开发服务器冷编译期间出现。

本轮用户复验入口：`/login` → `/opening/today`。前提是已有可登录账户及匹配的服务配置。
成功登录后应显示进入状态，重复点击不再发起登录 POST；跳转迟滞时可点“点此继续”。
Today 等待读取期间应有明确提示，完成后保留工作区时区、任务定位和错误反馈。
再到 `/opening/assistant` 复验默认自然问句、显式查询、保存后刷新和临时会话。
ST001 需要真实 PDF 和可用对象存储；ST002 需要在专门验收环境启用自适应规划；
ST003 的无密钥校验/取消/不可用提示不代表真实模型可用；ST004 应操作原生内容备份的冲突拒绝/跳过恢复流程。
以上浏览器项目均待用户验收，空模型目录与零预算下的结果不证明模型质量。

## Connection credential foundation (C01)

Migrations `0041_opening_connections.sql` and `0042_opening_connection_lifecycle.sql`
add owner-scoped connection metadata and encrypted credentials. C01 itself is the
credential/vault foundation, not a claim that school IMAP or enterprise DingTalk
live connect is done. IMAP and DingTalk `check`/`sync` behavior is documented in
`opening-mail.md` and `opening-dingtalk.md` (and C02/C03 evidence): IMAP adapters
are wired when credentials and host allowlist are ready; DingTalk `check` returns
local fail-closed JSON (not a blanket 503) and does not call remote DingTalk APIs.
Requested DingTalk scopes are still not authorization grants. CAP01/CAP02 live
acceptance remains blocked until real school/org authorization is collected.

Web credential writes require `OPENING_CONNECTION_KEY` (canonical base64 of 32
random bytes) and a stable `OPENING_CONNECTION_KEY_ID`. Keep keys in the deployment
secret store, not URLs, logs or backups. HTTPS and the existing same-origin mutation
policy are required for deployed credential submission. Administrator-approved IMAP
hosts go in `OPENING_IMAP_ALLOWED_HOSTS`; future socket adapters must additionally
validate DNS/IP, prevent metadata access and enforce certificate-verified TLS.

For key rotation, change both the active key and key ID, retaining old keys in
`OPENING_CONNECTION_PREVIOUS_KEYS` as a JSON object keyed by their old IDs. Old
ciphertexts and credential-request replays require those retained keys. Connection
records and encrypted credentials are deliberately absent from current backups;
restoring materials does not restore or authorize remote connections.

Rollback: disable connection HTTP entry points and any future connection workers,
then revoke connections to delete their credential envelopes and replay fingerprints.
Retain the new tables and imported originals for repair; do not run a destructive
SQL down migration or alter applied migration checksums.

## Readiness checks

`npx tsx scripts/opening-readiness.mjs` runs real probes
(`scripts/opening-readiness-probes.mjs`) and fails closed: `ready: true`
requires every required check (`REQUIRED_CHECKS`) to have run and returned
`ok: true` **and** a configured alert destination. A check that was not run is
reported as `probe not run`. An unconfigured destination is reported as
`alertDelivery: "unconfigured"`; `"configured"` means a URL is set, not that an
alert was delivered. Output is metadata only; credentials and user content are
never printed. Exit code is 0 only when ready.

Windows machines without bash or Docker follow [opening-local-windows.md](opening-local-windows.md). The read-only check is `node scripts/opening-local-check.mjs`. It reports ports, `/api/opening/health`, whether required variables are set, `PARSER_PYTHON`, and `GET /api/opening/ai-readiness`. It prints booleans only and does not start or stop services.

Required environment: `DATABASE_URL`, `REDIS_URL`, `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `PUBLIC_BASE_URL`.

| Plan item (08-delivery §Q03) | Check / field | Probe |
| --- | --- | --- |
| DB | `database` | `select 1` (5s timeout) |
| Redis / worker heartbeat | `redis` / `workerBacklog` | `PING`; no outbox pending >10m, no `failed` outbox, no non-reminder/tutor job queued >10m |
| storage | `storage` | S3 `HeadBucket` (5s timeout) |
| HTTPS | `https` | `PUBLIC_BASE_URL` is https and `/api/health` returns 200 |
| registration403 | `registrationLocked` | `OPENING_RELEASE` parsed like the web app (`1`/`true`/`yes`); detail mentions expect registration 403 |
| owner setup | `ownerSetup` | at least one user exists |
| configured provider / daily cap | `providerConfigured` / `dailyCap` | product model catalog: default model `available`, `OPENING_MODEL_DAILY_CAP_CENTS > 0` (needs `tsx`) |
| backup freshness | `backupFreshness` | `OPENING_BACKUP_ARCHIVE_PATH` mtime within `OPENING_BACKUP_MAX_AGE_HOURS` (default 24h) |
| honest alert destination | `alertDelivery` | `ALERT_WEBHOOK_URL` non-empty → `"configured"` (not delivery proof); empty → `"unconfigured"` + note that nobody is receiving alerts |

Public `GET /api/opening/health` exposes only coarse `database`/`redis`/`storage`/`workerBacklog` up/down. Full readiness (including alert honesty) is the CLI report above.

## Backup and restore boundary

- A successfully composed draft is **not** a DB+S3 atomic snapshot. A deletion
  can always race after the last recheck; the apply executor must re-verify the
  deletion journal inside its own transaction before restoring.
- `validateOpeningRestore(...).allowed === true` and an apply **plan** are
  structural preflight results, never authorization to restore. Restores need
  the explicit local confirmation flag plus operator authorization.
- Archive member hashes declared inside metadata are not proof; the archive
  reader re-computes SHA-256 over actual bytes, and a mismatch fails closed.
- Off-host copies must stay in the encrypted envelope form; the passphrase is
  separate from the archive. Windows mode bits are not ACL proof for staging
  directories.

## Blocked acceptance items

These stay explicitly blocked and cannot be claimed from local runs:

1. Real-model budget consumption and quality sampling (needs funded keys).
2. Email/DingTalk reminder delivery (needs authorized accounts).
3. Full legacy browser suite and fresh-machine/Docker installation verification (the isolated Opening suite passes locally).
4. Backup restore drill to a **fresh empty** DB/S3 namespace (then learning-loop verify). Apply executor slice is Data-ACCEPTed for confirm+sql+empty local path (`q03-restore-apply-accept.md`); still blocked on: isolated empty namespace (shared `aistudy_opening_test` populated; docker CLI often absent → no compose-fresh), live S3 object restore (integration used in-memory put), full live export→archive→apply E2E, and packaging image/compose green. Native `backup-restore` is a different package path. Q03 stays active / not verified until those gates close.
5. Remote CI quality job bound to the release SHA (needs a pushed branch).

## Exclusive file publication (2026-09-25)

Archive/encrypt/decrypt publish closed temporary files using an exclusive hard link. Competing destinations and unowned temporary files are preserved. Cleanup failures explicitly identify whether publication occurred; callers must inspect that state before considering retries. Parent-run backup units (170) and real DB/MinIO integrations (31) passed; evidence: `docs/archive/superpowers/evidence/2026-09-25-opening-backup-publication/verification.md`.

This does not yet establish DB publication fencing, restore apply, crash durability or Windows private-staging ACLs. Short writes and suppressed sync errors remain in the PU05 handoff. Work now follows the personal-use plan from PU00; no published artifact or production deployment is implied.
