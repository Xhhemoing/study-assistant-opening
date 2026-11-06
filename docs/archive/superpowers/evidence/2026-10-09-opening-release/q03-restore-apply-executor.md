# Q03 — Opening restore apply executor (IMPLEMENT)

**Date:** 2026-10-09 ~20:30–21:04 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR (IMPLEMENT)  
**Status:** IMPLEMENT done — **ready for Accept by another agent**. **Not verified**, **no commit**, **no push**, **no Docker**.

## Intent delivered

Opening-scoped **transactional row + object apply executor** removes `APPLY_EXECUTOR_DEFERRED` when:

1. `confirmLocalRestore: true`
2. backup + journal pass `validateOpeningRestore` / `planOpeningRestoreApply`
3. empty-namespace verified (pre-counts and/or live re-read in-tx)
4. `sql` handle provided to `applyOpeningRestore` / `executeOpeningRestoreApply`

Native `backup-restore` / `applyRestorePlan` is **not** used (different schema).

## What changed

| Path | Change |
|---|---|
| `packages/domain/src/opening/backup-apply-plan.ts` | Export `OPENING_RESTORE_APPLY_ORDER` (former private `APPLY_ORDER`). |
| `packages/domain/src/index.ts` | Export `OPENING_RESTORE_APPLY_ORDER`, `normalizeOpeningRestoreHistory`. |
| `packages/database/src/repositories/opening-backup-apply.ts` | **New** executor: allowlisted inserts in APPLY_ORDER inside `sql.begin`; cancel `opening_jobs` queued/running; optional `objectPut` / staging / in-memory bodies; never NEVER_TABLES. |
| `packages/database/src/repositories/opening-backup-apply.test.ts` | Fail-closed unit gates (confirm / TARGET_NOT_EMPTY / allowlist). |
| `packages/database/src/repositories/opening-backup.ts` | `applyOpeningRestore` **async**; when confirm+backup+empty+`sql` → `APPLY_OK` (`mutated: true`); without `sql` still deferred after empty verify; dry-run stays `mutated: false`. |
| `packages/database/src/repositories/opening-backup-entrypoint.test.ts` | Async awaits; empty-without-sql deferred; APPLY_ORDER allowlist; dry-run mutated:false. |
| `packages/database/src/index.ts` | Re-exports executor helpers / APPLY_ORDER / row columns. |
| `scripts/opening-restore.ts` | Await async entry; CLI still has no DB handle → deferred without sql. |
| `tests/integration/opening-backup-restore-apply.test.ts` | **New** OPENING_TEST_DB proof: dedicated empty workspace UUID insert + object put + second apply TARGET_NOT_EMPTY. Does **not** wipe shared DB. |

## Guarantees (always)

- `secretsRestored=false`, `apiKeysRestored=false`, `sessionsRestored=false`
- `pendingJobs=cancelled` (queued/running `opening_jobs` → `cancelled` in-tx; never re-queued paid)
- Dry-run / denied paths: `mutated: false`

## Object apply honesty

- With `objectPut` + `objectBodies` / `stagingDirectory` → objects applied in same transaction callback (put failure rolls back rows).
- Without `objectPut` but `objects.length > 0` → rows still apply; `objectApplyDeferred: true` (documented gap; no fake S3 claim).
- Integration used in-memory `createMemoryOpeningRestoreObjectPut` (no live S3).

## Commands run (CST)

### Typecheck

```
npx tsc -p packages/domain/tsconfig.json --noEmit   # exit 0
npx tsc -p packages/database/tsconfig.json --noEmit # exit 0 (~20:54)
```

### Unit

```
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-backup-entrypoint.test.ts \
  packages/database/src/repositories/opening-backup-empty-namespace.test.ts \
  --testTimeout=15000
```
**Result:** PASS — 2 files / **14** tests (~20:56 CST).

```
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-backup-apply.test.ts --testTimeout=15000
```
**Result:** PASS — 1 file / **3** tests (~21:03 CST).

```
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/backup-apply-plan.test.ts --testTimeout=15000
```
**Result:** PASS — 1 file / **8** tests (~21:00 CST).

### Integration (OPENING_TEST_DB — dedicated workspace UUID)

```
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-backup-restore-apply.test.ts \
  tests/integration/opening-backup-empty-namespace.test.ts \
  --testTimeout=30000
```
**Result:** PASS — 2 files / **3** tests (~20:59 CST).  
Apply test: insert `opening_sources` into fresh workspace; `APPLY_OK` `mutated:true`; re-apply → `TARGET_NOT_EMPTY` `mutated:false`. Cleanup: DELETE that workspace/user only.

### CLI smoke

| Command | Observed |
|---|---|
| `tsx scripts/opening-restore.ts` (no flag) | refuse / usage |
| `tsx scripts/opening-restore.ts --confirm-local-restore` | `APPLY_EXECUTOR_DEFERRED`, `mutated=false`, guarantees cancelled/false (CLI has no sql) |

Docker CLI: **not used** / absent for image claims.

## Still blocked for Q03 **verified** (Accept / QA)

1. Accept review by another agent (this slice is IMPLEMENT only).
2. Broader packaging green (full monorepo lint/typecheck/build; production image/compose — docker CLI absent).
3. Live S3 object restore path (integration used in-memory object put).
4. Full live `exportOpeningBackup` + archive + apply E2E on empty drill target.
5. CI release-SHA evidence (**no commit** this slice).

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03 remains `active`**. Evidence path appended; status **not** flipped to verified; **no Accept self-claim**.

---

## ACCEPT note (2026-10-09 ~21:12 CST) — do not change IMPLEMENT verdict above

**Data ACCEPT** (slice only): PM attested AIstudy Data ACCEPTed this Opening apply-executor slice after re-running **unit 25** + **OPENING_TEST_DB empty-workspace integration 3** + **domain/database tsc** green.

- Accept evidence: `q03-restore-apply-accept.md`
- **Not verified.** Full **Q03 stays `active`.**
- IMPLEMENT status/sections above remain the implement record; this note does not upgrade packaging, Docker, live S3, full backup E2E, or CI SHA claims.
