import type { OpeningAiSettings, OpeningModelSnapshot, OpeningModelSummary, TutorMode } from "@aistudy/contracts";
import { modelTaskSpec, type ModelInputKind, type ModelTaskKey } from "./model-tasks";

export class OpeningModelRoutingError extends Error {
  readonly code = "AI_ROUTE_UNAVAILABLE";
}

/** Explicit mode mapping only. Never guess quality or silently try another provider. */
export function selectedOpeningModelId(settings: OpeningAiSettings, mode: TutorMode, serverDefaultId: string | null): string | null {
  return settings.mode === "manual" ? settings.manualModelId : settings.routes[mode] ?? settings.defaultModelId ?? serverDefaultId;
}
/**
 * Manual lock → task route → tutor mode route (tutor tasks) → workspace default → server default.
 * The manual lock wins so "use this one model everywhere" stays one switch.
 */
export function selectedModelIdForTask(settings: OpeningAiSettings, task: ModelTaskKey, serverDefaultId: string | null): string | null {
  if (settings.mode === "manual") return settings.manualModelId;
  const taskPrimary = settings.taskRoutes?.[task]?.primary;
  if (taskPrimary) return taskPrimary;
  const { tutorMode } = modelTaskSpec(task);
  if (tutorMode) return selectedOpeningModelId(settings, tutorMode, serverDefaultId);
  return settings.defaultModelId ?? serverDefaultId;
}
/** The user's explicit fallback for a task; never inferred. */
export function selectedFallbackModelIdForTask(settings: OpeningAiSettings, task: ModelTaskKey): string | null {
  return settings.taskRoutes?.[task]?.fallback ?? null;
}
export function resolveOpeningModel<T extends OpeningModelSummary>(models: T[], settings: OpeningAiSettings, mode: TutorMode, serverDefaultId: string | null): T {
  return pickAvailableModel(models, selectedOpeningModelId(settings, mode, serverDefaultId));
}
export function resolveModelForTask<T extends OpeningModelSummary>(models: T[], settings: OpeningAiSettings, task: ModelTaskKey, serverDefaultId: string | null): T {
  return assertTaskInputs(pickAvailableModel(models, selectedModelIdForTask(settings, task, serverDefaultId)), task);
}
/** Null when no fallback is configured or it cannot serve the task; the primary error then stands. */
export function resolveFallbackModelForTask<T extends OpeningModelSummary>(models: T[], settings: OpeningAiSettings, task: ModelTaskKey): T | null {
  const id = selectedFallbackModelIdForTask(settings, task);
  if (!id) return null;
  try {
    return assertTaskInputs(pickAvailableModel(models, id), task);
  } catch (error) {
    if (error instanceof OpeningModelRoutingError) return null;
    throw error;
  }
}
const INPUT_LABEL: Record<ModelInputKind, string> = { vision: "图片输入", audio: "音频输入" };
function assertTaskInputs<T extends OpeningModelSummary>(model: T, task: ModelTaskKey): T {
  for (const need of modelTaskSpec(task).needs ?? []) {
    const ok = need === "vision" ? model.supportsVision === true : model.supportsAudio === true;
    if (!ok) throw new OpeningModelRoutingError(`所选模型不支持${INPUT_LABEL[need]}，请为「${modelTaskSpec(task).label}」选择支持的模型。`);
  }
  return model;
}
function pickAvailableModel<T extends OpeningModelSummary>(models: T[], id: string | null): T {
  const model = models.find(item => item.id === id);
  if (!model) throw new OpeningModelRoutingError("所选模型已移除或尚未配置，请到设置重新选择模型。");
  if (model.availability !== "available") throw new OpeningModelRoutingError("所选模型暂不可用，请检查设置中的密钥、价格和预算状态；不会自动切换供应商。");
  return model;
}
export function openingModelSnapshot(model: OpeningModelSnapshot): OpeningModelSnapshot {
  return { id: model.id, providerId: model.providerId, modelName: model.modelName,
    inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion,
    ...(model.mediaInputTokenUpperBound === undefined ? {} : { mediaInputTokenUpperBound: model.mediaInputTokenUpperBound,
      mediaMaxInputBytes: model.mediaMaxInputBytes, mediaInputCentsPerMillion: model.mediaInputCentsPerMillion }) };
}
