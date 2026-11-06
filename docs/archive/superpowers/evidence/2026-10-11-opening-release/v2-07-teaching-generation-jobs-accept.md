# V2-07 accept — Teaching generation jobs Implement

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator (executor / Grok Bot) — Implement ACCEPT only  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `4f0b9ec42729b0361d2e0958ff8da2f65428f593` (`docs(opening): V2-07 implement evidence tip SHA`)  
**Implement commit:** `ffc4c72e1a5dbbd3d28b6eaf075ebbe7f00e2518` (`feat(opening): V2-07 compile-teaching-unit jobs + budget purpose`) — ancestor of HEAD  
**Baseline gate tip:** `1f9ff58` — ancestor of HEAD (dirty tree: unrelated untracked evidence only)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:** Plan `v2-07-teaching-generation-jobs-plan.md` + Plan ACCEPT + migr assign `0055` + Implement evidence  
**Verdict:** **ACCEPT**

## Scope of this accept

Independent Implement ACCEPT of V2-07 product land against plan / Plan ACCEPT / PM defaults. Re-ran claimed focused vitest + worker/database tsc. Did **not** apply migrate, push, hermes, stash, reset, or commit.

## Stronger review vs plan / PM

| Check | Result |
|---|---|
| Kind **`compile-teaching-unit`** (not tutor-extend / not separate mode kinds) | **Pass** — migration CHECK, `queue.ts`, `handlers.ts`, `index.ts` handlers map; tutor remains special-case only for `kind === "tutor"` |
| Modes `generate` \| `repair` on payload | **Pass** — payload type + parse + enqueue validation |
| Wire via **`runJob`** (not tutor branch) | **Pass** — `index.ts` registers handler in `createHandlers`; worker loop uses `runJob` for non-tutor kinds |
| `operationId = compile-teaching-unit:{job.id}` stable; never attempt-suffixed | **Pass** — handler + unit test CONFLICT path |
| Budget `purpose: "compile-teaching-unit"`; `runBudgetedCall` injectable purpose default `"tutor"` | **Pass** — `budgeted-call.ts` + tests |
| Generate write-back → **`needs_check`** | **Pass** — handler sets `needs_check` when provider used; test asserts |
| Non-model repair → `ready` only behind `skipProviderForRepair` | **Pass** — matches Plan §3.1 / Plan ACCEPT soft gap #1 (default false → still budgeted) |
| Cancel: job `queued\|running` → `cancelled`; activity `queued\|generating` → `cancelled` | **Pass** — `opening-jobs.cancel` + unit tests |
| Late cancel discards publish / no `needs_check` | **Pass** — handler double-checks job state before publish; unit test |
| Enqueue key `compile-teaching-unit:{activityId}:{mode}:{clientKey}` + outbox + `generate_status=queued` | **Pass** — activities repo + unit test |
| Migration **0055** sole file; CHECK = prior kinds + `compile-teaching-unit`; rollback comment correct | **Pass** — sole `0055_opening_compile_teaching_unit_job.sql`; prior list matches `0051` + new kind |
| Stub provider until V2-08 | **Pass** — honest in implement evidence + `index.ts` stub |
| No Experience HTTP route / no V2-08 compiler body / no tutor table expansion | **Pass** — not in diff |
| Tests not loosened to hide missing behavior | **Pass** — focused suite covers T1–T7 intents; T8 publish CAS CONFLICT not dedicated unit (soft gap); T9–T12 honestly `not_run` |

### PM defaults

| PM | Landed |
|---|---|
| `compile-teaching-unit` | Yes |
| Not tutor-extend | Yes |
| Writeback → `needs_check` after model generate | Yes |

### Soft gaps (do not overturn ACCEPT)

1. **T8** (stale `expectedVersion` → fail / no double bump): no dedicated handler unit; relies on V2-05 `publishActivitySpec` CAS + catch → `failed`. Recommend follow-up unit if desired.  
2. **Cancel + budget race:** `cancel` does not release reserved ledger; late-result path discards publish but does not settle. Matches Plan ACCEPT soft gap #4; mirror tutor when tightening.  
3. **HTTP enqueue / poll UI** absent (Plan §7 Experience later).  
4. **Live migrate apply** not executed (no DB / forbidden hermes this turn).  
5. **Stub provider** until V2-08.

## Sole 0055 + kind registration

```text
$ ls packages/database/src/migrations/0055*
packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql
# count = 1

CHECK (... 'extract-study-actions','compile-teaching-unit')
# prior kinds match 0051; rollback drops to 0051 list

createQueues / createHandlers / index handlers["compile-teaching-unit"] / runJob path — confirmed
```

## Commands re-run + results

### Vitest (focused — same set as implement claim)

```text
./node_modules/.bin/vitest run \
  apps/worker/src/runtime/queue.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/runtime/run-job.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts \
  packages/database/src/repositories/opening-teaching-activities.test.ts \
  packages/database/src/repositories/opening-jobs-cancel.test.ts
```

**Result:** exit 0 — **6 files, 50 tests passed** (CST ~11:32).

### Typecheck

```text
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/database/tsconfig.json --noEmit
```

**Result:** both exit 0 (`WORKER_TSC:0`, `DB_TSC:0`).

## not_run

| Check | Reason |
|---|---|
| Migrate apply `0055` | No live DB / `OPENING_TEST_DB` / hermes; DDL file only; gate forbids apply this turn |
| Integration T9–T10 | DB unavailable |
| E2E / browser T11 | Experience path; not Implement ACCEPT blocker for this slice |
| Real model smoke T12 | Deferred V2-08+ / auth; stub until then |
| Hermes / push / stash / reset / commit | Forbidden this turn |
| Full monorepo `npm test` / web typecheck | Not claimed by implementer; focused worker+database only |

## Diff scope observed (left alone)

Unrelated untracked only:

```text
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
```

Plus this accept evidence file. No product edits by Integrator. No migrate apply.

## Tip verification

```text
$ git rev-parse HEAD
4f0b9ec42729b0361d2e0958ff8da2f65428f593

$ git log -1 --oneline
4f0b9ec docs(opening): V2-07 implement evidence tip SHA

$ git merge-base --is-ancestor 1f9ff58 HEAD && git merge-base --is-ancestor ffc4c72 HEAD
# both OK
```

## Verdict

**ACCEPT.**

- Evidence: `docs/superpowers/evidence/2026-10-11-opening-release/v2-07-teaching-generation-jobs-accept.md`
- Kind `compile-teaching-unit` registered (0055 sole SQL + queues/handlers/`runJob`)
- Budget purpose + stable operationId; generate → `needs_check`; cancel drops late writeback
- Re-ran: Vitest **50 passed**; worker/database tsc exit 0
- Soft gaps: T8 unit, cancel-budget release, no HTTP route, stub provider, migrate not applied

Integrator did **not** apply migrate, push, hermes, stash, reset, or commit. `tasks.json` → `verified` may be updated by Projects Manager / follow-on process if authorized.
