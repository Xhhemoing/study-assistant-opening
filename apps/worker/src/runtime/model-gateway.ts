import {
  createModelGateway,
  createOpeningProvider,
  mergeOpeningCatalog,
  openingModelSnapshot,
  resolveFallbackModelForTask,
  resolveModelForTask,
  tutorModelTask,
  OpeningModelRoutingError,
  type BudgetedRepository,
  type ModelTaskKey,
  type ModelGatewayCallOptions,
  type ResolvedTaskModel,
  independentTeachingSolver,
  type TeachingBlindSolveConfig,
} from "@aistudy/ai";
import { loadOpeningModelCatalog, parseBooleanEnv } from "@aistudy/config";
import {
  loadOpeningRouting,
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
  return loadOpeningRouting(sql, scope, loadOpeningModelCatalog());
}

type MergedModel = ReturnType<typeof mergeOpeningCatalog>["models"][number];

function toResolved(model: MergedModel, task: ModelTaskKey): ResolvedTaskModel {
  const timeoutMs = task === "teaching.compile" || task === "knowledge.extract" || task === "practice.exam" ? 240_000
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

/** Server-only explicit identities. Reading configuration never enables a call by itself. */
export function teachingBlindSolveConfig(env: NodeJS.ProcessEnv = process.env): TeachingBlindSolveConfig | null {
  const config = {
    solver: { providerId: env.OPENING_TEACHING_SOLVER_PROVIDER_ID ?? "", modelName: env.OPENING_TEACHING_SOLVER_MODEL ?? "", family: env.OPENING_TEACHING_SOLVER_FAMILY ?? "" },
    generator: { providerId: env.OPENING_TEACHING_GENERATOR_PROVIDER_ID ?? "", modelName: env.OPENING_TEACHING_GENERATOR_MODEL ?? "", family: env.OPENING_TEACHING_GENERATOR_FAMILY ?? "" },
  };
  return independentTeachingSolver(config) ? config : null;
}

export async function resolveTaskModel(sql: Sql, scope: Scope, task: ModelTaskKey): Promise<ResolvedTaskModel> {
  const config = task === "teaching.solve" ? teachingBlindSolveConfig() : null;
  if (task === "teaching.solve" && !config) throw new OpeningModelRoutingError("异家族盲解未配置；不会使用编译模型。");
  const { settings, merged } = await loadRouting(sql, scope);
  if (task === "teaching.solve") {
    const candidates = merged.models.filter(model => model.providerId === config!.solver.providerId && model.modelName === config!.solver.modelName);
    if (candidates.length !== 1) throw new OpeningModelRoutingError("盲解模型身份不唯一或未配置。");
    const explicit = { ...settings, mode: "automatic" as const, taskRoutes: { ...settings.taskRoutes, [task]: { primary: candidates[0]!.id, fallback: null } } };
    return toResolved(resolveModelForTask(merged.models, explicit, task, null), task);
  }
  return toResolved(resolveModelForTask(merged.models, settings, task, merged.defaultModelId), task);
}

/** The user's explicit fallback for a task, or null (unset, removed or unable to serve it). */
export async function resolveFallbackTaskModel(sql: Sql, scope: Scope, task: ModelTaskKey): Promise<ResolvedTaskModel | null> {
  if (task === "teaching.solve") return null;
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
