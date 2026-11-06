# DL11 (Experience) — retest submit reject-early Accept

Verifier: Grok Bot (executor / Integrator Accept). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.  
Date: 2026-10-10 ~01:01 CST (Asia/Shanghai).  
Implementer: Experience (Grok Bot executor) per `dl11-retest-submit-reject-early.md`.

## Decision

**ACCEPT** — server-side earliest re-check on 补测提交 (`attempt-service` + domain helper); UI disable is not the sole guard. Ledger stays **`active`** (not `verified`). Integrator owns commit/push; Accept did not stage/commit/push.

Prior DL11 Accepts remain valid: day-planner earliest; plan-service `planningNow` wiring.

## Scope reviewed (uncommitted at Accept)

| Path | Role |
|---|---|
| `packages/domain/src/opening/retest-activity.ts` | `retestSubmitTooEarly`, `assertRetestSubmitEarliestAllowed`, `RetestSubmitTooEarlyError`; earliest = max(notBeforeAt, scheduledStartAt??recommendedAt) |
| `packages/domain/src/opening/retest-activity.test.ts` | domain unit coverage for floors / max / allow |
| `packages/domain/src/index.ts` | exports |
| `apps/web/.../attempt-service.ts` | when `retestId` present: load activity times → assert before `insertObservation`; too early → VALIDATION + Chinese message; no observation write |
| `apps/web/.../attempt-service.retest-earliest.test.ts` | new — reject early / allow on-time / skip without retestId |
| `apps/web/.../attempt-service.retest-close.test.ts` | sql mock past floors so close path still green |
| `apps/web/.../retest-attempt.ts` | `formatRetestSubmitError`; soft `recommendedAt` on prefill |
| `apps/web/.../retest-attempt.test.ts` | error-map + prefill |
| `apps/web/.../attempt-form.tsx` | alert uses server reject-early copy; soft status hint; submit still reachable |
| `apps/web/.../auth/service.ts` (+ test) | `mapDomainError` / `jsonError` surface `businessCode`/`earliestAt`/`reason` for Experience API |
| `packages/database/.../opening-learning-observations.ts` (+ untracked earliest test) | defense-in-depth assert before insert (Data overlap) |

Ignored unrelated dirty: `docs/superpowers/evidence/2026-10-09-opening-release/rp5-gha-91b1c73-typecheck-fail.md`. No Q03/RP7 path churn claimed as this slice.

## AC check (slice)

| Criterion | Result |
|---|---|
| Server re-check earliest-allowed on submit (§DL11 Approach bullet) | Met — `assertRetestSubmitEarliestAllowed` before observation write |
| Frontend disable alone not sufficient | Met — soft hint only; form still submittable; server rejects |
| Chinese VALIDATION message; no observation on too-early | Met — tests assert throw + `insertObservation` not called |
| Observation write path same helper (defense in depth) | Met — database repository assert; Data may still harden further |
| Do **not** mark DL11 `verified` | Met — status remains `active` |

## Gates (re-run on Accept)

| Gate | Result |
|---|---|
| `node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening/retest-activity.test.ts apps/web/src/features/opening/learning/attempt-service.retest-earliest.test.ts apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts apps/web/src/features/opening/learning/retest-attempt.test.ts` | **4 files / 32 PASS** (matches Experience claim) |
| `npx tsc -p packages/domain/tsconfig.json --noEmit` | exit 0 |
| `npx tsc -p apps/web/tsconfig.json --noEmit` | exit 0 |
| `npx tsc -p packages/database/tsconfig.json --noEmit` | exit 0 (claimed optional; re-run clean) |
| Extra: `apps/web/src/features/auth/service.test.ts` | 1 file / 3 PASS (mapDomainError DL11 case) |

## Residual risks / follow-ups

- **Data parallel**: observations repository also gates with the same helper; if Data is still closing server-half elsewhere, coordinate on commit order — no conflict found beyond shared assert + SELECT columns.
- Full DL11 `verified` still needs Integrator commit of this slice (+ any remaining AC if any) before status may advance.
- Auth `jsonError` now forwards optional `businessCode`/`earliestAt`/`reason` for this error type only via property copy — intentional for Experience UI.

## Dirty files in this slice (for Integrator push later)

Modified: `packages/domain/src/opening/retest-activity.ts`, `packages/domain/src/opening/retest-activity.test.ts`, `packages/domain/src/index.ts`, `apps/web/src/features/opening/learning/attempt-service.ts`, `apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts`, `apps/web/src/features/opening/learning/retest-attempt.ts`, `apps/web/src/features/opening/learning/retest-attempt.test.ts`, `apps/web/src/features/opening/learning/attempt-form.tsx`, `apps/web/src/features/auth/service.ts`, `apps/web/src/features/auth/service.test.ts`, `packages/database/src/repositories/opening-learning-observations.ts`

Untracked (slice): `apps/web/src/features/opening/learning/attempt-service.retest-earliest.test.ts`, `packages/database/src/repositories/opening-learning-observations.retest-earliest.test.ts`, `docs/superpowers/evidence/2026-10-10-opening-release/dl11-retest-submit-reject-early.md`, this Accept file.

## Ledger

`tasks.json` DL11: status remains **`active`**; evidence appends this Accept path only. No commit/push by Accept.
