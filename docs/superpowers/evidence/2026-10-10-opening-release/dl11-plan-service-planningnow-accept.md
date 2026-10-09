# DL11 (web wiring) — plan-service planningNow Accept

Verifier: Grok Bot (executor / Accept). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.  
Date: 2026-10-10 ~00:54 CST (Asia/Shanghai).

## Decision

**ACCEPT** — upward wiring of domain earliest (`planningNow` + TZ01 `localDate`/`timeZone`) into production plan-service entrypoints. Ledger stays **`active`** (not `verified`). Integrator owns commit/push; Accept did not stage/commit/push.

Prior domain Accept remains valid: `../../evidence/2026-10-09-opening-release/dl11-day-planner-earliest-accept.md`.

## Scope reviewed (uncommitted at Accept)

| Path | Role |
|---|---|
| `apps/web/src/features/opening/planning/plan-service.ts` | `resolvePlanningNowForLocalDay`, `buildServerPlanDayOptions`; inject into `ensureDailyDraft` / `proposePlan` / `proposeDeltaPlan`; clock seam |
| `apps/web/src/features/opening/planning/plan-service.test.ts` | new — 10 unit tests |
| `packages/domain/src/index.ts` | export `PlanDayOptions` |

Ignored unrelated dirty: `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`.

## AC check (slice)

| Criterion | Result |
|---|---|
| Production path injects server `planningNow` so earliest uses `max(slot.start, recommendedAt/notBefore, planningNow)` | Met — builder sets `planningNow` when wall clock ∈ workspace local day; domain clamp already Accepted |
| TZ01 `localDate`+`timeZone` (no UTC `dayEnd` regression) | Met — removed `` `${date}T23:59:59.999Z` `` from all three call sites; options use `localDate`/`timeZone` only |
| `ensureDailyDraft` / `proposePlan` / `proposeDeltaPlan` wire planningNow | Met — all three call `buildServerPlanDayOptions` with `clock()` |
| Domain day-planner earliest already Accepted | Met — prior evidence kept on ledger |
| Out of slice: submit reject-early (Experience) | Confirmed out of scope — not claimed |
| Do **not** mark DL11 `verified` | Met — status → `active` only |

## Gates (re-run on Accept)

| Gate | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/planning/plan-service.test.ts packages/domain/src/opening/day-planner.test.ts packages/domain/src/opening/local-day-bounds.test.ts packages/domain/src/opening/daily-draft.test.ts` | **4 files / 43 PASS** (matches Data claim) |
| `npx tsc -p packages/domain/tsconfig.json --noEmit` | exit 0 |
| `npm run typecheck -w @aistudy/web` (`tsc -p tsconfig.json --noEmit`) | exit 0 |

## Residual risks / follow-ups

- **Submit reject-early** for retest still open (Experience / server path); frontend disable is not a guarantee per §5.2.
- Worker budgeted-call and Experience UI were not touched (out of Accept scope).
- Full DL11 `verified` still needs those remaining AC pieces (and Integrator commit of this wiring) before status may advance.

## Ledger

`tasks.json` DL11: `planned` → **`active`**; evidence appends this file; keeps day-planner Accept evidence. No commit/push by Accept.
