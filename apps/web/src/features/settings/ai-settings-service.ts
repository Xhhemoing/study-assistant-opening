import { openingAiSettingsSchema, type OpeningAiSettingsResponse, type OpeningModelSummary, type Scope, type TutorMode } from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import { mergeOpeningCatalog, resolveOpeningModel } from "@aistudy/ai";
import type { Sql } from "postgres";
import { ApiError } from "../auth/service";

/** Merged view: env catalog first, then web-managed workspace models (custom entries never override env ids). */
export async function loadMergedCatalog(sql: Sql, scope: Scope) {
  const catalog = loadOpeningModelCatalog();
  const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
  return mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId, dailyCapCents: catalog.dailyCapCents,
  });
}

function toSummary(model: OpeningModelSummary & { supportsVision?: boolean | undefined }): OpeningModelSummary {
  return {
    id: model.id, providerId: model.providerId, providerLabel: model.providerLabel,
    label: model.label, modelName: model.modelName, availability: model.availability,
    supportsVision: model.supportsVision ?? false, source: model.source,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
  };
}

export async function readAiSettings(sql: Sql, scope: Scope): Promise<OpeningAiSettingsResponse> {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  const merged = mergeOpeningCatalog(catalog.models, custom, { defaultModelId: catalog.defaultModelId, dailyCapCents: catalog.dailyCapCents });
  return {
    ...preference, defaultModelId: merged.defaultModelId, dailyCapCents: merged.dailyCapCents,
    models: merged.models.map(toSummary),
  };
}

export async function saveAiSettings(sql: Sql, scope: Scope, input: unknown): Promise<OpeningAiSettingsResponse> {
  const parsed = openingAiSettingsSchema.nullable().safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION", "模型设置格式无效，请重新选择后保存。", 422);
  if (parsed.data) {
    const merged = await loadMergedCatalog(sql, scope);
    const settings = parsed.data;
    const ids = (settings.mode === "manual" ? [settings.manualModelId] : [settings.defaultModelId, ...Object.values(settings.routes)]).filter(id => id !== null);
    if (ids.some(id => !merged.models.some(model => model.id === id))) throw new ApiError("VALIDATION", "有模型已从目录移除，请重新选择或恢复默认设置。", 422);
    for (const mode of ["listen", "hint", "explain", "think_together"] as TutorMode[]) {
      resolveOpeningModel(merged.models, settings, mode, merged.defaultModelId);
    }
  }
  await createOpeningAiSettingsRepository(sql).set(scope, parsed.data);
  return readAiSettings(sql, scope);
}
