import {
  createModelGateway,
  createOpeningProvider,
  mergeOpeningCatalog,
  openingModelSnapshot,
  resolveEffectiveDailyCap,
  resolveFallbackModelForTask,
  resolveModelForTask,
  tutorModelTask,
  OpeningModelRoutingError,
  type BudgetedRepository,
  type ModelTaskKey,
  type ModelGatewayCallOptions,
  type ResolvedTaskModel,
} from "@aistudy/ai";
import { loadOpeningModelCatalog, parseBooleanEnv } from "@aistudy/config";
import {
  createOpeningAiSettingsRepository,
  createOpeningModelProvidersRepository,
  type OpeningBudgetRepository,
} from "@aistudy/database";
import type { Scope, TutorMode } from "@aistudy/contracts";
import type { Sql } from "postgres";

/**
 * The only place that turns configuration into a provider: server catalog +
 * workspace BYOK models + effective cap + workspace routing. Resolve once per
 * call; the same selection supplies provider, prices and ledger attribution.
 */
async function loadRouting(sql: Sql, scope: Scope) {
  const catalog = loadOpeningModelCatalog();
  const [preference, custom] = await Promise.all([
    createOpeningAiSettingsRepository(sql).get(scope),
    createOpeningModelProvidersRepository(sql).listResolvableModels(scope),
  ]);
  if (preference.invalidStoredSettings) throw new OpeningModelRoutingError("已保存的模型设置无效，请到设置重新保存或恢复服务器默认设置。");
  // Match ai-settings / readiness: effective workspace cap (not env-only) so a
  // BYOK Lant model is not falsely budget_disabled when env cap is 0.
  const pricingConfigured =
    catalog.models.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0)
    || custom.some(model => model.inputCentsPerMillion > 0 && model.outputCentsPerMillion > 0);
  const effective = resolveEffectiveDailyCap({
    envCapCents: catalog.dailyCapCents,
    workspaceCapCents: preference.settings.dailyCapCents ?? null,
    confirmed: Boolean(preference.settings.budgetConfirmedAt),
    pricingConfigured,
  });
  const merged = mergeOpeningCatalog(catalog.models, custom, {
    defaultModelId: catalog.defaultModelId,
    dailyCapCents: effective.capCents,
  });
  return { settings: preference.settings, merged };
}

type MergedModel = ReturnType<typeof mergeOpeningCatalog>["models"][number];

function toResolved(model: MergedModel, task: ModelTaskKey): ResolvedTaskModel {
  const timeoutMs = task === "teaching.compile" || task === "knowledge.extract" ? 240_000
    : task === "media.transcribe" ? 180_000 : task.startsWith("practice.grade-") ? 120_000
      : task === "settings.probe" ? 30_000 : 60_000;
  return {
    provider: createOpeningProvider({
      baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName,
      supportsVision: model.supportsVision, supportsAudio: model.supportsAudio,
      mediaInputTokenUpperBound: model.mediaInputTokenUpperBound, mediaMaxInputBytes: model.mediaMaxInputBytes,
      mediaInputCentsPerMillion: model.mediaInputCentsPerMillion,
      answerStyle: parseBooleanEnv(process.env, "OPENING_ANSWER_STYLE", true),
      timeoutMs, idleTimeoutMs: 60_000,
    }),
    modelSnapshot: openingModelSnapshot(model),
    inputCentsPerMillion: model.inputCentsPerMillion,
    outputCentsPerMillion: model.outputCentsPerMillion,
    supportsVision: model.supportsVision,
    supportsAudio: model.supportsAudio ?? false,
    mediaInputTokenUpperBound: model.mediaInputTokenUpperBound, mediaMaxInputBytes: model.mediaMaxInputBytes,
    mediaInputCentsPerMillion: model.mediaInputCentsPerMillion,
    billing: model.billing ?? "metered",
    dailyRequestCap: model.dailyRequestCap ?? null,
  };
}

export async function resolveTaskModel(sql: Sql, scope: Scope, task: ModelTaskKey): Promise<ResolvedTaskModel> {
  const { settings, merged } = await loadRouting(sql, scope);
  return toResolved(resolveModelForTask(merged.models, settings, task, merged.defaultModelId), task);
}

/** The user's explicit fallback for a task, or null (unset, removed or unable to serve it). */
export async function resolveFallbackTaskModel(sql: Sql, scope: Scope, task: ModelTaskKey): Promise<ResolvedTaskModel | null> {
  const { settings, merged } = await loadRouting(sql, scope);
  const model = resolveFallbackModelForTask(merged.models, settings, task);
  return model ? toResolved(model, task) : null;
}

export function resolveTutorModel(sql: Sql, scope: Scope, mode: TutorMode): Promise<ResolvedTaskModel> {
  return resolveTaskModel(sql, scope, tutorModelTask(mode));
}

export function resolveTutorFallbackModel(sql: Sql, scope: Scope, mode: TutorMode): Promise<ResolvedTaskModel | null> {
  return resolveFallbackTaskModel(sql, scope, tutorModelTask(mode));
}

export function createDbModelGateway(sql: Sql) {
  return createModelGateway({
    resolve: (scope, task) => resolveTaskModel(sql, scope, task),
    resolveFallback: (scope, task) => resolveFallbackTaskModel(sql, scope, task),
  });
}

/** Connectivity checks use one explicitly selected owned model, with no fallback. */
export async function probeDbModel(sql: Sql, scope: Scope, providerId: string, modelId: string, options: ModelGatewayCallOptions) {
  const { settings, merged } = await loadRouting(sql, scope);
  const model = resolveModelForTask(merged.models, {
    ...settings, mode: "automatic", taskRoutes: { ...settings.taskRoutes, "settings.probe": { primary: modelId, fallback: null } },
  }, "settings.probe", merged.defaultModelId);
  if (model.providerId !== providerId || model.source !== "workspace") throw new OpeningModelRoutingError("模型不存在或不属于此服务商。");
  return createModelGateway({ resolve: async () => toResolved(model, "settings.probe") }).call(scope, "settings.probe", options);
}

/** Bind the shared ledger repository to one owner scope for runBudgetedCall. */
export function scopeBudget(budget: OpeningBudgetRepository, scope: Scope): BudgetedRepository {
  return {
    reserve: (input) => budget.reserve(scope, input),
    release: (requestId, reason) => budget.release(scope, requestId, reason),
    claimExecution: (reservationId) => budget.claimExecution(scope, reservationId),
    settle: (...args) => budget.settle(scope, ...args),
    markUnknown: (reservationId) => budget.markUnknown(scope, reservationId),
  };
}
