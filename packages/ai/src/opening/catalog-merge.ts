import type { OpeningModelSummary } from "@aistudy/contracts";

export type WorkspaceCatalogModel = {
  id: string; providerId: string; providerLabel: string; label: string;
  modelName: string; baseUrl: string; apiKey: string; supportsVision: boolean;
  inputCentsPerMillion: number; outputCentsPerMillion: number;
  vaultConfigBroken?: boolean | undefined;
};

/**
 * Merge the deployment env catalog with web-managed workspace models into one
 * resolvable list. Server entries keep priority: custom models never override
 * an env id, and the merged list stays capped at the same 32-model budget.
 * Availability mirrors the env catalog semantics; a workspace model whose key
 * cannot be decrypted is `vault_disabled`, never silently skipped.
 */
export function mergeOpeningCatalog(
  serverModels: Array<OpeningModelSummary & { baseUrl: string; apiKey: string }>,
  workspaceModels: WorkspaceCatalogModel[],
  input: { defaultModelId: string | null; dailyCapCents: number },
): { models: Array<OpeningModelSummary & { baseUrl: string; apiKey: string }>; defaultModelId: string | null; dailyCapCents: number } {
  const capacity = Math.max(0, 32 - serverModels.length);
  const serverIds = new Set(serverModels.map(model => model.id));
  const custom = workspaceModels
    // Server ids win: a custom model may never shadow an env catalog entry.
    .filter(model => !serverIds.has(model.id))
    .slice(0, capacity)
    .map(model => ({
    id: model.id, providerId: model.providerId, providerLabel: model.providerLabel,
    label: model.label, modelName: model.modelName,
    availability: model.vaultConfigBroken ? "vault_disabled" as const
      : !model.apiKey ? "missing_key" as const
      : input.dailyCapCents <= 0 ? "budget_disabled" as const
      : model.inputCentsPerMillion <= 0 || model.outputCentsPerMillion <= 0 ? "pricing_missing" as const
      : "available" as const,
    supportsVision: model.supportsVision,
    baseUrl: model.baseUrl, apiKey: model.apiKey,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
    source: "workspace" as const,
  }));
  return {
    models: [...serverModels, ...custom],
    // A removed custom default falls back to the server default; routing still
    // fails explicitly when the fallback is not itself selectable.
    defaultModelId: input.defaultModelId ?? serverModels[0]?.id ?? null,
    dailyCapCents: input.dailyCapCents,
  };
}
