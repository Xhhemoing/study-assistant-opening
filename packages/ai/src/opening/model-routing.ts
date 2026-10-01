import type { OpeningAiSettings, OpeningModelSnapshot, OpeningModelSummary, TutorMode } from "@aistudy/contracts";

export class OpeningModelRoutingError extends Error {
  readonly code = "AI_ROUTE_UNAVAILABLE";
}

/** Explicit mode mapping only. Never guess quality or silently try another provider. */
export function selectedOpeningModelId(settings: OpeningAiSettings, mode: TutorMode, serverDefaultId: string | null): string | null {
  return settings.mode === "manual" ? settings.manualModelId : settings.routes[mode] ?? settings.defaultModelId ?? serverDefaultId;
}
export function resolveOpeningModel<T extends OpeningModelSummary>(models: T[], settings: OpeningAiSettings, mode: TutorMode, serverDefaultId: string | null): T {
  const id = selectedOpeningModelId(settings, mode, serverDefaultId);
  const model = models.find(item => item.id === id);
  if (!model) throw new OpeningModelRoutingError("所选模型已移除或尚未配置，请到设置重新选择模型。");
  if (model.availability !== "available") throw new OpeningModelRoutingError("所选模型暂不可用，请检查设置中的密钥、价格和预算状态；不会自动切换供应商。");
  return model;
}
export function openingModelSnapshot(model: OpeningModelSnapshot): OpeningModelSnapshot {
  return { id: model.id, providerId: model.providerId, modelName: model.modelName,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion };
}
