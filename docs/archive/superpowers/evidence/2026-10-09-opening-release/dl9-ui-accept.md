# DL9 UI half accept — Timetable import, semester settings, one-tap suggest plan

**Date:** 2026-10-09 ~17:05 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Experience UI half only against `docs/superpowers/plans/opening-release/14-loop-closure.md` § DL9.  
**Verdict:** **ACCEPT** (UI half). Data half already **ACCEPT** in [`dl9-data-accept.md`](./dl9-data-accept.md).  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** not edited in this UI-half file (ledger close is separate if both halves ACCEPT).  
**Commit/push:** **not done**.

## Files reviewed (UI)

**New**
- `apps/web/src/features/opening/timetable/timetable-import.tsx` (+ `timetable-import.test.ts`)
- `apps/web/src/features/opening/timetable/semester-settings-form.tsx` (+ `semester-settings-form.test.ts`)
- `apps/web/src/features/opening/planning/suggest-plan-card.tsx` (+ `suggest-plan-card.test.ts`)

**Changed**
- `apps/web/src/features/opening/timetable/xlsx-reader.ts` (+ tests) — `parseTimetableSheets` pure map; `parseTimetableFile` via `read-excel-file/browser`; Node `parseTimetable` retained
- `apps/web/src/features/settings/settings-view.tsx` — mounts `SemesterSettingsForm` + `TimetableImport`
- `apps/web/src/features/opening/planning/today-view.tsx` — mounts `SuggestPlanCard` when plan ready

**Out of scope / Data half (cited, not re-owned here)**
- Migration `0047`, contracts/repo/API `planning-settings`, `day-blocks` / `deriveDayBlocks`, `plan-service` `free` optional — see [`dl9-data-accept.md`](./dl9-data-accept.md)

## Plan criteria checklist (UI-owned)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Local xlsx via `read-excel-file/browser` → preview → confirm then `PUT /api/opening/timetable`; raw file **not** uploaded to object storage | **PASS** | `parseTimetableFile` dynamic-imports browser reader; confirm calls `PUT` JSON `{ sessions }` only; UI copy states no object storage; cancel → idle without put |
| 2 | `parseTimetableSheets(sheets)` pure extract; Node path still works | **PASS** | Shared mapper; unit covers synthetic sheets without FS |
| 3 | Semester settings UI via `GET`/`PUT /api/opening/planning-settings`; 45-min period template; defaults window/meals/sleep | **PASS** | `loadPlanningSettings` / save through same routes; `PERIOD_45MIN_TEMPLATE` + contract defaults; Monday validation |
| 4 | Suggest presets 「课表空档（默认）」omit `free` / 「今晚 19:00–22:00」 / 「只排 1 小时」 → diff → confirm accept only | **PASS** | `buildSuggestProposeBody`; `diffAgainstConfirmedPlan`; `propose` never calls `accept`; confirm uses `acceptPlan` + version CAS; mount does not auto-accept |
| 5 | Import preview cancelable; write only on confirm | **PASS** | `cancelTimetablePreview` / tests assert put not called on cancel |
| 6 | 「按建议安排」does not change confirmed plan until confirm | **PASS** | Controller + card tests; copy「确认后才改变正式计划」 |
| 7 | Did not restyle/own Data migration/API/`day-blocks`/`plan-service` free-optional | **PASS** | UI files are Experience surfaces + xlsx extract; Data artifacts remain Data-owned |

## Tests re-run (actual counts)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/ \
  apps/web/src/features/opening/timetable/ \
  apps/web/src/features/opening/planning/
→ Test Files  49 passed (49)
→ Tests       515 passed (515)
→ Duration    ~27.68s

node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
→ exit 0
```

Matches Experience claim (49 files / 515; tsc web).

## Not run

- **Browser** (Paula) — not run; do not claim browser pass.
- Handler/integration for planning-settings/plans — Data half already green in `dl9-data-accept.md` (re-check reserved for ledger close).

## Recommendation

**ACCEPT** UI half of DL9. Full ledger close may proceed when consolidating with data half accept; browser remains user-owned.
