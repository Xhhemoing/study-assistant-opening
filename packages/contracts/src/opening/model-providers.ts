import { z } from "zod";
import { uuidSchema } from "./foundation";

/** Stable model ids are UUIDs; they must also satisfy the shared model id regex. */
const modelIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

/** Normalize equivalent endpoint spellings before comparing credential destinations. */
export function normalizeOpeningProviderBaseUrl(value: string): string {
  return new URL(value.trim()).href.replace(/\/+$/, "");
}

/** URL syntax only. The provider transport also validates the actual connection IP. */
export function isOpeningProviderBaseUrl(value: string, options: { allowLocal?: boolean } = {}): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol !== "http:") return false;
  return options.allowLocal === true && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
}

const providerBaseUrlSchema = z.string().trim().max(2048).refine(value => isOpeningProviderBaseUrl(value, { allowLocal: true }),
  "baseUrl 必须是 https 地址（本机开发可用 http://localhost）且不含用户信息、查询或片段")
  .transform(normalizeOpeningProviderBaseUrl);

export const openingProviderInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().min(1).max(4096).optional(),
}).strict();
export type OpeningProviderInput = z.infer<typeof openingProviderInputSchema>;

/**
 * metered: positive per-token prices, bounded by the daily cents cap.
 * free_tier: provider free quota (e.g. Gemini API free tier) — prices may be 0 and a
 * per-day request cap bounds use instead. Free-tier inputs may be used by the provider
 * to improve its products, so the UI must say so before saving.
 */
export const openingModelBillingSchema = z.enum(["metered", "free_tier"]);
export type OpeningModelBilling = z.infer<typeof openingModelBillingSchema>;
export const OPENING_DAILY_REQUEST_CAP_MAX = 100_000;
const dailyRequestCapSchema = z.number().int().min(1).max(OPENING_DAILY_REQUEST_CAP_MAX);

/** Price/billing invariant shared by create and quick setup (mirrors the 0062 CHECK). */
export function pricingIssue(input: {
  billing?: OpeningModelBilling | undefined;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  dailyRequestCap?: number | null | undefined;
}): string | null {
  if ((input.billing ?? "metered") === "metered") {
    return input.inputCentsPerMillion > 0 && input.outputCentsPerMillion > 0 ? null : "按量计费模型的输入/输出价格必须大于 0";
  }
  if (input.inputCentsPerMillion < 0 || input.outputCentsPerMillion < 0) return "价格不能为负数";
  return input.dailyRequestCap ? null : "免费额度模型必须设置每日请求上限";
}

export const openingMediaBudgetFields = {
  mediaInputTokenUpperBound: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  mediaMaxInputBytes: z.number().int().positive().max(104_857_600).nullable().optional(),
  mediaInputCentsPerMillion: z.number().finite().nonnegative().nullable().optional(),
};

/** These bounds come from the supplier's context/price rules, never a byte-to-token guess. */
export function mediaPricingIssue(input: {
  billing?: OpeningModelBilling | undefined;
  mediaInputTokenUpperBound?: number | null | undefined;
  mediaMaxInputBytes?: number | null | undefined;
  mediaInputCentsPerMillion?: number | null | undefined;
}): string | null {
  const values = [input.mediaInputTokenUpperBound, input.mediaMaxInputBytes, input.mediaInputCentsPerMillion];
  if (values.every(value => value == null)) return null;
  if (values.some(value => value == null)) return "媒体 token 上界、总字节上限和价格必须一起填写或一起清空。";
  if ((input.billing ?? "metered") === "metered" && input.mediaInputCentsPerMillion! <= 0) return "按量计费的媒体输入价格必须大于 0。";
  return null;
}

const modelFields = {
  ...openingMediaBudgetFields,
  label: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(200),
  inputCentsPerMillion: z.number().finite().nonnegative(),
  outputCentsPerMillion: z.number().finite().nonnegative(),
  supportsVision: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  billing: openingModelBillingSchema.optional(),
  dailyRequestCap: dailyRequestCapSchema.nullable().optional(),
};

export const openingProviderModelInputSchema = z.object(modelFields).strict().superRefine((input, ctx) => {
  const mediaIssue = mediaPricingIssue(input);
  if (mediaIssue) ctx.addIssue({ code: "custom", path: ["mediaInputTokenUpperBound"], message: mediaIssue });
  const issue = pricingIssue(input);
  if (issue) ctx.addIssue({ code: "custom", path: ["inputCentsPerMillion"], message: issue });
});
export type OpeningProviderModelInput = z.infer<typeof openingProviderModelInputSchema>;

