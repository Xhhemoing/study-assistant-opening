/**
 * Opening restore CLI live-deps resolver (Q03).
 *
 * Parses process env into a postgres connection URL + OpeningS3Config for the
 * mutating CLI path. Fail-closed when any required live dependency is missing —
 * callers must not silently fall through to APPLY_EXECUTOR_DEFERRED when a draft
 * is present but env is incomplete.
 *
 * Database URL preference (first non-empty wins):
 *   1. OPENING_RESTORE_DATABASE_URL
 *   2. OPENING_TEST_DATABASE_URL
 *   3. DATABASE_URL
 *
 * S3 / MinIO: OPENING_S3_* overrides S3_* when set (same fields as loadEnv().s3 /
 * integration OpeningS3 construction). Required: endpoint, region, bucket,
 * accessKeyId, secretAccessKey. forcePathStyle defaults to true.
 *
 * Never returns secret values in missingKeys / error text — only key names.
 */
import type { OpeningS3Config } from "../storage/opening-s3";

export type OpeningRestoreCliLiveDepsOk = {
  ok: true;
  databaseUrl: string;
  /** Which env key supplied databaseUrl (for diagnostics; never the URL itself). */
  databaseUrlSource:
    | "OPENING_RESTORE_DATABASE_URL"
    | "OPENING_TEST_DATABASE_URL"
    | "DATABASE_URL";
  s3: OpeningS3Config;
};

export type OpeningRestoreCliLiveDepsMissing = {
  ok: false;
  code: "LIVE_DEPS_MISSING";
  /** Canonical env key names that were absent / blank (no values). */
  missingKeys: string[];
};

export type OpeningRestoreCliLiveDepsResult =
  | OpeningRestoreCliLiveDepsOk
  | OpeningRestoreCliLiveDepsMissing;

const DB_URL_PREF = [
  "OPENING_RESTORE_DATABASE_URL",
  "OPENING_TEST_DATABASE_URL",
  "DATABASE_URL",
] as const;

type DbUrlSource = (typeof DB_URL_PREF)[number];

/** Prefer OPENING_S3_* then S3_*; returns blank-trimmed value or undefined. */
function pickS3(
  env: NodeJS.ProcessEnv,
  openingKey: string,
  s3Key: string,
): string | undefined {
  const opening = env[openingKey]?.trim();
  if (opening) return opening;
  const s3 = env[s3Key]?.trim();
  return s3 || undefined;
}

function parseForcePathStyle(env: NodeJS.ProcessEnv): boolean {
  const raw =
    env.OPENING_S3_FORCE_PATH_STYLE?.trim() || env.S3_FORCE_PATH_STYLE?.trim();
  if (raw === undefined || raw === "") return true;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Invalid value → treat as missing so mutating path fails closed.
  return true;
}

function forcePathStyleExplicitlyInvalid(env: NodeJS.ProcessEnv): boolean {
  const raw =
    env.OPENING_S3_FORCE_PATH_STYLE?.trim() || env.S3_FORCE_PATH_STYLE?.trim();
  if (raw === undefined || raw === "") return false;
  return raw !== "true" && raw !== "false";
}

/**
 * Resolve live DB + S3 deps for `scripts/opening-restore.ts` mutating apply.
 * Pure: does not connect, does not print secrets.
 */
export function resolveOpeningRestoreCliLiveDeps(
  env: NodeJS.ProcessEnv = process.env,
): OpeningRestoreCliLiveDepsResult {
  const missingKeys: string[] = [];

  let databaseUrl: string | undefined;
  let databaseUrlSource: DbUrlSource | undefined;
  for (const key of DB_URL_PREF) {
    const value = env[key]?.trim();
    if (value) {
      databaseUrl = value;
      databaseUrlSource = key;
      break;
    }
  }
  if (!databaseUrl || !databaseUrlSource) {
    missingKeys.push("OPENING_RESTORE_DATABASE_URL|OPENING_TEST_DATABASE_URL|DATABASE_URL");
  }

  const endpoint = pickS3(env, "OPENING_S3_ENDPOINT", "S3_ENDPOINT");
  const region = pickS3(env, "OPENING_S3_REGION", "S3_REGION");
  const bucket = pickS3(env, "OPENING_S3_BUCKET", "S3_BUCKET");
  const accessKeyId = pickS3(env, "OPENING_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID");
  const secretAccessKey = pickS3(env, "OPENING_S3_SECRET_ACCESS_KEY", "S3_SECRET_ACCESS_KEY");

  if (!endpoint) missingKeys.push("S3_ENDPOINT");
  if (!region) missingKeys.push("S3_REGION");
  if (!bucket) missingKeys.push("S3_BUCKET");
  if (!accessKeyId) missingKeys.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missingKeys.push("S3_SECRET_ACCESS_KEY");
  if (forcePathStyleExplicitlyInvalid(env)) {
    missingKeys.push("S3_FORCE_PATH_STYLE");
  }

  if (
    missingKeys.length > 0
    || !databaseUrl
    || !databaseUrlSource
    || !endpoint
    || !region
    || !bucket
    || !accessKeyId
    || !secretAccessKey
  ) {
    return { ok: false, code: "LIVE_DEPS_MISSING", missingKeys };
  }

  return {
    ok: true,
    databaseUrl,
    databaseUrlSource,
    s3: {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: parseForcePathStyle(env),
    },
  };
}
