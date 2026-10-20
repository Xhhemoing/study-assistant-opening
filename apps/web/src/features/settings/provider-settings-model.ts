import type { OpeningProviderConfigResponse, OpeningProviderModelView, OpeningProviderView } from "@aistudy/contracts";
import { normalizeOpeningProviderBaseUrl } from "@aistudy/contracts";

export type ProviderDraft = {
  label: string; baseUrl: string; apiKey: string;
};

export type ProviderModelDraft = {
  label: string; modelName: string;
  inputCentsPerMillion: string; outputCentsPerMillion: string;
  supportsVision: boolean; supportsAudio: boolean;
  billing: "metered" | "free_tier"; dailyRequestCap: string;
  mediaInputTokenUpperBound?: string; mediaMaxInputBytes?: string; mediaInputCentsPerMillion?: string;
};

export const emptyProviderDraft: ProviderDraft = { label: "", baseUrl: "", apiKey: "" };
export const emptyModelDraft: ProviderModelDraft = {
  label: "", modelName: "", inputCentsPerMillion: "", outputCentsPerMillion: "", supportsVision: false,
  supportsAudio: false, billing: "metered", dailyRequestCap: "",
  mediaInputTokenUpperBound: "", mediaMaxInputBytes: "", mediaInputCentsPerMillion: "",
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
    supportsVision: view.supportsVision, supportsAudio: view.supportsAudio,
    billing: view.billing, dailyRequestCap: view.dailyRequestCap === null ? "" : String(view.dailyRequestCap),
    mediaInputTokenUpperBound: view.mediaInputTokenUpperBound == null ? "" : String(view.mediaInputTokenUpperBound),
    mediaMaxInputBytes: view.mediaMaxInputBytes == null ? "" : String(view.mediaMaxInputBytes),
    mediaInputCentsPerMillion: view.mediaInputCentsPerMillion == null ? "" : String(view.mediaInputCentsPerMillion),
  };
}

function isBlank(value: string): boolean { return value.trim().length === 0; }

/** Returns a user-facing message or null when the draft may be submitted. */
export function validateProviderDraft(draft: ProviderDraft, current?: OpeningProviderView): string | null {
  if (isBlank(draft.label) || draft.label.trim().length > 120) return "请填写不超过 120 字的服务商名称。";
  if (isBlank(draft.baseUrl)) return "请填写接口地址（baseUrl）。";
  if (draft.apiKey.length > 4096) return "API 密钥过长（上限 4096 字符）。";
  let url: URL;
  try { url = new URL(draft.baseUrl.trim()); } catch { return "接口地址格式无效。"; }
  if (url.username || url.password || url.search || url.hash) return "接口地址不能包含用户信息、查询参数或片段。";
  if (current?.hasApiKey && !draft.apiKey && normalizeOpeningProviderBaseUrl(draft.baseUrl) !== normalizeOpeningProviderBaseUrl(current.baseUrl)) {
    return "更改接口地址时请同时填写该地址的 API 密钥。";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase())) return null;
  return "远程接口必须使用 https；仅本机开发地址可用 http。";
}

function price(value: string, allowZero: boolean): number | null {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
}

export function validateModelDraft(draft: ProviderModelDraft): string | null {
  if (isBlank(draft.label) || draft.label.trim().length > 120) return "请填写不超过 120 字的模型显示名。";
  if (isBlank(draft.modelName) || draft.modelName.trim().length > 200) return "请填写不超过 200 字的模型名称（以供应商文档为准）。";
  const free = draft.billing === "free_tier";
  const input = price(draft.inputCentsPerMillion || (free ? "0" : ""), free);
  const output = price(draft.outputCentsPerMillion || (free ? "0" : ""), free);
  if (input === null) return free ? "输入价格必须为不小于 0 的数字。" : "输入价格必须为大于 0 的数字（分 / 百万 token）。";
  if (output === null) return free ? "输出价格必须为不小于 0 的数字。" : "输出价格必须为大于 0 的数字（分 / 百万 token）。";
  if (free) {
    const cap = Number(draft.dailyRequestCap);
    if (!/^\d+$/.test(draft.dailyRequestCap.trim()) || cap < 1 || cap > 100_000) return "免费额度模型请填写 1–100000 的每日请求上限。";
  }
  const media = [draft.mediaInputTokenUpperBound ?? "", draft.mediaMaxInputBytes ?? "", draft.mediaInputCentsPerMillion ?? ""];
  if (media.some(value => !isBlank(value))) {
    if (media.some(isBlank)) return "媒体 token 上界、总字节上限和价格必须一起填写或全部留空。";
    const tokens = Number(media[0]), bytes = Number(media[1]);
    if (!/^\d+$/.test(media[0]!.trim()) || !Number.isSafeInteger(tokens) || tokens <= 0) return "媒体 token 上界必须是供应商可核验的正整数。";
    if (!/^\d+$/.test(media[1]!.trim()) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 104_857_600) return "媒体总字节上限须为 1–104857600 的整数。";
    if (price(media[2]!, free) === null) return free ? "媒体输入价格必须为不小于 0 的数字。" : "按量计费的媒体输入价格必须大于 0。";
  }
  return null;
}

export function providerRequestBody(draft: ProviderDraft): { label: string; baseUrl: string; apiKey?: string } {
  const body: { label: string; baseUrl: string; apiKey?: string } = {
    label: draft.label.trim(), baseUrl: draft.baseUrl.trim(),
  };
  if (draft.apiKey.length > 0) body.apiKey = draft.apiKey;
  return body;
}

export function modelRequestBody(draft: ProviderModelDraft, options: { clearMedia?: boolean } = {}): {
  label: string; modelName: string; inputCentsPerMillion: number; outputCentsPerMillion: number;
  supportsVision: boolean; supportsAudio: boolean; billing: "metered" | "free_tier"; dailyRequestCap: number | null;
  mediaInputTokenUpperBound?: number | null; mediaMaxInputBytes?: number | null; mediaInputCentsPerMillion?: number | null;
} {
  const free = draft.billing === "free_tier";
  return {
    label: draft.label.trim(), modelName: draft.modelName.trim(),
    inputCentsPerMillion: Number(draft.inputCentsPerMillion || (free ? "0" : "")),
    outputCentsPerMillion: Number(draft.outputCentsPerMillion || (free ? "0" : "")),
    supportsVision: draft.supportsVision,
    supportsAudio: draft.supportsAudio,
    billing: draft.billing,
    dailyRequestCap: free ? Number(draft.dailyRequestCap) : null,
    ...(draft.mediaInputTokenUpperBound?.trim() ? {
      mediaInputTokenUpperBound: Number(draft.mediaInputTokenUpperBound), mediaMaxInputBytes: Number(draft.mediaMaxInputBytes),
      mediaInputCentsPerMillion: Number(draft.mediaInputCentsPerMillion),
    } : options.clearMedia ? { mediaInputTokenUpperBound: null, mediaMaxInputBytes: null, mediaInputCentsPerMillion: null } : {}),
  };
}

export const FREE_TIER_NOTICE = "免费额度（如 Google Gemini API 免费额度）的输入和输出可能被供应商用于改进其产品，并可能经人工审阅；不要用于隐私材料。";

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
