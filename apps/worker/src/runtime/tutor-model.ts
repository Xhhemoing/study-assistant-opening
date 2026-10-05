import { createOpeningProvider, mergeOpeningCatalog, openingModelSnapshot, resolveOpeningModel, OpeningModelRoutingError } from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import type { Scope, TutorMode } from "@aistudy/contracts";
import type { Sql } from "postgres";

/** Resolve once per call; the same selection supplies provider, prices and ledger attribution. */
export async function resolveTutorModel(sql: Sql, scope: Scope, mode: TutorMode) {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  if (preference.invalidStoredSettings) throw new OpeningModelRoutingError("已保存的模型设置无效，请到设置重新保存或恢复服务器默认设置。");
  const merged = mergeOpeningCatalog(catalog.models, custom, { defaultModelId: catalog.defaultModelId, dailyCapCents: catalog.dailyCapCents });
  const model = resolveOpeningModel(merged.models, preference.settings, mode, merged.defaultModelId);
  return {
    provider: createOpeningProvider({ baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName, supportsVision: model.supportsVision }),
    modelSnapshot: openingModelSnapshot(model),
    inputCentsPerMillion: model.inputCentsPerMillion,
    outputCentsPerMillion: model.outputCentsPerMillion,
    supportsVision: model.supportsVision,
  };
}
