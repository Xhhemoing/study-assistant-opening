#!/usr/bin/env node
/**
 * Opening readiness check. Aggregates probe results into one report.
 * Metadata only: never prints credentials, keys, or user content.
 *
 * Usage: node scripts/opening-readiness.mjs [--json]
 * The caller (or a future probe runner) supplies individual check results via
 * collectReadiness(); this module owns the honest-aggregation rules.
 */
import { stat } from "node:fs/promises";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];

const DEFAULT_BACKUP_MAX_AGE_HOURS = 24;

function checkName(result) {
  return typeof result?.detail === "string" && result.detail.length > 0
    ? `${result.name}: ${result.detail}`
    : result.name;
}

export function collectReadiness(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name] || env[name].length === 0);
  return { missingEnv: missing };
}

/**
 * Fail-closed aggregation. `ready` is true only when every check passed AND an
 * alert destination is configured; an unconfigured destination means monitoring
 * exists locally but nobody is receiving alerts, and that is stated, not hidden.
 */
export function buildReadinessReport({ env = process.env, checks }) {
  const entries = Object.entries(checks ?? {});
  const failing = entries
    .filter(([, result]) => !result?.ok)
    .map(([name, result]) => checkName({ name, detail: result?.detail }));
  const missing = REQUIRED_ENV.filter((name) => !env?.[name]);
  for (const name of missing) failing.push(`${name} is not configured`);
  const alertConfigured = typeof env?.ALERT_WEBHOOK_URL === "string" && env.ALERT_WEBHOOK_URL.length > 0;
  const notes = [];
  if (!alertConfigured) {
    notes.push("Unconfigured alert destination: monitoring exists locally but nobody is receiving alerts.");
  }
  const backupCheck = checks?.backupFreshness;
  if (backupCheck && !backupCheck.ok) {
    notes.push(`Backup freshness is failing (${backupCheck.detail}); recovery drills need a recent archive.`);
  }
  const ready = failing.length === 0 && alertConfigured;
  return {
    ready,
    alertDelivery: alertConfigured ? "configured" : "unconfigured",
    checks: Object.fromEntries(entries.map(([name, result]) => [name, { ok: result?.ok === true }])),
    failing,
    notes,
  };
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

function main() {
  const env = process.env;
  const report = buildReadinessReport({
    env,
    checks: Object.fromEntries([
      ["database", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["redis", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["storage", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["workerHeartbeat", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["https", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["registrationLocked", { ok: Boolean(env.OPENING_REGISTRATION_LOCKED), detail: env.OPENING_REGISTRATION_LOCKED ? "403 enforced" : "OPENING_REGISTRATION_LOCKED missing" }],
      ["ownerSetup", { ok: false, detail: "probe not run; run with a configured environment" }],
      ["providerConfigured", { ok: Boolean(env.AI_PROVIDER_API_KEY), detail: env.AI_PROVIDER_API_KEY ? "key present" : "AI_PROVIDER_API_KEY missing" }],
      ["dailyCap", { ok: Boolean(env.OPENING_DAILY_CAP), detail: env.OPENING_DAILY_CAP ? "configured" : "OPENING_DAILY_CAP missing" }],
      ["backupFreshness", { ok: false, detail: "probe not run; run with a configured environment" }],
    ]),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ready ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("opening-readiness.mjs")) {
  main();
}
