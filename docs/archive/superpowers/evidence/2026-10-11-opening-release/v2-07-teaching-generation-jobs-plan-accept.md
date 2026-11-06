# V2-07 accept — Teaching generation jobs Plan (Pipeline)

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Integrator (executor / Grok Bot) — Plan ACCEPT only  
**Branch:** `feat/opening-release`  
**Tip HEAD:** `cccc39272fd3a7d565a946b3979d0231220cbee2` — matches required baseline `cccc392` (message: `feat(opening): V2-05 versioned teaching content (migration 0054)`)  
**Stage:** Plan ACCEPT (not Implement). **No ALTER. No product code land. No push / hermes / stash / reset / commit.**  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Verdict:** **ACCEPT**

## Scope of this accept

Accept of:

- `docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-plan.md`
- Plan-stage evidence `docs/superpowers/evidence/2026-10-11-opening-release/v2-07-teaching-generation-jobs-plan.md`

against pack `plan.md` §V2-07 + `tasks.json` V2-07, V2-05 content APIs on tip, worker/opening_jobs patterns, and PM defaults for this slice.

**This ACCEPT authorizes opening the Implement gate** (migration 0055 → queue/handlers wiring → `compile-teaching-unit` job + enqueue + budget purpose + cancel/generate_status helpers → T1–T10 → implement evidence). It does **not** apply DDL, land product code, or move `tasks.json` → `verified`.

## Inputs reviewed

| Artifact | Role |
|---|---|
| `v2-07-teaching-generation-jobs-understand.md` | Restatement + durable-job / budget inventory |
| `v2-07-teaching-generation-jobs-plan.md` | Design under review |
| `v2-07-teaching-generation-jobs-plan.md` (evidence) | Plan-stage evidence claim |
| `plan.md` §V2-07 | Pack scope / verification / acceptance / rollback |
| `tasks.json` V2-07 | Scope / proposed_paths / existing_paths |
| `review-test-gates.md` | Independent accept rules |
| PM defaults (this turn) | Kind `compile-teaching-unit`; modes generate/repair; do **not** expand tutor; writeback → `needs_check`; migr `00xx` until Integrator assigns |
| Tip spot-checks | Migrations through `0054`; `queue.ts` / `handlers.ts` / `budgeted-call.ts` / `run-job.ts` / `dispatch.ts`; `opening-jobs.ts` / `opening-budget.ts` / `opening-knowledge.ts` enqueueRebuild; `opening-tutor-jobs.ts` cancel; `opening-teaching-content.ts` `publishActivitySpec`; contracts `generateStatus` enum; worker `index.ts` tutor special-case |

## Stronger Plan review

### 1. Restatement ↔ pack + PM (no invented scope)

| Check | Result |
|---|---|
| Wire teaching generation into **existing** durable job + budget stack | Pass — Understand outcome + Plan §2; pack “在既有worker/runtime注册教学任务” |
| Distinct generate / repair / cancel / unknown / failure | Pass — one kind + payload.mode; job states + activity `generate_status` mapping §4.1 |
| Reuse operationId / reserve-release-settle-markUnknown / privacy epoch | Pass — Plan §3; mirrors tutor-turn + `runBudgetedCall` |
| Bounded retries must not re-consume released / unknown | Pass — §3.2 table; forbid attempt-suffixed operationId (rejected alt §9) |
| Write-back: owner / source / activity version / epoch | Pass — §4.3 checklist; calls V2-05 `publishActivitySpec` |
| Refresh via persisted job (no duplicate content / debit) | Pass — createOnce + outbox + stable operationId |
| Pack proposed path `apps/worker/src/jobs/compile-teaching-unit.ts` | Pass — Plan §2.2 |
| Do **not** expand tutor / `opening_tutor_jobs` | Pass — Understand plug-in A; Plan §2.1 / §9; PM default |
| Post-model writeback `generate_status=needs_check` | Pass — Plan §3.1 / §8 default #2; PM default |
| OOS: no Implement / no invented migr # / no V2-08 compiler body / no Experience UI | Pass — Plan §1 / §11; Understand non-goals |

**PM defaults mapped:**

