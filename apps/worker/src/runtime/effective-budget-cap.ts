import { resolveEffectiveDailyCap } from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";

function pricingConfigured(models: Array<{ inputCentsPerMillion: number; outputCentsPerMillion: number; apiKey: string }>): boolean {
  return models.some(model => model.apiKey.length > 0 && model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0);
}

/** Resolve the workspace effective daily cap for worker reserve / tutor routing. */
export async function resolveWorkerEffectiveDailyCap(sql: Sql, scope: Scope): Promise<number> {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  return resolveEffectiveDailyCap({
    envCapCents: catalog.dailyCapCents,
    workspaceCapCents: preference.settings.dailyCapCents ?? null,
    confirmed: preference.settings.budgetConfirmedAt != null,
    pricingConfigured: pricingConfigured([...catalog.models, ...custom]),
  }).capCents;
}
