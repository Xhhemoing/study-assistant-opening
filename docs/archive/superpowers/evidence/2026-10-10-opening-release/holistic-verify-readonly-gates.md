# Holistic verify — agent read-only green re-runs

**Date:** 2026-10-10 ~07:37 CST (Asia/Shanghai)  
**Tip at dispatch:** `63a4737`  
**Constraint:** read-only; no product edits; no hermes redeploy; no ledger flips

## Results

| Owner | Result | Notes |
|---|---|---|
| AI | **116 PASS** / 9 files | provider/errors/usage/effective-cap/catalog-merge/budget-local-day + budgeted-call/budget-contract-discovery/tutor-turn |
| Data | **121 PASS** + domain/database tsc 0 | day-planner/local-day-bounds/retest + reminders/observations.retest-earliest (+ related) |
| Experience | **77 unit + 4 browser PASS** | plan-service/retest + guidance/today-plan e2e subset |

## Commands (AI, as reported)
```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/ai/src/opening/provider.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts \
  packages/ai/src/opening/budget-local-day.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts
```

Data reported GREEN without full command paste in Integrator chat; details sent to PM by Data.

## Experience (reported)

| Scope | Result |
|---|---|
| Unit 8 files | **77 PASSED** (plan-service, retest-proposals, retest-attempt, attempt-service retest-close/earliest, day-planner, retest-activity, local-day-bounds) |
| Browser subset | **4 PASSED** (~2.2m) — `guidance-modes.spec.ts` + `today-plan.spec.ts` with `OPENING_RELEASE=0` + e2e DB |

Claimed tip at run: `63a4737` (docs tip `0aa641b` later; product surface unchanged). No apps/web edits; no hermes redeploy.

### Totals (agent read-only)
- AI 116 + Data 121 + Experience unit 77 (suites may overlap across owners; not additive unique tests)
- Experience browser subset **4 PASS**
