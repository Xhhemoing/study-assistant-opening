# V2-08 Teaching plan/compiler — Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Tip HEAD (baseline; dirty tree, no commit):** `ae974983ce791894c2aa6d9459b06198d3152191` (`ae97498`)  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · No new DDL / job kind · No Experience UI · Exclusive tree (unrelated untracked evidence not touched)

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-08-teaching-plan-plan-accept.md`
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-08-teaching-plan-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM frozen: no DDL; domain outline + ai compiler via V2-07 `buildPublishInput`; path ≠ planDay; skippable explainable prereqs; freeze learned history; `generate_status=needs_check`

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/domain/src/opening/teaching-plan.ts` | Outline/prereq/freeze types; allowlist; `assertTeachingPathNotPlanDay`; `assertOutlineHonest` (reuses `assertNoMasteryPercentage`) |
| `packages/domain/src/opening/teaching-plan.test.ts` | C3, C4, C5, allowlist clamp + related |
| `packages/ai/src/opening/teaching-compiler.ts` | `proposeTeachingOutline`, `compileCurrentActivity`, `buildCompileProviderInput`, `createCompilerBuildPublishInput`, `isTeachingCompilerEnabled`, client-safe answer_key projection |
| `packages/ai/src/opening/teaching-compiler.test.ts` | C1, C2, C6–C9 + answer_key leakage + C10 helper; fixture `activity-outline.json` |

### Updated (thin wire + exports)

| Path | Change |
|---|---|
| `packages/domain/src/index.ts` | Export teaching-plan API |
| `packages/ai/src/index.ts` | Export teaching-compiler API |
| `apps/worker/src/jobs/compile-teaching-unit.ts` | Re-export `createTeachingCompilerPublishInput` / `isTeachingCompilerEnabled`; compile-oriented provider instruction when `buildPublishInput` present; **defaultStubPublish unchanged** as fallback |
| `apps/worker/src/jobs/compile-teaching-unit.test.ts` | C10 compiler publish + C10b stub fallback |
| `apps/worker/src/index.ts` | When `OPENING_TEACHING_COMPILER_ENABLED` (or `TEACHING_COMPILER_ENABLED`) is truthy → wire `buildPublishInput` via compiler + `chunks.listForSources`; else stub path |

### Explicitly not touched

- No migrations / ALTER / `0056*` (tip migr still **0055**)
- No new job kind
- Unrelated untracked: `rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`, plan-stage evidence files (left as-is)
- No Experience UI / HTTP / V2-09 verification
- No `tasks.json` → verified; no push / commit / hermes / stash / reset
- No self-ACCEPT

## Behavior landed

| Item | Detail |
|---|---|
| Outline | Editable `TeachingOutline` (`kind: "teaching_path"`); existing outline → validate/normalize only |
| Allowlist | `text\|formula\|prompt\|example\|steps\|answer_key\|meta`; `matrix-viz` → `text` |
| Path ≠ planDay | `assertTeachingPathNotPlanDay` rejects DayPlanResult / calendar kinds |
| Prereqs | Always `skippable: true` + human `reason` |
| History freeze | `decideHistoryFreeze` → `revise_subsequent_only` / `reject_rewrite_history` / `compile_current` |
| Compile current | Focus item only; prefetch ≤1 skeleton when enabled |
| Evidence | Calls `assembleTeachingEvidencePack` / `formatProviderContext` — no forked chunk loader |
| answer_key | Library may hold plaintext; `projectClientSafeLibraryBlocks` nulls content while hidden; publish graph has refs only |
| Worker flag | Off → `defaultStubPublish` (`extras.stub`, empty `blockOrder`); On → non-empty `blockOrder`, no `extras.stub` |
| Post-model status | Still `needs_check` (handler unchanged) |
| Fences | `runBudgetedCall` / `operationId=compile-teaching-unit:{job.id}` / cancel / epoch kept |

## Soft gaps (honest; do not claim resolved)

1. **Library body write:** `writeLibraryBlocks` hook exists on factory; index wire does **not** yet call `library.updateDocument` (Plan ACCEPT soft gap #1). Publish graph + blockOrder land; body revision write remains follow-up.
2. **Real model smoke (C11):** fixture/deterministic propose+compile only — **`not_run`**.
3. **Experience HTTP / outline UI:** deferred (T-E OOS).

## Commands run + results

### Tip

```text
$ git rev-parse HEAD
ae974983ce791894c2aa6d9459b06198d3152191
```

### Unit (focused)

```text
pnpm exec vitest run packages/domain/src/opening/teaching-plan.test.ts
# exit 0 — 1 file, 8 tests passed

pnpm exec vitest run packages/ai/src/opening/teaching-compiler.test.ts
# exit 0 — 1 file, 9 tests passed

pnpm exec vitest run \
  packages/ai/src/opening/teaching-evidence.test.ts \
  packages/domain/src/opening/teaching-coverage.test.ts \
  packages/domain/src/opening/tutor-policy.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  apps/worker/src/jobs/compile-teaching-unit.test.ts
# exit 0 — 5 files, 62 tests passed
```

**Combined focused:** teaching-plan 8 + teaching-compiler 9 + regressions/worker 62 = **79 tests passed** (CST ~11:43).

Covered plan cases: **C1–C10** (unit-testable without real model). **C11** = `not_run`.

### Typecheck

```text
./node_modules/.bin/tsc -p packages/domain/tsconfig.json --noEmit   # exit 0
./node_modules/.bin/tsc -p packages/ai/tsconfig.json --noEmit       # exit 0
./node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit       # exit 0
```

## not_run

| Check | Status | Reason |
|---|---|---|
| Real model compile smoke (C11) | **`not_run`** | No provider auth / acceptance criterion at product Accept |
| Browser / E2E | **`not_run`** | Experience UI OOS |
| migrate apply | **`not_run`** | No DDL planned / none added |
| hermes | **`not_run`** | Forbidden |
| push | **`not_run`** | Forbidden |
| commit | **`not_run`** | Forbidden (implementer not asked) |
| HTTP Experience outline APIs | **`not_run`** | Deferred |
| library.updateDocument in index wire | **`not_run`** | Soft gap #1 — hook ready, production body write follow-up |

## Ready for Integrator Implement ACCEPT?

**Yes.** Product modules + tests + thin worker wire landed on tip `ae97498` dirty tree. Hand to Integrator for independent Implement ACCEPT. AIstudy AI does **not** self-ACCEPT.
