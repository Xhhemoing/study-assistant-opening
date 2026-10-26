import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { OpeningModelRoutingError, openingModelSnapshot, resolveModelForTask, resolveFallbackModelForTask, selectedModelIdForTask, selectedFallbackModelIdForTask, resolveBudgetLocalDay, resolveBudgetTimeZone } from "@aistudy/ai";
import { loadOpeningAutoGradeDailyCap, loadOpeningModelCatalog, loadOpeningEmbeddingConfig } from "@aistudy/config";
import { createWorkspacePreferencesRepository, createOpeningPlanningSettingsRepository, loadOpeningRouting, type OpeningAutoGradePolicy } from "@aistudy/database";

export async function resolveAutoGradePolicy(sql: Sql, scope: Scope, photo = false): Promise<OpeningAutoGradePolicy> {
  const [preferences, planning] = await Promise.all([
    createWorkspacePreferencesRepository(sql).getLearningPreferences(scope), createOpeningPlanningSettingsRepository(sql).get(scope),
  ]);
  let modelAvailable = false;
  let modelUnavailableReason: "budget" | "no_model" = "no_model";
  let primaryModel: OpeningAutoGradePolicy["primaryModel"] = null;
  let fallbackModel: OpeningAutoGradePolicy["fallbackModel"] = null;
  let budgetOptions: OpeningAutoGradePolicy["budgetOptions"];
  let catalog: ReturnType<typeof loadOpeningModelCatalog> | undefined;
  let embedding: ReturnType<typeof loadOpeningEmbeddingConfig> = null;
  try {
    catalog = loadOpeningModelCatalog();
    embedding = loadOpeningEmbeddingConfig();
  } catch (error) {
    console.warn("Opening auto-grade model unavailable", { error: error instanceof Error ? error.name : "UnknownError" });
    catalog = undefined;
  }
  if (catalog) try {
    const { settings, merged } = await loadOpeningRouting(sql, scope, catalog);
    const task = photo ? "practice.grade-photo" : "practice.grade-text";
    const convert = (model: typeof merged.models[number]) => ({
      modelSnapshot: openingModelSnapshot(model), inputCentsPerMillion: model.inputCentsPerMillion,
      outputCentsPerMillion: model.outputCentsPerMillion, supportsVision: model.supportsVision,
      supportsAudio: model.supportsAudio, billing: model.billing, dailyRequestCap: model.dailyRequestCap,
      mediaInputTokenUpperBound: model.mediaInputTokenUpperBound, mediaMaxInputBytes: model.mediaMaxInputBytes,
      mediaInputCentsPerMillion: model.mediaInputCentsPerMillion,
    });
    const fallback = resolveFallbackModelForTask(merged.models, settings, task);
    fallbackModel = fallback ? convert(fallback) : null;
    try {
      primaryModel = convert(resolveModelForTask(merged.models, settings, task, merged.defaultModelId));
    } catch (error) {
      if (error instanceof OpeningModelRoutingError && !fallbackModel) {
        const selectedIds = [selectedModelIdForTask(settings, task, merged.defaultModelId), selectedFallbackModelIdForTask(settings, task)];
        if (merged.models.some(model => selectedIds.includes(model.id) && model.availability === "budget_disabled"
          && model.apiKey && model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0
          && (!photo || model.supportsVision))) modelUnavailableReason = "budget";
      }
      if (!(error instanceof OpeningModelRoutingError) || !fallbackModel) throw error;
    }
    budgetOptions = { envCapCents: catalog.dailyCapCents, dailyQuotaMode: catalog.dailyQuotaMode, parentCapCents: catalog.parentCapCents, pricingConfigured: Boolean(embedding && embedding.inputCentsPerMillion > 0) || catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0) };
    modelAvailable = true;
  } catch (error) {
    if (!(error instanceof OpeningModelRoutingError)) throw error;
    console.warn("Opening auto-grade model unavailable", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  let dailyCap = 0;
  try {
    dailyCap = loadOpeningAutoGradeDailyCap();
  } catch (error) {
    console.warn("Opening auto-grade daily cap unavailable", { error: error instanceof Error ? error.name : "UnknownError" });
  }
  const day = resolveBudgetLocalDay(new Date(), resolveBudgetTimeZone(planning.settings?.timeZone));
  return { enabled: preferences.autoGradeOnSave, modelAvailable, modelUnavailableReason, dailyCap, dayStart: day.dayStart, dayEnd: day.nextDayStart, primaryModel, fallbackModel, budgetOptions };
}
