# TZ01 — Data remaining gaps closeout (accept)

**Date:** 2026-10-10 ~01:11 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Sources:** `15-research-hardening.md` §TZ01; Known gaps in prior accepts; Data claim `tz01-data-gaps-closeout.md`  
**Verdict:** **ACCEPT** (Data reminder TZ + caller/shared-bounds closeout)  
**tasks.json:** TZ01 → **active** (evidence appended); **not verified** in this pass  
**Out of this accept:** commit/push; self-mark verified; Q03; hermes redeploy; full nature-test matrix claim

## Claim vs review

| # | Gap | Result | Notes |
|---|---|---|---|
| 1 | Budget SQL → `resolveLocalDayBounds` | **PASS (prior AI ACCEPT)** | Tip `b2a2004`; Data did not fork `opening-budget` / AI path. Confirmed WD clean of budget rewrites. |
| 2 | Reminder worker / API IANA TZ | **PASS** | Enqueue stamps `payload.timeZone` via `readPlanningTimeZone`; worker `resolveRemindTimeZone`: payload → `resolveTimeZone(job)` → legacy `deps.timeZone()` → `DEFAULT_WORKSPACE_TIME_ZONE`. `apps/worker/src/index.ts` wires planning settings. |
| 3 | Callers `localDate`+`timeZone` | **PASS** | Production `planDay` sites use `buildServerPlanDayOptions`. `endOfLocalDayIso` now `resolveLocalDayBounds` → `nextDayStart - 1ms` (shared bounds). |
| 4 | Nature / property tests | **PARTIAL (accepted as such)** | Light overnight + US DST ±1h + adjacent-day exclusivity + `resolveWorkspaceTimeZone`. **Not** full research matrix (overlapping free capacity / seasonal timetable expand). Plan allows not claiming complete matrix. |

## Diff scope (leave unrelated dirt)

**Modify (Data slice, uncommitted at accept time)**

- `apps/worker/src/jobs/remind.ts` — payload TZ + `resolveTimeZone` dep + shared default
- `apps/worker/src/jobs/remind.test.ts` — payload-over-resolve + resolve-when-omitted
- `apps/worker/src/index.ts` — planning-settings `resolveTimeZone` wire (+ budget comment only)
- `packages/database/src/repositories/opening-reminders.ts` — stamp planning TZ at enqueue
- `packages/database/src/repositories/opening-reminders.test.ts` — mock `planning_settings`
- `packages/domain/src/opening/extract-study-actions.ts` — `endOfLocalDayIso` → shared bounds

**Evidence**

- `docs/superpowers/evidence/2026-10-10-opening-release/tz01-data-gaps-closeout.md` (claim)
- `docs/superpowers/evidence/2026-10-10-opening-release/tz01-data-gaps-closeout-accept.md` (this file)
- `docs/superpowers/plans/opening-release/tasks.json` — TZ01 evidence append only; status stays `active`

**Not touched / left alone**

- `apps/web` / hermes (no WD churn beyond already-landed AI `ai-readiness` at `b2a2004`)
- `packages/ai` / `opening-budget.ts` (AI-owned)
- Untracked `docs/.../rp5-gha-91b1c73-typecheck-fail.md` (unrelated dirt)

## Reject criteria check

- Reminder TZ chain missing or forked day math: **no** → do not reject.
- Budget Data fork fighting AI ACCEPT: **no** → do not reject.
- apps/web hermes churn in this slice: **no** → do not reject.
- Gates fail: **no** → do not reject.

## Gates re-run (actual)

```text
npx vitest run \
  packages/domain/src/opening/local-day-bounds.test.ts \
  packages/domain/src/opening/extract-study-actions.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  apps/worker/src/jobs/remind.test.ts \
  apps/web/src/features/opening/planning/plan-service.test.ts \
  packages/database/src/repositories/opening-reminders.test.ts
# → Test Files  6 passed (6)
# → Tests  95 passed (95)

npx tsc -p packages/domain --noEmit   # exit 0
npx tsc -p packages/database --noEmit # exit 0
npx tsc -p apps/worker --noEmit       # exit 0
```

## Known gaps (keep active; Integrator decides verified after push)

1. Full nature matrix (overlapping free blocks / seasonal timetable expand / overnight free capacity) — **not claimed complete**; light overnight/DST/adjacent covered.
2. Older remind jobs without `payload.timeZone` rely on live `resolveTimeZone` — intentional back-compat.
3. Mild: `opening-reminders.test.ts` mocks planning_settings for SQL path but does not assert stamped `payload.timeZone` value (worker unit tests cover priority).
4. Mild duplication: AI `resolveBudgetTimeZone` parallels Data `resolveWorkspaceTimeZone` string normalize (day-bounds not forked).

## Verified recommendation (Integrator)

**Recommend YES — mark TZ01 `verified` after this Data slice + accept evidence are committed/pushed**, provided tip includes the six Data files and this accept note.

**Rationale vs §TZ01 Acceptance:** timetable / budget caps / day-plan share one `[dayStart, nextDayStart)` interpretation; Shanghai day-boundary automation locked; reminder worker TZ source now consistent with planning settings. Nature-test matrix remains **partial by design** — research listed overlapping free capacity as suggested AC, not a hard blocker once shared helper + Shanghai locks + budget/reminder/plan callers are wired.

**Do not** mark verified from this Accept pass alone (no commit/push here).
