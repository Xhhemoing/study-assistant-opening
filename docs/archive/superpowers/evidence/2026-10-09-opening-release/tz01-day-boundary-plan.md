# TZ01 — Local day-boundary helper (plan)

**Date:** 2026-10-10 ~00:10 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Sources:** `15-research-hardening.md` TZ01; research §5.3 P1

## Outcome

One domain helper `resolveLocalDayBounds(localDate, timeZone) → { dayStart, nextDayStart }` (half-open `[dayStart, nextDayStart)` absolute instants). Asia/Shanghai 00:30 and 07:59 lock to the same local day; illegal dates hard-error; planDay can take `localDate`+`timeZone` instead of naked UTC dayEnd fallback. Shared `zonedLocalInstant` used by timetable/day-blocks.

## Out of scope

- `apps/web`, worker budgeted-call (BC1 / AI)
- Database SQL budget AT TIME ZONE rewrite (helper exported for later; DL7 SQL stays)
- Marking TZ01 verified; commit/push; tasks.json status
- Multi-timezone product UX; changing device TZ
- Regressing DL11 `notBefore` / `planningNow`

## Files

- **Create:** `packages/domain/src/opening/local-day-bounds.ts` + `.test.ts`
- **Modify:** `day-planner.ts` (optional localDate+timeZone; dayEnd still wins), `day-blocks.ts` / `timetable.ts` (import shared zoned instant), `index.ts` exports
- **Evidence:** this plan; Accept left for Integrator

## Approach

1. Validate YYYY-MM-DD as a real calendar date + IANA tz; throw `RangeError` (no NaN/Infinity silent unconstrained).
2. `dayStart = zoned(localDate 00:00)`, `nextDayStart = zoned(nextCalendarDay 00:00)`.
3. `planDay`: priority `dayEnd` > `localDate`+`timeZone` (exclusive nextDayStart) > UTC free-start fallback (documented). Do not touch placement/`planningNow`.
4. Deduplicate `zonedInstant` into helper; timetable + day-blocks import it.

## Rejected alternatives

- Inclusive 23:59:59.999 end only — §5.3 asks half-open `[dayStart, nextDayStart)`.
- Pulling budget SQL / web into this slice — domain export is enough for TZ01.
- Rewriting `endOfLocalDayIso` probe list in extract-study-actions this pass — optional follow-up; not a day-bounds consumer yet.

## Test commands

```text
npx vitest run packages/domain/src/opening/local-day-bounds.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  packages/domain/src/opening/day-blocks.test.ts \
  packages/domain/src/opening/timetable.test.ts
npx tsc -p packages/domain --noEmit
```

## Acceptance checks

- [ ] Shanghai 00:30 & 07:59 same local day (not split by UTC midnight)
- [ ] next-day boundary: instant at nextDayStart is outside the day
- [ ] illegal date / bad tz → hard RangeError
- [ ] planDay with localDate+timeZone uses helper (dayEnd override preserved)
- [ ] timetable/day-blocks share zoned helper; DL11 notBefore/planningNow tests still green
