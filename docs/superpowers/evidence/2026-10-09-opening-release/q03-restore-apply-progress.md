# Q03 slice — Restore apply dry-run / plan-only executor

**Date:** 2026-10-09 ~19:12 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR+QA  
**Status:** progress only — **not verified**, **no commit**, **no Docker image/compose**, **no DB/storage mutation**.

## What changed

| Path | Change |
|---|---|
| `packages/database/src/repositories/opening-backup.ts` | `applyOpeningRestore` gains `dryRun` + backup/journal options; dry-run runs `validateOpeningRestore` + `planOpeningRestoreApply`, returns structured report (`preview.allowed/errors/recordCounts`, `plan.batches/objectCount`, guarantees, `mutated: false`). Confirm-without-dry-run stays `APPLY_EXECUTOR_DEFERRED`. |
| `packages/database/src/repositories/opening-backup-entrypoint.test.ts` | Extended: dry-run missing backup; dry-run OK plan; dry-run preflight rejection; `mutated: false` on deferred path. |
| `packages/database/src/index.ts` | Exports `OpeningRestoreApplyArgs`, `OpeningRestoreApplyPlan`, `planOpeningRestoreApply`. |
| `packages/domain/src/index.ts` | Exports `OpeningRestoreLearningState` (typing for plan options). |
| `scripts/opening-restore.ts` | `--confirm-local-restore --dry-run --draft <json> [--journal <json>]` plan-only CLI; no-dry-run still deferred exit 1. |
| `docs/.../q03-packaging-gaps.md` | Restore-drill row updated for dry-run vs still-deferred apply. |

## Honest boundaries

- **No Opening-scoped transactional row/object apply** exists in-repo. Native `backup-restore.ts` / `applyRestorePlan` is a **different** package path (native notes), not wired here.
- Dry-run success (`DRY_RUN_OK`) is **structural preflight only** — not authorization to restore.
- Guarantees always: `secretsRestored/apiKeysRestored/sessionsRestored=false`, `pendingJobs=cancelled`.
- No Docker claims; Docker not used this slice.

## Commands run (results)

### Unit tests

```
node node_modules/vitest/vitest.mjs run packages/database/src/repositories/opening-backup-entrypoint.test.ts
```

**Result:** PASS — Test Files 1 passed; Tests **5/5** passed (~19:11 CST).

### Typecheck

```
npx tsc -p packages/database/tsconfig.json --noEmit
npx tsc -p packages/domain/tsconfig.json --noEmit
```

**Result:** both exit 0 (~19:12 CST).

### CLI smoke

| Command | Exit | Notes |
|---|---|---|
| `tsx scripts/opening-restore.ts` (no flag) | **2** | usage / refuse |
| `tsx scripts/opening-restore.ts --confirm-local-restore` | **1** | `APPLY_EXECUTOR_DEFERRED`, `mutated=false`, pendingJobs=cancelled |
| `tsx scripts/opening-restore.ts --confirm-local-restore --dry-run` | **1** | staging incomplete (missing `--draft`) |
| `tsx scripts/opening-restore.ts --confirm-local-restore --dry-run --draft <valid-draft.json>` | **0** | `DRY_RUN_OK`, `preview.allowed=true`, `plan.objectCount=1`, `mutated=false` |

## Still blocked for Q03 verified

1. Real Opening empty-namespace apply executor (tx + journal re-read + object restore) — **missing**.
2. Isolated restore drill against empty DB/S3.
3. Full packaging green (lint / monorepo typecheck / production image build / compose up) — **not claimed**; no Docker this slice.
4. Full live `exportOpeningBackup` + S3 path end-to-end.
5. CI release-SHA evidence (requires commit — **no commit** this slice).

## Tasks

`docs/superpowers/plans/opening-release/tasks.json` **Q03 remains `active`**. Evidence path appended surgically; status not flipped to verified.
