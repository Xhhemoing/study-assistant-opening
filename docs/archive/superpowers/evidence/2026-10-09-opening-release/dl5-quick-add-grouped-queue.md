# DL5 Today queue quick-add and grouped queue — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL5

**Data half**
- Migration `0046_opening_task_client_key.sql`: nullable `opening_tasks.client_key` (8–200) + partial unique index `(workspace_id, owner_user_id, client_key) WHERE client_key IS NOT NULL`.
- Schema `openingTasks.clientKey` + matching uniqueIndex.
- `insertOpeningTask`: when `candidateId === null`, stores `clientKey` on the task row and replays via `findQuickAddReplay` (payload conflict → CONFLICT). Does **not** fake candidates through `opening_jobs`. Retest/assistant acceptance paths unchanged.
- Pure `groupTodayQueue`: confirmed / dueRetests / overdue / other / upcomingRetestCount / done; future retests counted only; confirmed wins over overdue/due retest.

**UI half**
- `quick-add-task.tsx`: title ≤240, minutes 15/25/45 (default 25), optional due date/time (date-only → local 23:59 / 「当日内」; empty → no deadline). One intent → one `clientKey`; unknown outcome shows 「可能已添加，正在核对」 and re-reads; no auto-retry. New tasks do not rewrite accepted plan.
- `today-view.tsx` / `today-dashboard.tsx`: queue grouped with Chinese labels; upcoming retest hint; QuickAdd mounted when ready. Complete/skip remain in TaskContext (DL2).

## Verification (agent-owned, Integrator re-run 2026-10-09)

- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/` — 13 files, **111** passed.
- `OPENING_TEST_DB=1` `OPENING_TEST_DATABASE_URL=postgres://…@127.0.0.1:5432/aistudy_opening_test` `vitest --project handler tests/integration/handler/opening-plans.test.ts` — **10** passed (includes DL5 quick-add idempotency suite).
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` — exit 0.
- `node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit` — exit 0.

## Not run

- Browser walk: 添加 → 刷新 → 仍在且只有一条. Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL2. Full due-retest projection still depends on DL3 fields.

## Ledger

- `tasks.json` DL5 → `verified` with this evidence path. No commit.
