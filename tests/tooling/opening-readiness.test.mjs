import assert from "node:assert/strict";
import test from "node:test";

const { buildReadinessReport } = await import("../../scripts/opening-readiness.mjs");

function env(overrides = {}) {
  return {
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/aistudy",
    REDIS_URL: "redis://127.0.0.1:6379",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_BUCKET: "aistudy",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    AI_PROVIDER_API_KEY: "sk-test",
    ALERT_WEBHOOK_URL: "https://alerts.example/hook",
    OPENING_BACKUP_MAX_AGE_HOURS: "24",
    ...overrides,
  };
}

function baseChecks() {
  return {
    database: { ok: true, detail: "reachable" },
    redis: { ok: true, detail: "reachable" },
    storage: { ok: true, detail: "reachable" },
    workerHeartbeat: { ok: true, detail: "recent" },
    https: { ok: true, detail: "tls" },
    registrationLocked: { ok: true, detail: "403 enforced" },
    ownerSetup: { ok: true, detail: "done" },
    providerConfigured: { ok: true, detail: "key present" },
    dailyCap: { ok: true, detail: "1000" },
    backupFreshness: { ok: true, detail: "2h old" },
  };
}

test("reports ok only when every check passes and an alert destination is configured", () => {
  const report = buildReadinessReport({ env: env(), checks: baseChecks() });
  assert.equal(report.ready, true);
  assert.equal(report.alertDelivery, "configured");
});

test("an unconfigured alert destination keeps checks green but is never reported as supervised", () => {
  const report = buildReadinessReport({ env: env({ ALERT_WEBHOOK_URL: "" }), checks: baseChecks() });
  assert.equal(report.ready, false);
  assert.equal(report.alertDelivery, "unconfigured");
  assert.ok(report.notes.some((note) => /nobody is receiving alerts/i.test(note)));
});

test("any failed check blocks readiness and lists the failing area by name", () => {
  const checks = baseChecks();
  checks.storage = { ok: false, detail: "connection refused" };
  const report = buildReadinessReport({ env: env(), checks });
  assert.equal(report.ready, false);
  assert.ok(report.failing.some((item) => item.startsWith("storage")));
  assert.ok(!JSON.stringify(report).includes("minioadmin"));
  assert.ok(!JSON.stringify(report).includes("sk-test"));
});

test("missing required environment is reported as not ready with the variable named", () => {
  const report = buildReadinessReport({ env: env({ REDIS_URL: undefined }), checks: baseChecks() });
  assert.equal(report.ready, false);
  assert.ok(report.failing.some((item) => item.includes("REDIS_URL")));
});

test("stale backup beyond the configured age is named with the age, not silent", () => {
  const report = buildReadinessReport({
    env: env({ OPENING_BACKUP_MAX_AGE_HOURS: "24" }),
    checks: { ...baseChecks(), backupFreshness: { ok: false, detail: "73h old" } },
  });
  assert.equal(report.ready, false);
  assert.ok(report.failing.some((item) => /backup/i.test(item)));
});
