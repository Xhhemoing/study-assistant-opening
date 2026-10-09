import {
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  mergeOpeningCatalog,
  resolveEffectiveDailyCap,
  resolveOpeningModel,
} from "@aistudy/ai";
import {
  openingAiSettingsSchema,
  type OpeningAiSettings,
  type OpeningAiSettingsResponse,
  type OpeningModelSummary,
  type Scope,
  type TutorMode,
} from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../auth/service";

function catalogPricingConfigured(
  models: Array<{ inputCentsPerMillion: number; outputCentsPerMillion: number }>,
): boolean {
  return models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0);
}

/** Merged view: env catalog first, then web-managed workspace models (custom entries never override env ids). */
export async function loadMergedCatalog(sql: Sql, scope: Scope, effectiveCapCents: number) {
  const catalog = loadOpeningModelCatalog();
  const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
  return mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId,
    dailyCapCents: effectiveCapCents,
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

function resolveCapFromSettings(
  envCapCents: number,
  settings: OpeningAiSettings,
  pricingConfigured: boolean,
) {
  return resolveEffectiveDailyCap({
    envCapCents,
    workspaceCapCents: settings.dailyCapCents ?? null,
    confirmed: Boolean(settings.budgetConfirmedAt),
    pricingConfigured,
    ceilingCents: OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  });
}

function validateBudgetFields(settings: OpeningAiSettings, envCapCents: number, pricingConfigured: boolean) {
  const cap = settings.dailyCapCents;
  if (cap === undefined) return;
  if (cap === null) {
    if (settings.budgetConfirmedAt) {
      throw new ApiError("VALIDATION", "清除日额度时请同时取消确认时间。", 422);
    }
    return;
  }
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new ApiError("VALIDATION", "日额度必须是非负整数。", 422);
  }
  if (envCapCents > 0) {
    if (cap > envCapCents) {
      throw new ApiError("VALIDATION", `日额度不能超过运维上限 ${envCapCents} 分。`, 422);
    }
  } else {
    if (cap > OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS) {
      throw new ApiError("VALIDATION", `日额度不能超过 ${OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS} 分。`, 422);
    }
    if (cap > 0) {
      if (!settings.budgetConfirmedAt) {
        throw new ApiError("VALIDATION", "开启日额度前请先确认每日上限。", 422);
      }
      if (!pricingConfigured) {
        throw new ApiError("VALIDATION", "尚未配置模型定价，无法开启日额度。", 422);
      }
    }
  }
}

export async function readAiSettings(sql: Sql, scope: Scope): Promise<OpeningAiSettingsResponse> {
  const catalog = loadOpeningModelCatalog();
  const pricingConfigured = catalogPricingConfigured(catalog.models);
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  const effective = resolveCapFromSettings(catalog.dailyCapCents, preference.settings, pricingConfigured);
  const merged = mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId,
    dailyCapCents: effective.capCents,
  });
  return {
    ...preference,
    defaultModelId: merged.defaultModelId,
    dailyCapCents: effective.capCents,
    envCapCents: catalog.dailyCapCents,
    personalCeilingCents: OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
    models: merged.models.map(toSummary),
  };
}

export async function saveAiSettings(sql: Sql, scope: Scope, input: unknown): Promise<OpeningAiSettingsResponse> {
  const catalog = loadOpeningModelCatalog();
  const pricingConfigured = catalogPricingConfigured(catalog.models);
  const parsed = openingAiSettingsSchema.nullable().safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION", "模型设置格式无效，请重新选择后保存。", 422);
  if (parsed.data) {
    validateBudgetFields(parsed.data, catalog.dailyCapCents, pricingConfigured);
    const effective = resolveCapFromSettings(catalog.dailyCapCents, parsed.data, pricingConfigured);
    const merged = await loadMergedCatalog(sql, scope, effective.capCents);
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
