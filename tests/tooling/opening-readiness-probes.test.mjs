import assert from "node:assert/strict";
import test from "node:test";

const { runReadinessProbes } = await import("../../scripts/opening-readiness-probes.mjs");

test("missing service configuration fails closed without exposing secrets", async () => {
  const result = await runReadinessProbes({
    DATABASE_URL: "",
    REDIS_URL: "",
    S3_ENDPOINT: "",
    S3_BUCKET: "",
    PUBLIC_BASE_URL: "not-a-url",
    OPENING_MODEL_API_KEY: "sk-private-test",
    S3_SECRET_ACCESS_KEY: "secret-value",
  });

  assert.equal(result.database.ok, false);
  assert.equal(result.redis.ok, false);
  assert.equal(result.storage.ok, false);
  assert.equal(result.https.ok, false);
  assert.equal(result.backupFreshness.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /sk-private-test|secret-value/);
});

test("registration and model probe results remain structured metadata", async () => {
  const result = await runReadinessProbes({
    DATABASE_URL: "",
    REDIS_URL: "",
    S3_ENDPOINT: "",
    S3_BUCKET: "",
    PUBLIC_BASE_URL: "https://example.invalid",
    OPENING_RELEASE: "true",
    OPENING_MODEL_API_KEY: "",
    OPENING_MODEL_DAILY_CAP_CENTS: "0",
  });

  assert.equal(result.registrationLocked.ok, true);
  assert.equal(typeof result.providerConfigured.ok, "boolean");
  assert.equal(typeof result.dailyCap.ok, "boolean");
  assert.equal(typeof result.workerBacklog.ok, "boolean");
});
