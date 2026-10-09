# RP5 accept — AI sticky catalog availability → ai-settings 409

**Date:** 2026-10-09 ~22:07 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ `e774ae5030a92cffdb08403efbc6f3a438e60557` (+ this AI fix + Data `retest: null` test fix, uncommitted at accept time)  
**Workspace:** `/workspace/study-assistant-opening`  
**Owner:** INTEGRATOR (AIstudy AI claim; Integrator ACCEPT re-run)  
**Verdict:** **ACCEPT yes** — local unit + `packages/ai` / `apps/web` tsc green for this slice; **RP5 status stays `active`** (**not verified**) until remote `quality` green on the pushed SHA.

## Claim (AIstudy AI)

`packages/ai/src/opening/catalog-merge.ts` keeps sticky `missing_key` / `pricing_missing` / `vault_disabled` across effective-cap recompute (only `budget_disabled` is recomputed from the workspace/env daily cap). That restores `PUT /api/opening/ai-settings` returning **409** for unavailable active models **without** calling set.

## Diff verified (RP5 AI unit-fix scope)

| File | Change |
|---|---|
| `packages/ai/src/opening/catalog-merge.ts` | Add `serverAvailabilityWithEffectiveCap`; sticky for `missing_key` / `pricing_missing` / `vault_disabled`; docs note |
| `packages/ai/src/opening/catalog-merge.test.ts` | New case: sticky `missing_key` and `pricing_missing` across effective-cap recompute |

`git diff --stat` on those two paths at accept: **2 files**, sticky helper + one test. No route rewrite — `apps/web/.../ai-settings/route.ts` already maps `OpeningModelRoutingError` → **409**; the merge bug was clearing `missing_key` when a workspace cap was present.

### Bundled Data ACCEPT (already documented)

See `rp5-unit-retest-null-accept.md` — test expectations add `retest: null` on TaskItem in:
- `packages/database/src/repositories/opening-plans.test.ts`
- `packages/database/src/repositories/opening-retest-task.test.ts`

### Extra working-tree dirty (out of scope — left unstaged)

- `docs/superpowers/evidence/2026-10-09-opening-release/q03-live-minio-object-restore.md`
- `docs/superpowers/evidence/2026-10-09-opening-release/q03-packaging-gaps.md`
- Untracked: `services/parser/opening_parser.egg-info/`

## Integrator re-run (local)

| Command | Result |
|---|---|
| `pnpm exec vitest run --project unit apps/web/src/app/api/opening/ai-settings/route.test.ts packages/ai/src/opening/catalog-merge.test.ts packages/ai/src/opening/model-routing.test.ts apps/web/src/features/settings/ai-settings-model.test.ts packages/database/src/repositories/opening-plans.test.ts packages/database/src/repositories/opening-retest-task.test.ts` | **6 files / 35 PASS** (exit 0) |
| `pnpm exec tsc -p packages/ai --noEmit` | **exit 0** |
| `pnpm exec tsc -p apps/web --noEmit` | **exit 0** |
| `pnpm exec tsc -p packages/database --noEmit` | **exit 0** (Data slice reconfirm) |

Key assertion reconfirmed: `route.test.ts` — unavailable `missing_key` catalog → PUT status **409**, `mocks.set` not called.

## Hold before verified

Prior GHA unit failure (`rp5-gha-after-evidence-push.md`) listed exactly these three tests. This ACCEPT + Data ACCEPT cover all three locally. Remote `quality` on the push SHA still required for `verified`.

## Ledger

- Append this file to RP5 `evidence` in `tasks.json` (with `rp5-unit-retest-null-accept.md`)
- RP5 **status remains `active`** until remote `quality` succeeds
- **Do not** mark `verified` on ACCEPT alone
