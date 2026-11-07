# V2-15 Matrix transform — Data Implement Evidence

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Data implementer (executor / Grok Bot)  
**Branch:** `feat/opening-release`  
**Baseline tip (assignment / Plan ACCEPT):** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`)  
**Tip HEAD at Implement write (dirty; no commit):** `267f9d2e983524e3f2487bb0d9237dc827e7e43a` (`267f9d2`) — **exact match**; product changes uncommitted only  
**Status:** **implemented, awaiting Integrator Implement ACCEPT** — do **not** self-ACCEPT; `tasks.json` not marked verified  
**Hard rules held:** No push / hermes / stash / reset / commit · **No DDL** · No Experience UI (`matrix-transform.tsx` / catalog OOS) · Exclusive Data tree · No self-ACCEPT

## Authority followed

- Plan ACCEPT: `docs/superpowers/evidence/2026-10-11-opening-release/v2-15-matrix-transform-plan-accept.md` (verdict ACCEPT; DDL NO; Data-first)
- Plan: `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-plan.md`
- Understand: `docs/superpowers/plans/ai-led-learning-v2/v2-15-matrix-transform-understand.md`
- Gates: `docs/superpowers/plans/opening-release/review-test-gates.md`
- PM locks 1–10 (assignment): canonical `matrix_transform`; matrix-viz* → it (not text); M1 reals ≤4×4; autoplay default false; soft interactionParams; NEW contracts + domain files; allowlist+aliases+tests; fixtures; compiler emit OOS; no Experience UI

## Diff scope

### New

| Path | Role |
|---|---|
| `packages/contracts/src/opening/teaching-math-model.ts` (+ test) | Zod `matrixTransformParamsSchema` + caps + soft `matrixTransformInteractionParamsSchema` (new file only; not folded into teaching-content) |
| `packages/domain/src/opening/teaching-math-model.ts` (+ test) | Pure parse / caps / apply / step / text-alt / staticFallback |

### Updated

| Path | Change |
|---|---|
| `packages/contracts/src/opening/index.ts` | `export * from "./teaching-math-model"` |
| `packages/domain/src/index.ts` | Export math-model helpers + types |
| `packages/domain/src/opening/teaching-plan.ts` | Add `matrix_transform` to `ALLOWED_TEACHING_BLOCK_TYPES`; remap `matrix-viz` / `matrix_viz` / `matrixviz` → **`matrix_transform`** (breaking vs prior →`text`) |
| `packages/domain/src/opening/teaching-plan.test.ts` | Expect remap to `matrix_transform`; allowlist contains canonical id |

### Explicitly not touched

- **Experience** `component-catalog.ts` / `block-renderer.tsx` / `blocks/matrix-transform.tsx` (OOS; Data-first half only)
- Compiler / generation emit of first-unit real matrix content (AI follow-up; lock 7 / assignment 9)
- Any migration SQL / inventing `0058` (tip remains **0057**)
- push / commit / hermes / stash / reset / self-ACCEPT / `tasks.json` verified flip
- Unrelated untracked evidence left as-is

## Behavior landed

| Rule | Behavior |
|---|---|
| Same-semantics params | One `MatrixTransformParams`: `matrixA` + `vectorX` (+ optional `vectorY`) + labels / prose / expression |
| Caps | `MAX_DIM=4`, `MAX_ABS=1e6`, `DISPLAY_DECIMALS=6`; non-rectangular / non-finite / over-cap → parse fail |
| Apply | `applyMap` / `applyLinearMap` pure A·x; dim mismatch → `{ ok:false, error }` |
| Steps | Discrete `stepPlan` (`by_column` / `by_entry` / `all_at_once`); `stepApply` clamp + reset idempotent — **not** animator DSL |
| Text-alt / static | `buildTextAlternative` + `staticFallbackModel` from same params |
| autoplay | Schema default **false** |
| Soft UI state | `matrixTransformInteractionParamsSchema` + `parseMatrixTransformInteractionParams` (empty/partial OK) |
| Allowlist | Canonical `matrix_transform`; legacy matrix-viz* → `matrix_transform` on normalize; unknown still dropped |
| History | Old outlines already stored as `text` stay text until recompile — no invented MathModel backfill |
| DDL | **None** |

## Tests (Data slice: T1–T11 + T19 contracts/domain)

| ID | Status | Where / note |
|---|---|---|
| T1 | **pass** | domain — parse 2×2; reject non-rectangular |
| T2 | **pass** | domain — zero matrix → y=0 |
| T3 | **pass** | domain — identity → y=x |
| T4 | **pass** | domain — rank-1 A=(1,1;0,0) kernel + non-kernel |
| T5 | **pass** | domain — negatives/decimals + stable display rounding |
| T6 | **pass** | domain — dim mismatch → ok:false |
| T7 | **pass** | domain — 5×5 / abs>MAX_ABS reject |
| T8 | **pass** | domain — expression↔numeric consistency in text-alt + staticFallback |
| T9 | **pass** | domain — stepPlan ≥1; reset idempotent; modes |
| T10 | **pass** | contracts — zod round-trip; strict unknown keys; soft interaction sketch |
| T11 | **pass** | teaching-plan — normalize keeps `matrix_transform`; matrix-viz* → `matrix_transform` |
| T12–T18 | **not_run** | Experience half (catalog / UI / renderer / resume bag UI) — OOS this slice |
| T19 | **pass** (contracts + domain) | `tsc -p` both packages `--noEmit` green; apps/web Experience typecheck deferred |
| T20 | **pending_user** | Browser/device visual — Experience / Paula |

## Commands + results

```text
$ git rev-parse HEAD
267f9d2e983524e3f2487bb0d9237dc827e7e43a

