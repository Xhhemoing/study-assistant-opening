import assert from "node:assert/strict";
import test from "node:test";

const {
  REQUIRED_CHECKS,
  buildReadinessReport,
  httpsCheck,
  modelChecks,
  ownerSetupCheck,
  backupFreshnessCheck,
  registrationCheck,
  workerBacklogCheck,
} = await import("../../scripts/opening-readiness.mjs");

function env(overrides = {}) {
  return {
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/aistudy",
    REDIS_URL: "redis://127.0.0.1:6379",
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "aistudy",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    PUBLIC_BASE_URL: "https://study.example",
    OPENING_MODEL_API_KEY: "sk-test",
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
    workerBacklog: { ok: true, detail: "no stale backlog" },
    https: { ok: true, detail: "tls" },
    registrationLocked: { ok: true, detail: "403 enforced" },
    ownerSetup: { ok: true, detail: "done" },
    providerConfigured: { ok: true, detail: "key present" },
    dailyCap: { ok: true, detail: "1000" },
    backupFreshness: { ok: true, detail: "2h old" },
  };
}

function catalog(overrides = {}) {
  return {
    models: [{ id: "default", availability: "available" }],
    defaultModelId: "default",
    dailyCapCents: 500,
    ...overrides,
  };
}

test("reports ok only when every check passes and an alert destination is configured", () => {
  const report = buildReadinessReport({ env: env(), checks: baseChecks() });
  assert.equal(report.ready, true);
  assert.equal(report.alertDelivery, "configured");
});

test("empty checks never report ready, and every required probe is named as not run", () => {
  const report = buildReadinessReport({ env: env(), checks: {} });
  assert.equal(report.ready, false);
  assert.equal(Object.keys(report.checks).length, REQUIRED_CHECKS.length);
  for (const name of REQUIRED_CHECKS) {
    assert.ok(report.failing.includes(`${name}: probe not run`), name);
  }
});

test("one omitted required check blocks readiness", () => {
  const { workerBacklog: _omitted, ...checks } = baseChecks();
  const report = buildReadinessReport({ env: env(), checks });
  assert.equal(report.ready, false);
  assert.deepEqual(report.failing, ["workerBacklog: probe not run"]);
});

test("only ok === true passes; truthy non-boolean results fail", () => {
  const report = buildReadinessReport({ env: env(), checks: { ...baseChecks(), redis: { ok: "yes" } } });
  assert.equal(report.ready, false);
  assert.ok(report.failing.includes("redis"));
});

test("an unconfigured alert destination keeps checks green but is never reported as supervised", () => {
  const report = buildReadinessReport({ env: env({ ALERT_WEBHOOK_URL: "  " }), checks: baseChecks() });
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

test("registration is locked only by the product OPENING_RELEASE parsing", () => {
  for (const value of ["1", "true", " YES "]) {
    assert.equal(registrationCheck({ OPENING_RELEASE: value }).ok, true, value);
  }
  for (const value of [undefined, "", "0", "false", "on"]) {
    assert.equal(registrationCheck({ OPENING_RELEASE: value }).ok, false, String(value));
  }
  // The old flag name is not what the product reads.
  assert.equal(registrationCheck({ OPENING_REGISTRATION_LOCKED: "true" }).ok, false);
});

test("provider and cap readiness follow catalog availability, not string presence", () => {
  assert.deepEqual(
    Object.values(modelChecks(catalog())).map((check) => check.ok),
    [true, true],
  );
  const disabled = modelChecks(catalog({ dailyCapCents: 0, models: [{ id: "default", availability: "budget_disabled" }] }));
  assert.equal(disabled.providerConfigured.ok, false);
  assert.match(disabled.providerConfigured.detail, /budget_disabled/);
  assert.equal(disabled.dailyCap.ok, false);
  assert.equal(modelChecks(catalog({ models: [{ id: "default", availability: "pricing_missing" }] })).providerConfigured.ok, false);
  assert.equal(modelChecks(catalog({ defaultModelId: null })).providerConfigured.ok, false);
  const invalid = modelChecks(null);
  assert.equal(invalid.providerConfigured.ok, false);
  assert.equal(invalid.dailyCap.ok, false);
});

test("worker backlog fails on stale pending, failed enqueue, or unclaimed jobs", () => {
  assert.equal(workerBacklogCheck({ stalePending: 0, failedOutbox: 0, staleQueued: 0 }).ok, true);
  for (const counts of [
    { stalePending: 2, failedOutbox: 0, staleQueued: 0 },
    { stalePending: 0, failedOutbox: 1, staleQueued: 0 },
    { stalePending: 0, failedOutbox: 0, staleQueued: 3 },
  ]) {
    assert.equal(workerBacklogCheck(counts).ok, false, JSON.stringify(counts));
  }
});

test("https requires an https public URL and a 200 health response", () => {
  assert.equal(httpsCheck("https://study.example", 200).ok, true);
  assert.equal(httpsCheck("http://study.example", 200).ok, false);
  assert.equal(httpsCheck("not a url", 200).ok, false);
  assert.equal(httpsCheck("https://study.example", null).ok, false);
  assert.equal(httpsCheck("https://study.example", 503).ok, false);
});

test("REQUIRED_CHECKS covers the §Q03 readiness list names", () => {
  for (const name of [
    "database", "redis", "storage", "workerBacklog", "https",
    "registrationLocked", "ownerSetup", "providerConfigured", "dailyCap", "backupFreshness",
  ]) {
    assert.ok(REQUIRED_CHECKS.includes(name), name);
  }
  assert.equal(REQUIRED_CHECKS.length, 10);
});

test("ownerSetupCheck requires at least one user", () => {
  assert.equal(ownerSetupCheck(0).ok, false);
  assert.match(ownerSetupCheck(0).detail, /no owner/i);
  assert.equal(ownerSetupCheck(1).ok, true);
});

test("backupFreshnessCheck fails closed without archive or when stale", () => {
  assert.equal(backupFreshnessCheck(null).ok, false);
  assert.equal(backupFreshnessCheck(2, 24).ok, true);
  assert.equal(backupFreshnessCheck(25, 24).ok, false);
  assert.match(backupFreshnessCheck(25, 24).detail, /exceeds/);
});

test("registrationLocked detail mentions registration 403 when locked", () => {
  assert.match(registrationCheck({ OPENING_RELEASE: "true" }).detail, /403/);
  assert.match(registrationCheck({ OPENING_RELEASE: "0" }).detail, /403/);
});

