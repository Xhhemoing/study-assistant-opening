import { z } from "zod";

const embeddingSchema = z.object({
  baseUrl: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
  modelName: z.string().trim().min(1).max(200),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/),
  dimensions: z.number().int().min(1).max(4096),
  requestDimensions: z.boolean().default(true),
  inputCentsPerMillion: z.number().finite().nonnegative(),
  billing: z.enum(["metered", "free_tier"]).default("metered"),
  dailyRequestCap: z.number().int().min(1).max(100_000).nullable().default(null),
}).strict().refine(value => value.billing === "free_tier"
  ? value.dailyRequestCap !== null && value.inputCentsPerMillion === 0
  : value.inputCentsPerMillion > 0, "embedding billing needs a price or a bounded free quota");

export class OpeningEmbeddingConfigurationError extends Error {
  readonly code = "AI_CONFIGURATION_INVALID";
  constructor() { super("服务器资料检索模型配置无效，请联系管理员检查配置。"); }
}

/** Server-only credentials. Changing endpoint, model or dimensions creates a new index identity. */
export function loadOpeningEmbeddingConfig(source: NodeJS.ProcessEnv = process.env) {
  const raw = source.OPENING_EMBEDDING_CONFIG?.trim();
  if (!raw) return null;
  try {
    const { apiKeyEnv, ...config } = embeddingSchema.parse(JSON.parse(raw));
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    return {
      ...config, baseUrl, apiKey: source[apiKeyEnv]?.trim() ?? "",
      modelKey: JSON.stringify([baseUrl, config.modelName, config.dimensions]),
    };
  } catch {
    throw new OpeningEmbeddingConfigurationError();
  }
}

export type OpeningEmbeddingConfig = NonNullable<ReturnType<typeof loadOpeningEmbeddingConfig>>;
