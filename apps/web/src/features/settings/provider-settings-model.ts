import type { OpeningProviderConfigResponse, OpeningProviderModelView, OpeningProviderView } from "@aistudy/contracts";

export type ProviderDraft = {
  label: string; baseUrl: string; apiKey: string;
};

export type ProviderModelDraft = {
  label: string; modelName: string;
  inputCentsPerMillion: string; outputCentsPerMillion: string;
  supportsVision: boolean;
};

export const emptyProviderDraft: ProviderDraft = { label: "", baseUrl: "", apiKey: "" };
export const emptyModelDraft: ProviderModelDraft = {
  label: "", modelName: "", inputCentsPerMillion: "", outputCentsPerMillion: "", supportsVision: false,
};

/** Key fields are write-only: drafts start empty and stay empty after a save. */
export function providerDraftFromView(view: OpeningProviderView): ProviderDraft {
  return { label: view.label, baseUrl: view.baseUrl, apiKey: "" };
}
export function modelDraftFromView(view: OpeningProviderModelView): ProviderModelDraft {
  return {
    label: view.label, modelName: view.modelName,
    inputCentsPerMillion: String(view.inputCentsPerMillion),
    outputCentsPerMillion: String(view.outputCentsPerMillion),
    supportsVision: view.supportsVision,
  };
}

function isBlank(value: string): boolean { return value.trim().length === 0; }

/** Returns a user-facing message or null when the draft may be submitted. */
export function validateProviderDraft(draft: ProviderDraft): string | null {
  if (isBlank(draft.label) || draft.label.trim().length > 120) return "请填写不超过 120 字的服务商名称。";
  if (isBlank(draft.baseUrl)) return "请填写接口地址（baseUrl）。";
  if (draft.apiKey.length > 4096) return "API 密钥过长（上限 4096 字符）。";
  let url: URL;
  try { url = new URL(draft.baseUrl.trim()); } catch { return "接口地址格式无效。"; }
  if (url.username || url.password || url.search || url.hash) return "接口地址不能包含用户信息、查询参数或片段。";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())) return null;
  return "远程接口必须使用 https；仅本机开发地址可用 http。";
}

function positivePrice(value: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function validateModelDraft(draft: ProviderModelDraft): string | null {
  if (isBlank(draft.label) || draft.label.trim().length > 120) return "请填写不超过 120 字的模型显示名。";
  if (isBlank(draft.modelName) || draft.modelName.trim().length > 200) return "请填写不超过 200 字的模型名称（以供应商文档为准）。";
  const input = positivePrice(draft.inputCentsPerMillion);
  const output = positivePrice(draft.outputCentsPerMillion);
  if (input === null) return "输入价格必须为大于 0 的数字（分 / 百万 token）。";
  if (output === null) return "输出价格必须为大于 0 的数字（分 / 百万 token）。";
  return null;
}

export function providerRequestBody(draft: ProviderDraft): { label: string; baseUrl: string; apiKey?: string } {
  const body: { label: string; baseUrl: string; apiKey?: string } = {
    label: draft.label.trim(), baseUrl: draft.baseUrl.trim(),
  };
  if (draft.apiKey.length > 0) body.apiKey = draft.apiKey;
  return body;
}

export function modelRequestBody(draft: ProviderModelDraft): {
  label: string; modelName: string; inputCentsPerMillion: number; outputCentsPerMillion: number; supportsVision: boolean;
} {
  return {
    label: draft.label.trim(), modelName: draft.modelName.trim(),
    inputCentsPerMillion: Number(draft.inputCentsPerMillion),
    outputCentsPerMillion: Number(draft.outputCentsPerMillion),
    supportsVision: draft.supportsVision,
  };
}

/** Drafts keyed by entity id for edit forms. */
export function indexDrafts(views: OpeningProviderView[], drafts: Record<string, ProviderDraft>): Record<string, ProviderDraft> {
  const next: Record<string, ProviderDraft> = {};
  for (const view of views) next[view.id] = drafts[view.id] ?? providerDraftFromView(view);
  return next;
}

export function keyStatusText(view: OpeningProviderView): string {
  if (!view.hasApiKey) return "未配置密钥";
  const when = view.apiKeyUpdatedAt ? `，更新于 ${view.apiKeyUpdatedAt.slice(0, 10)}` : "";
  return `已配置（尾号 ${view.apiKeyHint ?? "****"}${when}）`;
}

export function customModelCount(data: OpeningProviderConfigResponse): number {
  return data.models.length;
}
