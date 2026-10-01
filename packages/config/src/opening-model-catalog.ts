import { z } from "zod";
import { loadOpeningModel, openingModelFields } from "./opening-model";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const modelSchema = z.object({
  id: identifier,
  label: z.string().trim().min(1).max(120),
  providerId: identifier,
  providerLabel: z.string().trim().min(1).max(120),
  modelName: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/),
  inputCentsPerMillion: z.number().finite().nonnegative(),
  outputCentsPerMillion: z.number().finite().nonnegative(),
}).strict();
const catalogSchema = z.array(modelSchema).max(32).superRefine((models, ctx) => {
  if (new Set(models.map(model => model.id)).size !== models.length) ctx.addIssue({ code: "custom", message: "model ids must be unique" });
  const labels = new Map<string, string>();
  for (const model of models) {
    if (labels.has(model.providerId) && labels.get(model.providerId) !== model.providerLabel) ctx.addIssue({ code: "custom", message: "provider labels must agree" });
    labels.set(model.providerId, model.providerLabel);
  }
});
export class OpeningModelConfigurationError extends Error {
  readonly code = "AI_CONFIGURATION_INVALID";
  constructor() { super("服务器模型目录配置无效，请联系管理员检查配置并重启服务。"); }
}

export function loadOpeningModelCatalog(source: NodeJS.ProcessEnv = process.env) {
  try {
    const directory = source.OPENING_MODEL_CATALOG?.trim();
    const legacy = directory ? null : loadOpeningModel(source);
    const dailyCapCents = openingModelFields.OPENING_MODEL_DAILY_CAP_CENTS.parse(source.OPENING_MODEL_DAILY_CAP_CENTS);
    const entries = directory
      ? catalogSchema.parse(JSON.parse(directory))
      : [{ id: "default", label: legacy!.name, providerId: "default", providerLabel: "默认供应商", modelName: legacy!.name,
          baseUrl: legacy!.baseUrl, apiKeyEnv: "OPENING_MODEL_API_KEY", inputCentsPerMillion: legacy!.inputCentsPerMillion, outputCentsPerMillion: legacy!.outputCentsPerMillion }];
    const models = entries.map(({ apiKeyEnv, ...entry }) => {
      const apiKey = source[apiKeyEnv]?.trim() ?? "";
      const availability = !apiKey ? "missing_key" as const : dailyCapCents <= 0 ? "budget_disabled" as const
        : entry.inputCentsPerMillion <= 0 || entry.outputCentsPerMillion <= 0 ? "pricing_missing" as const : "available" as const;
      return { ...entry, apiKey, availability };
    });
    const defaultModelId = source.OPENING_MODEL_DEFAULT_ID?.trim() || models[0]?.id || null;
    if (defaultModelId && !models.some(model => model.id === defaultModelId)) throw new OpeningModelConfigurationError();
    return { models, defaultModelId, dailyCapCents };
  } catch {
    // Never attach raw environment JSON, endpoint credentials, or secret values.
    throw new OpeningModelConfigurationError();
  }
}
export type OpeningModelCatalog = ReturnType<typeof loadOpeningModelCatalog>;
