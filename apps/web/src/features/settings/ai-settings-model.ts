import type { OpeningAiSettings, OpeningAiSettingsResponse, OpeningModelSummary, TutorMode } from "@aistudy/contracts";
import { selectedOpeningModelId } from "@aistudy/ai";

export const tutorRouteLabels: Array<{ mode: TutorMode; label: string }> = [
  { mode: "listen", label: "倾听" }, { mode: "hint", label: "提示" },
  { mode: "explain", label: "解释" }, { mode: "think_together", label: "共同思考" },
];
export const availabilityLabels: Record<OpeningModelSummary["availability"], string> = {
  available: "已配置", missing_key: "缺少服务器密钥", budget_disabled: "服务器日预算未启用", pricing_missing: "缺少服务器价格",
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
  const ids = settings.mode === "manual" ? [settings.manualModelId] : [settings.defaultModelId, ...Object.values(settings.routes)];
  return ids.some(id => id !== null && !data.models.some(model => model.id === id));
}
