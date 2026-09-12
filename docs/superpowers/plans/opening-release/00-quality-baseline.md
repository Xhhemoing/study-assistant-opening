# B01 Baseline Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove four confirmed baseline lint errors without changing behavior and record remaining environment gates.

**Architecture:** Surgical removal of unused bindings only. Keep the public ImportedLink re-export and the seedItem-local pointId intact.

**Tech Stack:** Existing ESLint, TypeScript, Vitest.

## Global Constraints

- Depends on B00. Do not change the original working tree or refactor unrelated legacy files.
- `npm run verify:ci` passed. `npm run lint` failed with four `@typescript-eslint/no-unused-vars` diagnostics; the chained typecheck did not run.

## B01: Four unused bindings

**Owner:** INTEGRATOR.
**Modify:** `apps/web/src/app/api/reviews/route.ts` (remove createCardForPrincipal import); `apps/web/src/features/notebook-preview/notebook-preview-overlays.tsx` (remove ChevronDown import); `apps/web/src/features/notion-import-preview/notion-import-parser.ts` (remove ImportedLink from import type only); `tests/integration/practice-content-repository.test.ts` (remove outer pointId declaration/destructuring).
**Interfaces:** No runtime/public type signature changes.

- [x] Reproduce `npm run lint` and locate each reference with rg.
- [x] Apply the four removals. For the test, retain `seedItem`'s local pointId and change only the outer assignment to `({ packageId, itemId } = await seedItem(sql, workspaceId));`.
- [x] Run `npm run lint` and require zero diagnostics.
- [x] Run `npm run typecheck`; stop and record any new failure before fixes.
- [x] Run focused unit regression: `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/notion-import-preview/notion-import-parser.test.ts apps/web/src/features/review/review-service.test.ts`.
- [x] Inspect `git diff --check`. Database test execution remains gated on a separately guarded local test DB; do not point destructive tests at a real database.

**Recorded commit:** `79dd89b`. Focused files are included in the final 515-test unit/contract run; Windows typecheck passed with explicit Git Bash script-shell after recording the default-shell failure.

**Commit boundary:** `fix: clear isolated baseline lint errors`; only listed changes after narrow checks pass. This does not certify build, database integration or the new learning product.
