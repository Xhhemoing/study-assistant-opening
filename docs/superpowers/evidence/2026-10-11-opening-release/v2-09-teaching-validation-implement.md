# V2-09 Teaching validation / publish control — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty tree, no commit):** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`)  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No new DDL / job kind · No `apps/web` · Exclusive tree (unrelated untracked evidence / V2-10 plan docs not touched)

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-09-teaching-validation-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-09-teaching-validation-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM frozen: structure≠fact; missing evidence/conflict → not verified; no fake authority; tool timeout→`unknown`; reuse existing status enums; no DDL / new job kind

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/domain/src/opening/teaching-validation.ts` | LayerOutcome / LayerResult / PresentationPolicy / ValidationReport; `structurePassed` / `factPassed` / `mayPublishVerified` / `presentationFor` / `buildValidationReport`; `assertNotAuthoritySpoof`; `denyIncompleteStreamActions`; `recheckPrivacyFreshness` |
| `packages/domain/src/opening/teaching-validation.test.ts` | C1, C4, C6/C3, C8, C9, C11 + vacuous claim / action_permission independence |
| `packages/ai/src/opening/teaching-verifiers.ts` | `verifyTeachingContent` (L1–L5); `verifyTutorTurnOutput`; `scanInjectionRisks`; `detectAuthoritySpoof`; `isTeachingValidationEnabled`; `createTeachingValidationAfterPublish` |
| `packages/ai/src/opening/teaching-verifiers.test.ts` | C1–C8, C7 peer-upvote reject, happy path verified, flag, vacuous claims |

### Updated (thin wire + exports)

| Path | Change |
|---|---|
| `packages/domain/src/index.ts` | Export teaching-validation API |
| `packages/ai/src/index.ts` | Export teaching-verifiers API + after-publish factory |
| `apps/worker/src/jobs/compile-teaching-unit.ts` | Optional `verifyAfterPublish` dep; post-`needs_check` hook behind `OPENING_TEACHING_VALIDATION_ENABLED`; CAS metadata republish; cancel/epoch fences kept; re-export flag + factory |
| `apps/worker/src/jobs/compile-teaching-unit.test.ts` | C10 flag-off / flag-on verified→ready / unknown leaves needs_check |
| `apps/worker/src/index.ts` | When validation flag on → wire `verifyAfterPublish` via `createTeachingValidationAfterPublish` + `chunks.listForSources` |

### Explicitly not touched

- No migrations / ALTER / `0056*` (tip migr still **0055**)
- No new job kind
- No `apps/web` (Experience V2-10)
- Unrelated untracked: `rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`, V2-10 plan docs (left as-is)
- No tutor-turn product edits (prefer compile wire; domain helpers exported for later attach)
- No `tasks.json` → verified; no push / commit / hermes / stash / reset
- No self-ACCEPT

## Behavior landed

| Item | Detail |
|---|---|
| Structure ≠ fact | `structurePassed` = schema + source_identity pass; `factPassed` = claim_support pass + tool pass/skipped; unknown blocks fact |
| Publish gate | `mayPublishVerified` requires structure∧fact, no required unknown, no unresolved conflict |
| Status mapping | structure-only → `structure_ok`; fact pass → `verified`; tool/claim unknown → `needs_check`; schema/source fail → `rejected` |
| Presentation | verified → authoritative; structure_ok/needs_check/unchecked → discussion_draft (`allowsFormalScoring=false`); rejected/stale → blocked |
| Authority spoof | model self-claim / peer-model upvote / second LLM “looks good” → fail; does **not** grant verified |
| Injection | prompt / javascript: / latex `\write18` `\input` etc. → schema fail |
| Tool timeout | `LayerOutcome: "unknown"` (return `{unknown:true}` or throw timeout) — never coerced to pass/fail |
| Claim support | Reuses `classifyClaimSupport` / pack — citation id alone ≠ support (AN-RN-06); empty claims refuse vacuous fact pass |
| Coverage conflict | Pack coverage `conflict` rows → claim_support fail → refuse verified |
| Worker flag | `OPENING_TEACHING_VALIDATION_ENABLED` / `TEACHING_VALIDATION_ENABLED` off → leave `needs_check`; on → run verify + CAS status promote |
| Ready only when verified | Promotion sets `generate_status=ready` **only** when report is verified + `mayPublishVerified` |
| Fences | cancel re-check + epoch assert before validate and before promote; budget `operationId` unchanged |

## Soft gaps (honest; do not claim resolved)

1. **Library body / keyClaims at index wire:** Index `verifyAfterPublish` loads chunks but not library teach blocks yet (Plan ACCEPT soft gap #1/#4). Without teach/example bodies, fact layer refuses vacuous pass → typically `structure_ok` / `needs_check`, **never** false `verified`. Tests inject full claims/blocks for C1–C7 / happy path.
2. **Repair `skipProviderForRepair` → ready:** Unchanged this slice (soft gap #2). Authoritative ready-via-validation only applies on the generate + validation flag path.
3. **Tutor-turn product wire:** Domain `denyIncompleteStreamActions` / `recheckPrivacyFreshness` + ai `verifyTutorTurnOutput` exported and unit-tested; **not** edited into `tutor-turn.ts` (avoid Experience merge conflict). Soft attach remains for a later thin PR.
4. **Real formula tool / model smoke:** unit-mocked only — **`not_run`**.
5. **Experience presentation chrome:** OOS (V2-10); domain `presentationFor` ready for client.

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
f5dae08c4b6d28c0a1a74118d916a9a36fb544e6
```

