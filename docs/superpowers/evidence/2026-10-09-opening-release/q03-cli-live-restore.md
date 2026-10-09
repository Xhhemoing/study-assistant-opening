# Q03 — CLI live restore (IMPLEMENT after Data REJECT)

**Date:** 2026-10-09 ~22:48–22:52 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR (IMPLEMENT)  
**Status:** IMPLEMENT done — **READY_FOR_DATA_ACCEPT**. **Not verified**, **no commit**, **no push**, **no Docker**.

## Why this slice (Data REJECT)

Prior tree still had the CLI stub:

- `scripts/opening-restore.ts` confirm without `sql`/`objectPut` → always `APPLY_EXECUTOR_DEFERRED` / exit 1
- `opening-restore-cli-env.ts` missing
- evidence `q03-cli-live-restore.md` missing
- integration had no CLI spawn `APPLY_OK`

Library MinIO apply (prior ACCEPT) does **not** satisfy this CLI slice.

## Intent delivered

1. Wire CLI so confirm + draft + live DB+S3 env → `applyOpeningRestore({ sql, objectPut: createOpeningS3RestoreObjectPut(...) })` can return **APPLY_OK** (`mutated: true`).
2. Dry-run path unchanged (structural preflight only).
3. Fail-closed with **LIVE_DEPS_MISSING** (lists missing env key names) when mutating path has draft but incomplete live deps — never silent DEFERRED.
4. Dedicated workspace UUID + tracked keys only — never wipe shared DB/bucket.
5. Do not touch `apps/web`. Do not mark Q03 verified. Do not commit/push.

## Diff table

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-restore-cli-env.ts` | **New:** `resolveOpeningRestoreCliLiveDeps` — DB URL preference `OPENING_RESTORE_DATABASE_URL` → `OPENING_TEST_DATABASE_URL` → `DATABASE_URL`; S3 from `OPENING_S3_*` / `S3_*`; `LIVE_DEPS_MISSING` + `missingKeys` (no secrets). |
| `packages/database/src/repositories/opening-restore-cli-env.test.ts` | **New:** 8 unit tests (preference order, overrides, forcePathStyle, missing/blank gates). |
| `packages/database/src/repositories/opening-backup.ts` | Re-export cli-env resolver + types. |
| `packages/database/src/index.ts` | Re-export cli-env resolver + types. |
| `scripts/opening-restore.ts` | Mutating path: require `--draft`; resolve live deps; build `sql` + `OpeningS3` + `createOpeningS3RestoreObjectPut`; optional `--staging`; APPLY_OK→exit 0; LIVE_DEPS_MISSING / PREFLIGHT / TARGET_NOT_EMPTY / etc→exit 1. Header: CLI **can** apply when env present. Dry-run unchanged. |
| `tests/integration/opening-backup-restore-apply.test.ts` | CLI spawn: confirm+draft+live → APPLY_OK; confirm+draft+no DB URL → LIVE_DEPS_MISSING (not APPLY_OK). |
| `docs/superpowers/plans/opening-release/tasks.json` | Surgical append evidence path; Q03 status stays **active**. |
| `docs/superpowers/evidence/2026-10-09-opening-release/q03-cli-live-restore.md` | This note. |

## Commands run (CST)

### Typecheck

```
npx tsc -p packages/domain --noEmit    # exit 0 (~22:50)
npx tsc -p packages/database --noEmit  # exit 0 (~22:50)
```

### Unit

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

**Result:** PASS — 6 files / **39** tests (~22:50 CST) (prior 31 + **8** cli-env).

### Integration (OPENING_TEST_DB + MinIO from `.env` S3_*)

```
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
# + S3_* from .env (minioadmin / bucket aistudy @ 127.0.0.1:9000)
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-backup-restore-apply.test.ts \
  tests/integration/opening-backup-empty-namespace.test.ts \
  --testTimeout=60000
```

**Result:** PASS — 2 files / **6** tests (~22:51 CST):

| Test | Proof |
|---|---|
| library empty workspace + live MinIO objectPut | prior green |
| library export→archive→empty→apply E2E | prior green |
| **CLI spawn APPLY_OK** | `tsx scripts/opening-restore.ts --confirm-local-restore --draft … --staging …` → exit 0, stderr `APPLY_OK` / `mutated=true`; row+object restored |
| **CLI spawn no sql env** | confirm+draft with DB URL keys deleted → exit 1, `LIVE_DEPS_MISSING`, not APPLY_OK; no secrets in stderr |
| empty-namespace integration | still green (2) |

Cleanup: DELETE only dedicated workspace/user; delete only tracked MinIO keys. No shared wipe. No Docker.

### CLI smokes

| Command | Exit | Notes |
|---|---|---|
| `tsx scripts/opening-restore.ts` (no confirm) | **2** | refuse / usage |
| `tsx … --confirm-local-restore --dry-run --draft <json>` | **0** | `DRY_RUN_OK`, `mutated=false` |
| `tsx … --confirm-local-restore` (no draft) | **1** | draft required |
| `tsx … --confirm-local-restore --draft <json>` (DB URLs unset) | **1** | `LIVE_DEPS_MISSING` |
| `tsx … --confirm-local-restore --draft <live empty ws>` | **0** | `APPLY_OK`, `mutated=true` (dedicated UUID; cleaned after) |

## Explicit non-claims

- **No Docker**
- **Not verified** (Q03 remains active; no Accept self-claim)
- **Uncommitted / unpushed**
- Did not touch `apps/web`
- Did not race handler files (`opening-upload-desktop`, `opening-connections`)

## READY_FOR_DATA_ACCEPT

**Yes.** Data should re-run:

1. `tsc -p packages/domain` + `tsc -p packages/database`
2. Unit suite above → **39**
3. Integration under `OPENING_TEST_DB` + `.env` `S3_*` → **6** including CLI spawn APPLY_OK
4. CLI smokes (no-confirm→2, dry-run→0 DRY_RUN_OK mutated=false, confirm+live→APPLY_OK when env+empty dedicated ws)

Evidence on disk: `docs/superpowers/evidence/2026-10-09-opening-release/q03-cli-live-restore.md`
