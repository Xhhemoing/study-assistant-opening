# P01 slice 2 verified — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Implemented by `xhh/gpt-5.6-luna-fast` worker run `mu47kbym-7efa48bf`; independently re-verified by read-only verifier run `mu48env0-9b3154c1`.

## Delivered

- `apps/web/src/features/opening/timetable/xlsx-reader.ts` + tests: parses course/weekday/week-range/period cells (Chinese 周次/节次 conventions incl. multi-line cells), emits `WeekSession[]` plus per-cell raw provenance (`RawCell`) and honest `TimetableParseWarning[]` for unparseable content — partial parse never silently drops a course. Merged/layout repeats emitted once; final dedup via domain `normalizeWeekSessions`.
- `apps/web/src/features/opening/timetable/timezone.ts`: `parsePeriodTimes` HH:mm validation with actionable errors; `expandToTimeBlocks` blocks absolute expansion when `weekOneMonday` missing / not a Monday / invalid, wraps domain DST rejections.
- `tests/fixtures/opening/timetable-synthetic.xlsx` (sanitized synthetic only) + README with sha256 `2bdd8bb8a9e61bb887f1c39a592088630260545a00abec399c445394f2974e60`.
- Deps (INTEGRATOR, commit `7fcab9f`): worker `bullmq@5.56.10`/`ioredis@5.6.1` (I03 prep); apps/web devDeps `read-excel-file@9.3.10`, `write-excel-file@4.1.1`, `@js-temporal/polyfill@0.5.1`.

Lead-verified tech facts before dispatch: Temporal `toZonedDateTime(tz,{disambiguation:'reject',offset:'reject'})` throws RangeError on DST gap and ambiguous times (default silently shifts — never use default); write-excel-file v4 API is `writeXlsx(rows).toFile(path)` with constructor cell types.

## Golden cases covered

Saturday class (weekday 6), split week ranges `1-8,10-16`, merged/repeated cell → one session, partial parse → warning with raw text (`English Composition`), missing weekOneMonday → actionable error, non-Monday weekOneMonday (2026-03-08) → actionable error, DST gap (2026-03-08 02:30 America/New_York) and DST ambiguous (2026-11-01) rejected without silent shift, HH:mm validation.

## Gates

```text
$ node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/timetable packages/domain/src/opening
Test Files  5 passed (5)   Tests  45 passed (45)   [xlsx-reader: 4 passed]
$ npx tsc -p apps/web/tsconfig.json --noEmit          → clean (exit 0)
$ npx eslint apps/web/src/features/opening/timetable  → clean (exit 0)
$ sha256sum tests/fixtures/opening/timetable-synthetic.xlsx → matches README
$ git status --short → only the four expected paths; no scope creep
```

Commits: `7fcab9f` (deps), `b9859a7` (slice 2). Notes: contracts `weekSessionSchema` weekday is 0..6 while domain enforces 1..7 — reader follows domain semantics; reconciliation deferred to P02 when the schema is actually consumed (recorded, non-blocking).
