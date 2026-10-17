import { z } from "zod";
import { loadOpeningModel, openingModelFields } from "./opening-model";
import { loadOpeningModelCatalog } from "./opening-model-catalog";

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const quotaInteger = (fallback: string) => z.string().trim().regex(/^\d+$/, "must be a positive safe integer")
  .default(fallback).transform(Number).refine(value => Number.isSafeInteger(value) && value > 0, "must be a positive safe integer");
const openingUploadQuotaFields = {
  OPENING_UPLOAD_MAX_WORKSPACE_BYTES: quotaInteger("2147483648"),
  OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS: quotaInteger("200"),
};
const openingUploadQuotaSchema = z.object(openingUploadQuotaFields);
export type OpeningUploadQuota = { maxBytes: number; maxObjects: number };

/** Server-side admission limits; independent of infrastructure credentials. */
export function loadOpeningUploadQuota(source: NodeJS.ProcessEnv = process.env): OpeningUploadQuota {
  const parsed = openingUploadQuotaSchema.safeParse(source);
  if (!parsed.success) throw new EnvValidationError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  return { maxBytes: parsed.data.OPENING_UPLOAD_MAX_WORKSPACE_BYTES, maxObjects: parsed.data.OPENING_UPLOAD_MAX_WORKSPACE_OBJECTS };
}

const envSchema = z.object({
  ...openingUploadQuotaFields,
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  S3_ENDPOINT: z.string().url("S3_ENDPOINT must be a valid URL"),
  S3_REGION: z.string().min(1, "S3_REGION is required"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID is required"),
  S3_SECRET_ACCESS_KEY: z.string().min(1, "S3_SECRET_ACCESS_KEY is required"),
  PUBLIC_BASE_URL: z.string().url("PUBLIC_BASE_URL must be a valid URL"),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  SESSION_TTL_SECONDS: z.string().optional().default("604800").transform((v) => Number.parseInt(v, 10)).refine((n) => Number.isFinite(n) && n >= 60, { message: "SESSION_TTL_SECONDS must be an integer >= 60" }),
  AUTH_COOKIE_NAME: z.string().min(1).default("aistudy_session"),
  AUTH_TRUSTED_IP_HEADER: z.string().trim().regex(/^$|^[A-Za-z0-9][A-Za-z0-9-]*$/, "AUTH_TRUSTED_IP_HEADER must be a single HTTP header name").optional().transform((value) => value || undefined),

});

export type AppEnv = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  redisUrl: string;
  publicBaseUrl: string;
  authSecret: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
  authCookieName: string;
  authTrustedIpHeader?: string;
  openingModel: ReturnType<typeof loadOpeningModel>;
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  toPublicSummary: () => { nodeEnv: "development" | "test" | "production"; publicBaseUrl: string; databaseConfigured: boolean; redisConfigured: boolean; storageConfigured: boolean; authConfigured: boolean };
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const usesCatalog = Boolean(source.OPENING_MODEL_CATALOG?.trim());
  const result = (usesCatalog ? envSchema : envSchema.extend(openingModelFields)).safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`));
  }
  const data = result.data;
  const catalog = usesCatalog ? loadOpeningModelCatalog(source) : null;
  const defaultModel = catalog?.models.find(model => model.id === catalog.defaultModelId);
  return {
    nodeEnv: data.NODE_ENV,
    databaseUrl: data.DATABASE_URL,
    redisUrl: data.REDIS_URL,
    publicBaseUrl: data.PUBLIC_BASE_URL,
    authSecret: data.AUTH_SECRET,
    sessionCookieSecure: data.SESSION_COOKIE_SECURE === undefined ? data.NODE_ENV === "production" : data.SESSION_COOKIE_SECURE === "true",
    sessionTtlSeconds: data.SESSION_TTL_SECONDS,
    authCookieName: data.AUTH_COOKIE_NAME,
    authTrustedIpHeader: data.AUTH_TRUSTED_IP_HEADER,
    openingModel: catalog ? {
      baseUrl: defaultModel?.baseUrl ?? "https://api.openai.com/v1", apiKey: defaultModel?.apiKey ?? "",
      name: defaultModel?.modelName ?? "unconfigured", dailyCapCents: catalog.dailyCapCents,
      inputCentsPerMillion: defaultModel?.inputCentsPerMillion ?? 0,
      outputCentsPerMillion: defaultModel?.outputCentsPerMillion ?? 0,
    } : loadOpeningModel(source),
    s3: { endpoint: data.S3_ENDPOINT, region: data.S3_REGION, bucket: data.S3_BUCKET, accessKeyId: data.S3_ACCESS_KEY_ID, secretAccessKey: data.S3_SECRET_ACCESS_KEY, forcePathStyle: data.S3_FORCE_PATH_STYLE },
    toPublicSummary() {
      return { nodeEnv: data.NODE_ENV, publicBaseUrl: data.PUBLIC_BASE_URL, databaseConfigured: true, redisConfigured: true, storageConfigured: true, authConfigured: data.AUTH_SECRET.length >= 32 };
    },
  };
}
