import {
  createModelGateway,
  createOpeningProvider,
  mergeOpeningCatalog,
  openingModelSnapshot,
  resolveEffectiveDailyCap,
  resolveModelForTask,
  tutorModelTask,
  OpeningModelRoutingError,
  type BudgetedRepository,
  type ModelTaskKey,
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
export async function resolveTaskModel(sql: Sql, scope: Scope, task: ModelTaskKey): Promise<ResolvedTaskModel> {
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
  const model = resolveModelForTask(merged.models, preference.settings, task, merged.defaultModelId);
  return {
    provider: createOpeningProvider({ baseUrl: model.baseUrl, apiKey: model.apiKey, model: model.modelName, supportsVision: model.supportsVision, answerStyle: parseBooleanEnv(process.env, "OPENING_ANSWER_STYLE", true) }),
    modelSnapshot: openingModelSnapshot(model),
    inputCentsPerMillion: model.inputCentsPerMillion,
    outputCentsPerMillion: model.outputCentsPerMillion,
    supportsVision: model.supportsVision,
  };
}

export function resolveTutorModel(sql: Sql, scope: Scope, mode: TutorMode): Promise<ResolvedTaskModel> {
  return resolveTaskModel(sql, scope, tutorModelTask(mode));
}

export function createDbModelGateway(sql: Sql) {
  return createModelGateway({ resolve: (scope, task) => resolveTaskModel(sql, scope, task) });
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
