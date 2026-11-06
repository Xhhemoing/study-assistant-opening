# TZ01 — AI/budget local-day slice (accept)

**Date:** 2026-10-10 ~01:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Sources:** `15-research-hardening.md` §TZ01; Known gaps in `tz01-day-boundary-accept.md` item 2 (budget/DL7 SQL); AI claim `tz01-ai-budget-local-day.md`  
**Verdict:** **ACCEPT** (AI budget local-day wiring only)  
**tasks.json:** TZ01 → **active** (evidence appended); **not verified**  
**Out of this accept:** marking TZ01 verified; reminder worker/API TZ; commit/push; product-owner implementation; Data domain helper semantics

## Critical review — opening-budget SQL day predicate

| Check | Result | Notes |
|---|---|---|
| Half-open absolute bounds | **PASS** | `created_at >= dayStart AND created_at < nextDayStart` |
| Bounds from `resolveLocalDayBounds` | **PASS** | via `resolveBudgetLocalDay` → domain `localDateKeyInZone` + `resolveLocalDayBounds` |
| No fragile `AT TIME ZONE` date-equality | **PASS** | Removed from reserve + ai-readiness `usedCents` |
| planning_settings.timeZone | **PASS** | reserve reads `planning_settings`; readiness via `createOpeningPlanningSettingsRepository` |
| Default Asia/Shanghai | **PASS** | `DEFAULT_BUDGET_TIME_ZONE` / `resolveBudgetTimeZone` |

**SQL-predicate verdict:** **ACCEPT** — ledger day predicate is half-open absolute instants consistent with Data `resolveLocalDayBounds`, not `AT TIME ZONE` date-equality.

## Claim vs review

| Claim | Result | Notes |
|---|---|---|
| Consumes Data `resolveLocalDayBounds`, no fork | **PASS** | `budget-local-day.ts` imports domain helpers; does not reimplement day math |
| `packages/ai/.../budget-local-day.ts` (default Asia/Shanghai) | **PASS** | present + exported |
| opening-budget reserve: planning TZ + half-open bounds | **PASS** | see SQL verdict |
| ai-readiness same TZ/bounds for `usedCents` | **PASS** | same helper + predicate shape |
| 38 unit tests + ai/db/worker/web tsc green | **PASS** | re-run below (worker had concurrent Data remind dirt mid-pass; final worker tsc 0) |

## Files (AI slice only — do not mix unrelated dirt)

**Create**

- `packages/ai/src/opening/budget-local-day.ts`
- `packages/ai/src/opening/budget-local-day.test.ts`
- `docs/superpowers/evidence/2026-10-09-opening-release/tz01-ai-budget-local-day.md`
- `docs/superpowers/evidence/2026-10-10-opening-release/tz01-ai-budget-local-day-accept.md` (this file)

**Modify**

- `packages/ai/package.json` — `@aistudy/domain` dependency
- `packages/ai/src/index.ts` — exports
- `packages/database/src/repositories/opening-budget.ts` — planning TZ + half-open SQL
- `apps/web/src/app/api/opening/ai-readiness/route.ts` — planning TZ + half-open `usedCents`
- `apps/worker/src/index.ts` — comment only (factory TZ = fallback)
- `docs/superpowers/plans/opening-release/tasks.json` — TZ01 surgical evidence append; status stays `active`

**Unrelated dirt left untouched (not part of this accept)**

- `packages/domain/src/opening/local-day-bounds.ts` / `index.ts` — `DEFAULT_WORKSPACE_TIME_ZONE` / `resolveWorkspaceTimeZone` (Data)
- `packages/domain/src/opening/extract-study-actions.ts` — `endOfLocalDayIso` rewrite (Data / concurrent)
- `apps/worker/src/jobs/remind.ts`, `packages/database/src/repositories/opening-reminders.ts` — reminder TZ (Data; residual gap)

## Gates re-run (actual)

```text
npx vitest run packages/ai/src/opening/budget-local-day.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts
# → Test Files  5 passed (5)
# → Tests  38 passed (38)

npx tsc -p packages/ai --noEmit       # exit 0
npx tsc -p packages/database --noEmit # exit 0
npx tsc -p apps/worker --noEmit       # exit 0 (final; concurrent remind write caused a transient parse fail earlier)
npx tsc -p apps/web --noEmit          # exit 0
```

## Known gaps (keep TZ01 active, not verified)

1. Callers must pass `localDate`+`timeZone` for local day-end; bare UTC free-start fallback remains when both omitted (prior domain accept).
2. **Budget/DL7 SQL** — **addressed by this AI slice** (reserve + readiness). Prior gap item 2 closed for budget wiring.
3. Reminder worker / API workspace TZ — **still open / Data in progress** (concurrent dirt on `remind.ts` / `opening-reminders.ts` not accepted here).
4. Nature/property-test matrix (overnight / seasonal / overlapping free) incomplete — unchanged.
5. Mild duplication: AI `resolveBudgetTimeZone` parallels Data `resolveWorkspaceTimeZone` string normalize; day-bounds themselves are not forked.

## Residual

- Data reminder/API TZ still open (gap #3).
- TZ01 remains **active**, not verified, until reminder/API (and any remaining shared callers) close.
