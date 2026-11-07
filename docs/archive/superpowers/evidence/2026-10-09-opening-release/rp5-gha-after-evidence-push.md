# RP5 — GHA quality after missing-evidence push

**Date:** 2026-10-09 ~22:01 CST (Asia/Shanghai)  
**Owner:** INTEGRATOR  
**Status:** **observed failure** — RP5 stays **active**, **not verified**. No fabricate.

## Push under test

| Field | Value |
|---|---|
| Commit | `fa3cc2664d6fdd8b4f12b17faba04ce640bebe0b` |
| Message | `docs(opening): add missing RP5/Q03 evidence for plan checks` |
| Run | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37939844118 |
| Job | https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37939844118/job/113851120795 |
| Conclusion | **failure** |

## What passed (progress vs prior)

- Lint — success  
- Typecheck — success  
- **Plan and tooling checks — success** (prior missing-evidence errors cleared)  
- Setup / parser / install — success  

## What failed

- Step **Unit and contract tests** — exit 1  
- Summary: **3 failed** | 2456 passed | 12 skipped | 1 todo (371 files: 3 failed | 367 passed | 1 skipped)  
- Failed tests / annotations:
  1. `packages/database/src/repositories/opening-plans.test.ts:12` — expected task list without `retest`; received `{ retest: null, … }`
  2. `packages/database/src/repositories/opening-retest-task.test.ts:30` — same extra `retest: null` on task object
  3. `apps/web/src/app/api/opening/ai-settings/route.test.ts:70` — expected **409**, received **200**

Later spike/integration/handler/browser/build steps skipped.

## Notes

- Pipeline lint-fix symbols are cleared remotely; this failure is **not** the unused-import lint.  
- Unit failures look like contract/test drift (`retest` field + AI settings conflict handling), outside the lint-fix ACCEPT scope.  
- Do **not** mark RP5 `verified`.

## Verdict

RP5 remains **active** until a full `quality` / `lint-typecheck-test-build` success.
