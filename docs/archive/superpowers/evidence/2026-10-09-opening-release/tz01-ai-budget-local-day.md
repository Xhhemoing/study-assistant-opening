# TZ01 — AI/budget local-day call-chain (AI half)

**Date:** 2026-10-10 ~01:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Role:** AIstudy AI  
**Plan:** `15-research-hardening.md` § TZ01; Data contract `resolveLocalDayBounds` / `localDateKeyInZone`  
**Prior Data slice:** `tz01-day-boundary-plan.md` + `tz01-day-boundary-accept.md` (domain helper Accepted; TZ01 stays active)  
**Verdict for Integrator:** AI slice ready for Accept review — **do not** self-mark verified

## Scope (this slice)

Consume Data’s day-boundary helper for AI budget day keys; wire ledger reserve + readiness spend to half-open local bounds and workspace planning TZ.

**Out of scope:** domain helper semantics; Q03; hermes redeploy; commit/push; marking TZ01 verified; reminder worker TZ (Data/known gap #3); property-test matrix completeness (gap #4).

## Files

**Create**

- `packages/ai/src/opening/budget-local-day.ts` — `resolveBudgetLocalDay` / `resolveBudgetTimeZone` wrapping domain bounds
- `packages/ai/src/opening/budget-local-day.test.ts`
- `docs/superpowers/evidence/2026-10-09-opening-release/tz01-ai-budget-local-day.md` (this file)

**Modify**

- `packages/ai/package.json` — add `@aistudy/domain` dependency (flag: AI→domain for day-boundary consume)
- `packages/ai/src/index.ts` — export helper
- `packages/database/src/repositories/opening-budget.ts` — reserve reads `planning_settings.timeZone`; completed spend uses `[dayStart, nextDayStart)` from `resolveBudgetLocalDay` (replaces `AT TIME ZONE` date equality)
- `apps/web/src/app/api/opening/ai-readiness/route.ts` — planning TZ + same absolute bounds for `usedCents`
- `apps/worker/src/index.ts` — comment that factory TZ is fallback only

## Contract alignment

| Field / API | Source |
|---|---|
| `resolveLocalDayBounds(localDate, timeZone)` | `@aistudy/domain` (Data; unchanged) |
| `localDateKeyInZone(instant, timeZone)` | `@aistudy/domain` |
| Default TZ | `Asia/Shanghai` (`DEFAULT_BUDGET_TIME_ZONE` ≡ planning default) |
| Per-workspace TZ | `workspace_preferences.planning_settings.timeZone` |
| Ledger day predicate | `created_at >= dayStart AND created_at < nextDayStart` |
| `budget_disabled` | unchanged — still `effectiveCapCents <= 0` via catalog-merge (not a day-key) |

## Tests

```text
npx vitest run packages/ai/src/opening/budget-local-day.test.ts   packages/ai/src/opening/effective-cap.test.ts   packages/ai/src/opening/catalog-merge.test.ts   packages/ai/src/opening/ai-readiness.test.ts   apps/worker/src/runtime/budgeted-call.test.ts
# → Test Files  5 passed (5)
# → Tests  38 passed (38)

npx tsc -p packages/ai --noEmit       # exit 0
npx tsc -p packages/database --noEmit # exit 0
npx tsc -p apps/worker --noEmit       # exit 0
npx tsc -p apps/web --noEmit          # exit 0
```

## Data handoff / blockers

1. **Data still owns** domain helper, planDay callers, timetable/day-blocks, reminder worker TZ wiring (gap #3).
2. **Flagged additive touch:** `opening-budget.ts` reserve SQL + planning_settings read — needed so ledger day matches readiness; Data should review, not fork a second day calculator.
3. **Callers of planDay** already pass `localDate`+`timeZone` (Data) — AI does not change that.
4. **Integration:** existing DL7 reconcile tests should still pass (same Shanghai local day; absolute bounds ≡ prior AT TIME ZONE for fixed offset).
5. **Accept:** Integrator only; keep `tasks.json` TZ01 `active` until Accept.

## Known gaps remaining (honest)

1. Reminder worker / quiet-hours TZ source consistency — not in this slice.
2. Nature/property tests (overnight / seasonal / overlapping free) incomplete — Data note still stands.
3. `endOfLocalDayIso` in extract-study-actions still has its own probe — optional follow-up; not a budget consumer.
