# DL9 Timetable import, default free time and one-tap plan — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL9

**Data half** (detail in [`dl9-data-accept.md`](./dl9-data-accept.md))
- Migration Integrator **0047** `workspace_preferences.planning_settings` jsonb; contract + repo + `GET`/`PUT /api/opening/planning-settings` (owner, strict HH:mm).
- `deriveDayBlocks` in `packages/domain/src/opening/day-blocks.ts` (+ tests).
- `proposePlan` `free` optional: omit → derive from settings+timetable; missing settings → `VALIDATION` → HTTP **400** 「请先完成学期设置」 (repo convention vs plan’s 422 wording).
- Backup SELECT/parse includes `planning_settings`. Handler isolation: other owner cannot read settings; omit/explicit free draft blocks match.

**UI half** (detail in [`dl9-ui-accept.md`](./dl9-ui-accept.md))
- Local xlsx: `parseTimetableSheets` + browser `parseTimetableFile` (`read-excel-file/browser`) → preview → confirm → `PUT /api/opening/timetable` JSON only; raw workbook not uploaded to object storage; cancel discards preview.
- Semester settings form on settings page via planning-settings GET/PUT; 45-minute period template + contract defaults.
- `SuggestPlanCard` on today view: presets 「课表空档（默认）」(omit `free`) / 「今晚 19:00–22:00」 / 「只排 1 小时」 → diff vs confirmed → confirm accept only (propose never accepts).

## Verification (agent-owned, Integrator re-run 2026-10-09 ~17:05 CST)

**UI half (this close):**
- `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/ apps/web/src/features/opening/timetable/ apps/web/src/features/opening/planning/` → **49** files, **515** passed (~27.68s).
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` → exit 0.

**Data half (cheap re-run at ledger close):**
- `vitest --project unit packages/domain/src/opening/day-blocks.test.ts` → **5** passed.
- `OPENING_TEST_DB=1` `OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test` `vitest --project handler` `opening-planning-settings.test.ts` + `opening-plans.test.ts` → **15** passed (~5.86s).

**Cited from prior data accept** ([`dl9-data-accept.md`](./dl9-data-accept.md)): day-blocks + timetable domain + planning-settings contract **14** unit; same handler pair **15**; tsc domain/database/contracts/web exit 0.

## Not run

- **Browser** walk for Paula (import xlsx → semester settings → 按建议安排 → confirm). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5/DL6/DL7/DL8. Do **not** claim browser pass.

## Ledger

- `tasks.json` DL9 → `verified` with this evidence path. No commit. **DL8 remains verified**; P04a untouched (planned).
