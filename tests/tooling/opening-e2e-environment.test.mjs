import assert from "node:assert/strict";
import test from "node:test";
import { buildOpeningE2eEnvironment, assertOpeningE2eDatabase } from "../../scripts/opening-e2e/environment.mjs";

const database = "postgres://opening:opening-local-test@127.0.0.1:15432/aistudy_opening_e2e";
test("requires explicit opt-in before touching the isolated E2E database", () => {
  assert.throws(() => assertOpeningE2eDatabase(database, undefined), /OPENING_E2E=1/);
  assert.equal(assertOpeningE2eDatabase(database, "1").pathname, "/aistudy_opening_e2e");
});
for (const [name, url] of [
  ["application database", database.replace("aistudy_opening_e2e", "aistudy")],
  ["existing developer instance", database.replace(":15432", ":5433")],
  ["remote server", database.replace("127.0.0.1", "db.example.com")],
  ["database override", `${database}?database=aistudy`],
  ["host override", `${database}?host=db.example.com`],
  ["non-postgres protocol", database.replace("postgres:", "https:")],
]) {
  test(`rejects ${name} before reset or seed`, () => {
    assert.throws(() => assertOpeningE2eDatabase(url, "1"));
  });
}
test("isolates all mutable services and prevents inherited paid model configuration", () => {
  const env = buildOpeningE2eEnvironment({
    DATABASE_URL: "postgres://production/private", REDIS_URL: "redis://production",
    S3_BUCKET: "user-data", OPENING_MODEL_API_KEY: "paid-secret",
    OPENING_MODEL_BASE_URL: "https://paid.example.com", FEISHU_REMINDER_CREDENTIAL: "live-token",
    OPENING_TUTOR_MAX_CONTEXT_CHARS: "1",
  });
  assert.equal(env.DATABASE_URL, database);
  assert.equal(env.E2E_DATABASE_URL, database);
  assert.equal(env.REDIS_URL, "redis://127.0.0.1:16379/0");
  assert.equal(env.S3_ENDPOINT, "http://127.0.0.1:19000");
  assert.equal(env.S3_BUCKET, "opening-e2e");
  assert.equal(env.PUBLIC_BASE_URL, "http://127.0.0.1:3100");
  assert.equal(env.OPENING_RELEASE, "1");
  assert.equal(env.OPENING_MODEL_BASE_URL, "http://127.0.0.1:18081/v1");
  assert.equal(env.OPENING_MODEL_API_KEY, "opening-e2e-fixture-key");
  assert.equal(env.OPENING_TUTOR_MAX_CONTEXT_CHARS, "12000");
  assert.equal(env.FEISHU_REMINDER_CREDENTIAL, "");
});
for (const [key, value] of [
  ["DATABASE_URL", "postgres://remote/userdata"], ["REDIS_URL", "redis://127.0.0.1:6379"],
  ["S3_ENDPOINT", "https://real-storage.example.com"], ["S3_BUCKET", "existing-user-data"],
  ["PUBLIC_BASE_URL", "https://production.example.com"],
]) {
  test(`prepare rejects overridden ${key} before any I/O`, async () => {
    const { prepareOpeningE2e } = await import("../../scripts/opening-e2e/prepare.mjs");
    await assert.rejects(prepareOpeningE2e({ ...buildOpeningE2eEnvironment({}), [key]: value }), /isolated service configuration/);
  });
}
