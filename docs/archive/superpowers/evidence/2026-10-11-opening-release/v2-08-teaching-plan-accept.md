# V2-08 Teaching plan/compiler — Implement ACCEPT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Reviewer:** AIstudy Integrator (executor / Grok Bot) — **≠** implementer (AIstudy AI)  
**Stage:** Implement ACCEPT only (no product fix edits; no self-ACCEPT for AI; no `tasks.json` → verified by implementer)  
**Branch:** `feat/opening-release`  
**Tip SHA verified:** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`)  
**Dirty tree:** Yes — product modules + thin worker wire + docs on tip (no commit, as claimed)  
**Gates:** `docs/superpowers/plans/opening-release/review-test-gates.md`  
**Authority:**
- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-plan.md`
- Implement claim: `docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-implement.md`

## Verdict

**ACCEPT**

Independent stronger review + re-run of claimed vitest/tsc suites match Plan ACCEPT / PM frozen defaults. Soft gaps honestly listed (`not_run` / deferred). No blockers found that require REJECT or product “fix” edits.

## Tip / dirty status

```text
$ git rev-parse HEAD
ae974983ce791894c2aa6d9459b06198d3152191

$ git branch --show-current
feat/opening-release

$ git log -1 --oneline
ae97498 docs(opening): V2-07 teaching generation jobs ACCEPT evidence

$ date '+%Y-%m-%d %H:%M:%S %Z'
2026-10-11 11:45:39 CST

$ git status --short (product + evidence relevant)
 M apps/worker/src/index.ts
 M apps/worker/src/jobs/compile-teaching-unit.test.ts
 M apps/worker/src/jobs/compile-teaching-unit.ts
 M packages/ai/src/index.ts
 M packages/domain/src/index.ts
?? packages/ai/src/opening/teaching-compiler.test.ts
?? packages/ai/src/opening/teaching-compiler.ts
?? packages/domain/src/opening/teaching-plan.test.ts
?? packages/domain/src/opening/teaching-plan.ts
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-implement.md
?? docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-accept.md
(+ plan/understand + unrelated untracked evidence; this accept file after write)

$ ls packages/database/src/migrations/*.sql | tail -3
…/0053_opening_teaching_activities.sql
…/0054_opening_teaching_content.sql
…/0055_opening_compile_teaching_unit_job.sql
# no 0056*
```

**Result:** tip OK. Product landed dirty on `ae97498` (no commit). Migrations still end at **0055**. Job kind remains `compile-teaching-unit` only.

## Stronger-review table (diff vs Plan ACCEPT)

| Claim / PM default | Evidence in code | Result |
|---|---|---|
| `packages/domain/src/opening/teaching-plan.ts` (+test) | New module: allowlist, `assertTeachingPathNotPlanDay`, `suggestPrerequisites` (always `skippable: true` + reason), `decideHistoryFreeze`, `assertOutlineHonest` (reuses `assertNoMasteryPercentage`); 8 tests C3–C5/allowlist | **Pass** |
| `packages/ai/src/opening/teaching-compiler.ts` (+test) | `proposeTeachingOutline` (existingOutline → normalize only), `compileCurrentActivity` (focus only, prefetch ≤1), `buildCompileProviderInput` (UNTRUSTED via `formatProviderContext`), `createCompilerBuildPublishInput`, `projectClientSafeLibraryBlocks`, `isTeachingCompilerEnabled`; 9 tests C1/C2/C6–C10 + answer_key | **Pass** |
| V2-07 `buildPublishInput` thin wire | `compile-teaching-unit.ts` re-exports `createTeachingCompilerPublishInput` / `isTeachingCompilerEnabled`; handler uses `deps.buildPublishInput` when present else `defaultStubPublish`; `index.ts` wires only when flag on | **Pass** |
| `OPENING_TEACHING_COMPILER_ENABLED` off → stub | `isTeachingCompilerEnabled` checks env; flag off → `buildPublishInput` undefined → `defaultStubPublish` (`extras.stub`, empty `blockOrder`); C10b asserts stub path | **Pass** |
| No new migration / no new job kind | No `0056*`; handler map still `"compile-teaching-unit"`; migr tip `0055` | **Pass** |
| path ≠ planDay | `assertTeachingPathNotPlanDay` rejects `plan_day`/`day_plan`/`calendar` kinds and DayPlanResult `{blocks,unscheduledTaskIds}` calendar shape; C3 test | **Pass** |
| prerequisites explainable + skippable | `TeachingPrerequisiteSuggestion.skippable: true` invariant; `assertOutlineHonest` rejects non-skippable / empty reason; C4 tests | **Pass** |
| freeze learned history | `decideHistoryFreeze` → `revise_subsequent_only` / `reject_rewrite_history` / `compile_current`; C5 tests. Compiler compiles focus only (does not rewrite other bodies). Domain helper not auto-invoked in worker index (caller/Experience responsibility) — soft note, not blocker | **Pass** (+ soft) |
| Soft gap: library body write | `writeLibraryBlocks` optional on factory; **index wire does not** pass it / call `library.updateDocument` — publish graph + `blockOrder` land; body revision follow-up. Matches Plan ACCEPT soft gap #1 | **Pass** (honest) |
| Soft gap: Experience HTTP / outline UI | No HTTP/UI added; T-E OOS | **Pass** (honest) |
| Soft gap: C11 real model | Fixture/deterministic propose+compile only; no provider auth smoke | **Pass** (`not_run`) |
| matrix-viz | Alias map → `text`; allowlist excludes `matrix-viz`; C8 | **Pass** (plan-allowed) |
| Post-model `needs_check` | Compiler sets `verificationStatus: "needs_check"`; worker C10 expects `generateStatus: "needs_check"`; handler status path unchanged | **Pass** |
| Budget/cancel/epoch fences kept | C10 still asserts reserve purpose/`operationId`; no fence bypass in wire | **Pass** |
| Exports | domain + ai `index.ts` export teaching-plan / teaching-compiler APIs | **Pass** |

