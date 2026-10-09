#!/usr/bin/env node
/**
 * Opening readiness check. Aggregates probe results into one report.
 * Metadata only: never prints credentials, keys, or user content.
 *
 * Usage: npx tsx scripts/opening-readiness.mjs
 * tsx is needed so the product model catalog (TypeScript) decides provider and
 * budget readiness; this module owns the honest-aggregation rules and the
 * probes live in opening-readiness-probes.mjs.
 */
import { stat } from "node:fs/promises";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "PUBLIC_BASE_URL",
];

/**
 * Every check a release depends on. A check that was never run is a failure.
 * Maps 08-delivery.md §Q03 readiness list:
 * owner setup → ownerSetup; registration403 → registrationLocked;
 * HTTPS → https; storage → storage; DB/Redis/worker → database/redis/workerBacklog;
 * provider → providerConfigured; daily cap → dailyCap; backup freshness → backupFreshness.
 * Alert destination honesty is separate (`alertDelivery`), not a probe name.
 */
export const REQUIRED_CHECKS = [
  "database",
  "redis",
  "storage",
  "workerBacklog",
  "https",
  "registrationLocked",
  "ownerSetup",
  "providerConfigured",
  "dailyCap",
  "backupFreshness",
];

const DEFAULT_BACKUP_MAX_AGE_HOURS = 24;
/** Outbox/job rows older than this mean no worker is consuming. */
export const WORKER_BACKLOG_STALE_MINUTES = 10;

function checkName(result) {
  return typeof result?.detail === "string" && result.detail.length > 0
    ? `${result.name}: ${result.detail}`
    : result.name;
}

/**
 * Fail-closed aggregation. `ready` is true only when every required check was
 * run and returned `ok: true` AND an alert destination is configured; an
 * unconfigured destination means monitoring exists locally but nobody is
 * receiving alerts, and that is stated, not hidden. "configured" never claims
 * an alert was delivered.
 */
export function buildReadinessReport({ env = process.env, checks }) {
  const supplied = checks ?? {};
  const names = [...new Set([...REQUIRED_CHECKS, ...Object.keys(supplied)])];
  const results = Object.fromEntries(names.map((name) => [
    name,
    Object.hasOwn(supplied, name) ? supplied[name] : { ok: false, detail: "probe not run" },
  ]));
  const failing = names
    .filter((name) => results[name]?.ok !== true)
    .map((name) => checkName({ name, detail: results[name]?.detail }));
  const missing = REQUIRED_ENV.filter((name) => typeof env?.[name] !== "string" || env[name].trim().length === 0);
  for (const name of missing) failing.push(`${name} is not configured`);
  const alertConfigured = typeof env?.ALERT_WEBHOOK_URL === "string" && env.ALERT_WEBHOOK_URL.trim().length > 0;
  const notes = [];
  if (!alertConfigured) {
    notes.push("Unconfigured alert destination: monitoring exists locally but nobody is receiving alerts.");
  }
  const backupCheck = results.backupFreshness;
  if (backupCheck.ok !== true) {
    notes.push(`Backup freshness is failing (${backupCheck.detail}); recovery drills need a recent archive.`);
  }
  const ready = failing.length === 0 && alertConfigured;
  return {
    ready,
    alertDelivery: alertConfigured ? "configured" : "unconfigured",
    checks: Object.fromEntries(names.map((name) => [name, { ok: results[name]?.ok === true }])),
    failing,
    notes,
  };
}

/** Same truthy parsing as apps/web isOpeningRelease; registration is closed only then. */
export function registrationCheck(env = process.env) {
  const raw = env.OPENING_RELEASE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes"
    ? { ok: true, detail: "OPENING_RELEASE closes registration (expect registration 403)" }
    : { ok: false, detail: "OPENING_RELEASE is not enabled; registration stays open (no registration 403)" };
}

/**
 * Provider and budget readiness from the product model catalog
 * (loadOpeningModelCatalog result), not from raw env string presence.
 */
export function modelChecks(catalog) {
  if (!catalog) {
    const failed = { ok: false, detail: "model catalog invalid or unavailable" };
    return { providerConfigured: failed, dailyCap: failed };
  }
  const model = catalog.models.find((entry) => entry.id === catalog.defaultModelId);
  return {
    providerConfigured: model?.availability === "available"
      ? { ok: true, detail: `default model ${model.id} available` }
      : { ok: false, detail: model ? `default model ${model.id} is ${model.availability}` : "no default model" },
    dailyCap: catalog.dailyCapCents > 0
      ? { ok: true, detail: `${catalog.dailyCapCents} cents/day` }
      : { ok: false, detail: "OPENING_MODEL_DAILY_CAP_CENTS is 0; model budget disabled" },
  };
}

/** Stale undispatched outbox, failed enqueue, or never-claimed jobs mean nobody is consuming. */
export function workerBacklogCheck({ stalePending, failedOutbox, staleQueued }) {
  const problems = [];
  if (stalePending > 0) problems.push(`${stalePending} outbox rows pending > ${WORKER_BACKLOG_STALE_MINUTES}m`);
  if (failedOutbox > 0) problems.push(`${failedOutbox} outbox rows failed to enqueue`);
  if (staleQueued > 0) problems.push(`${staleQueued} jobs queued > ${WORKER_BACKLOG_STALE_MINUTES}m`);
  return problems.length
    ? { ok: false, detail: problems.join("; ") }
    : { ok: true, detail: "no stale backlog" };
}

export function ownerSetupCheck(userCount) {
  return userCount > 0
    ? { ok: true, detail: "owner exists" }
    : { ok: false, detail: "no owner; run scripts/opening-create-owner.ts" };
}

export function httpsCheck(publicBaseUrl, healthStatus) {
  let url;
  try {
    url = new URL(publicBaseUrl ?? "");
  } catch {
    return { ok: false, detail: "PUBLIC_BASE_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, detail: "PUBLIC_BASE_URL is not https" };
  if (healthStatus === null) return { ok: false, detail: "public /api/health unreachable" };
  return healthStatus === 200
    ? { ok: true, detail: "public /api/health 200 over https" }
    : { ok: false, detail: `public /api/health returned ${healthStatus}` };
}

export async function backupAgeHours(archivePath, now = new Date()) {
  const info = await stat(archivePath).catch(() => null);
  if (!info) return null;
  return (now.getTime() - info.mtimeMs) / 3_600_000;
}

export function backupFreshnessCheck(ageHours, maxAgeHours = DEFAULT_BACKUP_MAX_AGE_HOURS) {
  if (ageHours === null) return { ok: false, detail: "no archive found" };
  return ageHours <= maxAgeHours
    ? { ok: true, detail: `${ageHours.toFixed(1)}h old` }
    : { ok: false, detail: `${ageHours.toFixed(1)}h old exceeds ${maxAgeHours}h limit` };
}

async function main() {
  const { runReadinessProbes } = await import("./opening-readiness-probes.mjs");
  const env = process.env;
  const report = buildReadinessReport({ env, checks: await runReadinessProbes(env) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("opening-readiness.mjs")) {
  // Not top-level awaited: the probes module imports this one back.
  main().catch((error) => {
    process.stderr.write(`readiness failed: ${error?.name ?? "error"}\n`);
    process.exitCode = 1;
  });
}
