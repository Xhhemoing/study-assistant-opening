# V2-07 Teaching generation jobs — Plan-stage evidence (Understand + Plan only)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Pipeline (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `cccc39272fd3a7d565a946b3979d0231220cbee2` — **matches required baseline `cccc392`** (message: `feat(opening): V2-05 versioned teaching content (migration 0054)`)  
**Stage:** Understand → Plan only. **No product Implement. No ALTER. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Self-ACCEPT:** **forbidden** — hand to Integrator for Plan ACCEPT.

## Diff scope (this slice)

### Written (docs only)

| Path | Role |
|---|---|
| `docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-understand.md` | Understand |
| `docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-plan.md` | Plan (await ACCEPT) |
| `docs/superpowers/evidence/2026-10-11-opening-release/v2-07-teaching-generation-jobs-plan.md` | This plan-stage evidence |

### Explicitly not touched

- No `apps/worker/src/jobs/compile-teaching-unit.ts` (or any worker/product code)
- No edits to `budgeted-call.ts` / `handlers.ts` / `queue.ts` / `tutor-turn.ts`
- No migration SQL under `packages/database/src/migrations/`
- No ALTER / migrate / psql / vitest product runs
- No `tasks.json` status → verified / in_progress
- No V2-06 Plan tree edits
- No push / hermes / stash / reset / commit

### Dirty tree observed (left alone)

```text
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
```

Unrelated untracked evidence only. `cccc392` is ancestor of HEAD (HEAD == tip).

## Tip / branch verification

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
cccc392 feat(opening): V2-05 versioned teaching content (migration 0054)

$ git merge-base --is-ancestor cccc392 HEAD && echo "cccc392 is ancestor of HEAD"
cccc392 is ancestor of HEAD

$ ls packages/database/src/migrations/005*.sql
0050_opening_parse_media_job.sql
0051_opening_extract_study_actions_job.sql
0052_opening_action_digest_decisions.sql
0053_opening_teaching_activities.sql
0054_opening_teaching_content.sql
```

**Result:** tip OK; migrations tip ends at **0054** (V2-05). Next job-kind migration remains Integrator-assigned (`00xx` in Plan).

## What was read (inventory)

### Pack / gates

- `docs/superpowers/plans/ai-led-learning-v2/plan.md` §V2-07 (L465–L483)
- `docs/superpowers/plans/ai-led-learning-v2/tasks.json` V2-07 (L389–L439)
- `docs/superpowers/plans/opening-release/review-test-gates.md`
- V2-05 Understand + Plan (hand-off notes; pipeline/compile deferred to V2-07)
- V2-05 landed surfaces: `teaching-content.ts` contracts, `opening-teaching-content.ts` `publishActivitySpec`, migration `0054`

### Worker / runtime

- `apps/worker/src/runtime/budgeted-call.ts` (operationId, purpose hardcoded `"tutor"`, ledgerActionForProviderError, settle/release/markUnknown)
- `apps/worker/src/runtime/handlers.ts` (`createHandlers` kinds)
- `apps/worker/src/runtime/queue.ts` (`createQueues` kinds)
- `apps/worker/src/runtime/dispatch.ts` (`dispatchPending`, `dispatchTutorTurns`)
- `apps/worker/src/runtime/run-job.ts` (epoch fence, outcome_unknown)
- `apps/worker/src/runtime/privacy-guard.ts`
- `apps/worker/src/jobs/tutor-turn.ts` (operationId `tutor:${id}`, beforeSend epoch, fail vs markUnknown)
- `apps/worker/src/index.ts` (handler wiring; tutor special-case)

### Database

- `packages/database/src/schema/opening-jobs.ts`
- `packages/database/src/repositories/opening-jobs.ts` (createOnce, claim, finish)
- `packages/database/src/repositories/opening-job-failure.ts` (parse/parse-media fences)
- `packages/database/src/repositories/opening-budget.ts` (reserve idempotency; release; markUnknown keeps reserved)
- `packages/database/src/repositories/opening-tutor-jobs.ts` (cancel pattern)
- `packages/database/src/repositories/opening-knowledge.ts` `enqueueRebuild` (outbox enqueue template)
- `packages/database/src/repositories/opening-teaching-activities.ts` / `opening-teaching-content.ts`
- Migrations `0018`, `0050`, `0051`, `0053`, `0054`
- Contracts `teaching-activity.ts` generateStatus enum

## Commands run + results

### Git / tip

```text
$ git log -1 --oneline && git status --short && git branch --show-current
cccc392 feat(opening): V2-05 versioned teaching content (migration 0054)
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
feat/opening-release
```

**Result:** exit 0 — baseline match; dirty = unrelated untracked only.

### Locate V2-07 + worker entry points

```text
$ rg -n "V2-07|v2-07|teaching.?generat" docs/superpowers/plans/ai-led-learning-v2/plan.md \
    docs/superpowers/plans/ai-led-learning-v2/tasks.json | head -80

