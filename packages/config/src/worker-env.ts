import { EnvValidationError } from "./env";
import { loadWorkerStartupConfig } from "./worker-startup";

/** Local-only defaults; never used when NODE_ENV=production. */
const DEVELOPMENT_DEFAULTS = {
  DATABASE_URL: "postgres://postgres@127.0.0.1:5432/aistudy",
  REDIS_URL: "redis://127.0.0.1:6379",
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "aistudy",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "minioadmin",
} as const;

type RequiredKey = keyof typeof DEVELOPMENT_DEFAULTS;
const REQUIRED_KEYS = Object.keys(DEVELOPMENT_DEFAULTS) as RequiredKey[];

export type WorkerRole = "all" | "learning" | "parser";

export type WorkerEnv = {
  nodeEnv: "development" | "test" | "production";
  workerRole: WorkerRole;
  databaseUrl: string;
  redisUrl: string;
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  parserTempDir: string;
  parserPdfSegmentPages: number;
  parserPdfSegmentTimeoutSeconds: number;
  parserTorchThreads: number;
};

/**
 * Worker infrastructure settings. Production fails closed on any missing value
 * instead of silently connecting to loopback services with default credentials.
 */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  loadWorkerStartupConfig(source);
  const nodeEnv = source.NODE_ENV === "production" ? "production" : source.NODE_ENV === "test" ? "test" : "development";
  const issues: string[] = [];
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = source[key]?.trim() ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      issues.push(`${key}: must be an integer between ${min} and ${max}`);
    }
    return value;
  };
  const parserPdfSegmentPages = integer("PARSER_PDF_SEGMENT_PAGES", 5, 1, 100);
  const parserPdfSegmentTimeoutSeconds = integer("PARSER_PDF_SEGMENT_TIMEOUT_SECONDS", 240, 30, 3600);
  const parserTorchThreads = integer("PARSER_TORCH_THREADS", 1, 1, 4);
  const workerRole = source.WORKER_ROLE?.trim() || "all";
  if (!["all", "learning", "parser"].includes(workerRole)) {
    issues.push("WORKER_ROLE: must be all, learning or parser");
  }
  const value = (key: RequiredKey): string => {
    const raw = source[key]?.trim();
    if (raw) return raw;
    if (nodeEnv === "production") issues.push(`${key}: ${key} is required in production`);
    return DEVELOPMENT_DEFAULTS[key];
  };
  const resolved = Object.fromEntries(REQUIRED_KEYS.map((key) => [key, value(key)])) as Record<RequiredKey, string>;
  try {
    new URL(resolved.S3_ENDPOINT);
  } catch {
    issues.push("S3_ENDPOINT: S3_ENDPOINT must be a valid URL");
  }
  const forcePathStyle = source.S3_FORCE_PATH_STYLE?.trim();
  if (forcePathStyle && forcePathStyle !== "true" && forcePathStyle !== "false") {
    issues.push("S3_FORCE_PATH_STYLE: must be true or false");
  }
  if (issues.length) throw new EnvValidationError(issues);
  return {
    nodeEnv,
    workerRole: workerRole as WorkerRole,
    databaseUrl: resolved.DATABASE_URL,
    redisUrl: resolved.REDIS_URL,
    s3: {
      endpoint: resolved.S3_ENDPOINT,
      region: resolved.S3_REGION,
      bucket: resolved.S3_BUCKET,
      accessKeyId: resolved.S3_ACCESS_KEY_ID,
      secretAccessKey: resolved.S3_SECRET_ACCESS_KEY,
      forcePathStyle: forcePathStyle !== "false",
    },
    parserTempDir: source.PARSER_TEMP_DIR?.trim() || ".tmp/opening-parser",
    parserPdfSegmentPages,
    parserPdfSegmentTimeoutSeconds,
    parserTorchThreads,
  };
}
