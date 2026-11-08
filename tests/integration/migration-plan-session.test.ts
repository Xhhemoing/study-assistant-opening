import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { applyMigrations, createMigrationSqlClient, createSqlClient, inspectMigrationQuiescence, planMigrations } from "../../packages/database/src/migrate";

const databaseUrl = process.env.DATABASE_URL!;
const admin = createSqlClient(databaseUrl, { max: 1 });
const cleanup: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  await admin.end();
});
async function fixture(files: Record<string, string> = { "0001_one.sql": "CREATE TABLE one(id int);", "0002_two.sql": "SELECT 2;" }) {
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
it("real 0108 commit/0109 failure and 0109 commit/0110 failure retain the exact committed prefix", async () => {
  const migrations = path.resolve('packages/database/src/migrations');
  const ids = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
  for (const failedVersion of [109, 110]) {
    const files = Object.fromEntries(await Promise.all(ids.map(async id => [id, await readFile(path.join(migrations, id), 'utf8')])));
    const { sql, directory } = await fixture(files);
    const [scope] = await sql`SELECT current_schema() AS name`;
    await sql.unsafe(`SET search_path TO ${scope!.name}, public`);
    const blocker = createSqlClient(databaseUrl, { max: 1 });
    const table = failedVersion === 109 ? 'opening_course_reserved_questions' : 'course_asset_memberships';
    // Real SQL bytes stay untouched. A DDL event trigger injects the failure
    // exactly at the next migration, after the prior migration COMMIT.
    const [schema] = await sql`SELECT current_schema() AS name`;
    const trigger = `fail_migration_${randomUUID().replaceAll('-', '')}`;
    const fn = `${trigger}_fn`;
    await blocker.unsafe(`CREATE FUNCTION public.${fn}() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_schema()='${schema!.name}' AND to_regclass('${schema!.name}.schema_migrations') IS NOT NULL
        AND (SELECT count(*) FROM ${schema!.name}.schema_migrations)=${failedVersion - 1}
        AND EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
        WHERE object_identity='${schema!.name}.${table}') THEN RAISE EXCEPTION 'injected migration failure'; END IF; END $$`);
    await blocker.unsafe(`CREATE EVENT TRIGGER ${trigger} ON ddl_command_end EXECUTE FUNCTION public.${fn}()`);
    try {
      await expect(applyMigrations(sql, { migrationsDir: directory })).rejects.toMatchObject({ code: 'P0001' });
      const rows = await sql<{ id: string }[]>`SELECT id FROM schema_migrations ORDER BY id`;
      expect(rows.map(row => row.id)).toEqual(ids.slice(0, failedVersion - 1));
      expect((await planMigrations(sql, { migrationsDir: directory })).pending).toEqual(ids.slice(failedVersion - 1));
      if (failedVersion === 109) expect((await sql`SELECT to_regclass(${`${schema!.name}.opening_course_reserved_questions`}) AS name`)[0]!.name).toBeNull();
      else expect((await sql`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='course_asset_memberships' AND column_name='purpose'`)[0]!.count).toBe(0);
    } finally {
      await blocker.unsafe(`DROP EVENT TRIGGER ${trigger}`);
      await blocker.unsafe(`DROP FUNCTION public.${fn}()`);
      await blocker.end();
    }
  }
}, 30_000);

it("lost COMMIT receipt still leaves the committed ledger and plan, never an inferred rollback", async () => {
  const { sql, directory } = await fixture({ '0001_one.sql': 'CREATE TABLE committed_effect(id int);' });
  const originalReserve = sql.reserve.bind(sql);
  const lostReceipt = new Proxy(sql, { get(target, property, receiver) {
    if (property !== 'reserve') return Reflect.get(target, property, receiver);
    return async () => {
      const reserved = await originalReserve();
      return new Proxy(reserved, { get(target, property, receiver) {
        if (property !== 'unsafe') return Reflect.get(target, property, receiver);
        return async (query: string) => {
          const result = await reserved.unsafe(query);
          if (query === 'COMMIT') throw new Error('injected lost COMMIT receipt after real commit');
          return result;
        };
      } });
    };
  } });
  await expect(applyMigrations(lostReceipt, { migrationsDir: directory })).rejects.toThrow('lost COMMIT receipt');
  expect((await planMigrations(sql, { migrationsDir: directory })).pending).toEqual([]);
  expect((await sql`SELECT to_regclass('committed_effect') AS name`)[0]!.name).toBe('committed_effect');
});

it('real hermes-db plan and no-op migration execute the bounded adapter with sanitized output', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hermes-db-session-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'test.env');
  await writeFile(config, `DATABASE_URL=${databaseUrl}\n`);
  for (const action of ['plan', 'quiescence', 'migrate']) {
    const result = spawnSync(process.execPath, [path.resolve('infra/deploy/hermes-db.mjs'), action, config, path.resolve('.')], { encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(databaseUrl);
    const report = JSON.parse(result.stdout);
    if (action === 'plan') expect(report).toMatchObject({ registryReadyWithoutWrites: true, pending: [], readOnly: true });
    if (action === 'migrate') expect(report.applied).toEqual([]);
  }
}, 30_000);

it('quiescence refuses insufficient visibility and an actual prepared transaction/advisory lock', async context => {
  const { sql, url } = await fixture();
  const role = `migration_observer_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE ROLE ${role}`);
  try {
    await sql.unsafe(`SET ROLE ${role}`);
    await expect(inspectMigrationQuiescence(sql)).rejects.toMatchObject({ code: 'MIGRATION_QUIESCENCE_UNCONFIRMED' });
  } finally { await sql.unsafe('RESET ROLE'); await admin.unsafe(`DROP ROLE ${role}`); }
  const other = createSqlClient(url.href, { max: 1 });
  try {
    await other`SELECT pg_advisory_lock(791002399)`;
    await expect(inspectMigrationQuiescence(sql)).rejects.toMatchObject({ code: 'MIGRATION_QUIESCENCE_UNCONFIRMED' });
    await other`SELECT pg_advisory_unlock(791002399)`;
    const [settings] = await admin`SHOW max_prepared_transactions`;
    if (Number(settings!.max_prepared_transactions) === 0) { context.skip('Prepared transaction coverage requires isolated PG max_prepared_transactions > 0'); return; }
    const gid = `migration_test_${randomUUID()}`;
    await other.unsafe('BEGIN');
    await other.unsafe(`PREPARE TRANSACTION '${gid}'`);
    try { await expect(inspectMigrationQuiescence(sql)).rejects.toMatchObject({ code: 'MIGRATION_QUIESCENCE_UNCONFIRMED' }); }
    finally { await other.unsafe(`ROLLBACK PREPARED '${gid}'`); }
  } finally { await other.end(); }
});

it("quiescence returns aggregates only and rejects an actual foreign transaction", async () => {
  const { sql, url } = await fixture();
  expect(await inspectMigrationQuiescence(sql)).toMatchObject({ readOnly: true });
  const foreign = createSqlClient(url.href, { max: 1 });
  try {
    await foreign.unsafe("BEGIN");
    await expect(inspectMigrationQuiescence(sql)).rejects.toMatchObject({ code: "MIGRATION_QUIESCENCE_UNCONFIRMED" });
  } finally { await foreign.unsafe("ROLLBACK"); await foreign.end(); }
});