$ rg -n "createQueues|budgeted-call|operationId|tutor-turn" apps/worker -l | head -60
```

**Result:** exit 0 — pack §V2-07 + tasks entry found; worker files listed.

### Job kinds / CHECK / budget idempotency

```text
$ rg -n "createQueues|compile-teaching" apps/worker/src/runtime/queue.ts apps/worker/src/runtime/handlers.ts

$ rg -n "opening_jobs_kind_check|compile-teaching" packages/database/src/migrations/*.sql | head -20

$ rg -n "request_id|state !== 'reserved'|markUnknown" \
    packages/database/src/repositories/opening-budget.ts | head -40
```

**Result:** exit 0 — current kinds end at `extract-study-actions`; no teaching kind; reserve replay only while `reserved`.

### Teaching write-back / generateStatus

```text
$ rg -n "publishActivitySpec|expectedVersion|generate_status|generateStatus" \
    packages/database/src/repositories/opening-teaching-content.ts \
    packages/contracts/src/opening/teaching-activity.ts | head -80
```

**Result:** exit 0 — publish CAS present; activity generateStatus enum complete; no setGenerateStatus writer yet (gap called in Understand).

## Not run (`not_run`)

| Check | Status | Reason |
|---|---|---|
| vitest product (`apps/worker`, `packages/database`) | **`not_run`** | Plan-only slice; no code under test changed |
| typecheck / lint / build | **`not_run`** | No Implement; avoid unsolicited full CI |
| migrate / psql / OPENING_TEST_DB integration | **`not_run`** | No migration invented or applied |
| e2e / browser | **`not_run`** | User/Experience; not Plan ACCEPT criteria |
| real model / provider smoke | **`not_run`** | Deferred to Implement / V2-08 |
| hermes / push | **`not_run`** | Forbidden this turn |
| stash / reset | **`not_run`** | Forbidden; dirty tree left intact |

## Key recommendation (for Integrator focus)

- **New** BullMQ / `opening_jobs` kind **`compile-teaching-unit`** (modes `generate` | `repair` on payload).
- Reuse `runJob` + `runBudgetedCall` with `operationId = compile-teaching-unit:{job.id}`; injectable budget `purpose`.
- Retries must keep the same operationId; after **release**, do **not** mint a new attempt key (ledger CONFLICT = stop).
- Write-back via V2-05 `publishActivitySpec` + generate_status fences + epoch/owner/source checks.
- Migration placeholder **`00xx`** only.

## Suggested Integrator Plan Accept focus

1. Confirm new-kind vs tutor-extend decision against pack proposed path.  
2. Verify double-spend rules (released / unknown) match C04 and ledger code facts.  
3. Confirm write-back checklist covers owner / epoch / content_version / cancel late-result.  
4. Confirm migration stays `00xx` (tip **0054**).  
5. Confirm no product files in the slice diff.

## Verdict of this evidence

Plan-stage documentation complete. **Await Integrator Plan ACCEPT.** Pipeline did **not** Implement, invent migration numbers, push, hermes, stash, or reset.
