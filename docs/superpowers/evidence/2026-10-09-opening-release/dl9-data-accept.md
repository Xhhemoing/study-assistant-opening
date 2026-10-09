# DL9 accept — data half only (planning settings / deriveDayBlocks / free optional)

**Date:** 2026-10-09 ~17:01 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept of **DATA half only** against `docs/superpowers/plans/opening-release/14-loop-closure.md` § DL9.  
**Verdict:** **ACCEPT** (agent-owned data half; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**UI half:** Experience’s (may still be in progress) — **not required** for this accept.  
**tasks.json:** **not edited**. **verified:** **not marked**.  
**Commit/push:** **not done**.

## Files reviewed (data-owned)

**New**
- `packages/database/src/migrations/0047_opening_planning_settings.sql` — additive `workspace_preferences.planning_settings jsonb`
- `packages/contracts/src/opening/planning-settings.ts` (+ `planning-settings.test.ts`) — strict schema, HH:mm, overnight sleep, defaults
- `packages/database/src/repositories/opening-planning-settings.ts` — owner-gated get/set
- `apps/web/src/app/api/opening/planning-settings/route.ts` — GET/PUT
- `packages/domain/src/opening/day-blocks.ts` (+ `day-blocks.test.ts`) — `deriveDayBlocks`
- `tests/integration/handler/opening-planning-settings.test.ts`

**Changed (data-relevant)**
- `packages/database/src/schema/preferences.ts` — `planningSettings` column
- `packages/database/src/repositories/opening-backup-course-records.ts` — backup SELECT + parse `planning_settings`
- `apps/web/src/features/opening/planning/plan-service.ts` — `free` optional; omit → derive from settings+timetable; missing/invalid settings → `OpeningPlanError("VALIDATION", …学期设置…)`
- Exports: `packages/contracts/src/opening/index.ts`, `packages/database/src/index.ts`, `packages/domain/src/index.ts`

**Not required / out of scope for this accept**
- Experience UI: `timetable-import.tsx`, `semester-settings-form.tsx`, `suggest-plan-card.tsx`, settings-view entry (UI half WIP; `timetable-import.tsx` + `xlsx-reader` `parseTimetableSheets` extract appeared mid-review ~17:00 CST — not treated as Data deliverable)
- `packages/database/src/repositories/opening-plans.ts` — unchanged (propose/derive lives in `plan-service`)

## Plan criteria checklist (data-owned)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | Migration: `workspace_preferences.planning_settings` jsonb; Integrator **0047** only | **PASS** | `0047_opening_planning_settings.sql` additive; applied in test DB (`schema_migrations` id present; column exists). No other new migration from Data. |
| 2 | Contract + repo + GET/PUT `/api/opening/planning-settings` (owner, strict, HH:mm) | **PASS** | Zod strict + same-day meal/window refine; sleep may cross midnight; repo owner gate; route Cache-Control no-store |
| 3 | `deriveDayBlocks(date, settings, sessions, hardBlocks?)` → class/meal/sleep + free | **PASS** | Week-N class date, overnight sleep, missing periodTimes throws (no guess), no-class free = window − meals |
| 4 | `proposePlan` `free` optional; omit → derive; no settings → VALIDATION **HTTP 400** 「请先完成学期设置」 | **PASS** | Plan prose said “422”; **this repo maps VALIDATION → 400** via `mapDomainError` / `mapRepoError`. Handler asserts `status === 400` and message `/学期设置/`. Explicit `free` unchanged. |
| 5 | Omit free after settings → same draft blocks as explicit derived free | **PASS** | Handler test compares propose with/without `free` |
| 6 | Other owner cannot read this owner’s settings | **PASS** | Handler isolation case |
| 7 | No UI restyle by Data | **PASS** | Data paths are migration/contract/repo/API/domain/plan-service/backup; no Data CSS/restyle. Experience UI files not required. |
| 8 | Backup columns include `planning_settings` | **PASS** | Read path SELECT + schema parse in `opening-backup-course-records.ts` |

## Tests re-run (actual counts)

```text
# Unit — claimed day-blocks / timetable / contracts (= 14)
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/day-blocks.test.ts \
  packages/domain/src/opening/timetable.test.ts \
  packages/contracts/src/opening/planning-settings.test.ts
→ Test Files  3 passed (3)
→ Tests       14 passed (14)
→ Duration    ~2.32s
  (day-blocks 5 + timetable 6 + planning-settings contract 3)

# Handler — planning-settings 5 + plans 10 (= 15)
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project handler \
  tests/integration/handler/opening-planning-settings.test.ts \
  tests/integration/handler/opening-plans.test.ts
→ Test Files  2 passed (2)
→ Tests       15 passed (15)
→ Duration    ~6.04s

# tsc --noEmit
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit     → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit  → exit 0
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit           → exit 0
```

DB probe: `pg_isready` + `psql` to `aistudy_opening_test` OK before handlers.

## Not run

- **Browser** — not run.
- Experience UI half (import preview, semester form, “按建议安排” card) — out of scope; may still be in progress.
- Full plan verify command that includes `apps/web/src/features/opening/timetable/` + `planning/` UI unit trees — not claimed for Data-only accept (xlsx-reader extract is Experience WIP).

## Notes (non-blocking)

- Plan § DL9 test step wording “422” vs repo convention **VALIDATION → HTTP 400**: accept follows repo + claimed handler expectations (400). Message contains 「请先完成学期设置」.
- `OpeningPlanError("VALIDATION", …)` from omit-free path is mapped by plans route `mapDomainError` generic `code === "VALIDATION"` → `ApiError` 400 (confirmed by handler).
- Concurrent Experience edits (`xlsx-reader` `parseTimetableSheets`, `timetable-import.tsx`) observed ~17:00 CST during accept; ignored for Data verdict.

## Recommendation

**ACCEPT** DL9 **data half** only. Do **not** mark verified; do **not** edit `tasks.json`. Full DL9 verified awaits Experience UI half + browser.