### Unit (focused)

```text
pnpm exec vitest run packages/domain/src/opening/teaching-validation.test.ts
# exit 0 — 1 file, 10 tests passed

pnpm exec vitest run packages/ai/src/opening/teaching-verifiers.test.ts
# exit 0 — 1 file, 11 tests passed

pnpm exec vitest run \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/domain/src/opening/teaching-plan.test.ts \
  packages/ai/src/opening/teaching-compiler.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts
# exit 0 — 5 files, 50 tests passed (includes +3 C10 validation wire cases)
```

**Combined focused re-check:** teaching-validation 10 + teaching-verifiers 11 + compile-teaching-unit (in combined) → **34** in final 3-file run; regressions **50** across 5 files. All green (CST ~11:56–11:57).

Covered plan cases in unit tests: **C1–C11** (unit-testable). Real tool/model smoke = `not_run`.

### Typecheck

```text
./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit   # OK
./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit       # OK
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit       # OK
```

### Migrations

```text
$ ls packages/database/src/migrations/005*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*
```

## Checks table (honesty)

| Check | Status | Notes |
|---|---|---|
| Tip = `f5dae08…` | **run** | Unchanged; no stash/reset |
| Domain + ai modules + exports | **run** | Present + indexed |
| Vitest teaching-validation | **run** | 10 passed |
| Vitest teaching-verifiers | **run** | 11 passed |
| Regressions (evidence/coverage/plan/compiler/worker) | **run** | 50 passed |
| tsc domain / ai / worker | **run** | all OK |
| Flag off leaves needs_check | **run** | worker C10 |
| Flag on verified → ready + CAS | **run** | worker C10 |
| No DDL / no new job kind | **run** | migr tip 0055 |
| Real formula tool smoke | **`not_run`** | mocked only |
| Real model smoke | **`not_run`** | |
| Browser / E2E | **`not_run`** | |
| migrate apply | **`not_run`** | none planned |
| tutor-turn product attach | **`not_run`** | helpers only |
| Experience UI | **`not_run`** | V2-10 OOS |
| hermes / push / commit | **`not_run`** | forbidden |
| self-ACCEPT / tasks.json verified | **`not_run`** | forbidden |

## Handoff

1. Implement complete for Integrator **Implement ACCEPT** (independent; AI does **not** self-ACCEPT).
2. Flag default off → production behavior unchanged (`needs_check` after compile).
3. Experience V2-10 should call `presentationFor` / respect `verificationStatus` — no client-only “已核验”.
4. Optional follow-up: load library teach blocks into `verifyAfterPublish`; thin tutor-turn continue hooks.

## Verdict (implementer)

**DONE** — modules + tests + exports + flag-gated thin compile wire; fences intact; no DDL; evidence complete; awaiting independent Implement ACCEPT.
