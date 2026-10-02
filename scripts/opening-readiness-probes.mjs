/**
 * Real service probes for scripts/opening-readiness.mjs. Each probe returns
 * { ok, detail } and converts its own failure into a result; details carry
 * error names/codes only, never URLs, credentials, or row content.
 */
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import postgres from "postgres";
import {
  WORKER_BACKLOG_STALE_MINUTES,
  backupAgeHours,
  backupFreshnessCheck,
  httpsCheck,
  modelChecks,
  ownerSetupCheck,
  registrationCheck,
  workerBacklogCheck,
} from "./opening-readiness.mjs";

const TIMEOUT_MS = 5000;

function failure(error) {
  const code = error?.code ?? error?.name ?? "error";
  return { ok: false, detail: `unreachable (${String(code).slice(0, 40)})` };
}

async function probe(run) {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

async function databaseProbes(databaseUrl) {
  if (!databaseUrl) {
    const missing = { ok: false, detail: "DATABASE_URL missing" };
    return { database: missing, ownerSetup: missing, workerBacklog: missing };
  }
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: TIMEOUT_MS / 1000, onnotice: () => {} });
  try {
    const database = await probe(async () => {
      await sql`select 1`;
      return { ok: true, detail: "reachable" };
    });
    if (!database.ok) return { database, ownerSetup: database, workerBacklog: database };
    const ownerSetup = await probe(async () => {
      const [row] = await sql`SELECT count(*)::int AS n FROM users`;
      return ownerSetupCheck(row.n);
    });
    const workerBacklog = await probe(async () => {
      const stale = `${WORKER_BACKLOG_STALE_MINUTES} minutes`;
      // Reminders are delayed by design, so only non-remind jobs count as stale.
      const [row] = await sql`
        SELECT
          (SELECT count(*)::int FROM opening_outbox
            WHERE state = 'pending' AND created_at < now() - ${stale}::interval) AS stale_pending,
          (SELECT count(*)::int FROM opening_outbox WHERE state = 'failed') AS failed_outbox,
          (SELECT count(*)::int FROM opening_jobs
            WHERE state = 'queued' AND kind <> 'remind' AND created_at < now() - ${stale}::interval)
          + (SELECT count(*)::int FROM opening_tutor_jobs
            WHERE status = 'queued' AND created_at < now() - ${stale}::interval) AS stale_queued`;
      return workerBacklogCheck({
        stalePending: row.stale_pending,
        failedOutbox: row.failed_outbox,
        staleQueued: row.stale_queued,
      });
    });
    return { database, ownerSetup, workerBacklog };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function redisProbe(redisUrl) {
  if (!redisUrl) return { ok: false, detail: "REDIS_URL missing" };
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: TIMEOUT_MS, lazyConnect: true });
  redis.on("error", () => {});
  try {
    return await probe(async () => {
      await redis.connect();
      return (await redis.ping()) === "PONG"
        ? { ok: true, detail: "reachable" }
        : { ok: false, detail: "unexpected ping response" };
    });
  } finally {
    redis.disconnect();
  }
}

async function storageProbe(env) {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) return { ok: false, detail: "S3 configuration missing" };
  const client = new S3Client({
    region: env.S3_REGION || "us-east-1",
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "" },
  });
  try {
    return await probe(async () => {
      await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
      return { ok: true, detail: "bucket reachable" };
    });
  } finally {
    client.destroy();
  }
}

async function publicHttpsProbe(publicBaseUrl) {
  let status = null;
  try {
    if (new URL(publicBaseUrl ?? "").protocol === "https:") {
      const response = await fetch(new URL("/api/health", publicBaseUrl), {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
    }
  } catch {
    status = null;
  }
  return httpsCheck(publicBaseUrl, status);
}

async function loadCatalog(env) {
  try {
    const { loadOpeningModelCatalog } = await import("../packages/config/src/opening-model-catalog.ts");
    return loadOpeningModelCatalog(env);
  } catch {
    // Invalid catalog, or not running under tsx; both mean provider readiness is unproven.
    return null;
  }
}

async function backupProbe(env) {
  const path = env.OPENING_BACKUP_ARCHIVE_PATH?.trim();
  if (!path) return { ok: false, detail: "OPENING_BACKUP_ARCHIVE_PATH not set" };
  const maxAge = Number(env.OPENING_BACKUP_MAX_AGE_HOURS);
  return backupFreshnessCheck(await backupAgeHours(path), Number.isFinite(maxAge) && maxAge > 0 ? maxAge : undefined);
}

export async function runReadinessProbes(env = process.env) {
  const [db, redis, storage, https, catalog, backupFreshness] = await Promise.all([
    databaseProbes(env.DATABASE_URL),
    redisProbe(env.REDIS_URL),
    storageProbe(env),
    publicHttpsProbe(env.PUBLIC_BASE_URL),
    loadCatalog(env),
    backupProbe(env),
  ]);
  return {
    ...db,
    redis,
    storage,
    https,
    registrationLocked: registrationCheck(env),
    ...modelChecks(catalog),
    backupFreshness,
  };
}
