# BC1 — operationId wiring + concurrency/cancel/late-result slice

**Date:** 2026-10-10 ~00:11 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release` @ tip after `b174394`  
**Owner:** AIstudy AI (executor)  
**Scope guard:** worker / ai / database budget paths only; **no** `apps/web` edits; **no** day-boundary / TZ01; avoided tutor answer JSON parser edits (Hermes collision)

## Prior art

- P0 ACCEPTed: `bc1-budget-cost-contract-patch.md` + `bc1-budget-cost-contract-accept.md` @ `c36112e`
- `runBudgetedCall` already supports optional `operationId` / `noteOverage`
- Discovery: `p0-budget-cost-contract-discovery.md`

## Done this slice

| AC item | Status | Notes |
|---|---|---|
| Wire optional `operationId` through **tutor-turn** | **Done** | `operationId` + `requestId` = `tutor:${claimed.id}` (durable job key; retries reuse one ledger reserve) |
| Wire through **ephemeral** callers | **Deferred** (documented + locked) | Ephemeral lives in `apps/web` (Experience out of BC1 worker scope). Discovery tests lock: UUID-style ids without `operationId` double-reserve; shared `operationId` reuses one reserve (contract for a future web slice) |
| Concurrency: two reserves cannot both consume same balance | **Done** (unit) | CAS fake ledger in discovery; DB integration already covers true concurrency in `tests/integration/opening-budget.test.ts` |
| Cancel before send → release | **Done** | Discovery matrix |
| Abort after send (`PROVIDER_ABORTED`) → markUnknown | **Done** | No release / no settle |
| Late settle after release → no double-charge | **Done** | Settle rejects `NOT_FOUND` |
| Unknown fee confirmation converges once | **Done** | Second settle rejected |
| Release vs late settle race → single terminal state | **Done** | Exactly one of released/completed |
| Settings/discovery vs ledger alignment | **Done** | `resolveEffectiveDailyCap` disabled ↔ catalog `budget_disabled`; `PROVIDER_DISABLED` / `BUDGET_EXCEEDED` stay business codes (not INTERNAL) |
| Safety gates retained | **Done** | No loosened assertions; illegal reserve / missing usage / AUTH release / budget_disabled / overage cap unchanged |

## Files changed

| File | Change |
|---|---|
| `apps/worker/src/jobs/tutor-turn.ts` | Pass `operationId` (same durable job key as `requestId`) into `runBudgetedCall` |
| `apps/worker/src/jobs/tutor-turn.test.ts` | Same-job retry reuses one ledger reservation |
| `apps/worker/src/runtime/budget-contract-discovery.test.ts` | Concurrency/cancel/late-result matrix; ephemeral deferral locks; settings↔ledger alignment |
| `docs/superpowers/evidence/2026-10-09-opening-release/bc1-operationid-concurrency-slice.md` | This evidence |

**Not changed:** `apps/web/**`, domain day-boundary, contracts public schema, Hermes/tutor JSON parsers, `provider.ts`.

## Tests

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts
→ Test Files  7 passed (7)
→ Tests       93 passed (93)
→ Duration    ~4.23s
```

## Still deferred (why)

1. **Ephemeral `operationId` wiring in `apps/web/.../ephemeral-service.ts`** — Experience / `apps/web` explicitly out of this slice. Contract tests lock the required behavior for a follow-up Experience patch (`requestKey` / client op key → `operationId`). **Accepted as documented deferral by Integrator for BC1 verified.**
2. **Promote `operationId` / `noteOverage` into shared contracts** — still worker-local additive; needs Integrator if public schema.
3. **True DB cancel/late-result integration row** — unit CAS mirrors `opening-budget` settle/release `WHERE state='reserved'`; existing integration already covers concurrent reserve + settle-once. Optional follow-up.
4. **TZ01 / day-boundary** — separate task; not touched.
