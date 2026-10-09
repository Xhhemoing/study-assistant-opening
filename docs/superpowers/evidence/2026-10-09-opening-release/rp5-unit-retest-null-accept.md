# RP5 accept — Unit fix: TaskItem `retest: null` expectations

**Date:** 2026-10-09 ~22:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `e774ae5030a92cffdb08403efbc6f3a438e60557` (+ this unit fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy Data claim; Data ACCEPT re-run)  
**Verdict:** **ACCEPT yes** — local unit + database tsc green for this slice; **RP5 status stays `active`** (**not verified**). **Do not push yet** — waiting on AI `ai-settings` 409 fix.

## Claim (AIstudy Data)

Only tests updated to expect `retest: null` on TaskItem (contract intentional). No mapper change.

Files:
- `packages/database/src/repositories/opening-plans.test.ts`
- `packages/database/src/repositories/opening-retest-task.test.ts`

## Diff verified (RP5 unit-fix scope)

| File | Change |
|---|---|
| `opening-plans.test.ts` | Expectation adds `retest: null` on listTasks TaskItem |
| `opening-retest-task.test.ts` | Expectation adds `retest: null` on prepareRetestTask result |

`git diff --stat` on those two paths: **2 files changed, 2 insertions(+), 2 deletions(-)** — only the expectation lines.

No mapper / repository implementation change in this slice.

### Extra working-tree dirty (out of scope — documented, not part of this ACCEPT)

Unrelated to this RP5 unit fix (left untouched by this accept):
- `docs/superpowers/evidence/2026-10-09-opening-release/q03-live-minio-object-restore.md` (Q03 ACCEPT note append)
- `docs/superpowers/evidence/2026-10-09-opening-release/q03-packaging-gaps.md` (Q03 ACCEPT note append)
- Untracked: `services/parser/opening_parser.egg-info/`

## Data / Integrator re-run (local)

| Command | Result |
|---|---|
| `pnpm exec vitest run --project unit packages/database/src/repositories/opening-plans.test.ts packages/database/src/repositories/opening-retest-task.test.ts` | **2 files / 7 PASS** (exit 0) |
| `pnpm exec tsc -p packages/database --noEmit` | **exit 0** |

## Hold before push

GHA unit failures after evidence push (`rp5-gha-after-evidence-push.md`) included:
1. These two `retest: null` expectation mismatches — **this ACCEPT covers that slice**
2. `apps/web/src/app/api/opening/ai-settings/route.test.ts` — expected **409**, received **200** — **still open; waiting on AI before push**

**No commit / no push** on this ACCEPT.

## Ledger

- Append this file to RP5 `evidence` in `tasks.json`
- RP5 **status remains `active`** until remote `quality` / full unit suite green (including ai-settings 409) on a pushed SHA
- **Do not** mark `verified` on ACCEPT alone