### Tests that pass without behavior? (loosened asserts)

| Area | Integrator check | Result |
|---|---|---|
| C1 edited outline | Asserts edited title + notes survive propose+compile into goals | **Real** |
| C2 current-only / prefetch | Non-empty `blockOrder`; prefetch next itemId; `prefetchNext:false` → null | **Real** (id-string check is weak alone but paired with focus compile + prefetch asserts) |
| C3 path≠planDay | Throws on DayPlanResult shape + calendar kinds | **Real** |
| C4 prereqs | `skippable===true`, reason length, rejects non-skippable + mastery key | **Real** |
| C5 freeze | Exact `revise_subsequent_only` / `reject_rewrite_history` / `compile_current` | **Real** |
| C10 worker | `blockOrder.length > 0`, `extras.stub` undefined, `needs_check`, budget fence | **Real** |
| C10b stub fallback | Empty `blockOrder` + `extras.stub===true` when no `buildPublishInput` | **Real** |
| answer_key | Library has answer; client projection `null`; publish JSON has no `"answer":` | **Real** |

No REJECT-class loosened suite found.

## Re-run commands + results (Integrator, independent)

### Focused unit

```text
$ pnpm exec vitest run packages/domain/src/opening/teaching-plan.test.ts
# exit 0 — Test Files 1 passed; Tests 8 passed (8)
# Start at 11:45:18 CST; Duration ~729ms

$ pnpm exec vitest run packages/ai/src/opening/teaching-compiler.test.ts
# exit 0 — Test Files 1 passed; Tests 9 passed (9)
# Start at 11:45:18 CST; Duration ~1.06s
```

### Regressions + worker

```text
$ pnpm exec vitest run \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/domain/src/opening/tutor-policy.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts
# exit 0 — Test Files 5 passed; Tests 62 passed (62)
# Start at 11:45:22 CST; Duration ~4.15s
```

**Combined claimed suites:** 8 + 9 + 62 = **79 passed** (matches implementer claim).

### Typecheck

```text
$ ./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit
# domain_tsc_exit=0

$ ./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit
# ai_tsc_exit=0

$ ./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
# worker_tsc_exit=0
```

Covered plan cases in unit suite: **C1–C10**. **C11** remains `not_run`.

## not_run

| Check | Status | Reason |
|---|---|---|
| Real model compile smoke (C11) | **`not_run`** | No provider auth; acceptance criterion deferred — soft gap, does not overturn ACCEPT per Plan (fixture path covers C1–C10) |
| Browser / E2E | **`not_run`** | Experience UI OOS |
| migrate apply | **`not_run`** | No DDL added; forbidden to apply |
| hermes | **`not_run`** | Forbidden |
| push | **`not_run`** | Forbidden |
| commit | **`not_run`** | Forbidden (dirty tree OK per handoff) |
| HTTP Experience outline APIs | **`not_run`** | Deferred |
| `library.updateDocument` in index wire | **`not_run`** | Soft gap — `writeLibraryBlocks` hook-ready, production body write follow-up |

## Soft gaps (honest; do not overturn ACCEPT)

1. **Library body write:** `writeLibraryBlocks` on `createCompilerBuildPublishInput`; index does **not** yet call `library.updateDocument` — publish graph + non-empty `blockOrder` land without durable library body revision.
2. **C11 real model smoke:** fixture/deterministic only — `not_run`.
3. **Experience HTTP / outline UI:** deferred (T-E OOS).
4. **`decideHistoryFreeze`:** domain helper + tests landed; worker index does not auto-gate compile on freeze decision (caller/Experience responsibility; compile-current-only still avoids rewriting other activity bodies).
5. **matrix-viz:** mapped → `text` (plan-allowed).
6. **V2-07 carry-forward:** T8 publish-CAS dedicated unit; cancel does not release reserved ledger; Experience enqueue/poll absent — unchanged.

## Scope confirmation

- Integrator did **not** edit product code to “fix”.  
- Integrator did **not** commit / push / stash / reset / hermes / apply migrate.  
- Integrator did **not** mark `tasks.json` verified on behalf of AI self-ACCEPT.  
- Integrator ≠ implementer; re-ran claimed suites independently.

## Handoff

1. **Implement ACCEPT** recorded for V2-08 teaching plan/compiler on tip `ae97498` dirty tree.  
2. Follow-ups (non-blocking): wire `library.updateDocument` via `writeLibraryBlocks`; optional C11 when auth available; Experience outline HTTP later.  
3. Confirm **no push / hermes / commit** by Integrator this turn.

## One-line soft gaps

Library `updateDocument` unwired (hook ready); C11 model / Experience HTTP / matrix-viz map deferred; freeze helper domain-only; V2-07 T8/cancel-budget carry-forward.
