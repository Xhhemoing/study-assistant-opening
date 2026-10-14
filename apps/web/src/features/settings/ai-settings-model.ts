import type { OpeningAiSettings, OpeningAiSettingsResponse, OpeningModelSummary, TutorMode } from "@aistudy/contracts";
import { selectedFallbackModelIdForTask, selectedModelIdForTask, selectedOpeningModelId, type ModelTaskKey } from "@aistudy/ai";

export const tutorRouteLabels: Array<{ mode: TutorMode; label: string }> = [
  { mode: "listen", label: "倾听" }, { mode: "hint", label: "提示" },
  { mode: "explain", label: "解释" }, { mode: "think_together", label: "共同思考" },
];
export const availabilityLabels: Record<OpeningModelSummary["availability"], string> = {
  available: "已配置", missing_key: "缺少服务器密钥", budget_disabled: "服务器日预算未启用",
  pricing_missing: "缺少服务器价格", vault_disabled: "密钥加密不可用",
};
export function modelOptions(models: OpeningModelSummary[], providerId: string, selectedId: string | null) {
  return models.filter(model => !providerId || model.providerId === providerId || model.id === selectedId);
}
export function effectiveModelRoutes(data: OpeningAiSettingsResponse, settings: OpeningAiSettings) {
  return tutorRouteLabels.map(({ mode, label }) => {
    const id = selectedOpeningModelId(settings, mode, data.defaultModelId);
    const model = data.models.find(item => item.id === id);
    return { mode, label, id, model, problem: !model ? "模型已移除或尚未配置" : model.availability === "available" ? null : availabilityLabels[model.availability] };
  });
}

export function switchRoutingMode(settings: OpeningAiSettings, mode: OpeningAiSettings["mode"], serverDefaultId: string | null): OpeningAiSettings {
  return { ...settings, mode, manualModelId: mode === "manual" ? settings.manualModelId ?? settings.defaultModelId ?? serverDefaultId : settings.manualModelId };
}
export function hasRemovedActiveModel(data: OpeningAiSettingsResponse, settings: OpeningAiSettings): boolean {
  const ids = [
    ...(settings.mode === "manual" ? [settings.manualModelId] : [settings.defaultModelId, ...Object.values(settings.routes)]),
    ...Object.values(settings.taskRoutes ?? {}).flatMap(route => [route.primary, route.fallback]),
  ];
  return ids.some(id => id !== null && !data.models.some(model => model.id === id));
}

export type TaskView = NonNullable<OpeningAiSettingsResponse["tasks"]>[number];
const NEED_LABEL = { vision: "图片输入", audio: "音频输入" } as const;
export const taskGroupLabels: Record<string, string> = {
  tutor: "辅导", teaching: "AI 主讲", materials: "材料处理", practice: "练习", planning: "规划",
};

/** Why a model cannot serve a task, or null. Mirrors gateway routing (availability, then inputs). */
export function modelProblemForTask(model: OpeningModelSummary | undefined, task: TaskView): string | null {
  if (!model) return "模型已移除或尚未配置";
  if (model.availability !== "available") return availabilityLabels[model.availability];
  const missing = task.needs.find(need => need === "vision" ? !model.supportsVision : !model.supportsAudio);
  return missing ? `不支持${NEED_LABEL[missing]}` : null;
}

/** The model each task will use after save, plus its explicit fallback. */
export function effectiveTaskRoutes(data: OpeningAiSettingsResponse, settings: OpeningAiSettings) {
  return (data.tasks ?? []).map(task => {
    const key = task.key as ModelTaskKey;
    const id = selectedModelIdForTask(settings, key, data.defaultModelId);
    const model = data.models.find(item => item.id === id);
    const fallbackId = selectedFallbackModelIdForTask(settings, key);
    const fallbackModel = fallbackId ? data.models.find(item => item.id === fallbackId) : undefined;
    return {
      task, id, model, problem: modelProblemForTask(model, task),
      fallbackId, fallbackModel, fallbackProblem: fallbackId ? modelProblemForTask(fallbackModel, task) : null,
    };
  });
}

export function setTaskRoute(settings: OpeningAiSettings, task: string, patch: { primary?: string | null; fallback?: string | null }): OpeningAiSettings {
  const current = settings.taskRoutes?.[task] ?? { primary: null, fallback: null };
  const next = { ...current, ...patch };
  const taskRoutes = { ...(settings.taskRoutes ?? {}) };
  if (next.primary === null && next.fallback === null) delete taskRoutes[task];
  else taskRoutes[task] = next;
  const { taskRoutes: _drop, ...rest } = settings;
  return Object.keys(taskRoutes).length ? { ...rest, taskRoutes } : rest;
}
