import {
  emptyModelDraft, emptyProviderDraft, modelRequestBody, validateModelDraft, validateProviderDraft,
  type ProviderModelDraft, type ProviderDraft,
} from "./provider-settings-model";

export type QuickSetupPreset = "gemini_free" | "openai_compatible";
export type QuickSetupDraft = ProviderDraft & Omit<ProviderModelDraft, "label"> & {
  dailyCapCents: string;
  confirmBudget: boolean;
};

const blankDraft: QuickSetupDraft = {
  ...emptyProviderDraft, ...emptyModelDraft, dailyCapCents: "", confirmBudget: false,
};

const PRESET_LABELS: Record<QuickSetupPreset, string> = { gemini_free: "Google Gemini", openai_compatible: "" };

/** Presets describe the endpoint and capabilities, never an invented token price. */
export function applyQuickSetupPreset(draft: QuickSetupDraft, preset: QuickSetupPreset): QuickSetupDraft {
  // A blank or untouched preset name follows the preset; a name the user typed is kept.
  const label = !draft.label.trim() || Object.values(PRESET_LABELS).includes(draft.label) ? PRESET_LABELS[preset] : draft.label;
  const next = { ...blankDraft, label, apiKey: draft.apiKey };
  return preset === "gemini_free" ? {
    ...next, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelName: "gemini-2.5-flash",
    supportsVision: true, supportsAudio: true, billing: "free_tier", dailyRequestCap: "200",
  } : { ...next, baseUrl: "https://api.openai.com/v1" };
}

export const initialQuickSetupDraft = applyQuickSetupPreset(blankDraft, "gemini_free");

/** Shown next to the disabled 一键配置模型 button: name every empty required field at once. */
export function quickSetupMissingFields(draft: QuickSetupDraft): string[] {
  return [
    ...(draft.label.trim() ? [] : ["配置名称"]),
    ...(draft.modelName.trim() ? [] : ["模型名称"]),
    ...(draft.apiKey.trim() ? [] : ["API 密钥"]),
  ];
}

export function validateQuickSetupDraft(draft: QuickSetupDraft): string | null {
  const missing = quickSetupMissingFields(draft);
  if (missing.length) return `还差：${missing.join("、")}。填好后就能一键配置。`;
  const providerIssue = validateProviderDraft(draft);
  if (providerIssue) return providerIssue;
  if (draft.baseUrl.trim().length > 2048) return "接口地址过长（上限 2048 字符）。";
  const modelIssue = validateModelDraft(draft);
  if (modelIssue) return modelIssue;
  if (draft.billing === "metered") {
    const cap = Number(draft.dailyCapCents);
    if (!/^\d+$/.test(draft.dailyCapCents.trim()) || !Number.isSafeInteger(cap) || cap <= 0) return "按量计费请填写大于 0 的每日额度（整数分）。";
    if (!draft.confirmBudget) return "请确认每日额度后再一键配置。";
  }
  return null;
}

export function quickSetupRequestBody(draft: QuickSetupDraft, clientKey: string) {
  return {
    ...modelRequestBody(draft), clientKey, label: draft.label.trim(),
    baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey,
    dailyCapCents: draft.billing === "metered" ? Number(draft.dailyCapCents) : null,
    confirmBudget: draft.billing === "metered" && draft.confirmBudget,
  };
}

export type QuickSetupSubmission = {
  clientKey: string | null;
  payload: ReturnType<typeof quickSetupRequestBody> | null;
  uncertain: boolean;
};
export const initialQuickSetupSubmission: QuickSetupSubmission = { clientKey: null, payload: null, uncertain: false };

/** An uncertain retry sends the original snapshot, even if another draft is supplied. */
export function beginQuickSetupSubmission(current: QuickSetupSubmission, draft: QuickSetupDraft, candidateKey: string) {
  const payload = current.payload ?? quickSetupRequestBody(draft, current.clientKey ?? candidateKey);
  return { clientKey: payload.clientKey, payload, uncertain: false };
}

export function finishQuickSetupSubmission(current: QuickSetupSubmission, outcome: "success" | "rejected" | "unknown"): QuickSetupSubmission {
  if (outcome === "success") return { ...initialQuickSetupSubmission };
  if (outcome === "rejected") return { clientKey: current.clientKey, payload: null, uncertain: false };
  return { ...current, uncertain: true };
}

/** These route rejections happen before any setup writes; other failures may have committed. */
export function isDefiniteQuickSetupRejection(status: number): boolean {
  return (status >= 400 && status < 500) || status === 503;
}
