# DL7 accept — AI readiness / effective daily cap / budget reconcile

**Date:** 2026-10-09 ~16:45 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Agent accept against `docs/superpowers/plans/opening-release/14-loop-closure.md` § DL7.  
**Verdict:** **ACCEPT** (agent-owned; **not verified**)  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** **not edited**. **verified:** **not marked**.

## Files reviewed

**New**
- `packages/ai/src/opening/effective-cap.ts` (+ `effective-cap.test.ts`)
- `apps/web/src/app/api/opening/ai-readiness/route.ts`
- `apps/web/src/features/opening/assistant/ai-readiness.tsx` (exact path)
- `tests/integration/opening-budget-reconcile.test.ts`

**Changed (DL7-relevant)**
- `packages/contracts/src/opening/ai-settings.ts` — optional `dailyCapCents` / `budgetConfirmedAt`; response `envCapCents` / `personalCeilingCents`
- `packages/ai/src/opening/catalog-merge.ts` (+ test) — availability recomputed from effective cap (server + workspace)
- `packages/ai/src/index.ts` — exports `resolveEffectiveDailyCap` / ceiling
- `packages/database/src/repositories/opening-budget.ts` — `envCapCents`, lazy reconcile, local-day `created_at` for completed
- `apps/web/src/features/settings/ai-settings-service.ts` / `ai-settings-panel.tsx` / `ai-settings-model.test.ts`
- `apps/web/src/features/opening/runtime.ts` — budget repo uses `envCapCents` + `pricingConfigured`
- `apps/worker/src/index.ts` — same budget construction (file also has unrelated DL3 stem-prompt wiring in same dirty tree)
- `apps/web/src/features/opening/assistant/assistant-view.tsx` — empty-state mounts `AiReadinessChecklist`

## Today / evidence spot-check

DL7 core files do not reference today-view or evidence-eligibility.  
Working-tree dirty `today-view*` / `opening-learning-evidence*` / `evidence-eligibility*` have **earlier mtimes** (~16:19–16:26 CST) than DL7 artifacts (~16:37–16:41 CST). Treat those as other DL work, not DL7 edits.

## Plan criteria checklist

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | `resolveEffectiveDailyCap`: env > 0 wins; settings can only lower via `min`; env=0 stays disabled until confirmed workspace; ceiling 2000; pricing required when env=0 enable | **PASS** | Unit-tested four combos + pricing-missing + ceiling truncate + invalid ints |
| 2 | `ai_settings` optional `dailyCapCents` / `budgetConfirmedAt`; settings UI enable + confirm dialog | **PASS** | Contract zod `.max(2000).nullable().optional()`; panel confirm when envCap=0; service `validateBudgetFields` |
| 3 | Lazy reconcile: stale `reserved` → `completed` (default 30 min); completed counted by local-day `created_at` | **PASS** | Budget repo cutoff update + SQL date in Asia/Shanghai; integration green |
| 4 | `GET /api/opening/ai-readiness` + assistant empty-state checklist; catalog availability from effective cap | **PASS** | Route returns boolean/count items + fixHint, no secrets; checklist in assistant when not in learning attempt; merge recomputes availability |
| 5 | Must NOT touch Today page or learning-evidence rules | **PASS** | Spot-check: DL7 files clean; today/evidence dirty files predate DL7 mtimes |

## Tests re-run

```text
# Claimed unit path
node node_modules/vitest/vitest.mjs run --project unit packages/ai/src/opening/ apps/web/src/features/settings/
→ Test Files  12 passed (12)
→ Tests       78 passed (78)
→ Duration    ~5.68s

# Focused DL7 unit slices (subset)
packages/ai effective-cap + catalog-merge + packages/contracts ai-settings
→ Test Files  3 passed; Tests 15 passed

# tsc --noEmit
node node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit        → exit 0
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p packages/database/tsconfig.json --noEmit → exit 0
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit          → exit 0
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit       → exit 0
```

**No dedicated `ai-readiness.tsx` component unit test** (not claimed; not blocking agent accept).

## Integration

DB available (`pg_isready` + `psql` to `aistudy_opening_test` OK).

```text
OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test \
  node node_modules/vitest/vitest.mjs run --project integration \
  tests/integration/opening-budget-reconcile.test.ts \
  tests/integration/opening-budget.test.ts
→ Test Files  2 passed (2)
→ Tests       12 passed (12)
→ Duration    ~4.57s
```

Plan’s explicit “北京 00:30 vs 07:59 same local day” case is **not** a named assertion; local-day `created_at` SQL + “yesterday created_at frees today’s cap” covers the intended day-boundary semantics.

## Extra observation (non-blocking for ACCEPT; fix before verified)

```text
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/app/api/opening/ai-settings/route.test.ts
→ 1 failed / 9 passed (10)
  FAIL: "rejects unknown or unavailable active models…" expected 409, got 200
```

Cause: DL7 `mergeOpeningCatalog` **recomputes** server availability from `apiKey` / cap / pricing (plan-required so workspace enablement can clear `budget_disabled`). The route test stubs `availability: "missing_key"` while leaving a non-empty `apiKey`, which is inconsistent with `loadOpeningModelCatalog` (empty key ↔ `missing_key`). Production pairing remains correct. **Update the fixture** (empty `apiKey`) before marking verified; do not treat as product BLOCK.

Also: plan TDD listed dedicated handler 422 cases for negative / non-integer / over-ceiling budget — not present as new tests; zod + `validateBudgetFields` implement the rules. Existing route.test still covers unauthenticated 401 for ai-settings GET/PUT.

## Not run

- **Browser** — not run (implementer did not; accept agent did not).
- Interactive UI confirmation of settings enable dialog / assistant checklist rendering — not run.

## Recommendation

**ACCEPT** DL7 agent-owned. Do **not** mark verified; do **not** edit `tasks.json`. Before verified: fix stale `ai-settings/route.test.ts` fixture; optional browser smoke of readiness checklist + settings confirm; optional named 00:30/07:59 integration assertion.
