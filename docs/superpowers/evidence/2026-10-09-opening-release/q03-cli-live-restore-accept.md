# Q03 — CLI live restore — Data ACCEPT (re-ACCEPT after prior REJECT)

**Date:** 2026-10-09 ~22:53 CST (Asia/Shanghai)  
**Workspace:** `/workspace/study-assistant-opening`  
**Branch:** `feat/opening-release` (uncommitted IMPLEMENT)  
**Scope:** Agent **ACCEPT** of the Opening-scoped **CLI live restore** slice only (IMPLEMENT evidence: `q03-cli-live-restore.md`). Prior Data REJECT (stub always-DEFERRED / missing cli-env / no CLI spawn APPLY_OK) is superseded by on-disk re-judge.  
**Verdict:** **ACCEPT** (slice only). **Not verified.** Full **Q03 stays `active`.**  
**Commit/push/deploy/Docker:** **not done** / **not claimed**. Does not touch `apps/web`.

## What was accepted (on disk now)

1. `scripts/opening-restore.ts` wires mutating path with `createSqlClient` + `createOpeningS3RestoreObjectPut(OpeningS3)` after `resolveOpeningRestoreCliLiveDeps`; incomplete env → **`LIVE_DEPS_MISSING`** (exit 1), not silent forever-`APPLY_EXECUTOR_DEFERRED` when deps are present.
2. `packages/database/src/repositories/opening-restore-cli-env.ts` (+ 8 unit tests) present; re-exported from `opening-backup.ts` / `packages/database/src/index.ts`.
3. Integration CLI spawn reaches **`APPLY_OK`** / `mutated=true` under live DB+MinIO; fail-closed spawn without DB URL → `LIVE_DEPS_MISSING`.

Object put on CLI path is **live S3** (`OpeningS3.putObject` / PutObject), not an in-memory stub.

Implement evidence (do not alter its IMPLEMENT verdict):  
`docs/superpowers/evidence/2026-10-09-opening-release/q03-cli-live-restore.md`

## Stronger review

| Concern | On-disk finding |
|---|---|
| Still-always-DEFERRED? | **No.** Confirm+draft+live env → `APPLY_OK` (integration spawn + CLI smoke). |
| Memory put on CLI path? | **No.** CLI uses `createOpeningS3RestoreObjectPut(storage)` → `storage.putObject`. |
| Evidence overclaim? | **No.** Re-run matched: tsc 0/0, unit 39, integration 6 incl. CLI spawn. |
| Missing cli-env? | **Present** + unit coverage. |
| Green without CLI spawn? | **No** — integration file includes CLI spawn APPLY_OK + LIVE_DEPS_MISSING cases; both ran. |

## Data re-run gates (this ACCEPT)

### Typecheck

```
npx tsc -p packages/domain --noEmit    # exit 0 (~22:52 CST)
npx tsc -p packages/database --noEmit  # exit 0 (~22:52 CST)
```

### Unit (match IMPLEMENT evidence)

```
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-backup-apply.test.ts \
  packages/database/src/storage/opening-s3.test.ts \
  packages/database/src/repositories/opening-backup-entrypoint.test.ts \
  packages/database/src/repositories/opening-backup-empty-namespace.test.ts \
  packages/domain/src/opening/backup-apply-plan.test.ts \
  packages/database/src/repositories/opening-restore-cli-env.test.ts \
  --testTimeout=15000
```

**Result:** PASS — 6 files / **39** tests (~22:52 CST).

### Integration (OPENING_TEST_DB + `.env` S3_*/MinIO `:9000`)

```
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
# + S3_* from .env
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-backup-restore-apply.test.ts \
  tests/integration/opening-backup-empty-namespace.test.ts \
  --testTimeout=60000
```

**Result:** PASS — 2 files / **6** tests (~22:52 CST), including CLI spawn APPLY_OK and CLI spawn LIVE_DEPS_MISSING. Dedicated UUID/keys only — no shared wipe.

### CLI spot-checks (~22:53 CST)

| Command | Exit | Notes |
|---|---|---|
| `tsx scripts/opening-restore.ts` (no confirm) | **2** | refuse / usage |
| `tsx … --confirm-local-restore --dry-run --draft <empty.json>` | **0** | `DRY_RUN_OK`, `mutated=false` |
| `tsx … --confirm-local-restore` (no draft) | **1** | draft required |
| `tsx … --confirm-local-restore --draft <json>` (DB URL keys unset) | **1** | `LIVE_DEPS_MISSING` (no secrets in stderr) |
| `tsx … --confirm-local-restore --draft <empty dedicated ws>` + live env | **0** | `APPLY_OK`, `mutated=true`; cleaned dedicated user/workspace after |

## Explicit non-claims / gaps

- **Not verified** — do not flip Q03 to `verified`.
- **No Docker** / compose / packaging-green / production build claims.
- **No commit / push** of IMPLEMENT.
- Did not edit `apps/web`.
- Remaining open for full Q03 (non-exhaustive): Docker/compose, packaging gates, CI release-SHA, encrypted-archive decrypt→apply, other packaging gaps per `q03-packaging-gaps.md`.

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03** remains **`status: active`**. This accept path (and implement evidence if not already listed) is appended under `evidence`. **verified: not set.**
