# P04a accept — data half only (daily auto draft)

**Date:** 2026-10-09 ~17:14 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **DATA half only** against `docs/superpowers/plans/opening-release/14-loop-closure.md` § P04a.  
**Verdict:** **ACCEPT** (agent-owned data half; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**UI half:** Experience’s (WIP) — **not required** for this accept (`daily-draft-card.tsx` / today-dashboard wiring absent and out of scope).  
**tasks.json:** **not edited**. **verified:** **not marked**.  
**Commit/push:** **not done**.

## Files reviewed (data-owned)

**New**
- `packages/domain/src/opening/daily-draft.ts` (+ `daily-draft.test.ts`) — `buildDailyDraftInput`, `dailyDraftClientKey` (`auto-draft:<date>`), carry-over label `顺延自昨天`
- `tests/integration/handler/opening-daily-draft.test.ts` — 5 handler cases

**Changed**
- `packages/domain/src/opening/day-planner.ts` — optional `preferredOrder`
- `packages/domain/src/index.ts` — exports
- `packages/database/src/repositories/opening-plans.ts` — `dailyDraftAdvisoryLockKeys`, `findDraftByProposeClientKey`, `ensureAutoDraft` (`pg_advisory_xact_lock` + client key), `formatPlanDay` in `mapDraft`
- `apps/web/src/features/opening/planning/plan-service.ts` — `ensureDailyDraft`, lazy call from `getToday`; Today fields `dailyDraft`, `dailyDraftSkippedReason`, `unplannedPendingCount`

**Not required / out of scope**
- Experience UI: `daily-draft-card.tsx`, `today-dashboard.tsx` changes (plan lists them; UI half WIP)
- No migration (plan § P04a 需迁移: 否)

## Plan criteria checklist (data-owned)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Lazy generate on first today read (`getToday` → `ensureDailyDraft`) | **PASS** | Wired in `plan-service.getToday` |
| 2 | Idempotency key `propose_client_key = auto-draft:<本地日期>` | **PASS** | `dailyDraftClientKey`; handler asserts single row |
| 3 | Tx advisory lock `pg_advisory_xact_lock` (workspace+date) before lookup/insert | **PASS** | `dailyDraftAdvisoryLockKeys` sha256 → two int4; concurrent handler test |
| 4 | Same-day second open returns same draft (no second insert) | **PASS** | Handler |
| 5 | Accepted plan that day → no auto-draft; `dailyDraftSkippedReason=accepted` + `unplannedPendingCount` | **PASS** | Handler |
| 6 | Reject via existing reject endpoint → no recreate same day; `skippedReason=rejected` | **PASS** | Handler uses `POST .../reject` |
| 7 | No planning settings → HTTP 200 skip, `no_settings` (not 500) | **PASS** | Handler |
| 8 | Carry-over first; block reason label `顺延自昨天` | **PASS** | Domain unit + `applyDraftReasons` on carry_over_yesterday |
| 9 | Not-yet-due retests omitted; overflow prefer_tomorrow / shorten_duration; no sleep/meal packing | **PASS** | Domain units |
| 10 | Accept/reject via existing plan endpoints (no new accept API) | **PASS** | Handler; no new routes for accept/reject |
| 11 | Today response shape: `dailyDraft`, `dailyDraftSkippedReason` (`accepted`\|`rejected`\|`no_settings`), `unplannedPendingCount` when accepted | **PASS** | Types + handlers |
| 12 | No new scheduler / no unique index migration | **PASS** | Lazy only; advisory lock + client key |
| 13 | No Data UI restyle; UI card not required | **PASS** | `daily-draft-card.tsx` absent — expected for data-only |

## Tests re-run (actual counts)

```text
# Unit — daily-draft + day-planner (= 23)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/daily-draft.test.ts \
  packages/domain/src/opening/day-planner.test.ts
→ Test Files  2 passed (2)
→ Tests       23 passed (23)
→ Duration    ~2.19s
  (daily-draft 5 + day-planner 18 incl. it.each duration rejects)

# Handler — daily-draft 5 + plans 10 (= 15)
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project handler \
  tests/integration/handler/opening-daily-draft.test.ts \
  tests/integration/handler/opening-plans.test.ts
→ Test Files  2 passed (2)
→ Tests       15 passed (15)
→ Duration    ~7.51s

# tsc --noEmit
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit     → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit  → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit           → exit 0
```

DB probe: `pg_isready` + `psql` to `aistudy_opening_test` OK before handlers.

## Not run

- **Browser** — not run.
- Experience UI half (daily-draft card / today-dashboard presentation) — out of scope; may still be WIP.
- Dedicated unit for `preferredOrder` alone — not present; ordering covered by `buildDailyDraftInput` + planner preferredOrder path used in `ensureDailyDraft` (non-blocking for data accept).

## Notes (non-blocking)

- Implementer note also at `p04a-daily-draft-data.md`; this file is the agent **accept** record.
- `preferredOrder` has no isolated day-planner unit case; behavior is exercised via daily-draft ordering + auto-draft propose path.
- Concurrent Experience/other WIP files on the branch ignored for this Data verdict.

## Recommendation

**ACCEPT** P04a **data half** only. Do **not** mark verified; do **not** edit `tasks.json`. Full P04a verified awaits Experience UI half + browser.
