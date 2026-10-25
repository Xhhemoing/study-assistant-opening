import { mergeOpeningCatalog, resolveEffectiveDailyCap, OpeningModelRoutingError } from "@aistudy/ai";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { createOpeningAiSettingsRepository } from "./opening-ai-settings";
import { createOpeningModelProvidersRepository } from "./opening-model-providers";

type Catalog = { models: Parameters<typeof mergeOpeningCatalog>[0]; defaultModelId: string | null; dailyCapCents: number };
/** Shared Web/Worker routing inputs; never contacts a provider. */
export async function loadOpeningRouting(sql: Sql, scope: Scope, catalog: Catalog) {
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  if (preference.invalidStoredSettings) throw new OpeningModelRoutingError("已保存的模型设置无效，请到设置重新保存或恢复服务器默认设置。");
  const pricingConfigured = catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0)
    || custom.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0);
  const effective = resolveEffectiveDailyCap({ envCapCents: catalog.dailyCapCents,
    workspaceCapCents: preference.settings.dailyCapCents ?? null,
    confirmed: Boolean(preference.settings.budgetConfirmedAt), pricingConfigured });
  const merged = mergeOpeningCatalog(catalog.models, custom, { defaultModelId: catalog.defaultModelId, dailyCapCents: effective.capCents });
  return { settings: preference.settings, merged };
}
