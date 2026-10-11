# V2-07 implement — Teaching generation jobs + budget

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Pipeline (executor / Grok Bot) — Implement only  
**Branch:** `feat/opening-release`  
**Baseline tip (gate):** `1f9ff58` (`feat(opening): V2-06 teaching evidence pack + V2-07 plans`) — confirmed via `git log -1` before edits  
**Post-implement tip:** `11f5ab09bb84548473753086893fb1f5eca72fbd`  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:** Plan `v2-07-teaching-generation-jobs-plan.md` + Understand + migration assignment `0055` + Plan ACCEPT  
**Verdict:** Implement complete — **not** self-ACCEPT / not `tasks.json` → verified

## Diff scope

### Added
- `packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql` — extend `opening_jobs_kind_check` with `'compile-teaching-unit'`
- `apps/worker/src/jobs/compile-teaching-unit.ts` (+ `.test.ts`) — job handler (budget + fences + stub provider)
- `packages/database/src/repositories/opening-jobs-cancel.test.ts` — cancel unit tests
- this evidence file

### Modified
- `apps/worker/src/runtime/queue.ts` / `queue.test.ts` — register `"compile-teaching-unit"`
- `apps/worker/src/runtime/handlers.ts` / `run-job.test.ts` — handler key + default map
- `apps/worker/src/index.ts` — wire handler via `runJob` (not tutor special-case); stub provider
- `apps/worker/src/runtime/budgeted-call.ts` / `.test.ts` — injectable `purpose?: string` (default `"tutor"`)
- `packages/database/src/repositories/opening-jobs.ts` — `cancel(scope, id)` + teaching activity fence
- `packages/database/src/repositories/opening-teaching-activities.ts` / `.test.ts` — `setGenerateStatus` + `enqueueCompileTeachingUnit`

### Not touched (intentional)
- Unrelated untracked: `rp5-gha…`, `p0-assistant-list-preview-failsoft-implement.md`
- No tutor / `opening_tutor_jobs` expansion
- No V2-08 compiler body (stub provider only)
- No Experience UI / HTTP route
- No push / hermes / stash / reset
- No self-ACCEPT

## Behavior landed

| Item | Detail |
|---|---|
| Kind | `compile-teaching-unit` on `opening_jobs` + BullMQ `opening-compile-teaching-unit` |
| Modes | payload `mode: "generate" \| "repair"` |
| operationId | `compile-teaching-unit:{job.id}` — never attempt-suffixed |
| Budget purpose | `compile-teaching-unit` via `runBudgetedCall({ purpose })` |
| Generate write-back | `publishActivitySpec` CAS + `generate_status=needs_check` |
| Non-model repair | `skipProviderForRepair` → `ready` without provider |
| Cancel | job `queued\|running` → `cancelled`; activity `queued\|generating` → `cancelled` |
| Late cancel | discard publish; no `needs_check` |
| Released retry | ledger CONFLICT → `BUDGET_CONFLICT` non-retryable fail (no new operationId) |
| Enqueue key | `compile-teaching-unit:{activityId}:{mode}:{clientKey}` + outbox + `generate_status=queued` |
| Provider | **stub** until V2-08 (still reserves/settles ledger) |

## Commands run + results

### Unit (focused)

```text
./node_modules/.bin/vitest run \
  apps/worker/src/runtime/queue.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/runtime/run-job.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts \
  packages/database/src/repositories/opening-teaching-activities.test.ts \
  packages/database/src/repositories/opening-jobs-cancel.test.ts
```

**Result:** exit 0 — **6 files, 50 tests passed** (CST ~11:30).

Covered intents: queue kind registration; purpose default/propagate; handlers map includes kind; generate → `needs_check`; released CONFLICT; cancel discards late write-back; purpose on reserve; non-model repair → `ready`; epoch → stale + release; timeout → unknown; sources excluded → failed; enqueue+outbox+queued; setGenerateStatus fence; cancel helper.

### Typecheck

```text
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/database/tsconfig.json --noEmit
```

**Result:** both exit 0.

## not_run

| Check | Reason |
|---|---|
| Migrate apply `0055` | No live DB / `OPENING_TEST_DB` / hermes on this box (`ECONNREFUSED` risk); DDL file only |
| Integration T9–T10 (OPENING_TEST_DB enqueue→dispatch→ledger) | DB unavailable |
| E2E / browser T11 | Experience / user path; out of Implement scope |
| Real model smoke T12 | Deferred V2-08+ / auth |
| Hermes | Forbidden this slice |
| Full monorepo `npm test` / web typecheck | Focused worker+database only; not claimed green |

## Non-goals (honest)

- No push, no hermes, no stash/reset
- No self-ACCEPT / no `tasks.json` → verified
- Stub provider noted (V2-08 replaces compile body inside same handler)
- No Experience poll UI / HTTP route in this slice

## Accept focus for Integrator

1. Migration `0055` CHECK list includes all prior kinds + `compile-teaching-unit`; rollback comment correct.
2. Worker: kind in `createQueues` / `createHandlers` / `index.ts` via **`runJob`** (not tutor branch).
3. `operationId` stable; purpose `"compile-teaching-unit"`; released CONFLICT does not mint attempt-suffix.
4. Generate → `needs_check`; cancel late-result discard; epoch/owner/version fences called.
5. Re-run the focused vitest + tsc commands above; mark migrate/e2e `not_run` if still no DB.
6. Soft gaps: HTTP enqueue route absent; stub provider; live migrate not applied.

## Blockers

None for Implement ACCEPT gate. Live migrate apply needs Integrator/DB env confirmation that schema max &lt; 0055 before apply.
