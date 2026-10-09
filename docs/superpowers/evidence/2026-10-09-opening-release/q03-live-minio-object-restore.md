# Q03 — Live MinIO object restore + export→archive→apply E2E (IMPLEMENT)

**Date:** 2026-10-09 ~21:28–21:31 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR (IMPLEMENT)  
**Status:** IMPLEMENT done — **READY_FOR_DATA_ACCEPT**. **Not verified**, **no commit**, **no push**, **no Docker**.

## Intent delivered

1. Close honesty gap: real `OpeningRestoreObjectPut` via `OpeningS3.putObject` / PutObject against **live MinIO** (no longer memory-only).
2. Advance full `exportOpeningBackup` → `publishOpeningBackupArchive` → `applyOpeningRestore` (confirm + sql + live objectPut) on a **fresh empty workspace UUID**.
3. Guarantees held: secrets/API keys/sessions unrestored; pending `opening_jobs` cancelled in-tx.
4. Dedicated workspace UUID + source object keys only — **never** wipe shared DB/bucket.

## What changed

| Path | Change |
|---|---|
| `packages/database/src/storage/opening-s3.ts` | Add `putObject(key, body, { mime? })` (PutObjectCommand); include in `OpeningStorage` Pick. |
| `packages/database/src/storage/opening-s3.test.ts` | Unit: putObject sends PutObjectCommand with ContentLength/Body. |
| `packages/database/src/repositories/opening-backup-apply.ts` | `parseOpeningRestoreObjectVersion`, `createOpeningS3RestoreObjectPut` (finalKey from `objects/<id>/vN.bin`; tracks keys for cleanup). |
| `packages/database/src/repositories/opening-backup-apply.test.ts` | Unit: version parse + put mapping; unsafe/mismatch path rejection. |
| `packages/database/src/repositories/opening-backup.ts` / `index.ts` | Re-export S3 objectPut factory + types. |
| `tests/integration/opening-backup-restore-apply.test.ts` | Live MinIO apply (`objectApplyDeferred=false` + head/digest); full export→archive→empty→apply E2E. |

## Object apply honesty (closed)

- Prior slice used only `createMemoryOpeningRestoreObjectPut`.
- This slice wires `createOpeningS3RestoreObjectPut(storage)` → `OpeningS3.putObject` → live MinIO `opening/sources/<sourceId>/v<N>`.
- Integration asserts `objectApplyDeferred === false`, `objectsApplied >= 1`, object exists via `headObject` + `streamDigest` sha match.

## Commands run (CST)

### Typecheck

```
npx tsc -p packages/domain/tsconfig.json --noEmit   # exit 0 (~21:29)
npx tsc -p packages/database/tsconfig.json --noEmit # exit 0 (~21:29)
```

### Unit

```
node node_modules/vitest/vitest.mjs run --project unit \
  packages/database/src/repositories/opening-backup-apply.test.ts \
  packages/database/src/storage/opening-s3.test.ts \
  packages/database/src/repositories/opening-backup-entrypoint.test.ts \
  packages/database/src/repositories/opening-backup-empty-namespace.test.ts \
  packages/domain/src/opening/backup-apply-plan.test.ts \
  --testTimeout=15000
```

**Result:** PASS — 5 files / **31** tests (~21:29 and reconfirm ~21:30 CST).

### Integration (OPENING_TEST_DB + live MinIO from `.env` S3_*)

```
OPENING_TEST_DB=1 \
OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
# + S3_* from .env (minioadmin / bucket aistudy @ 127.0.0.1:9000)
node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-backup-restore-apply.test.ts \
  tests/integration/opening-backup-empty-namespace.test.ts \
  --testTimeout=60000
```

**Result:** PASS — 2 files / **4** tests (~21:30 CST):

| Test | Proof |
|---|---|
| empty workspace + live MinIO objectPut | `APPLY_OK`, `objectApplyDeferred=false`, object head+sha; re-apply → `TARGET_NOT_EMPTY` |
| export→archive→empty→apply E2E | seed source+MinIO+queued job → `exportOpeningBackup` → publish archive → delete dedicated rows/key → apply with staging + S3 put → rows+object restored; job cancelled |
| empty-namespace integration (prior) | still green (2 tests) |

Cleanup: DELETE only dedicated workspace/user; delete only tracked MinIO keys under `opening/sources/<uuid>/…`. No shared bucket wipe. No Docker.

## Still blocked for Q03 **verified**

1. Data **ACCEPT** of this live-MinIO / E2E slice (this note is IMPLEMENT only).
2. Broader packaging green (full monorepo lint/typecheck/build; production image/compose — **Docker CLI absent**; do not claim packaging green).
3. CI release-SHA evidence (**no commit** this slice).
4. Optional follow-ups: CLI wiring of live `objectPut`+sql; encrypted-archive decrypt→apply path; remap-to-second-workspace restore.

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03 remains `active`**. Evidence path appended; status **not** flipped to verified; **no Accept self-claim**.

## READY_FOR_DATA_ACCEPT

**Yes.** Data agent `d2384ec6-c521-428e-9d45-469bb426002a` should re-run:

1. Unit (31) as above  
2. Integration (4) under `OPENING_TEST_DB` + `.env` `S3_*` / live MinIO  
3. `tsc -p packages/domain` + `tsc -p packages/database`  

Evidence: `docs/superpowers/evidence/2026-10-09-opening-release/q03-live-minio-object-restore.md`
