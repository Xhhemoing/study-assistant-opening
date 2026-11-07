# P04a Daily auto draft from existing tasks, due retests, timetable and carry-over — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § P04a

**Data half** (detail in [`p04a-data-accept.md`](./p04a-data-accept.md); implementer note [`p04a-daily-draft-data.md`](./p04a-daily-draft-data.md))
- Domain `buildDailyDraftInput` / `dailyDraftClientKey` (`auto-draft:<date>`); carry-over label `顺延自昨天`; day-planner optional `preferredOrder`.
- Repo `ensureAutoDraft` with `pg_advisory_xact_lock` + propose client key; no unique-index migration; no new scheduler.
- `plan-service.ensureDailyDraft` lazy from `getToday`; Today fields `dailyDraft`, `dailyDraftSkippedReason`, `unplannedPendingCount`; accept/reject via existing plan endpoints.

**UI half** (detail in [`p04a-ui-accept.md`](./p04a-ui-accept.md))
- `DailyDraftCard` on today view: confirm → accept CAS; reject → reject; adjust → propose only then separate confirm; fail keeps draft; skipped copy for accepted / rejected / no_settings; shows「顺延自昨天」; never auto-accepts.
- Client Today schema extended for draft skip fields; Data core not restyled by UI.

## Verification (agent-owned, Integrator re-run 2026-10-09 ~17:19 CST)

**UI half (this close):**
- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/` → **16** files, **128** passed (~12.17s).
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` → exit 0.

**Data half (cheap re-run at ledger close):**
- `vitest --project unit` `daily-draft.test.ts` + `day-planner.test.ts` → **23** passed (~1.53s).
- `OPENING_TEST_DB=1` `OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test` `vitest --project handler` `opening-daily-draft.test.ts` + `opening-plans.test.ts` → **15** passed (~5.13s).

**Cited from prior data accept** ([`p04a-data-accept.md`](./p04a-data-accept.md)): same unit **23** + handler **15**; tsc domain/database/web exit 0.

## Not run

- **Browser** walk for Paula (open today → see auto draft → confirm / adjust / reject; accepted skip copy; no_settings tip). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5–DL9. Do **not** claim browser pass.

## Ledger

- `tasks.json` P04a → `verified` with this evidence path. No commit. **DL9 remains verified**; other tasks untouched.
