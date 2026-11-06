# BC1 P0 budget·cost contract — Accept

Verifier: Grok Bot (executor). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`.
Date: 2026-10-09 ~23:55 CST (Asia/Shanghai).

## Accept vs Integrator contract

**ACCEPT: yes** against Integrator BC1 table (illegal reserve / ledger actions / overage cap / operationId / safety gates).

| # | Contract | Verdict |
|---|---|---|
| 1 | Illegal reserve → `BUDGET_INVALID_RESERVE`, provider calls=0 | PASS — `runBudgetedCall` short-circuits; `opening-budget.reserve` throws same code |
| 2 | `ledgerActionForProviderError`: AUTH/RATE_LIMIT→release; REQUEST→release unless `requestSent`→markUnknown; UNAVAILABLE/timeout→markUnknown | PASS — helper + unit lock; runtime catch uses table (REQUEST default release) |
| 3 | overage → cap-to-reserved + `noteOverage` audit | PASS — `settleCentsForActual`; settle never unrestricted above reserved |
| 4 | Without `operationId`: double-reserve locked by test; with `operationId`: reuse same reservation | PASS — discovery + budgeted-call tests |
| 5 | Safety gates kept (amount≤0, missing usage→unknown, AUTH release, budget_disabled) | PASS — gates retained; no removal |

**Not REJECT:** safety gates present; overage settles capped (not unrestricted).

## Diff scope

- `apps/worker/src/runtime/budgeted-call.ts` (+ `budgeted-call.test.ts`)
- `apps/worker/src/runtime/budget-contract-discovery.test.ts` (`it.fails` → positive)
- `packages/database/src/repositories/opening-budget.ts` (additive `BUDGET_INVALID_RESERVE`)
- patch evidence: `bc1-budget-cost-contract-patch.md`
- this accept file
- `tasks.json` BC1: planned → **active** + evidence append only (**not verified**)

Excluded from commit: Q03 packaging, egg-info, rp5-gha, unrelated dirt.

## Gates (re-run on Accept)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts
→ Test Files  4 passed (4)
→ Tests       33 passed (33)
→ Duration    ~1.77s
```

## Contracts / Integrator notes (approved this slice)

- Keep `operationId?` and `noteOverage?` **worker-local** (no shared contracts schema required this slice).
- Do **not** mark BC1 verified: `operationId` optional wiring not in shared contracts yet; full BC1 AC may remain.
- Callers (tutor-turn / ephemeral) may still omit `operationId`; default remains per-`requestId` reserve (double-reserve documented/locked).

## Ledger

BC1 status: **active** (was planned). Evidence appended:
- `../../evidence/2026-10-09-opening-release/bc1-budget-cost-contract-patch.md`
- `../../evidence/2026-10-09-opening-release/bc1-budget-cost-contract-accept.md`
