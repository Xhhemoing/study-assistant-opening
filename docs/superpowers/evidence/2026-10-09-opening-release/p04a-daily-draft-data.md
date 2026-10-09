# P04a DATA half — daily auto draft

**Date:** 2026-10-09 ~17:12 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Scope:** DATA half only (`14-loop-closure.md` §P04a). No Experience UI, no `tasks.json`, no commit/push, no migration.

## Files

**Created**
- `packages/domain/src/opening/daily-draft.ts` (+ `daily-draft.test.ts`) — `buildDailyDraftInput`, `dailyDraftClientKey`
- `tests/integration/handler/opening-daily-draft.test.ts`

**Modified**
- `packages/domain/src/opening/day-planner.ts` — optional `preferredOrder`
- `packages/domain/src/index.ts` — exports
- `packages/database/src/repositories/opening-plans.ts` — `dailyDraftAdvisoryLockKeys`, `findDraftByProposeClientKey`, `ensureAutoDraft`, `formatPlanDay` in `mapDraft`
- `apps/web/src/features/opening/planning/plan-service.ts` — `ensureDailyDraft`, lazy in `getToday`

**Not touched:** `daily-draft-card.tsx`, `today-dashboard.tsx`, `tasks.json`, migrations.

## Today response shape (for Experience)

`GET /api/opening/today?date=YYYY-MM-DD` →

```ts
{
  date: string;                     // YYYY-MM-DD
  acceptedVersion: number;
  blocks: PlannedBlock[];           // accepted plan blocks
  hardBlocks: TimeBlock[];
  dailyDraft?: PlanDraft | null;    // auto draft or null
  dailyDraftSkippedReason?: 'accepted' | 'rejected' | 'no_settings' | null;
  unplannedPendingCount?: number;   // when skipped because accepted
}
```

`PlanDraft`: `{ id, date, version, baseVersion, status, blocks, unscheduledTaskIds }`  
Carry-over blocks use reason label `顺延自昨天`. Accept/reject = existing plan APIs.

## Lock + clientKey

- `propose_client_key = 'auto-draft:' + date`
- Transaction: `pg_advisory_xact_lock` on sha256(`opening-daily-draft:${workspaceId}:${date}`) → two int4 keys
- Existing draft → return; rejected → no recreate same day; accepted plan → no draft + `unplannedPendingCount`; no settings → skip (no 500)

## Commands

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/daily-draft.test.ts \
  packages/domain/src/opening/day-planner.test.ts
→ 2 files, 23 tests passed

OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project handler \
  tests/integration/handler/opening-daily-draft.test.ts \
  tests/integration/handler/opening-plans.test.ts
→ 2 files, 15 tests passed (daily-draft 5 + plans 10)

node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit     → 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit  → 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit           → 0
```

## Blockers

None for DATA half. Experience UI card (`daily-draft-card.tsx`) not in this slice.
