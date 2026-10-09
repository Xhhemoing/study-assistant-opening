# RP5 accept — Pipeline lint fix (unused symbols)

**Date:** 2026-10-09 ~21:43 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `030662f` (+ this lint fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Integrator)  
**Verdict:** **ACCEPT yes** — local lint/test green; **status stays active** until GHA `quality` green (**not verified** yet).

## Triggering GHA failure

- Run: https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37937794431  
- Failed job: https://github.com/Xhhemoing/study-assistant-opening/actions/runs/37937794431/job/113844592815  
- SHA: `030662f71d7d0df85376e165efcaa31c33293e6d`  
- Annotations:
  - `apps/worker/src/jobs/parse-media.test.ts` — `'frameDirPlaceholder' is assigned a value but never used`
  - `apps/worker/src/index.ts` — `'createRetestCloseHandler' is defined but never used`

## Diff verified (only these 2 files, each remove 1 unused line)

1. `apps/worker/src/jobs/parse-media.test.ts` — remove unused `const frameDirPlaceholder = "will-be-set-by-extract";`
2. `apps/worker/src/index.ts` — remove unused `import { createRetestCloseHandler } from "./jobs/retest-close";`  
   - Kept bottom re-export: `export { createRetestCloseHandler } from "./jobs/retest-close";` (line 156 after fix)

No other paths in the lint-fix diff.

## Integrator re-run (local)

| Command | Result |
|---|---|
| `npx eslint apps/worker/src/index.ts apps/worker/src/jobs/parse-media.test.ts` | **exit 0** |
| `npx vitest run apps/worker/src/jobs/parse-media.test.ts` | **7 passed** (1 file), exit 0 |

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / `lint-typecheck-test-build` succeeds on the pushed SHA
- **Do not** mark `verified` on ACCEPT alone
