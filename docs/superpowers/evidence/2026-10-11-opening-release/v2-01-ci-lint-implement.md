# V2-01 implement — CI lint baseline (`react-hooks/exhaustive-deps` / material-library)

**Date:** 2026-10-11 ~10:22 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ baseline tip `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
**Workspace:** `/workspace/study-assistant-opening`  
**Role:** Integrator IMPLEMENT  
**Status:** implement complete — **uncommitted**; do **not** mark `tasks.json` verified; Accept is separate.

## Triggering CI failure

- GHA run: https://github.com/Xhhemoing/study-assistant-opening/actions/runs/38065241208  
- Job: `lint-typecheck-test-build` / step **Lint** failed; Typecheck and later steps **skipped**  
- Head SHA: `1a4cf465c86da7f08b6fda3044f9b0f932b80824`  
- Annotation (from job logs):

```
apps/web/src/features/opening/library/material-library.tsx
  47:5  error  Definition for rule 'react-hooks/exhaustive-deps' was not found  react-hooks/exhaustive-deps
✖ 1 problem (1 error, 0 warnings)
```

## Root cause

1. `material-library.tsx` used `// eslint-disable-next-line react-hooks/exhaustive-deps` on a `useEffect` that intentionally only listed `uploadCourseId` (avoid re-running on every new `library` object identity).
2. Root `eslint.config.mjs` never loads `eslint-plugin-react-hooks`; the plugin is **not** in `package.json` / `package-lock.json`.
3. ESLint treats an unknown rule in a disable directive as an **error**, so CI Lint failed before any later quality gates ran.

Suppress intent was valid (inbound `courseId` only), but the disable referenced a rule that was never defined. Adding the plugin + enabling recommended was considered and **not** taken for this S-sized task: it would expand lockfile/lint surface without being required to clear the observed failure. Prefer **minimal correct deps** instead of keeping an intentional disable against a missing plugin.

## Fix (product only)

| File | Change |
|---|---|
| `apps/web/src/features/opening/library/use-material-library.ts` | `changeSpace` wrapped in `useCallback(..., [])` so identity is stable. |
| `apps/web/src/features/opening/library/material-library.tsx` | Destructure as `changeSpace: setLibrarySpace`; effect deps `[uploadCourseId, setLibrarySpace]`; **remove** `eslint-disable-next-line react-hooks/exhaustive-deps`. Keep local UI wrapper `changeSpace` (resets page/filters) unchanged. |

No `eslint.config.mjs` change. No lockfile / dependency change. Did **not** run `npm audit fix --force`.

## Commands + results (local)

| Command | Result |
|---|---|
| `npx eslint apps/web/src/features/opening/library/material-library.tsx` (before) | **exit 1** — Definition for rule `react-hooks/exhaustive-deps` was not found |
| `npx eslint …/material-library.tsx …/use-material-library.ts` (after) | **exit 0** |
| `npm run lint` (`eslint .` via heavy wrapper) | **exit 0** (~37s wall after `npm ci`) |

Remote GHA re-run requires push/Accept; **not** done in this implement slice.

## Config / baseline notes (V2-01 scope, observational)

- **Lockfile:** `package-lock.json` left unchanged from tip `1a4cf46`. Local `npm ci` OK (475 packages). Box Node **v20.19.2**; CI workflow uses Node **22** (`engines`: `>=20`). `lib0` warns EBADENGINE wanting Node `>=22` on this box — not introduced by this fix.
- **Audit:** `npm audit` reports **54** issues (32 moderate / 20 high / 2 critical) including production-reachable paths (e.g. `source-map-js`, `uuid` via `bullmq`). Per task: **no** blind `audit fix --force`. Production reachability of each advisory not re-triaged here.
- **Model config:** `.env.example` documents `OPENING_MODEL_*` and optional `OPENING_MODEL_CATALOG` / `OPENING_MODEL_DEFAULT_ID`; loader in `packages/config/src/opening-model.ts`. No model/env change in this slice.
- **Test fixtures:** `tests/fixtures/opening/` present (incl. `teaching/`). No MinIO service failure observed in this local lint-only work; do not treat historical MinIO image notes as current lint failure cause.
- **ESLint plugin check:** `eslint-plugin-react-hooks` absent from lockfile and flat config; intentional for V2-01 (product dep fix). Optional follow-up: add plugin + recommended rules in a dedicated lint-hardening task after measuring blast radius.

## Remaining risks

- Local green lint ≠ remote GHA green until Accept commits/pushes and `quality` job completes on the new SHA (Typecheck/tests/build were skipped on the failing run and were **not** re-executed fully here beyond lint).
- Without `eslint-plugin-react-hooks`, future accidental incomplete hook deps will not be flagged by CI.
- `changeSpace` is empty-deps `useCallback`; if it later closes over non-ref state, deps must be updated.

## Out of scope / not done

- No commit / push / stash / reset  
- Did not mark V2-01 `verified` in `tasks.json`  
- Did not overwrite opening-release verified ledger statuses  
- Did not change `eslint.config.mjs` or add `eslint-plugin-react-hooks`
