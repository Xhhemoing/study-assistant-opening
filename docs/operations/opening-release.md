# Opening Release Operations

Scope: the Opening release slice (43-task plan in
`docs/superpowers/plans/opening-release/`). This page records what operators
must run, what is verified, and what stays blocked. Release acceptance evidence is always bound to
an exact commit SHA; a claim without a SHA is not evidence.

## Status snapshot (2026-09-25, local only)

Implemented locally and covered by unit tests. The earlier default-port service
blocker is now removed by isolated PostgreSQL/Redis/MinIO. Source/storage and
application integration checks plus the Opening browser workflow have run locally;
this does not establish a complete backup/restore drill. Commands and boundaries:
`docs/superpowers/evidence/2026-09-24-opening-isolated-acceptance/verification.md`.

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

- Restore apply executor and the isolated restore drill. The planner exists;
  execution still needs the publish-protocol decision and end-to-end recovery
  evidence. Isolated PostgreSQL and MinIO are now available locally.
- `scripts/opening-backup.ts` / `scripts/opening-restore.ts` CLI wrappers.
- Docker packaging (`Dockerfile.opening-web`, `Dockerfile.opening-worker`,
  `compose.opening.yml`, `opening.env.example`).
- CI-run evidence for the release SHA (see `docs/operations/ci.md`).

## Real export validation (2026-09-25)

The real PostgreSQL/MinIO draft-to-encrypted-archive path now passes: 31 new
focused integration cases, with the full local suites at 209 unit files / 1112
tests and 47 integration files / 255 tests. See
`docs/superpowers/evidence/2026-09-25-opening-backup-integration/verification.md`.
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

## Connection credential foundation (C01, active)

Migrations `0041_opening_connections.sql` and `0042_opening_connection_lifecycle.sql`
add owner-scoped connection metadata and encrypted credentials. This is not a
working IMAP/DingTalk connector: check and sync return 503 without opening sockets;
requested DingTalk scopes are not authorization grants. Import receipts, cursors,
queue cancellation and connection-version/privacy-epoch writeback remain pending.

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

| Check | Probe |
| --- | --- |
| `database` / `redis` / `storage` | `select 1`, `PING`, S3 `HeadBucket` (5s timeout) |
| `workerBacklog` | no outbox row pending >10 min, no `failed` outbox row, no non-reminder job or tutor job queued >10 min. Failed outbox rows have no automatic re-drive yet, so they stay red until handled |
| `https` | `PUBLIC_BASE_URL` is https and its `/api/health` returns 200 |
| `registrationLocked` | `OPENING_RELEASE` parsed like the web app (`1`/`true`/`yes`) |
| `ownerSetup` | at least one user exists |
| `providerConfigured` / `dailyCap` | product model catalog: default model `available`, `OPENING_MODEL_DAILY_CAP_CENTS > 0` (needs `tsx`) |
| `backupFreshness` | `OPENING_BACKUP_ARCHIVE_PATH` mtime within `OPENING_BACKUP_MAX_AGE_HOURS` (default 24h) |
| alert destination | `ALERT_WEBHOOK_URL` non-empty |

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
4. Backup restore drill (needs the apply executor and consistency/publish protocol; isolated services are available).
5. Remote CI quality job bound to the release SHA (needs a pushed branch).

## Exclusive file publication (2026-09-25)

Archive/encrypt/decrypt publish closed temporary files using an exclusive hard link. Competing destinations and unowned temporary files are preserved. Cleanup failures explicitly identify whether publication occurred; callers must inspect that state before considering retries. Parent-run backup units (170) and real DB/MinIO integrations (31) passed; evidence: `docs/superpowers/evidence/2026-09-25-opening-backup-publication/verification.md`.

This does not yet establish DB publication fencing, restore apply, crash durability or Windows private-staging ACLs. Short writes and suppressed sync errors remain in the PU05 handoff. Work now follows the personal-use plan from PU00; no published artifact or production deployment is implied.
