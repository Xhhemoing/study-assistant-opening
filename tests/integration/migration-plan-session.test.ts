import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { applyMigrations, createMigrationSqlClient, createSqlClient, inspectMigrationQuiescence, planMigrations } from "../../packages/database/src/migrate";

const databaseUrl = process.env.DATABASE_URL!;
const admin = createSqlClient(databaseUrl, { max: 1 });
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  await admin.end();
});
async function fixture(files = { "0001_one.sql": "CREATE TABLE one(id int);", "0002_two.sql": "SELECT 2;" }) {
  const schema = `migration_plan_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  cleanup.push(() => admin.unsafe(`DROP SCHEMA ${schema} CASCADE`));
  const directory = await mkdtemp(path.join(tmpdir(), "migration-plan-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  for (const [id, body] of Object.entries(files)) await writeFile(path.join(directory, id), body);
  const url = new URL(databaseUrl);
  url.searchParams.set("search_path", schema);
  const sql = createMigrationSqlClient(url.href);
  cleanup.push(() => sql.end());
  return { sql, url, directory };
}
it("plans absent registries without creating anything; proves ready no-pending only after bootstrap", async () => {
  const { sql, directory } = await fixture();
  expect(await planMigrations(sql, { migrationsDir: directory })).toMatchObject({
    registryReadyWithoutWrites: false, pending: ["0001_one.sql", "0002_two.sql"], readOnly: true,
  });
  expect((await sql`SELECT to_regclass('schema_migrations') AS registry`)[0]!.registry).toBeNull();
  await applyMigrations(sql, { migrationsDir: directory });
  const before = [...await sql`SELECT * FROM schema_migrations ORDER BY id`];
  expect(await planMigrations(sql, { migrationsDir: directory })).toMatchObject({ registryReadyWithoutWrites: true, pending: [] });
  expect([...await sql`SELECT * FROM schema_migrations ORDER BY id`]).toEqual(before);
  await sql`DROP TABLE migration_attestations`;
  expect(await planMigrations(sql, { migrationsDir: directory })).toMatchObject({ registryReadyWithoutWrites: false, pending: [] });
});
it("refuses missing bootstrap columns without writing legacy states or creating attestations", async () => {
  const { sql, directory } = await fixture();
  await sql`CREATE TABLE schema_migrations(id text PRIMARY KEY, applied_at timestamptz DEFAULT now())`;
  await sql`INSERT INTO schema_migrations(id) VALUES ('0001_one.sql')`;
  const before = [...await sql`SELECT * FROM schema_migrations`];
  await expect(planMigrations(sql, { migrationsDir: directory })).rejects.toMatchObject({ code: "MIGRATION_REGISTRY_NOT_READY" });
  expect([...await sql`SELECT * FROM schema_migrations`]).toEqual(before);
  expect((await sql`SELECT to_regclass('migration_attestations') AS registry`)[0]!.registry).toBeNull();
});
it("uses runner verification for unknown history, gaps, checksum drift and invalid state", async () => {
  for (const [mutate, code] of [
    ["UPDATE schema_migrations SET id='9999_unknown.sql' WHERE id='0002_two.sql'", "MIGRATION_UNKNOWN_HISTORY"],
    ["DELETE FROM schema_migrations WHERE id='0001_one.sql'", "MIGRATION_HISTORY_GAP"],
    ["UPDATE schema_migrations SET checksum='changed'", "MIGRATION_CHECKSUM_DRIFT"],
    ["UPDATE schema_migrations SET verification_state='unknown'", "MIGRATION_INVALID_VERIFICATION_STATE"],
  ]) {
    const { sql, directory } = await fixture();
    await applyMigrations(sql, { migrationsDir: directory });
    await sql.unsafe(mutate!);
    for (const run of [planMigrations, applyMigrations]) await expect(run(sql, { migrationsDir: directory })).rejects.toMatchObject({ code });
  }
});
it("preserves legacy-unverified semantics, while plan never writes an attestation", async () => {
  const { sql, directory } = await fixture();
  await applyMigrations(sql, { migrationsDir: directory });
  await sql`UPDATE schema_migrations SET verification_state='legacy-unverified', checksum=null`;
  expect(await planMigrations(sql, { migrationsDir: directory })).toMatchObject({ pending: [], registryReadyWithoutWrites: true });
  expect([...await sql`SELECT * FROM migration_attestations`]).toEqual([]);
});
it("enforces real startup timeouts on distinct pool connections, including a replacement connection", async () => {
  const bounded = createMigrationSqlClient(databaseUrl, { max: 2 });
  try {
    const first = await bounded.reserve();
    await first`SELECT 1`; // Finish postgres.js type discovery before reserving the second connection.
    const second = await bounded.reserve();
    const settings = async (sql: typeof first) => {
      const [row] = await sql`SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock,
        current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`;
      expect(row).toMatchObject({ lock: "5s", statement: "2min", idle: "30s" });
      return row!.pid;
    };
    const pid = await settings(first);
    const secondPid = await settings(second);
    expect(secondPid).not.toBe(pid);
    first.release();
    second.release();
    const closed = new Promise<void>(resolve => {
      let count = 0;
      bounded.options.onclose = () => { if (++count === 2) resolve(); };
    });
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid IN (${pid}, ${secondPid})`;
    await closed; // Observe actual disconnect events, not a retry of a failed migration/query.
    const [replacement] = await bounded`SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS lock,
      current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`;
    expect([pid, secondPid]).not.toContain(replacement!.pid);
    expect(replacement).toMatchObject({ lock: "5s", statement: "2min", idle: "30s" });
  } finally { await bounded.end({ timeout: 1 }); }
  expect(() => createMigrationSqlClient(`${databaseUrl}?options=-c%20lock_timeout=0`)).toThrow();
  const ordinary = createSqlClient(databaseUrl, { max: 1 });
  try { expect((await ordinary`SHOW lock_timeout`)[0]!.lock_timeout).toBe("0"); }
  finally { await ordinary.end(); }
});
it("actual lock timeout is 5s, with no retry and with the backend still queryable", async () => {
  const { sql, url } = await fixture();
  const blocker = createSqlClient(url.href, { max: 1 });
  try {
    await sql`CREATE TABLE blocked(id int)`;
    await blocker.unsafe("BEGIN");
    await blocker.unsafe("LOCK TABLE blocked IN ACCESS EXCLUSIVE MODE");
    const started = Date.now();
    await expect(sql`ALTER TABLE blocked ADD COLUMN value text`).rejects.toMatchObject({ code: "55P03" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
    expect(Date.now() - started).toBeLessThan(15000);
    expect((await sql`SELECT 1 AS alive`)[0]!.alive).toBe(1);
  } finally { await blocker.unsafe("ROLLBACK"); await blocker.end(); }
}, 15_000);
it("quiescence returns aggregates only and rejects an actual foreign transaction", async () => {
  const { sql, url } = await fixture();
  expect(await inspectMigrationQuiescence(sql)).toMatchObject({ readOnly: true });
  const foreign = createSqlClient(url.href, { max: 1 });
  try {
    await foreign.unsafe("BEGIN");
    await expect(inspectMigrationQuiescence(sql)).rejects.toMatchObject({ code: "MIGRATION_QUIESCENCE_UNCONFIRMED" });
  } finally { await foreign.unsafe("ROLLBACK"); await foreign.end(); }
});
