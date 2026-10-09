# DL11 — retest submit reject-early (Data server half)

Implementer: Grok Bot (executor). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.  
Date: 2026-10-10 CST (Asia/Shanghai).

## Scope

Server re-validates earliest-allowed on **补测结果提交**; rejects early submissions. UI disable alone does **not** count. Ledger stays **active** (not verified). No commit/push; Q03 untouched.

Prior DL11 pieces remain valid:

- Domain day-planner earliest (`dl11-day-planner-earliest-accept.md`)
- Plan-service `planningNow` wiring (`dl11-plan-service-planningnow-accept.md`)

## Guarded endpoints / paths

| Path | Gate |
|------|------|
| `POST /api/opening/attempts/[id]/submit` | `attempt-service.submit` → `assertRetestSubmitEarliestAllowed` before `insertObservation` |
| `POST /api/opening/observations` (and any caller of `insertObservation` with `retestId`) | `insertOpeningLearningObservation` authoritative assert using DB `clock_timestamp()` |

## Error shape

HTTP **400**:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "补测尚未到最早可作答时间，请稍后再提交。",
    "businessCode": "RETEST_SUBMIT_TOO_EARLY",
    "earliestAt": "<ISO>",
    "reason": "not_before" | "scheduled_or_recommended"
  }
}
```

Domain: `RetestSubmitTooEarlyError` (`code: VALIDATION`, `businessCode: RETEST_SUBMIT_TOO_EARLY`). Mapped in `mapDomainError` / `jsonError`.

## Earliest computation

Same timing spirit as `isRetestActivityDue` (status/snooze ignored for submit):

1. Due target = `scheduledStartAt ?? recommendedAt`
2. Also respect `notBeforeAt`
3. Effective earliest = max of present floors
4. Future → reject; missing floors → allow

## Files (Data / shared)

| Area | Path |
|------|------|
| Pure helper | `packages/domain/src/opening/retest-activity.ts` |
| Domain export | `packages/domain/src/index.ts` |
| Domain tests | `packages/domain/src/opening/retest-activity.test.ts` |
| Attempt submit gate | `apps/web/src/features/opening/learning/attempt-service.ts` |
| Attempt tests | `attempt-service.retest-earliest.test.ts` (+ retest-close sql mock) |
| Authoritative insert gate | `packages/database/.../opening-learning-observations.ts` |
| Insert tests | `opening-learning-observations.retest-earliest.test.ts` |
| API error map | `apps/web/src/features/auth/service.ts` (+ `service.test.ts`) |

## Experience UI (parallel, optional for Accept)

Soft notice + `formatRetestSubmitError` in `retest-attempt.ts` / `attempt-form.tsx`. Not required for Data Accept of reject-early.

## Residual

- Day-planner / planningNow already Accepted separately.
- Full DL11 `verified` needs Integrator commit + both Data reject-early **and** any remaining Experience polish if product wants it; **do not** mark verified until Integrator Accept of both halves as PM defines.
- TZ01 / Q03 untouched.

## Gates

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/domain/src/opening/retest-activity.test.ts \
  packages/domain/src/opening/day-planner.test.ts \
  packages/domain/src/opening/local-day-bounds.test.ts \
  packages/database/src/repositories/opening-learning-observations.retest-earliest.test.ts \
  apps/web/src/features/opening/learning/attempt-service.retest-earliest.test.ts \
  apps/web/src/features/opening/learning/attempt-service.retest-close.test.ts \
  apps/web/src/features/auth/service.test.ts \
  apps/web/src/features/opening/planning/plan-service.test.ts
→ 8 files, 67 tests passed
```
