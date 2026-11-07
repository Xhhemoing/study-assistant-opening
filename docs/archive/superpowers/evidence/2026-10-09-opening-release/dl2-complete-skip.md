# DL2 Complete or skip a task from the Today queue — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `13-daily-loop-gaps.md` § DL2

- Actions live in `TaskContext` via `TaskStatusControl` (not queue rows).
- Real write path: `api.updateTaskStatus` → `PATCH /api/opening/tasks/[id]` with body `{ status, expectedVersion, at }` (`task-status-action.ts` → existing client). No mock completion path.
- One displayed version → one in-flight write; success / 4xx (except 408) / network / 5xx all settle; no automatic retry. Complete and skip share one session so a second action cannot send another PATCH.
- 409 notice: `任务已更新，请重新读取`. Missing `version` disables actions. done/skipped show status only (no rollback).
- Skip requires a second confirm (`确认跳过`). Success triggers queue re-read via `TaskQueueRefreshContext` → `listTasks`/`getToday` (no client-side optimistic plan rewrite).
- Retest hint: `retestOrigin={isRetestOriginTask(task)}` wired in `task-context.tsx`; no invented retest request.

## Verification (agent-owned)

- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/ apps/web/src/features/opening/assistant/` — 21 files, **179** tests passed (2026-10-09, Integrator re-run).
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` — exit 0 (no bash; equivalent to `npm run typecheck -w @aistudy/web` per plan global constraints).

## Not run

- `tests/integration/handler/opening-plans.test.ts` — no `OPENING_TEST_DB=1` / isolated `aistudy_opening_test` Postgres on this box; did not start or stop services.
- Browser / e2e walk (选任务→完成→刷新后仍在「已完成」) — plan and `AGENTS.md` assign browser acceptance to the user. Left as user follow-up; not treated as a blocker for agent-owned accept (same pattern as DL1 evidence).

## Ledger

- `docs/superpowers/plans/opening-release/tasks.json` DL2 → `verified` with this evidence path. No commit. DL5 dirty tree left untouched.
