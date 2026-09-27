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

## Readiness checks

`node scripts/opening-readiness.mjs` aggregates probe results and fails closed:
`ready: true` requires every check green **and** a configured alert destination.
An unconfigured destination is reported as `alertDelivery: "unconfigured"` with
the note that monitoring exists locally but nobody is receiving alerts — this
is stated, never hidden. Output is metadata only; credentials and user content
are never printed.

Required environment variables for a full run: `DATABASE_URL`, `REDIS_URL`,
`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
Feature flags reported as checks: `AI_PROVIDER_API_KEY`,
`OPENING_DAILY_CAP`, `OPENING_REGISTRATION_LOCKED`, `ALERT_WEBHOOK_URL`,
`OPENING_BACKUP_MAX_AGE_HOURS` (default 24h).

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
