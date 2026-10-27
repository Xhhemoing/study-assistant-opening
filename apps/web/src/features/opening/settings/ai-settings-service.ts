import {
  MODEL_TASKS,
  OpeningModelRoutingError,
  OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
  mergeOpeningCatalog,
  resolveEffectiveDailyCap,
  resolveFallbackModelForTask,
  resolveModelForTask,
  type ModelTaskKey,
} from "@aistudy/ai";
import {
  openingAiSettingsSchema,
  type OpeningAiSettings,
  type OpeningAiSettingsResponse,
  type OpeningModelSummary,
  type Scope,
} from "@aistudy/contracts";
import { loadOpeningModelCatalog } from "@aistudy/config";
import { createOpeningAiSettingsRepository, createOpeningModelProvidersRepository, OpeningBudgetError, readOpeningDailyBudgetUsage } from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

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
    dailyCapCents: effectiveCapCents, dailyQuotaMode: catalog.dailyQuotaMode,
  });
}

function toSummary(model: OpeningModelSummary & { supportsVision?: boolean | undefined }): OpeningModelSummary {
  return {
    id: model.id, providerId: model.providerId, providerLabel: model.providerLabel,
    label: model.label, modelName: model.modelName, availability: model.availability,
    supportsVision: model.supportsVision ?? false, source: model.source,
    supportsAudio: model.supportsAudio ?? false, billing: model.billing ?? "metered",
    dailyRequestCap: model.dailyRequestCap ?? null,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
  };
}

/** The routing UI is generated from the registry, so a new task shows up without UI changes. */
const TASK_VIEWS = Object.entries(MODEL_TASKS).filter(([, spec]) => spec.group !== "settings").map(([key, spec]) => ({
  key, label: spec.label, group: spec.group,
  needs: [...("needs" in spec ? (spec.needs as readonly ("vision" | "audio")[]) : [])],
}));

function isModelTaskKey(key: string): key is ModelTaskKey {
  return Object.prototype.hasOwnProperty.call(MODEL_TASKS, key);
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

export function validateBudgetFields(settings: OpeningAiSettings, envCapCents: number, pricingConfigured: boolean) {
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
  const [preference, custom, dailyUsage] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
    // A display-only usage failure must not disable configuration repair or imply zero spend.
    readOpeningDailyBudgetUsage(sql, scope).catch(error => {
      if (error instanceof OpeningBudgetError) throw error;
      return null;
    }),
  ]);
  // Include workspace BYOK pricing so Lant-only workspaces are not treated as unpriced.
  const pricingConfigured = catalogPricingConfigured([...catalog.models, ...custom]);
  const effective = resolveCapFromSettings(catalog.dailyCapCents, preference.settings, pricingConfigured);
  const merged = mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId,
    dailyCapCents: effective.capCents, dailyQuotaMode: catalog.dailyQuotaMode,
  });
  return {
    ...preference,
    defaultModelId: merged.defaultModelId,
    dailyCapCents: effective.capCents,
    dailyQuota: catalog.dailyQuotaMode === "unlimited" ? { mode: "unlimited" } : { mode: "limited", capCents: effective.capCents },
    dailyUsage,
    envCapCents: catalog.dailyCapCents,
    personalCeilingCents: OPENING_PERSONAL_DAILY_CAP_CEILING_CENTS,
    models: merged.models.map(toSummary),
    tasks: TASK_VIEWS,
  };
}

export async function saveAiSettings(sql: Sql, scope: Scope, input: unknown): Promise<OpeningAiSettingsResponse> {
  const catalog = loadOpeningModelCatalog();
  const parsed = openingAiSettingsSchema.nullable().safeParse(input);
  if (!parsed.success) throw new ApiError("VALIDATION", "模型设置格式无效，请重新选择后保存。", 422);
  if (parsed.data) {
    const custom = await createOpeningModelProvidersRepository(sql).listResolvableModels(scope);
    const pricingConfigured = catalogPricingConfigured([...catalog.models, ...custom]);
    if (catalog.dailyQuotaMode !== "unlimited") validateBudgetFields(parsed.data, catalog.dailyCapCents, pricingConfigured);
    const effective = resolveCapFromSettings(catalog.dailyCapCents, parsed.data, pricingConfigured);
    const merged = mergeOpeningCatalog(catalog.models, custom, {
      defaultModelId: catalog.defaultModelId,
      dailyCapCents: effective.capCents, dailyQuotaMode: catalog.dailyQuotaMode,
    });
    const settings = parsed.data;
    const taskRoutes = Object.entries(settings.taskRoutes ?? {});
    if (taskRoutes.some(([key]) => !isModelTaskKey(key))) throw new ApiError("VALIDATION", "包含未知的模型用途，请刷新设置页后重新保存。", 422);
    const ids = [
      ...(settings.mode === "manual" ? [settings.manualModelId] : [settings.defaultModelId, ...Object.values(settings.routes)]),
      ...taskRoutes.flatMap(([, route]) => [route.primary, route.fallback]),
    ].filter(id => id !== null);
    if (ids.some(id => !merged.models.some(model => model.id === id))) throw new ApiError("VALIDATION", "有模型已从目录移除，请重新选择或恢复默认设置。", 422);
    // Every tutor mode and every explicitly routed task must resolve as saved.
    const checked = new Set<ModelTaskKey>([
      ...(Object.keys(MODEL_TASKS) as ModelTaskKey[]).filter(key => key.startsWith("tutor.")),
      ...taskRoutes.map(([key]) => key as ModelTaskKey),
    ]);
    for (const task of checked) {
      const fallback = resolveFallbackModelForTask(merged.models, settings, task);
      if (settings.taskRoutes?.[task]?.fallback && !fallback) {
        throw new ApiError("VALIDATION", `「${MODEL_TASKS[task].label}」的备用模型暂不可用或不支持该用途。`, 422);
      }
      try {
        resolveModelForTask(merged.models, settings, task, merged.defaultModelId);
      } catch (error) {
        // An inherited text default can still transcribe via the user's explicit audio fallback.
        if (!(error instanceof OpeningModelRoutingError) || task !== "media.transcribe" || settings.taskRoutes?.[task]?.primary || !fallback) throw error;
      }
    }
    if (settings.transcription?.engine === "model") {
      try {
        resolveModelForTask(merged.models, settings, "media.transcribe", merged.defaultModelId);
      } catch (error) {
        if (!(error instanceof OpeningModelRoutingError)) throw error;
        if (!resolveFallbackModelForTask(merged.models, settings, "media.transcribe")) {
          throw new ApiError("VALIDATION", "模型转写需要可用且支持音频输入的模型，请先配置音视频转写用途。", 422);
        }
      }
    }
  }
  await createOpeningAiSettingsRepository(sql).set(scope, parsed.data);
  return readAiSettings(sql, scope);
}