export const openingModelQuickSetupInputSchema = z.object({
  ...openingMediaBudgetFields,
  clientKey: z.string().min(8).max(120),
  label: modelFields.label,
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().min(1).max(4096),
  modelName: modelFields.modelName,
  inputCentsPerMillion: modelFields.inputCentsPerMillion,
  outputCentsPerMillion: modelFields.outputCentsPerMillion,
  supportsVision: modelFields.supportsVision,
  supportsAudio: modelFields.supportsAudio,
  billing: openingModelBillingSchema.optional(),
  dailyRequestCap: dailyRequestCapSchema.nullable().optional(),
  dailyCapCents: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
  confirmBudget: z.boolean().optional(),
}).strict().superRefine((input, ctx) => {
  const mediaIssue = mediaPricingIssue(input);
  if (mediaIssue) ctx.addIssue({ code: "custom", path: ["mediaInputTokenUpperBound"], message: mediaIssue });
  const issue = pricingIssue(input);
  if (issue) ctx.addIssue({ code: "custom", path: ["inputCentsPerMillion"], message: issue });
  if ((input.billing ?? "metered") === "metered" && (!input.confirmBudget || !input.dailyCapCents)) {
    ctx.addIssue({ code: "custom", path: ["confirmBudget"], message: "请确认正数的每日预算。" });
  }
});
export type OpeningModelQuickSetupInput = z.infer<typeof openingModelQuickSetupInputSchema>;

export const openingModelProbeInputSchema = z.object({ clientKey: z.string().min(8).max(120) }).strict();

export const openingProviderUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  baseUrl: providerBaseUrlSchema.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
}).strict().refine(input => Object.keys(input).length > 0, "至少提供一个要更新的字段");
export type OpeningProviderUpdate = z.infer<typeof openingProviderUpdateSchema>;

/** Partial update; the merged row is re-checked with pricingIssue (and the DB CHECK). */
export const openingProviderModelUpdateSchema = z.object({
  ...openingMediaBudgetFields,
  label: modelFields.label.optional(),
  modelName: modelFields.modelName.optional(),
  inputCentsPerMillion: modelFields.inputCentsPerMillion.optional(),
  outputCentsPerMillion: modelFields.outputCentsPerMillion.optional(),
  supportsVision: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  billing: openingModelBillingSchema.optional(),
  dailyRequestCap: dailyRequestCapSchema.nullable().optional(),
}).strict().refine(input => Object.keys(input).length > 0, "至少提供一个要更新的字段").superRefine((input, ctx) => {
  const count = Object.keys(openingMediaBudgetFields).filter(key => key in input).length;
  if (count !== 0 && count !== 3) ctx.addIssue({ code: "custom", path: ["mediaInputTokenUpperBound"], message: "媒体上界三项必须一起更新。" });
  // The repository rechecks the merged billing mode for a partial update.
  const issue = mediaPricingIssue({ ...input, billing: input.billing ?? "free_tier" });
  if (issue) ctx.addIssue({ code: "custom", path: ["mediaInputTokenUpperBound"], message: issue });
});
export type OpeningProviderModelUpdate = z.infer<typeof openingProviderModelUpdateSchema>;

/** Management view: never carries the key material itself. */
export const openingProviderViewSchema = z.object({
  id: uuidSchema,
  label: z.string().min(1).max(120),
  baseUrl: z.string().max(2048),
  hasApiKey: z.boolean(),
  apiKeyHint: z.string().max(4).nullable(),
  apiKeyUpdatedAt: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type OpeningProviderView = z.infer<typeof openingProviderViewSchema>;

export const openingProviderModelViewSchema = z.object({
  mediaInputTokenUpperBound: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  mediaMaxInputBytes: z.number().int().positive().max(104_857_600).optional(),
  mediaInputCentsPerMillion: z.number().finite().nonnegative().optional(),
  id: modelIdSchema,
  providerId: uuidSchema,
  label: z.string().min(1).max(120),
  modelName: z.string().min(1).max(200),
  inputCentsPerMillion: z.number().finite().nonnegative(),
  outputCentsPerMillion: z.number().finite().nonnegative(),
  supportsVision: z.boolean(),
  supportsAudio: z.boolean(),
  billing: openingModelBillingSchema,
  dailyRequestCap: z.number().int().positive().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type OpeningProviderModelView = z.infer<typeof openingProviderModelViewSchema>;

export const openingProviderConfigResponseSchema = z.object({
  providers: z.array(openingProviderViewSchema).max(8),
  models: z.array(openingProviderModelViewSchema).max(32),
}).strict();
export type OpeningProviderConfigResponse = z.infer<typeof openingProviderConfigResponseSchema>;
