import { createOpeningProvider, openingModelSnapshot, resolveOpeningModel, OpeningModelRoutingError } from "@aistudy/ai";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository } from "@aistudy/database";
import type { Scope, TutorMode } from "@aistudy/contracts";
import type { Sql } from "postgres";

/** Resolve once per call; the same selection supplies provider, prices and ledger attribution. */
export async function resolveTutorModel(sql: Sql, scope: Scope, mode: TutorMode) {
  const catalog = loadOpeningModelCatalog();
  const preference = await createOpeningAiSettingsRepository(sql).get(scope);
  if (preference.invalidStoredSettings) throw new OpeningModelRoutingError("已保存的模型设置无效，请到设置重新保存或恢复服务器默认设置。");
  const model = resolveOpeningModel(catalog.models, preference.settings, mode, catalog.defaultModelId);
  return {
    provider: createOpeningProvider({ baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName }),
    modelSnapshot: openingModelSnapshot(model),
    inputCentsPerMillion: model.inputCentsPerMillion,
    outputCentsPerMillion: model.outputCentsPerMillion,
  };
}
