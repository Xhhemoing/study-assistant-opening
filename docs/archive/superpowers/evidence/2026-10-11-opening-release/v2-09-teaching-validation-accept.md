# V2-09 Teaching validation / publish control — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy AI)  
**Stage:** Implement ACCEPT only (no commit / push / hermes / stash / reset / migrate)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty product land, no commit):** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Reviewed:**
- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-plan.md`
- Implement claim: `docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-implement.md`

## Verdict

**ACCEPT**

Independent stronger review + re-run of claimed vitest/tsc match implement evidence. PM constraints hold: no DDL / no new job kind / structure_ok ≠ verified / missing evidence·conflict·timeout → not verified / no fake authority / consumes V2-08+V2-06. Soft gaps honest; skipped checks labeled `not_run`. No push / hermes / commit.

## Tip / dirty tree

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
f5dae08 feat(opening): V2-08 teaching plan outline + compiler

$ git status --short  (product-relevant)
 M apps/worker/src/index.ts
 M apps/worker/src/jobs/compile-teaching-unit.test.ts
 M apps/worker/src/jobs/compile-teaching-unit.ts
 M packages/ai/src/index.ts
 M packages/domain/src/index.ts
?? packages/ai/src/opening/teaching-verifiers.ts
?? packages/ai/src/opening/teaching-verifiers.test.ts
?? packages/domain/src/opening/teaching-validation.ts
?? packages/domain/src/opening/teaching-validation.test.ts
(+ evidence/plan docs; unrelated untracked left alone)

$ ls packages/database/src/migrations/005*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*

$ git diff --name-only HEAD -- apps/web
(empty — no apps/web changes)
```

**Result:** tip OK; dirty product land matches implement claim; migrations tip still **0055**.

## Stronger review

### Diff scope vs plan

| Path | Role | Review |
|---|---|---|
| `packages/domain/.../teaching-validation.ts` (+test) | LayerOutcome / structure≠fact / mayPublishVerified / presentationFor / spoof assert / stream deny / privacy recheck | **Pass** — matches Plan §4.1 |
| `packages/ai/.../teaching-verifiers.ts` (+test) | L1–L5; classifyClaimSupport; injection; tool timeout→unknown; flag; after-publish factory | **Pass** — matches Plan §4.2; reuses V2-06 pack |
| `compile-teaching-unit.ts` thin post-validation | Optional `verifyAfterPublish`; flag-gated; cancel/epoch fences; CAS metadata republish; ready only when verified | **Pass** — Plan §4.3 / C10 |
| `apps/worker/src/index.ts` | Wire factory + `chunks.listForSources` when flag on | **Pass** — thin |
| domain/ai `index.ts` exports | Public API surface | **Pass** |
| Migrations / new job kind / `apps/web` | Explicitly absent | **Pass** |

### PM constraints

| Constraint | Evidence in code | Result |
|---|---|---|
| `structure_ok` ≠ `verified` | `structurePassed` = schema+source only; `factPassed` requires claim pass; C1 domain+ai tests | **Pass** |
| Missing evidence / conflict / timeout → not verified | Empty claims → claim_support fail (vacuous refuse); coverage conflict → fail; tool unknown → needs_check; mayPublishVerified false | **Pass** |
| No fake authority | `assertNotAuthoritySpoof` / `detectAuthoritySpoof` reject self-claim + peer-model upvote; C4/C7 | **Pass** |
| No DDL / no new job kind | migr tip 0055; no 0056; reuse existing job + post-publish hook | **Pass** |
| Consume V2-08 + V2-06 | Post-compile on `compile-teaching-unit`; `classifyClaimSupport` + `assembleTeachingEvidencePack` | **Pass** |
| Flag off → leave `needs_check` | `isTeachingValidationEnabled`; worker C10 flag-off never calls verify | **Pass** |
| Ready only when verified | `nextGenerateStatus: "ready"` only if verified ∧ mayPublishVerified | **Pass** |
| Tests not loosened | C1–C11 assert structure≠fact, citation≠support, conflict, spoof, timeout unknown, stream fence, privacy, wire, presentation | **Pass** |

### Spot-check notes (not REJECT)

