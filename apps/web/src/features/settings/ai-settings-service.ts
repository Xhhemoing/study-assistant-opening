import { openingAiSettingsSchema, type OpeningAiSettingsResponse, type Scope, type TutorMode } from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository } from "@aistudy/database";
import { resolveOpeningModel } from "@aistudy/ai";
import type { Sql } from "postgres";
import { ApiError } from "../auth/service";

export async function readAiSettings(sql: Sql, scope: Scope): Promise<OpeningAiSettingsResponse> {
  const catalog = loadOpeningModelCatalog();
  const preference = await createOpeningAiSettingsRepository(sql).get(scope);
  return {
    ...preference, defaultModelId: catalog.defaultModelId, dailyCapCents: catalog.dailyCapCents,
    models: catalog.models.map(model => ({
      id: model.id, providerId: model.providerId, providerLabel: model.providerLabel,
      label: model.label, modelName: model.modelName, availability: model.availability,
      inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
    })),
  };
}

export async function saveAiSettings(sql: Sql, scope: Scope, input: unknown): Promise<OpeningAiSettingsResponse> {
  const parsed = openingAiSettingsSchema.nullable().safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION", "模型设置格式无效，请重新选择后保存。", 422);
  if (parsed.data) {
    const catalog = loadOpeningModelCatalog();
    const settings = parsed.data;
    const ids = (settings.mode === "manual" ? [settings.manualModelId] : [settings.defaultModelId, ...Object.values(settings.routes)]).filter(id => id !== null);
    if (ids.some(id => !catalog.models.some(model => model.id === id))) throw new ApiError("VALIDATION", "有模型已从服务器目录移除，请重新选择或恢复默认设置。", 422);
    for (const mode of ["listen", "hint", "explain", "think_together"] as TutorMode[]) {
      resolveOpeningModel(catalog.models, settings, mode, catalog.defaultModelId);
    }
  }
  await createOpeningAiSettingsRepository(sql).set(scope, parsed.data);
  return readAiSettings(sql, scope);
}
