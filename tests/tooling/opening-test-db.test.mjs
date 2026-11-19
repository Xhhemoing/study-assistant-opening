import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import setup, {
  assertOpeningTestDatabase,
  configureCiOpeningTestDb,
} from "../../scripts/opening-test-db.mjs";

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

test("PR-B scratch override: default still requires aistudy_opening_test", () => {
  const saved = process.env.OPENING_TEST_DB_SCRATCH_NAME;
  delete process.env.OPENING_TEST_DB_SCRATCH_NAME;
  try {
    assert.throws(() => assertOpeningTestDatabase("postgres://u:p@127.0.0.1/aistudy_prb_scratch_20261012", "1"), /exactly aistudy_opening_test/);
  } finally { if (saved !== undefined) process.env.OPENING_TEST_DB_SCRATCH_NAME = saved; }
});

test("PR-B scratch override: accepts only the named scratch DB and rejects bad names", () => {
  const saved = process.env.OPENING_TEST_DB_SCRATCH_NAME;
  try {
    process.env.OPENING_TEST_DB_SCRATCH_NAME = "aistudy_prb_scratch_20261012144500";
    assert.equal(assertOpeningTestDatabase("postgres://u:p@127.0.0.1/aistudy_prb_scratch_20261012144500", "1").pathname, "/aistudy_prb_scratch_20261012144500");
    assert.throws(() => assertOpeningTestDatabase(baseUrl, "1"), /exactly aistudy_prb_scratch_/);
    process.env.OPENING_TEST_DB_SCRATCH_NAME = "aistudy_opening_test";
    assert.throws(() => assertOpeningTestDatabase(baseUrl, "1"), /Refusing OPENING_TEST_DB_SCRATCH_NAME/);
    process.env.OPENING_TEST_DB_SCRATCH_NAME = "production";
    assert.throws(() => assertOpeningTestDatabase("postgres://u:p@127.0.0.1/production", "1"), /Refusing OPENING_TEST_DB_SCRATCH_NAME/);
  } finally {
    if (saved === undefined) delete process.env.OPENING_TEST_DB_SCRATCH_NAME; else process.env.OPENING_TEST_DB_SCRATCH_NAME = saved;
  }
});

for (const { name, url, enabled, message } of [
  { name: "non-loopback host", url: "postgres://u:p@db.example/aistudy_opening_test", enabled: "1", message: /loopback/i },
  { name: "database query override", url: `${baseUrl}?database=production`, enabled: "1", message: /database.*parameter/i },
  { name: "wrong database", url: "postgres://u:p@127.0.0.1/production", enabled: "1", message: /exactly aistudy_opening_test/i },
  { name: "missing opt-in", url: baseUrl, enabled: "", message: /OPENING_TEST_DB=1/ },
]) {
  test(`configureCiOpeningTestDb rejects ${name} before creating a client even in CI`, async () => {
    let createClientCalls = 0;
    await assert.rejects(
      configureCiOpeningTestDb(url, enabled, {
        env: { GITHUB_ACTIONS: "true" },
        createClient: async () => {
          createClientCalls += 1;
          throw new Error("must not connect");
        },
      }),
      message,
    );
    assert.equal(createClientCalls, 0);
  });
}

test("configureCiOpeningTestDb is a no-op outside GitHub Actions", async () => {
  for (const env of [{}, { GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "1" }]) {
    let createClientCalls = 0;
    const result = await configureCiOpeningTestDb(baseUrl, "1", {
      env,
      createClient: async () => {
        createClientCalls += 1;
        throw new Error("must not connect outside CI");
      },
    });
    assert.deepEqual(result, { configured: false, tables: 0 });
    assert.equal(createClientCalls, 0);
  }
});

test("configureCiOpeningTestDb disables autovacuum for public tables in one CI transaction and closes client", async () => {
  const connectedUrls = [];
  const catalogQueries = [];
  const unsafeStatements = [];
  const endCalls = [];
  let beginCalls = 0;

  const result = await configureCiOpeningTestDb(baseUrl, "1", {
    env: { GITHUB_ACTIONS: "true" },
    createClient: async (connectionUrl) => {
      connectedUrls.push(connectionUrl);
      return {
        async begin(callback) {
          beginCalls += 1;
          const tx = async (strings) => {
            catalogQueries.push(strings.join(""));
            return [
              { name: "plain_table", has_toast: false },
              { name: "toasted_table", has_toast: true },
              { name: 'odd"name', has_toast: true },
            ];
          };
          tx.unsafe = async (statement) => {
            unsafeStatements.push(statement);
          };
          return await callback(tx);
        },
        async end(opts) {
          endCalls.push(opts);
        },
      };
    },
  });

  assert.deepEqual(result, { configured: true, tables: 3 });
  assert.deepEqual(connectedUrls, [baseUrl]);
  assert.equal(beginCalls, 1);
  assert.equal(catalogQueries.length, 1);
  assert.match(catalogQueries[0], /n\.nspname\s*=\s*'public'\s+AND\s+c\.relkind\s*=\s*'r'/);
  assert.match(catalogQueries[0], /c\.reltoastrelid\s*<>\s*0\s+AS\s+has_toast/);
  assert.deepEqual(unsafeStatements, [
    'ALTER TABLE "public"."plain_table" SET (autovacuum_enabled = false)',
    'ALTER TABLE "public"."toasted_table" SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)',
    'ALTER TABLE "public"."odd""name" SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)',
  ]);
  assert.deepEqual(endCalls, [{ timeout: 5 }]);
});

test("configureCiOpeningTestDb always closes client when transaction fails", async () => {
  const endCalls = [];
  await assert.rejects(
    configureCiOpeningTestDb(baseUrl, "1", {
      env: { GITHUB_ACTIONS: "true" },
      createClient: async () => ({
        async begin(callback) {
          const tx = async () => [{ name: "broken_table", has_toast: false }];
          tx.unsafe = async () => {
            throw new Error("simulated ALTER TABLE failure");
          };
          return await callback(tx);
        },
        async end(opts) {
          endCalls.push(opts);
        },
      }),
    }),
    /simulated ALTER TABLE failure/,
  );
  assert.deepEqual(endCalls, [{ timeout: 5 }]);
});
