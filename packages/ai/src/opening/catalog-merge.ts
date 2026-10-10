import type { OpeningModelSummary } from "@aistudy/contracts";

export type WorkspaceCatalogModel = {
  id: string; providerId: string; providerLabel: string; label: string;
  modelName: string; baseUrl: string; apiKey: string; supportsVision: boolean;
  inputCentsPerMillion: number; outputCentsPerMillion: number;
  vaultConfigBroken?: boolean | undefined;
};

function availabilityFor(
  input: {
    apiKey: string;
    vaultConfigBroken?: boolean | undefined;
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
  },
  dailyCapCents: number,
): OpeningModelSummary["availability"] {
  if (input.vaultConfigBroken) return "vault_disabled";
  if (!input.apiKey) return "missing_key";
  if (dailyCapCents <= 0) return "budget_disabled";
  if (input.inputCentsPerMillion <= 0 || input.outputCentsPerMillion <= 0) return "pricing_missing";
  return "available";
}

/** Env catalog may mark missing_key / pricing_missing independently of the
 *  effective workspace cap. Only budget_disabled is recomputed from that cap. */
function serverAvailabilityWithEffectiveCap(
  model: OpeningModelSummary & { apiKey: string; vaultConfigBroken?: boolean | undefined },
  dailyCapCents: number,
): OpeningModelSummary["availability"] {
  if (
    model.availability === "missing_key" ||
    model.availability === "pricing_missing" ||
    model.availability === "vault_disabled"
  ) {
    return model.availability;
  }
  return availabilityFor(model, dailyCapCents);
}

type MergedCatalogEntry = OpeningModelSummary & { baseUrl: string; apiKey: string };

/**
 * Pick the merged default when workspace settings leave defaultModelId null.
 * Prefer an already-configured available workspace model over an env/catalog
 * stub that lacks keys (e.g. legacy gpt-4o-mini → missing_key). Never invent
 * a silent switch away from an available requested server default.
 */
export function resolveMergedDefaultModelId(
  models: Array<Pick<MergedCatalogEntry, "id" | "availability" | "source">>,
  requestedDefaultId: string | null,
): string | null {
  const requested = requestedDefaultId
    ? models.find(model => model.id === requestedDefaultId)
    : undefined;
  if (requested?.availability === "available") return requested.id;

  const workspaceAvailable = models.find(
    model => model.source === "workspace" && model.availability === "available",
  );
  if (workspaceAvailable) return workspaceAvailable.id;

  if (requested) return requested.id;

  const anyAvailable = models.find(model => model.availability === "available");
  if (anyAvailable) return anyAvailable.id;

  return requestedDefaultId ?? models[0]?.id ?? null;
}

/**
 * Merge the deployment env catalog with web-managed workspace models into one
 * resolvable list. Server entries keep priority: custom models never override
 * an env id, and the merged list stays capped at the same 32-model budget.
 * Availability uses the effective daily cap (env and/or workspace), so enabling
 * a workspace budget can clear env-only budget_disabled. Non-budget server
 * unavailability (missing_key, pricing_missing, vault_disabled) stays sticky.
 */
export function mergeOpeningCatalog(
  serverModels: Array<OpeningModelSummary & { baseUrl: string; apiKey: string }>,
  workspaceModels: WorkspaceCatalogModel[],
  input: { defaultModelId: string | null; dailyCapCents: number },
): { models: Array<OpeningModelSummary & { baseUrl: string; apiKey: string }>; defaultModelId: string | null; dailyCapCents: number } {
  const capacity = Math.max(0, 32 - serverModels.length);
  const serverIds = new Set(serverModels.map(model => model.id));
  const servers = serverModels.map(model => ({
    ...model,
    availability: serverAvailabilityWithEffectiveCap(model, input.dailyCapCents),
    source: model.source ?? ("server" as const),
  }));
  const custom = workspaceModels
    // Server ids win: a custom model may never shadow an env catalog entry.
    .filter(model => !serverIds.has(model.id))
    .slice(0, capacity)
    .map(model => ({
    id: model.id, providerId: model.providerId, providerLabel: model.providerLabel,
    label: model.label, modelName: model.modelName,
    availability: availabilityFor(model, input.dailyCapCents),
    supportsVision: model.supportsVision,
    baseUrl: model.baseUrl, apiKey: model.apiKey,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
    source: "workspace" as const,
  }));
  const models = [...servers, ...custom];
  return {
    models,
    // A removed custom default falls back via resolveMergedDefaultModelId;
    // routing still fails explicitly when the fallback is not itself selectable.
    defaultModelId: resolveMergedDefaultModelId(models, input.defaultModelId),
    dailyCapCents: input.dailyCapCents,
  };
}