$ npx vitest run --project unit \
  packages/contracts/src/opening/teaching-math-model.test.ts \
  packages/domain/src/opening/teaching-math-model.test.ts \
  packages/domain/src/opening/teaching-plan.test.ts
 Test Files  3 passed (3)
      Tests  26 passed (26)

$ npm run typecheck -w @aistudy/contracts
> tsc -p tsconfig.json --noEmit
(exit 0)

$ npm run typecheck -w @aistudy/domain
> tsc -p tsconfig.json --noEmit
(exit 0)

$ ls packages/database/src/migrations/0058* 2>/dev/null || echo 'no 0058 migr'
no 0058 migr

$ test ! -f apps/web/src/features/opening/teaching/blocks/matrix-transform.tsx && echo Experience_UI_untouched
Experience_UI_untouched

$ date '+%Y-%m-%d %H:%M %Z'
2026-10-11 13:46 CST
```

## Accept readiness (Integrator)

Ready for **Integrator Implement ACCEPT** of the **Data half** when independent re-run confirms:

1. Named vitest suites green (T1–T11) + contracts/domain tsc (T19 partial).
2. Allowlist remaps matrix-viz* → `matrix_transform` (not text); `ALLOWED_TEACHING_BLOCK_TYPES` contains `matrix_transform`.
3. Domain fixtures cover zero / identity / rank-1 / negatives·decimals / dim mismatch / caps / expression consistency.
4. Contracts file is **new** `teaching-math-model.ts` only (not folded into teaching-content).
5. **No DDL** / no `0058`; Experience UI / catalog still absent.
6. Compiler first-unit emit remains follow-up (not blocking).
7. Only Accept may flip `tasks.json` → verified; this Implement does **not** self-ACCEPT.

**Experience half** (catalog + `matrix-transform.tsx` + T12–T18 / T20) remains sequenced after Data ACCEPT + PM gate — exclusive tree, not this evidence.

## not_run (honest)

- T12–T18 Experience catalog/UI/renderer/interactionParams UI merge tests
- T19 apps/web typecheck (Experience tree unchanged)
- T20 user_browser `pending_user`
- Live compiler emit of matrix_transform block content (AI follow-up OOS)
- Integration / HTTP / DB (N/A — no DDL, no routes this slice)
