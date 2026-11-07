# Unify default Lant/glm-5.3 + dailyCap Zod — ACCEPT

**Date:** 2026-10-10 ~11:45 CST (Asia/Shanghai)  
**Reviewer:** INTEGRATOR  
**Branch tip (box):** `697d1d6` (working tree dirty — **no commit / no push**)  
**Source claim:** [`unify-default-lant-glm-daily-cap-schema.md`](./unify-default-lant-glm-daily-cap-schema.md)  
**Verdict:** **ACCEPT**

## Gates re-run (this Accept)

```text
npx vitest run \
  packages/contracts/src/opening/ai-settings.test.ts \
  packages/ai/src/opening/catalog-merge.test.ts \
  packages/ai/src/opening/model-routing.test.ts \
  packages/ai/src/opening/provider.test.ts \
  packages/ai/src/opening/ai-readiness.test.ts \
  packages/ai/src/opening/effective-cap.test.ts \
  packages/config/src/opening-model-catalog.test.ts \
  apps/web/src/features/settings/ai-settings-model.test.ts \
  apps/web/src/app/api/opening/ai-settings/route.test.ts \
  apps/worker/src/runtime/tutor-model.test.ts
→ PASS  Test Files 10 passed (10) / Tests 81 passed (81)
```

Matches claim (10 files / 81 passed).

## Spot-check vs claim

| Claim | Verified? | Notes |
|---|---|---|
| Zod `dailyCapCents` max → env-scale (`OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS` = 2_147_483_647) | Yes | Was `.max(2_000)`; writes still gated by `validateBudgetFields` (≤ env when env > 0, else ≤ personal ceiling 2000) |
| `resolveMergedDefaultModelId` prefers available `source=workspace` over `missing_key` env stub | Yes | Requested available kept; else first available workspace; else keep requested stub id |
| Tutor `resolveTutorModel` uses effective daily cap (workspace + env) | Yes | `resolveEffectiveDailyCap` + `pricingConfigured` includes custom BYOK |
| `ai-settings-service` large/null cap does not drop model routes; pricing includes workspace BYOK | Yes | `catalogPricingConfigured([...catalog.models, ...custom])`; save reuses listed custom for merge |
| Root cause narrative (1e6 vs Zod 2000 → invalidStoredSettings → gpt-4o-mini missing_key) | Honest | Schema + merge + tutor paths address stated failure chain |

## AI-scoped dirty files (Accept covers these only)

```text
.env.example
apps/web/src/app/api/opening/ai-settings/route.test.ts
apps/web/src/features/settings/ai-settings-service.ts
apps/worker/src/runtime/tutor-model.test.ts
apps/worker/src/runtime/tutor-model.ts
docs/operations/hermes-deployment.md
docs/operations/opening-model-routing.md
packages/ai/src/index.ts
packages/ai/src/opening/catalog-merge.test.ts
packages/ai/src/opening/catalog-merge.ts
packages/contracts/src/opening/ai-settings.test.ts
packages/contracts/src/opening/ai-settings.ts
docs/superpowers/evidence/2026-10-10-opening-release/unify-default-lant-glm-daily-cap-schema.md
docs/superpowers/evidence/2026-10-10-opening-release/unify-default-lant-glm-daily-cap-accept.md
```

## Not accepted here (Experience R2 / unrelated dirt)

Working tree also has UI loop converge R2 changes (palette/shell/Today/advanced settings folds, R2 evidence). Those were accepted separately under `ui-loop-converge-r2-accept.md`. This Accept does **not** re-verify or mark them.

```text
apps/web/src/features/opening/assistant/ai-readiness.test.ts
apps/web/src/features/opening/assistant/ai-readiness.tsx
apps/web/src/features/opening/planning/today-overview.test.ts
apps/web/src/features/opening/planning/today-overview.tsx
apps/web/src/features/opening/shell/opening-shell.tsx
apps/web/src/features/search/command-palette-model.test.ts
apps/web/src/features/search/command-palette-model.ts
apps/web/src/features/search/command-palette.test.ts
apps/web/src/features/settings/advanced-settings-view.tsx
apps/web/src/features/settings/settings-view.nav.test.ts
apps/web/src/features/settings/settings-view.tsx
docs/superpowers/evidence/2026-10-10-opening-release/ui-loop-converge-r2-*
```

## Residual

- **Hermes env still PM deploy:** set `OPENING_MODEL_CATALOG` / `OPENING_MODEL_DEFAULT_ID=lant-glm-5-3` / `LANT_API_KEY` / positive `OPENING_MODEL_DAILY_CAP_CENTS` (or rely on workspace BYOK + confirmed budget) on web+worker, then PM restart/redeploy. This task did **not** redeploy.
- No commit / no push from this Accept.

## Verdict rationale

Claimed unit set re-passed; Zod max + merge preference + tutor effective-cap + settings pricing/read paths match the root-cause story; write ceilings remain in `validateBudgetFields`; docs/env examples are placeholders only (no secrets). **ACCEPT** AI scope only.
