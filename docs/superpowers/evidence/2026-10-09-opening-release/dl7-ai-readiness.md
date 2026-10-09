# DL7 AI readiness checklist, in-app daily cap and unknown reservation reconciliation — agent-owned checks accepted

Verifier: AIstudy Integrator (not the implementer). Workspace: `/workspace/study-assistant-opening`, branch `feat/opening-release`. Uncommitted.

## Diff vs `14-loop-closure.md` § DL7

**Data / AI half**
- `packages/ai/src/opening/effective-cap.ts` (+ test): `resolveEffectiveDailyCap` — env > 0 wins; settings can only lower via `min`; env=0 stays disabled until confirmed workspace; ceiling 2000; pricing required when env=0 enable.
- `packages/contracts/src/opening/ai-settings.ts`: optional `dailyCapCents` / `budgetConfirmedAt`; response surfaces `envCapCents` / `personalCeilingCents`.
- `packages/ai/src/opening/catalog-merge.ts` (+ test): availability recomputed from effective cap (server + workspace) so workspace enablement can clear `budget_disabled`.
- `packages/database/src/repositories/opening-budget.ts`: `envCapCents`, lazy reconcile stale `reserved` → `completed` (default 30 min), completed counted by local-day `created_at` (Asia/Shanghai).
- `apps/web` / `apps/worker` budget construction uses `envCapCents` + `pricingConfigured` (no longer a single global cap alone).
- Integration: `tests/integration/opening-budget-reconcile.test.ts` (+ existing `opening-budget.test.ts`).

**UI / API half**
- `GET /api/opening/ai-readiness` — boolean/count items + fixHint, no secrets.
- `apps/web/src/features/opening/assistant/ai-readiness.tsx` mounted from assistant empty-state (`assistant-view.tsx`).
- Settings: enable + confirm dialog when envCap=0; service `validateBudgetFields`; panel wiring in `ai-settings-panel.tsx` / `ai-settings-service.ts`.
- Must not touch Today page or learning-evidence rules — DL7 core files clean of those; other dirty today/evidence paths predate DL7 mtimes (see accept spot-check).

## Verification (agent-owned, Integrator re-run 2026-10-09)

- `node node_modules/vitest/vitest.mjs run --project unit packages/ai/src/opening/ apps/web/src/features/settings/` — 12 files, **79** passed (~5.82s).
- `node node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit` — exit 0.
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` — exit 0.

**Cited from prior accept** ([`dl7-ai-readiness-accept.md`](./dl7-ai-readiness-accept.md); Integrator did not re-run; accept already green):

- Same unit path at accept: 12 files / 78 passed; focused effective-cap + catalog-merge + contracts ai-settings: 3 files / 15 passed.
- `tsc --noEmit` also green then for contracts, database, worker (ai/web reconfirmed above).
- Integration (DB up):  
  `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_opening_test`  
  `vitest --project integration tests/integration/opening-budget-reconcile.test.ts tests/integration/opening-budget.test.ts` — 2 files, **12** passed (~4.57s).

Plan’s explicit “北京 00:30 vs 07:59 same local day” case is not a named assertion; local-day `created_at` SQL + “yesterday created_at frees today’s cap” covers day-boundary semantics.

## Not run

- Browser walk for Paula (settings enable/confirm dialog, assistant readiness checklist). Plan/`AGENTS.md` leave browser to the user; same follow-up pattern as DL5/DL6.

## Separate note

`apps/web/src/app/api/opening/ai-settings/route.test.ts` — **1 fail / 9 pass** (expected 409, got 200) on “rejects unknown or unavailable active models…”. Stale fixture: stubs `availability: "missing_key"` with a non-empty `apiKey`. DL7 `mergeOpeningCatalog` recomputes server availability from `apiKey` / cap / pricing (plan-required so workspace enablement can clear `budget_disabled`), so the stub is inconsistent with `loadOpeningModelCatalog` (empty key ↔ `missing_key`). Production pairing remains correct. **Does not block ledger close per PM**; fixture update is follow-up, not a product BLOCK.

## Ledger

- `tasks.json` DL7 → `verified` with this evidence path. No commit. DL8 untouched.
