# Q03 continue — empty-namespace preflight + readiness audit

**Date:** 2026-10-09 ~19:36 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** progress only — **not verified**, **no commit**, **no push**, **no Docker image/compose** (docker CLI absent).

## What changed

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-backup-empty-namespace.ts` | New: `evaluateOpeningRestoreEmptyNamespace`, `readOpeningRestoreNamespaceCounts` (read-only UNION counts), `OPENING_RESTORE_NEVER_TABLES` / `isOpeningRestoreNeverTable`. |
| `packages/database/src/repositories/opening-backup.ts` | Confirm+backup path runs validate+plan+empty-namespace; `TARGET_NOT_EMPTY` or `APPLY_EXECUTOR_DEFERRED` with `emptyNamespaceVerified` — **still `mutated: false`**. |
| `packages/database/src/repositories/opening-backup-empty-namespace.test.ts` | Unit coverage for policy + never-tables. |
| `packages/database/src/repositories/opening-backup-entrypoint.test.ts` | +2 cases: occupied → `TARGET_NOT_EMPTY`; empty → deferred with `emptyNamespaceVerified`. |
| `tests/integration/opening-backup-empty-namespace.test.ts` | Read-only counts against `OPENING_TEST_DATABASE_URL` (fresh UUID empty; occupied workspace when courses exist). |
| `scripts/opening-readiness.mjs` | Plan-list mapping comment; `registrationLocked` detail mentions registration 403. |
| `tests/tooling/opening-readiness.test.mjs` | +REQUIRED_CHECKS alignment, ownerSetup, backupFreshness, 403 detail tests. |
| `apps/web/.../health-summary.ts` | Comment: public health is coarse subset; full readiness + alert honesty is CLI. |
| `docs/operations/opening-release.md` | Plan→check table; precise apply blocker (no insert executor; shared test DB populated; no docker). |
| `scripts/opening-restore.ts` | Header/usage note for empty-namespace library gate. |

## Commands / results (CST)

| Gate | Result | Time |
|---|---|---|
| `npx tsc -p packages/database --noEmit` | **PASS** | 19:36:25 |
| entrypoint + empty-namespace + health unit | **PASS** 14/14 | 19:36:26 |
| `node --test` readiness tooling | **PASS** 18/18 | ~19:36 |
| privacy + empty-namespace integration (`OPENING_TEST_DB=1`) | **PASS** 6/6 | 19:36:27 |
| scoped eslint (backup/readiness/health paths) | **PASS** | ~19:36 |
| Earlier cheap gates this turn | tsc PASS; entrypoint was 5/5 before extend; privacy 4/4; scoped eslint PASS (19:34) |

## Mutating apply decision (item 3)

**Not implemented as a mutating path.** Exact blocker:

1. No Opening-scoped transactional **insert** executor for `APPLY_ORDER` tables + object bytes (native `backup-restore` / `applyRestorePlan` is a different schema/package path).
2. Shared `aistudy_opening_test` is **populated** (courses and other durable rows) — not an empty-DB restore drill target; docker CLI absent so no compose-fresh empty namespace.
3. Safe progress delivered instead: empty-namespace **policy + read-only counts** wired into confirm preflight; guarantees remain `secrets/apiKeys/sessions=false`, `pendingJobs=cancelled`, `mutated=false`.

## Still blocked for Q03 verified

1. Opening row/object apply executor + isolated empty DB/S3 drill  
2. Production image build / compose up (scaffold only; no docker CLI)  
3. Full live `exportOpeningBackup` + S3 E2E  
4. Full monorepo lint/typecheck/build packaging green  
5. CI release-SHA evidence (**no commit**)

## Tasks

`tasks.json` Q03 remains **`active`**. Evidence paths appended; status not flipped to verified.
