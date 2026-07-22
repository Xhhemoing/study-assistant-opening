import { z } from "zod";

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  S3_ENDPOINT: z.string().url("S3_ENDPOINT must be a valid URL"),
  S3_REGION: z.string().min(1, "S3_REGION is required"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID is required"),
  S3_SECRET_ACCESS_KEY: z.string().min(1, "S3_SECRET_ACCESS_KEY is required"),
  PUBLIC_BASE_URL: z.string().url("PUBLIC_BASE_URL must be a valid URL"),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  SESSION_TTL_SECONDS: z
    .string()
    .optional()
    .default("604800")
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n >= 60, {
      message: "SESSION_TTL_SECONDS must be an integer >= 60",
    }),
  AUTH_COOKIE_NAME: z.string().min(1).default("aistudy_session"),
});

export type AppEnv = {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  redisUrl: string;
  publicBaseUrl: string;
  authSecret: string;
  sessionTtlSeconds: number;
  authCookieName: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  };
  toPublicSummary: () => {
    nodeEnv: "development" | "test" | "production";
    publicBaseUrl: string;
    databaseConfigured: boolean;
    redisConfigured: boolean;
    storageConfigured: boolean;
    authConfigured: boolean;
  };
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join(".") || "env";
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  const data = result.data;
  return {
    nodeEnv: data.NODE_ENV,
    databaseUrl: data.DATABASE_URL,
    redisUrl: data.REDIS_URL,
    publicBaseUrl: data.PUBLIC_BASE_URL,
    authSecret: data.AUTH_SECRET,
    sessionTtlSeconds: data.SESSION_TTL_SECONDS,
    authCookieName: data.AUTH_COOKIE_NAME,
    s3: {
      endpoint: data.S3_ENDPOINT,
      region: data.S3_REGION,
      bucket: data.S3_BUCKET,
      accessKeyId: data.S3_ACCESS_KEY_ID,
      secretAccessKey: data.S3_SECRET_ACCESS_KEY,
      forcePathStyle: data.S3_FORCE_PATH_STYLE,
    },
    toPublicSummary() {
      return {
        nodeEnv: data.NODE_ENV,
        publicBaseUrl: data.PUBLIC_BASE_URL,
        databaseConfigured: data.DATABASE_URL.length > 0,
        redisConfigured: data.REDIS_URL.length > 0,
        storageConfigured:
          data.S3_ENDPOINT.length > 0 &&
          data.S3_BUCKET.length > 0 &&
          data.S3_ACCESS_KEY_ID.length > 0 &&
          data.S3_SECRET_ACCESS_KEY.length > 0,
        authConfigured: data.AUTH_SECRET.length >= 32,
      };
    },
  };
}
