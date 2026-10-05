import { z } from "zod";
import { uuidSchema } from "./foundation";

/** Stable model ids are UUIDs; they must also satisfy the shared model id regex. */
const modelIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

/** HTTPS for remote endpoints; plain HTTP only for loopback development endpoints. */
export function isOpeningProviderBaseUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase());
}

const providerBaseUrlSchema = z.string().trim().max(2048).refine(isOpeningProviderBaseUrl,
  "baseUrl 必须是 https 地址（本机开发可用 http://localhost）且不含用户信息、查询或片段");

export const openingProviderInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().min(1).max(4096).optional(),
}).strict();
export type OpeningProviderInput = z.infer<typeof openingProviderInputSchema>;

export const openingProviderModelInputSchema = z.object({
  label: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(200),
  inputCentsPerMillion: z.number().finite().positive(),
  outputCentsPerMillion: z.number().finite().positive(),
  supportsVision: z.boolean().optional(),
}).strict();
export type OpeningProviderModelInput = z.infer<typeof openingProviderModelInputSchema>;

export const openingProviderUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  baseUrl: providerBaseUrlSchema.optional(),
  apiKey: z.string().min(1).max(4096).optional(),
}).strict().refine(input => Object.keys(input).length > 0, "至少提供一个要更新的字段");
export type OpeningProviderUpdate = z.infer<typeof openingProviderUpdateSchema>;

export const openingProviderModelUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  modelName: z.string().trim().min(1).max(200).optional(),
  inputCentsPerMillion: z.number().finite().positive().optional(),
  outputCentsPerMillion: z.number().finite().positive().optional(),
  supportsVision: z.boolean().optional(),
}).strict().refine(input => Object.keys(input).length > 0, "至少提供一个要更新的字段");
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
  id: modelIdSchema,
  providerId: uuidSchema,
  label: z.string().min(1).max(120),
  modelName: z.string().min(1).max(200),
  inputCentsPerMillion: z.number().finite().positive(),
  outputCentsPerMillion: z.number().finite().positive(),
  supportsVision: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type OpeningProviderModelView = z.infer<typeof openingProviderModelViewSchema>;

export const openingProviderConfigResponseSchema = z.object({
  providers: z.array(openingProviderViewSchema).max(8),
  models: z.array(openingProviderModelViewSchema).max(32),
}).strict();
export type OpeningProviderConfigResponse = z.infer<typeof openingProviderConfigResponseSchema>;
