import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import setup, { assertOpeningTestDatabase } from "../../scripts/opening-test-db.mjs";

const baseUrl = "postgres://u:p@127.0.0.1/aistudy_opening_test";
const wrapper = fileURLToPath(new URL("../../scripts/opening-test-db.mjs", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

for (const query of [
  "database=production",
  "database=aistudy_opening_test&database=production",
  "%64atabase=production",
]) {
  test(`CLI guard rejects startup database override: ${query}`, () => {
    assert.throws(
      () => assertOpeningTestDatabase(`${baseUrl}?${query}`, "1"),
      /database.*parameter|parameter.*database/i,
    );
  });
}

test("CLI guard preserves ordinary connection parameters", () => {
  const parsed = assertOpeningTestDatabase(`${baseUrl}?sslmode=disable`, "1");
  assert.equal(parsed.pathname, "/aistudy_opening_test");
  assert.equal(parsed.searchParams.get("sslmode"), "disable");
});

test("unsafe URL stops the wrapper before it starts the supplied child", () => {
  const result = spawnSync(process.execPath, [wrapper, "--", "node", "--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      OPENING_TEST_DB: "1",
      OPENING_TEST_DATABASE_URL: `${baseUrl}?database=production`,
      DATABASE_URL: "postgres://unused:unused@invalid.example/never-connect",
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /database.*parameter|parameter.*database/i);
});

for (const { name, url, enabled, message } of [
  { name: "missing URL", url: "", enabled: "1", message: /required/i },
  { name: "missing opt-in", url: baseUrl, enabled: "", message: /OPENING_TEST_DB=1/ },
  { name: "non-loopback host", url: "postgres://u:p@db.example/aistudy_opening_test", enabled: "1", message: /loopback/i },
  { name: "wrong database", url: "postgres://u:p@127.0.0.1/aistudy", enabled: "1", message: /exactly aistudy_opening_test/i },
  ...["database=production", "database=aistudy_opening_test&database=production", "%64atabase=production"].map((query) => ({
    name: `database override ${query}`, url: `${baseUrl}?${query}`, enabled: "1", message: /database.*parameter/i,
  })),
]) {
  test(`global setup rejects ${name} before changing the database target`, async () => {
    const previous = { ...process.env };
    try {
      process.env.OPENING_TEST_DATABASE_URL = url;
      process.env.OPENING_TEST_DB = enabled;
      process.env.DATABASE_URL = "postgres://unused:unused@invalid.example/never-connect";
      await assert.rejects(setup(), message);
      assert.equal(process.env.DATABASE_URL, "postgres://unused:unused@invalid.example/never-connect");
    } finally {
      for (const key of ["OPENING_TEST_DATABASE_URL", "OPENING_TEST_DB", "DATABASE_URL"]) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
}