1. Index wire omits `loadBlocks` → empty claims → fact refuse (never false verified). Implement soft gap #1 honest.  
2. Repair `skipProvider` → `ready` path unchanged (Plan ACCEPT soft gap #2). Validation path does not widen that hole.  
3. Tutor-turn helpers exported + unit-tested; product `tutor-turn.ts` not edited (soft attach).  
4. Worker C10 mocks `verifyAfterPublish` return for wire — layer honesty covered in domain/ai unit tests (not a hide).

## Integrator re-runs (independent)

Re-run at ~11:58–11:59 CST on dirty tip `f5dae08`.

### Unit — teaching-validation

```text
$ pnpm exec vitest run packages/domain/src/opening/teaching-validation.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
# exit 0
```

### Unit — teaching-verifiers

```text
$ pnpm exec vitest run packages/ai/src/opening/teaching-verifiers.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)
# exit 0
```

### Regressions

```text
$ pnpm exec vitest run \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/domain/src/opening/teaching-plan.test.ts \
  packages/ai/src/opening/teaching-compiler.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts
 Test Files  5 passed (5)
      Tests  50 passed (50)
# exit 0 (includes C10 validation flag-off / flag-on verified→ready / unknown leaves needs_check)
```

### Typecheck

```text
$ ./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit   # exit 0
$ ./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit       # exit 0
$ ./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit       # exit 0
```

**Summary:** teaching-validation **10**; teaching-verifiers **11**; regressions **50**; tsc domain/ai/worker **OK**. Matches implement claim.

## Checks table

| Check | Status | Notes |
|---|---|---|
| Tip = `f5dae08…` dirty, no commit | **run** | Confirmed |
| Stronger review vs Plan / Plan ACCEPT / PM | **run** | Pass (tables above) |
| Vitest teaching-validation | **run** | 10 passed |
| Vitest teaching-verifiers | **run** | 11 passed |
| Regressions (evidence/coverage/plan/compiler/worker) | **run** | 50 passed |
| tsc domain / ai / worker | **run** | all OK |
| No DDL / no new job kind / no apps/web | **run** | migr 0055; web empty |
| Flag off leaves needs_check | **run** | worker C10 |
| Structure≠fact; spoof; vacuous claims; timeout unknown | **run** | unit C1–C7 |
| Real formula tool / model smoke | **`not_run`** | mocked only |
| Browser / E2E | **`not_run`** | |
| tutor-turn product attach | **`not_run`** | helpers only |
| Experience UI presentation chrome | **`not_run`** | V2-10 OOS |
| migrate apply | **`not_run`** | none planned |
| hermes / push / commit | **`not_run`** | forbidden |
| tasks.json → verified by Integrator here | **deferred** | ACCEPT granted; status edit is PM/process — Integrator did not edit tasks.json this handoff |

## Soft gaps (honest; do not overturn ACCEPT)

1. **Index wire without library teach blocks:** `createTeachingValidationAfterPublish` without `loadBlocks` → empty claims → refuse vacuous fact pass (structure_ok/needs_check, never false verified).  
2. **Repair `skipProviderForRepair` → ready:** unchanged this slice.  
3. **Tutor-turn product hook:** domain/ai helpers ready; `tutor-turn.ts` not wired.  
4. **Real tools/model smoke:** unit-mocked — `not_run`.  
5. **Experience UI:** OOS V2-10; must call `presentationFor` / respect status — no client-only「已核验」.

## Scope confirmation

- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** “fix” product code.  
- Integrator wrote **only** this accept evidence file.  
- Implementer (AIstudy AI) ≠ Accepter (this Integrator).

## Handoff

1. **Implement ACCEPT granted** for V2-09 teaching validation / publish control.  
2. Flag default off → production compile behavior unchanged (`needs_check`).  
3. Soft gaps #1–#5 remain for follow-up (library body load, repair ready path, tutor-turn wire, real tool smoke, Experience chrome).  
4. No push / hermes from this ACCEPT.

## Verdict (summary)

**ACCEPT** — tip `f5dae08` dirty; stronger review pass; vitest 10+11+50 / tsc OK; soft gaps honest; no push / hermes / commit.
