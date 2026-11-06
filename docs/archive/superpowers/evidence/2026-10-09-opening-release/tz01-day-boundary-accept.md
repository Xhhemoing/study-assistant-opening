# TZ01 — Local day-boundary helper (accept)

**Date:** 2026-10-10 ~00:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Remote:** `study-assistant-opening`  
**Sources:** `15-research-hardening.md` TZ01; research §5.3 P1; plan `tz01-day-boundary-plan.md`  
**Verdict:** **ACCEPT** (domain day-boundary slice)  
**tasks.json:** TZ01 → **active** (evidence appended); **not verified**  
**Out of this accept:** apps/web; worker budgeted-call / BC1; DL7 SQL AT TIME ZONE rewrite; marking verified

## Claim vs review

| Claim | Result | Notes |
|---|---|---|
| `resolveLocalDayBounds(localDate, tz) → [dayStart, nextDayStart)` | **PASS** | Half-open absolute bounds; exported from `packages/domain` |
| Illegal date hard error | **PASS** | `2026-02-30` / bad tz → `RangeError` (no silent unconstrained) |
| `planDay` consumes `localDate`+`timeZone`; explicit `dayEnd` still wins | **PASS** | Priority: `dayEnd` (inclusive) > `localDate`+`timeZone` (exclusive nextDayStart) > UTC free-start fallback |
| DL11 `notBefore` / `planningNow` unchanged | **PASS** | `taskNotBeforeMs` + `planningNowMs` → `earliest = Math.max(...)` untouched; only day-end resolution extended |
| day-blocks / timetable share `zonedLocalInstant` | **PASS** | Local duplicates removed; both import shared helper |
| No apps/web / worker budgeted-call | **PASS** | `apps/web` clean; tutor-turn / BC1 dirt left unstaged |
| Gates: local-day-bounds+day-planner+day-blocks+timetable **39**; daily-draft+planning-time **19**; domain tsc 0 | **PASS** | Re-run below |

## Reject criteria (15-research-hardening TZ01 / §5.3)

- Shared day-boundary helper + `planDay` wiring: **confirmed** → do not reject.
- DL11 earliest logic regression: **none** → do not reject.
- apps/web touched: **no** → do not reject.

## Files (this slice)

**Create**

- `packages/domain/src/opening/local-day-bounds.ts`
- `packages/domain/src/opening/local-day-bounds.test.ts`
- `docs/superpowers/evidence/2026-10-09-opening-release/tz01-day-boundary-plan.md`
- `docs/superpowers/evidence/2026-10-09-opening-release/tz01-day-boundary-accept.md` (this file)

**Modify**

- `packages/domain/src/opening/day-planner.ts` — optional `localDate`+`timeZone`; exclusive nextDayStart when used
- `packages/domain/src/opening/day-blocks.ts` — `zonedLocalInstant` + `assertValidLocalDate`
- `packages/domain/src/opening/timetable.ts` — `zonedLocalInstant`
- `packages/domain/src/index.ts` — export helper + types
- `docs/superpowers/plans/opening-release/tasks.json` — TZ01 surgical only (`active` + evidence)

## Plan / research checklist (domain slice)

| # | Criterion | Result |
|---|---|---|
| 1 | Shanghai 00:30 & 07:59 same local day (UTC midnight must not split) | **PASS** |
| 2 | nextDayStart exclusive (half-open) | **PASS** |
| 3 | Negative-offset zone (America/New_York) | **PASS** |
| 4 | Illegal date / bad tz → hard RangeError | **PASS** |
| 5 | planDay localDate+timeZone; dayEnd override | **PASS** |
| 6 | Shared zoned helper in timetable/day-blocks | **PASS** |
| 7 | DL11 notBefore/planningNow still green | **PASS** (day-planner suite) |
| 8 | Budget SQL / reminder worker TZ / apps/web | **Deferred** (out of slice; not verified) |

## Tests re-run (actual)

```text
npx vitest run packages/domain/src/opening/local-day-bounds.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  packages/domain/src/opening/day-blocks.test.ts \
  packages/domain/src/opening/timetable.test.ts
# → Test Files  4 passed (4)
# → Tests  39 passed (39)

npx vitest run packages/domain/src/opening/daily-draft.test.ts \
  packages/domain/src/opening/planning-time.test.ts
# → Test Files  2 passed (2)
# → Tests  19 passed (19)

npx tsc -p packages/domain --noEmit
# → exit 0
```

## Known gaps (keep TZ01 active, not verified)

1. Callers must pass `localDate`+`timeZone` for local day-end; bare UTC free-start fallback remains when both omitted (documented §5.3 risk).
2. Budget caps / DL7 SQL local-day accounting not rewired to this helper in this slice.
3. Reminder worker / API contract carrying workspace TZ not in this commit.
4. Nature-test matrix in research (overnight / seasonal / overlapping free) only partially covered by existing day-blocks/timetable suites — not claimed complete here.
