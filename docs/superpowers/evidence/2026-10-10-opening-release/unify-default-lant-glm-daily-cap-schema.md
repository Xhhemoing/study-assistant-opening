# Unify default model (Lant/glm-5.3) + dailyCapCents schema max

**Date:** 2026-10-10 ~11:45 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**No commit/push** · **No hermes redeploy**

## Root cause (wrong default / Tutor broken)

1. **Primary (Hermes hotfix):** workspace `ai_settings.dailyCapCents=1000000` failed Zod `.max(2000)` in `openingAiSettingsSchema` → repository `safeParse` failed → `invalidStoredSettings=true` → entire preference wiped to `DEFAULT_OPENING_AI_SETTINGS` → routing fell through to env stub `gpt-4o-mini` / id `default` with `missing_key`.
2. **Secondary:** even with valid settings, `mergeOpeningCatalog` kept env `defaultModelId` when that stub was `missing_key`, instead of preferring an already-available workspace BYOK model (Lant/`glm-5.3`).
3. **Tutor path:** `resolveTutorModel` merged with env-only `dailyCapCents`, so workspace-budget BYOK models could be falsely `budget_disabled` when env cap was 0.

## Fix

| Area | Change |
|---|---|
| `packages/contracts/.../ai-settings.ts` | `dailyCapCents` Zod max → `OPENING_AI_SETTINGS_DAILY_CAP_SCHEMA_MAX_CENTS` (= env max `2_147_483_647`). Write ceilings remain in `validateBudgetFields`. |
| `packages/ai/.../catalog-merge.ts` | `resolveMergedDefaultModelId`: prefer available `source=workspace` over unavailable env stub. |
| `apps/worker/.../tutor-model.ts` | Use `resolveEffectiveDailyCap` (workspace + env) for merge availability. |
| `apps/web/.../ai-settings-service.ts` | `pricingConfigured` includes workspace BYOK models; save/read keep large/null caps without wiping routes. |
| Docs / `.env.example` | Hermes `OPENING_MODEL_*` checklist for Lant/`glm-5.3` (placeholders only). |

## Hermes env checklist (PM sets; do not redeploy from this task)

- `OPENING_MODEL_CATALOG` — JSON with `id=lant-glm-5-3`, `providerId=lant`, `modelName=glm-5.3`, `apiKeyEnv=LANT_API_KEY`, positive prices, `supportsVision:true` for vision parse
- `OPENING_MODEL_DEFAULT_ID=lant-glm-5-3`
- `LANT_API_KEY` — secret store only
- `OPENING_MODEL_DAILY_CAP_CENTS` — positive (e.g. `1000000`); `0` = hard budget block
- Or rely on workspace BYOK Lant + confirmed workspace budget / null workspace cap under env cap
- Apply identical env to web + worker, then PM restart/redeploy

## Tests

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
→ 10 files, 81 passed
```

Covers: stored `1000000` + Lant routes; stored null under large env; reject over-env / over-schema; prefer workspace over `missing_key` stub; budget 0 hard block; readiness soft vision unchanged.

## Accept-ready

**yes** (Integrator) — no secrets in diffs; no push; no hermes redeploy.
