# V2-08 Teaching plan/compiler — Plan ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** plan author (AIstudy AI)  
**Stage:** Plan ACCEPT only (no product Implement, no migration, no push / hermes / stash / reset / commit)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`)  
**Baseline:** V2-07 merged ACCEPT at tip; dirty tree = V2-08 plan docs + unrelated untracked evidence only  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md` + delivery-loop Plan gate (stronger review of design claims vs code)  
**Docs reviewed:**
- `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-understand.md`
- `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-plan.md`
- `docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-implement.md` (Plan-stage evidence filename)

## Verdict

**ACCEPT**

Plan matches PM frozen defaults, authority (`plan.md` §V2-08 / `tasks.json` V2-08), and tip `ae97498` surfaces. No invented durable APIs that block Plan; soft gaps listed for Implement (do not overturn ACCEPT).

## Tip / tree verification

```text
$ git rev-parse HEAD
ae974983ce791894c2aa6d9459b06198d3152191

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
ae97498 docs(opening): V2-07 teaching generation jobs ACCEPT evidence

$ git status --short
?? docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md
?? docs/superpowers/evidence/2026-10-11-opening-release/p0-assistant-list-preview-failsoft-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-implement.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-plan.md
?? docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-understand.md
(+ this accept evidence file after write)

$ test ! -f packages/domain/src/opening/teaching-plan.ts \
  && test ! -f packages/ai/src/opening/teaching-compiler.ts && echo absent
absent

$ ls packages/database/src/migrations/*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*
```

**Result:** tip OK. Product modules for V2-08 **not** landed (Plan-only scope honored). Migrations tip ends at **0055**.

## PM frozen defaults (verify against Plan)

| PM default | Plan coverage | Spot-check |
|---|---|---|
| No new DDL / no new job kind | Plan §2, §6, §7; Understand OOS | Tip migrations end `0055`; job kind already in V2-07; payload JSON-only preference |
| domain outline + ai compiler via V2-07 `buildPublishInput` | Plan §2–§4.3; paths match `tasks.json` proposed_paths | `CompileTeachingUnitDeps.buildPublishInput?` at `compile-teaching-unit.ts` L65–69; stub wire `index.ts` L118–152; stub instruction L181; `defaultStubPublish` empty `blockOrder` + `extras.stub` L108–126 |
| path ≠ planDay | Plan §4.1 `assertTeachingPathNotPlanDay` + `kind: "teaching_path"`; C3 | `planDay` / `DayPlanResult` / `PlannedBlock` in `day-planner.ts`; orthogonal calendar |
| prerequisites explainable + skippable | Plan `TeachingPrerequisiteSuggestion` (`reason`, `skippable: true`); C4 | No mastery unlock; reuses `assertNoMasteryPercentage` (`tutor-policy.ts` L229–242) |
| do not rewrite learned history | Plan `decideHistoryFreeze` / `revise_subsequent_only`; C5; M1 library revision note | Contracts M1 note: no ActivitySpec history table; past body via library `revision_number` |

## Stronger-review table (claims vs files)

| Claim | File / API on tip | Result |
|---|---|---|
| Entry `tutor-policy.ts`; proposed `teaching-plan.ts` + `teaching-compiler.ts` | `plan.md` L493–495; `tasks.json` V2-08 `existing_paths` / `proposed_paths` | **Pass** |
| V2-07 stub + `buildPublishInput` hook | `apps/worker/src/jobs/compile-teaching-unit.ts` L42–79, L108–126, L181, L244–246; `apps/worker/src/index.ts` L118–152 | **Pass** (line refs ≈ evidence; stub provider L121–129) |
| No new job kind / migration already `0055` | `0055_opening_compile_teaching_unit_job.sql`; no `0056*` | **Pass** |
| V2-06 evidence pack APIs | `assembleTeachingEvidencePack`, `formatProviderContext`, `classifyClaimSupport`, `assertNoHeldOutLeak` in `teaching-evidence.ts`; `buildCoverageTable` / `SourceAnchor` in `teaching-coverage.ts`; exported from domain/ai `index.ts` | **Pass** |
| V2-05 publish / roles / goals | `teachingBlockRoleSchema` = teach\|prompt\|example\|answer_key\|meta; `activitySpecPublishInputSchema`; `generationConfig.extras`; `answer_key` redact rule | **Pass** |
| Activity `pathVersion` / `generateStatus` / intent kinds | `teaching-activity.ts` (`pathVersion` positive int; intents material\|topic\|question\|goal\|resume\|course_continue) | **Pass** |
| Post-model → `needs_check` | Handler L256–257 sets `needs_check` unless repair skip-provider | **Pass** (aligns Plan default) |
| Mastery % ban | `assertNoMasteryPercentage` L229–242; also `assertCitationsForPage` exists (Understand cite) | **Pass** |
| Outline persistence without DDL | `teachingGenerationConfigSchema.extras`; `checkpointJson` on activity/content contracts | **Pass** (JSON-only; no silent DDL) |
| Fixture sample | `tests/fixtures/opening/teaching/unit-rank-nullspace/lecture/activity-outline.json` (`goalIds` / `blockTypes` / `sourceIds`) | **Pass** |
| `SourceChunk` / `ProviderOutput` / `ActivitySpecPublishInput` | contracts `sources.ts` / `tutor.ts` / `teaching-content.ts` | **Pass** |
| Worker already imports `@aistudy/ai` | `compile-teaching-unit.ts` imports `OpeningProviderError` | **Pass** (compiler wire layer OK) |
| Ownership / no cyclic design | domain policy ← tutor-policy; ai compiler ← domain + evidence; worker ← ai + existing fences | **Pass** |
| Tests guard “green without behavior” | Plan C1–C11 explicitly forbid stub-only / empty `blockOrder` / skipping asserts | **Pass** (Plan-stage design; Implement must land) |
| Experience HTTP deferred | Plan T-E OOS; V2-07 soft gap #3 carry-forward | **Pass** (honest) |
| Scope = docs only this handoff | No product files created; evidence claims not_run for vitest/tsc/model | **Pass** |

