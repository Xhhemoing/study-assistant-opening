import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  mergeOpeningCatalog,
  resolveEffectiveDailyCap,
  resolveOpeningModel,
  type EffectiveDailyCapResult,
} from "@aistudy/ai";
import { openingAiSettingsSchema, type OpeningAiSettings, type OpeningAiSettingsResponse, type OpeningModelSummary, type Scope, type TutorMode } from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../auth/service";

function pricingConfigured(models: Array<{ inputCentsPerMillion: number; outputCentsPerMillion: number; apiKey: string }>): boolean {
  return models.some(model => model.apiKey.length > 0 && model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0);
}

export async function resolveWorkspaceEffectiveCap(sql: Sql, scope: Scope): Promise<EffectiveDailyCapResult & {
  envCapCents: number;
  workspaceCapCents: number | null;
  budgetConfirmedAt: string | null;
  settings: OpeningAiSettings;
  invalidStoredSettings: boolean;
  saved: boolean;
}> {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  const workspaceCapCents = preference.settings.dailyCapCents ?? null;
  const budgetConfirmedAt = preference.settings.budgetConfirmedAt ?? null;
  const effective = resolveEffectiveDailyCap({
    envCapCents: catalog.dailyCapCents,
    workspaceCapCents,
    confirmed: budgetConfirmedAt != null,
    pricingConfigured: pricingConfigured([...catalog.models, ...custom]),
  });
  return {
    ...effective,
    envCapCents: catalog.dailyCapCents,
    workspaceCapCents,
    budgetConfirmedAt,
    settings: preference.settings,
    invalidStoredSettings: preference.invalidStoredSettings,
    saved: preference.saved,
  };
}

/** Merged view: env catalog first, then web-managed workspace models (custom entries never override env ids). */
export async function loadMergedCatalog(sql: Sql, scope: Scope) {
  const catalog = loadOpeningModelCatalog();
  const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
  const effective = await resolveWorkspaceEffectiveCap(sql, scope);
  return mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId, dailyCapCents: effective.capCents,
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
  const effective = await resolveWorkspaceEffectiveCap(sql, scope);
  const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
  const merged = mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId, dailyCapCents: effective.capCents,
  });
  return {
    settings: effective.settings,
    saved: effective.saved,
    invalidStoredSettings: effective.invalidStoredSettings,
    defaultModelId: merged.defaultModelId,
    dailyCapCents: effective.capCents,
    envDailyCapCents: effective.envCapCents,
    workspaceDailyCapCents: effective.workspaceCapCents,
    budgetConfirmedAt: effective.budgetConfirmedAt,
    effectiveCapSource: effective.source,
    models: merged.models.map(toSummary),
  };
}

function validateWorkspaceBudget(input: OpeningAiSettings, envCapCents: number): void {
  const cap = input.dailyCapCents;
  if (cap == null) return;
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new ApiError("VALIDATION", "日额度必须是非负整数（分）。", 422);
  }
  const ceiling = envCapCents > 0 ? envCapCents : OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS;
  if (cap > ceiling) {
    throw new ApiError("VALIDATION", `日额度不能超过上限 ${ceiling} 分。`, 422);
  }
  if (input.budgetConfirmedAt != null) {
    const parsed = Date.parse(input.budgetConfirmedAt);
    if (!Number.isFinite(parsed)) {
      throw new ApiError("VALIDATION", "预算确认时间无效。", 422);
    }
  }
}

export async function saveAiSettings(sql: Sql, scope: Scope, input: unknown): Promise<OpeningAiSettingsResponse> {
  const parsed = openingAiSettingsSchema.nullable().safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION", "模型设置格式无效，请重新选择后保存。", 422);
  if (parsed.data) {
    const catalog = loadOpeningModelCatalog();
    validateWorkspaceBudget(parsed.data, catalog.dailyCapCents);
    const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
    const pendingEffective = resolveEffectiveDailyCap({
      envCapCents: catalog.dailyCapCents,
      workspaceCapCents: parsed.data.dailyCapCents ?? null,
      confirmed: parsed.data.budgetConfirmedAt != null,
      pricingConfigured: pricingConfigured([...catalog.models, ...custom]),
    });
    const merged = mergeOpeningCatalog(catalog.models, custom, {
      defaultModelId: catalog.defaultModelId, dailyCapCents: pendingEffective.capCents,
    });
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