| PM decision | Plan coverage | Accept |
|---|---|---|
| New kind **`compile-teaching-unit`** | §2.1 | Pass |
| Payload modes `generate` \| `repair` (not separate kinds) | §2.1 / §2.3 | Pass |
| Do **not** expand tutor | §2.1 / §9 | Pass |
| After writeback → **`needs_check`** | §3.1 / §4.1 / §8 | Pass (model generate locked; see soft gap #1 for non-model repair nuance) |
| Migr placeholder `00xx` (tip ended 0054) | §6 / §9 | Pass → **0055 assigned this accept** |

### 2. Claims name real files/APIs; migration need clear

| Claim | Tip spot-check | Result |
|---|---|---|
| `opening_jobs` states include cancelled / outcome_unknown / failed | `0018_*.sql` CHECK; schema/repo | Pass |
| Current kinds end at `extract-study-actions`; **no** teaching kind | `queue.ts` L19; `handlers.ts` L4–L23; CHECK tip `0051`; 0052–0054 did not alter kind CHECK | Pass |
| Tutor bypasses `runJob` via `createTutorTurnHandler` | `index.ts` imports + separate wiring; handlers map still lists tutor stub | Pass — Plan correctly stays on opening_jobs + `runJob` |
| `runBudgetedCall` purpose hardcoded `"tutor"`; `operationId` → ledger requestId | `budgeted-call.ts` L119–L126 | Pass — Plan §3.3 injectable purpose |
| Reserve replay only while `state='reserved'` (same purpose/amount/snapshot); else CONFLICT | `opening-budget.ts` L188–L194 | Pass — §3.2 released/completed behavior honest |
| `markUnknown` keeps reserved | `opening-budget.ts` L242+; Understand | Pass |
| Dispatch `attempts: 2` | `dispatch.ts` L31 / L58 | Pass |
| `canClaimJob` rejects cancelled | `run-job.ts` L14–L16 | Pass |
| Epoch fence in `runJob` | `run-job.ts` L28–L49 | Pass |
| Enqueue template = `enqueueRebuild` (privacy epoch + outbox) | `opening-knowledge.ts` L264+ | Pass |
| Tutor `cancel` exists; **opening_jobs cancel helper absent** | `opening-tutor-jobs.ts` L141+; no cancel in `opening-jobs.ts` | Pass — Plan §4.2 Implement work |
| `generateStatus` enum complete (queued…stale) | `teaching-activity.ts` L20–L28 | Pass |
| No `setGenerateStatus` writer yet; create defaults `ready` | activities repo create only; schema default `"ready"` | Pass — Plan gap honest |
| V2-05 `publishActivitySpec` CAS (`expectedVersion`, optional `expectedRevisionNumber`) | `opening-teaching-content.ts` L267+ | Pass — write-back reuses, does not fork body store |
| `assertOwnedActivity` / `lockLearningOwner` | `opening-teaching-activities.ts` | Pass |
| Product Implement artifacts absent | No `compile-teaching-unit.ts`; no `0055_*` SQL | Pass |
| Migration **needed** | Yes — extend `opening_jobs_kind_check` only; no new tables for M1 | Pass |
| Integrator assigns number | Placeholder `00xx`; tip migrations end **0054**; no `0055_*` | Pass → assigned **0055** |

**Assigned migration number:** **0055**  
Evidence: `docs/superpowers/evidence/2026-10-11-opening-release/v2-07-migration-number-assigned.md`  
Implement filename: `packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql` (replace `00xx`). **No ALTER applied by this assignment.**

### 3. Tests cannot pass by hiding behavior; rejected alternatives present

| ID | Intent (anti-hide) | Plan status |
|---|---|---|
| T1 | Queues/handlers register `compile-teaching-unit` | `not_run` (Plan stage) |
| T2 | `runBudgetedCall` accepts purpose; teaching purpose passed | `not_run` |
| T3 | Same operationId while reserved → single reserve | `not_run` |
| T4 | After release, same operationId → CONFLICT / no second reserve | `not_run` |
| T5 | markUnknown keeps reserved; job/activity → unknown | `not_run` |
| T6 | Cancel then late publish discarded | `not_run` |
| T7 | Epoch mismatch → stale/failed; no publish | `not_run` |
| T8 | Stale `expectedVersion` → fail; no double bump | `not_run` |
| T9 | Integration: enqueue→succeed → unique ledger + content_version+1 | `not_run` |
| T10 | Restart mid-job: claim takeover / soft-idempotent publish | `not_run` |
| T11–T12 | e2e / real model | `not_run` (user / V2-08+) |

Rejected alternatives §9 present and correct: tutor-extend, per-mode kinds, attempt-scoped operationId, auto-release+retry on unknown, job.result as body store, inventing migr # in Pipeline docs. Matches C04 / pack acceptance.

### 4. Dependencies acyclic; V2-05 handoff respected

| Edge | Check |
|---|---|
| Pack `depends_on: [V2-01, V2-03]`; V2-08 depends on V2-07 | Acyclic |
| Operational use of V2-05 `publishActivitySpec` + V2-04 activity `generate_status` | Honest in Understand/Plan; both landed on tip `cccc392` / `0054` |
| Downstream V2-08/… list V2-07 | No cycle |
| Plan stubs provider behind budgeted-call until V2-08 | Pass — still exercises ledger + write-back fences |

### 5. Design validators / test re-run (Plan Accept)

| Check | Status | Reason |
|---|---|---|
| Product T1–T12 | **`not_run`** | Plan stage; no Implement |
| typecheck / vitest / migrate apply | **`not_run`** | Docs-only slice; no ALTER |
| e2e / browser / real model | **`not_run`** | Not Plan ACCEPT criteria |
| hermes / push / stash / reset / commit | **`not_run`** | Forbidden this turn |

Per gates: Plan Accept does not require re-running product tests that were never claimed. Plan-stage evidence honestly lists all product checks `not_run`.

## Soft gaps (do not overturn ACCEPT; track for Implement / PM)

1. **Non-model repair → `ready`:** Plan §3.1 allows repair that only rewrites indexes without a provider call to set `ready`. PM default for this turn is writeback → `needs_check`. **Implement default:** always `needs_check` after any model generate; only take the non-model → `ready` path if PM explicitly confirms before Implement lands it.
2. **`tasks.json` depends_on lists only V2-01/V2-03** while Plan correctly binds V2-05 publish + V2-04 activity rows. Non-blocking (both landed); optional hygiene: add V2-04/V2-05 to depends_on in a later pack edit.
3. **`failOpeningJob` is parse/parse-media-oriented** — Plan correctly prefers a **teaching-specific finish helper** rather than overloading parse source write-back. Implement must not couple activity generate_status to parse failure paths.
4. **Cancel + budget race:** Plan §4.1 says if unknown → leave reserved; if reserved before known usage → release when safe. Implement must mirror tutor cancel lock order and prove late-result discard (T6) without releasing an already-sent unknown.
5. **Live `schema_migrations` not queried** — if production/hermes max ≥ 0055 before apply, renumber. Same caveat as V2-04/V2-05 assignment notes.

## Diff scope observed (left alone)

```text
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-06-teaching-evidence-plan-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-07-teaching-generation-jobs-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-06-teaching-evidence-understand.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-07-teaching-generation-jobs-understand.md
```

Plus this accept’s new evidence files (`v2-07-teaching-generation-jobs-plan-accept.md`, `v2-07-migration-number-assigned.md`). No product/worker/migration SQL changes. No stash/reset. Did not edit V2-06 trees.

## Tip verification (this accept)

```text
$ git rev-parse HEAD
cccc39272fd3a7d565a946b3979d0231220cbee2

$ git log -1 --oneline
cccc392 feat(opening): V2-05 versioned teaching content (migration 0054)

$ ls packages/database/src/migrations/005*.sql
0050_opening_parse_media_job.sql
0051_opening_extract_study_actions_job.sql
0052_opening_action_digest_decisions.sql
0053_opening_teaching_activities.sql
0054_opening_teaching_content.sql
# no 0055_* before assignment
```

## Verdict

**ACCEPT.**

- Kind: **`compile-teaching-unit`** (modes generate/repair on payload; not tutor-extend).
- Migration assigned: **0055** → `0055_opening_compile_teaching_unit_job.sql`.
- Writeback default after model generate: **`needs_check`**.
- Implement may proceed under a subsequent PM/Integrator Implement gate; this slice remains docs-only.

Integrator did **not** Implement, apply ALTER, push, hermes, stash, reset, or commit.