### Invented / soft-named helpers (not REJECT)

| Sketch name | Reality on tip | Integrator note |
|---|---|---|
| `writeLibraryRevisionIfNeeded` | **Not** a method on `opening-teaching-content` today. Library body write = `library.updateDocument` (new revision) or `createUnit` initial blocks. `publishActivitySpec` **pins** `revisionNumber` + `blockOrder` only. `index.ts` `ensureTeachingUnitId` creates unit with `blocks: []`. | Soft gap #1 — Implement must call `library.updateDocument` (via unit `document_id`) or add a thin teaching-content wrapper **before** publish; do not invent DDL. |
| Sync `proposeTeachingOutline` / `compileCurrentActivity` | Sketches are sync; provider path is async via `runBudgetedCall` | Soft gap #2 — Plan §4.3 already allows model on BudgetedProvider **or** parse inside `buildPublishInput`; Implement must pick async shape without bypassing budget/cancel fences. |

Neither is a dropped PM constraint or silent DDL. Placement rejection (compiler not in domain; outline not only in worker) is sound.

## DDL decision

| Item | Decision |
|---|---|
| New DDL for V2-08 M1? | **No** |
| New job kind? | **No** (reuse `compile-teaching-unit` / `0055`) |
| Invent migration number? | **Do not.** Prefer no DDL as claimed. If a later slice truly needs durable outline rows, Integrator assigns next free `0056` **only after** confirming no other `0056` exists — **not** required by this Plan ACCEPT. |

## Soft gaps / honesty (do not overturn ACCEPT)

1. **Library write path:** conceptual `writeLibraryRevisionIfNeeded` → Implement uses existing `library.updateDocument` (or thin repo wrapper); empty createUnit blocks today.  
2. **Async vs sync sketches:** keep budgeted provider fences; make compiler APIs async as needed.  
3. **`matrix-viz` allowlist:** Plan already allows map→text+formula if product lacks type.  
4. **Experience HTTP / outline UI:** deferred (V2-10+ / Experience); compiler must stay callable from worker without UI.  
5. **Plan-stage product checks:** C1–C11, vitest teaching-plan/compiler, tsc, real model smoke, browser/E2E, migrate, hermes/push — all honestly **`not_run`**.  
6. **V2-07 carry-forward soft gaps:** T8 publish-CAS dedicated unit missing; cancel does not release reserved ledger; stub provider until this Implement; Experience enqueue/poll absent.  
7. **Outline persistence default:** `generationConfig.extras.outline` and/or `checkpointJson.outline` — Understand §Decisions; escalate to PM only if disagree (defaults frozen unless PM overrides).

## Open decisions for PM

**None that block Plan ACCEPT.** Frozen PM room defaults match Plan. Optional later (not blockers): whether Experience needs outline zod in `packages/contracts` in-slice vs domain-first; whether prefetch default is 0 or 1.

## Scope confirmation

- Integrator did **not** implement product code.  
- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** change `tasks.json` status.  
- Integrator did **not** self-ACCEPT for AI Implement (this is Plan ACCEPT of AI-authored Plan only).

## not_run (Plan ACCEPT)

| Check | Status | Reason |
|---|---|---|
| vitest teaching-plan / teaching-compiler | **`not_run`** | Modules not landed |
| vitest regressions (evidence/coverage/tutor-policy/day-planner/compile-teaching-unit) | **`not_run`** | Plan stage; no product change |
| tsc / typecheck | **`not_run`** | Docs-only |
| Real model smoke | **`not_run`** | Implement/Accept later (acceptance criterion at product Accept) |
| Browser / E2E | **`not_run`** | N/A Plan |
| migrate apply | **`not_run`** | No DDL planned |
| push / hermes / commit | **`not_run`** | Forbidden |

Per gates: Plan Accept does not require re-running product tests never claimed as run.

## Handoff

1. **Plan ACCEPT** recorded — PM may open Implement gate later.  
2. Implement must keep: no DDL unless Integrator assigns; wire via `buildPublishInput`; path ≠ planDay; skippable explainable prereqs; freeze learned history; presentable non-empty `blockOrder` + remove `extras.stub` when compiler on; `generate_status=needs_check` after model.  
3. Independent **Implement ACCEPT** required after product work (implementer ≠ accepter).

## One-line soft gaps

Library write via `updateDocument` (not invented teaching-content helper); async/budget wire; matrix-viz map; Experience HTTP deferred; C1–C11/vitest/model `not_run`; V2-07 T8/cancel-budget/stub carry-forward.
