import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertOpeningTestDatabase } from "../../scripts/opening-test-db.mjs";

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
