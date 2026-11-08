import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSqlClient,
  MigrationRegistryError,
  preflightConfirmationRecovery,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for migration order tests");
}

const lockKey = 791_002_301;

describe("migration registry order and verification", () => {
  const sql = createSqlClient(databaseUrl, { max: 1 });
  const schemas: string[] = [];
  const directories: string[] = [];

  async function createFixture(files: Record<string, string>) {
    const schema = `migration_order_${randomUUID().replaceAll("-", "")}`;
    const directory = await mkdtemp(path.join(os.tmpdir(), "aistudy-migrations-"));
    schemas.push(schema);
    directories.push(directory);
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}, public`);
    await Promise.all(
      Object.entries(files).map(([name, body]) => writeFile(path.join(directory, name), body)),
    );
    return { schema, directory };
  }

  afterAll(async () => {
    await sql.unsafe("SET search_path TO public");
    for (const schema of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    await sql.end({ timeout: 5 });
  });

  it("records verified SHA-256 checksums in numeric migration order", async () => {
    const { directory } = await createFixture({
      "0002_second.sql": "CREATE TABLE second_table (id integer PRIMARY KEY);",
      "0001_first.sql": "CREATE TABLE first_table (id integer PRIMARY KEY);",
    });

    const result = await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey });

    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql"]);
    const rows = await sql<{ id: string; checksum: string; verification_state: string }[]>`
      SELECT id, checksum, verification_state FROM schema_migrations ORDER BY id
    `;
    expect(rows).toEqual([
      {
        id: "0001_first.sql",
        checksum: createHash("sha256").update("CREATE TABLE first_table (id integer PRIMARY KEY);").digest("hex"),
        verification_state: "verified",
      },
      {
        id: "0002_second.sql",
        checksum: createHash("sha256").update("CREATE TABLE second_table (id integer PRIMARY KEY);").digest("hex"),
        verification_state: "verified",
      },
    ]);
  });

  it("rejects duplicate, malformed, and gapped migration versions", async () => {
    const duplicate = await createFixture({
      "0001_first.sql": "SELECT 1;",
      "0001_again.sql": "SELECT 1;",
    });
    await expect(
      applyMigrations(sql, { migrationsDir: duplicate.directory, advisoryLockKey: lockKey + 1 }),
    ).rejects.toMatchObject({ code: "MIGRATION_DUPLICATE_VERSION" } satisfies Partial<MigrationRegistryError>);

    const malformed = await createFixture({ "migration.sql": "SELECT 1;" });
    await expect(
      applyMigrations(sql, { migrationsDir: malformed.directory, advisoryLockKey: lockKey + 2 }),
    ).rejects.toMatchObject({ code: "MIGRATION_INVALID_FILENAME" } satisfies Partial<MigrationRegistryError>);

    const gapped = await createFixture({
      "0001_first.sql": "SELECT 1;",
      "0003_third.sql": "SELECT 1;",
    });
    await expect(
      applyMigrations(sql, { migrationsDir: gapped.directory, advisoryLockKey: lockKey + 3 }),
    ).rejects.toMatchObject({ code: "MIGRATION_VERSION_GAP" } satisfies Partial<MigrationRegistryError>);
  });

  it("serializes concurrent runners so a migration executes only once", async () => {
    const { schema, directory } = await createFixture({
      "0001_once.sql": `
        CREATE TABLE migration_effects (id integer PRIMARY KEY);
        INSERT INTO migration_effects (id) VALUES (1);
        SELECT pg_sleep(0.1);
      `,
    });
    const first = createSqlClient(databaseUrl, { max: 1 });
    const second = createSqlClient(databaseUrl, { max: 1 });
    try {
      await Promise.all([
        first.unsafe(`SET search_path TO ${schema}, public`),
        second.unsafe(`SET search_path TO ${schema}, public`),
      ]);

      const [firstResult, secondResult] = await Promise.all([
        applyMigrations(first, { migrationsDir: directory, advisoryLockKey: lockKey + 6 }),
        applyMigrations(second, { migrationsDir: directory, advisoryLockKey: lockKey + 6 }),
      ]);

      expect([firstResult.applied, secondResult.applied]).toContainEqual(["0001_once.sql"]);
      expect([firstResult.alreadyApplied, secondResult.alreadyApplied]).toContainEqual(["0001_once.sql"]);
      const effects = await sql.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${schema}.migration_effects`,
      );
      expect(effects[0]?.count).toBe("1");
    } finally {
      await Promise.all([first.end({ timeout: 5 }), second.end({ timeout: 5 })]);
    }
  });

  it("fails closed for unknown registry history", async () => {
    const { directory } = await createFixture({ "0001_first.sql": "SELECT 1;" });
    await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 4 });
    await sql.unsafe(`SET search_path TO ${schemas.at(-1)!}, public`);
    await sql`DELETE FROM schema_migrations WHERE id = '0001_first.sql'`;
    await sql`INSERT INTO schema_migrations (id, checksum, verification_state)
      VALUES ('9999_unknown.sql', null, 'legacy-unverified')`;

    await expect(
      applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 4 }),
    ).rejects.toMatchObject({ code: "MIGRATION_UNKNOWN_HISTORY" } satisfies Partial<MigrationRegistryError>);
  });

  it("fails closed for an unrecognized registry verification state", async () => {
    const { directory } = await createFixture({ "0001_first.sql": "SELECT 1;" });
    await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 7 });
    await sql`UPDATE schema_migrations
      SET verification_state = 'tampered'
      WHERE id = '0001_first.sql'`;

    await expect(
      applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 7 }),
    ).rejects.toMatchObject({
      code: "MIGRATION_INVALID_VERIFICATION_STATE",
    } satisfies Partial<MigrationRegistryError>);
  });

  it("checks real 107 -> 108 recovery read-only and refuses unknown history, drift, missing schema and incompatible artifacts", async () => {
    const migrations = path.resolve("packages/database/src/migrations");
    const names = (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort();
    const { schema, directory } = await createFixture(Object.fromEntries(await Promise.all(names.slice(0, 107)
      .map(async name => [name, await readFile(path.join(migrations, name), "utf8")]))));
    await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 8 });
    const artifactRoot = path.resolve(".");
    const artifactPaths = ["packages/database/src/migrate.ts", "packages/database/src/repositories/opening-knowledge.ts", "infra/deploy/hermes-db.mjs"];
    const hash = createHash("sha256");
    for (const relative of artifactPaths) hash.update(relative).update("\0").update(await readFile(relative)).update("\0");
    const expectedArtifactContentDigest = hash.digest("hex");
    const preflight = () => preflightConfirmationRecovery(sql, { artifactRoot, expectedArtifactContentDigest });
    const ledger = async () => [...await sql`SELECT * FROM schema_migrations ORDER BY id`];
    const before107 = await ledger();
    await expect(preflight()).rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    expect(await ledger()).toEqual(before107);
    // Apply the real, untouched SQL only in this isolated test database; never fake a ledger row.
    await writeFile(path.join(directory, names[107]!), await readFile(path.join(migrations, names[107]!)));
    expect((await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 8 })).applied).toEqual([names[107]]);
    const before108 = await ledger();
    const report = await preflight();
    expect(report).toMatchObject({ ledgerThrough: 108, readOnly: true, automaticRecovery: false,
      writerProtocol: "graph-source-revocation-v1", artifactContentDigest: expectedArtifactContentDigest });
    expect(await ledger()).toEqual(before108);
    const config = path.join(directory, "test.env");
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    await writeFile(config, `DATABASE_URL=${scopedUrl.href}\n`);
    const helper = spawnSync(process.execPath, ["infra/deploy/hermes-db.mjs", "confirmation-recovery-preflight",
      config, artifactRoot, expectedArtifactContentDigest], { encoding: "utf8" });
    expect(helper.status, helper.stderr || helper.stdout).toBe(0);
    expect(JSON.parse(helper.stdout)).toEqual(report);
    expect(await ledger()).toEqual(before108);

    // An actual 107 runner inventory still refuses 108; the new report does not loosen applyMigrations.
    await rm(path.join(directory, names[107]!));
    await expect(applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 8 }))
      .rejects.toMatchObject({ code: "MIGRATION_UNKNOWN_HISTORY" });
    expect(await ledger()).toEqual(before108);
    const [kindCheck] = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='opening_knowledge_confirmations'::regclass AND conname='opening_knowledge_confirmations_node_kind_check'`;
    for (const [label, mutate, expectedCode] of [
      ["unknown109", async () => { await sql`INSERT INTO schema_migrations(id,checksum,verification_state)
        VALUES('0109_unknown.sql','unknown','verified')`; }, "MIGRATION_UNKNOWN_HISTORY"],
      ["drift", async () => { await sql`UPDATE schema_migrations SET checksum='drift' WHERE id=${names[107]!}`; }, "MIGRATION_CHECKSUM_DRIFT"],
      ["legacy", async () => { await sql`UPDATE schema_migrations SET verification_state='legacy-unverified' WHERE id=${names[107]!}`; }, "MIGRATION_RECOVERY_INCOMPATIBLE"],
      ["missing-table", async () => { await sql.unsafe(`ALTER TABLE ${schema}.opening_knowledge_confirmations RENAME TO hidden_confirmations`); }, "MIGRATION_RECOVERY_INCOMPATIBLE"],
      ["missing-check", async () => { await sql.unsafe(`ALTER TABLE ${schema}.opening_knowledge_confirmations DROP CONSTRAINT opening_knowledge_confirmations_node_kind_check`); }, "MIGRATION_RECOVERY_INCOMPATIBLE"],
    ] as const) {
      await mutate();
      try {
        const observed = await ledger();
        await expect(preflight()).rejects.toMatchObject({ code: expectedCode });
        expect(await ledger(), label).toEqual(observed);
        if (label === "unknown109") {
          const denied = spawnSync(process.execPath, ["infra/deploy/hermes-db.mjs", "confirmation-recovery-preflight",
            config, artifactRoot, expectedArtifactContentDigest], { encoding: "utf8" });
          expect(denied.status).toBe(1);
          expect(JSON.parse(denied.stdout)).toEqual({ eligible: false, code: "MIGRATION_UNKNOWN_HISTORY", automaticRecovery: false });
          expect(denied.stdout).not.toContain(databaseUrl);
          expect(await ledger()).toEqual(observed);
        }
      } finally {
        // Test-fixture cleanup only; production preflight has no repair/attestation path.
        if (label === "unknown109") await sql`DELETE FROM schema_migrations WHERE id='0109_unknown.sql'`;
        if (label === "drift" || label === "legacy") await sql`UPDATE schema_migrations
          SET checksum=${before108[107]!.checksum}, verification_state=${before108[107]!.verification_state} WHERE id=${names[107]!}`;
        if (label === "missing-table") await sql.unsafe(`ALTER TABLE ${schema}.hidden_confirmations RENAME TO opening_knowledge_confirmations`);
        if (label === "missing-check") await sql.unsafe(`ALTER TABLE ${schema}.opening_knowledge_confirmations
          ADD CONSTRAINT opening_knowledge_confirmations_node_kind_check ${kindCheck!.definition}`);
      }
    }
    for (const relative of artifactPaths.slice(0, 2)) {
      const old = await mkdtemp(path.join(os.tmpdir(), "aistudy-old-anchor-"));
      directories.push(old);
      for (const entry of artifactPaths) {
        await mkdir(path.dirname(path.join(old, entry)), { recursive: true });
        await cp(entry, path.join(old, entry));
      }
      await cp(migrations, path.join(old, "packages/database/src/migrations"), { recursive: true });
      // Negative integrity fixture, not a claimed historical-release restore drill.
      await writeFile(path.join(old, relative), "// incompatible reader/writer contents\n");
      await expect(preflightConfirmationRecovery(sql, { artifactRoot: old, expectedArtifactContentDigest }))
        .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
      expect(await ledger()).toEqual(before108);
    }
    await expect(preflightConfirmationRecovery(sql, { artifactRoot, expectedArtifactContentDigest: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    expect(await ledger()).toEqual(before108);
  });

  it("fails closed for verified checksum drift", async () => {
    const { directory } = await createFixture({ "0001_first.sql": "SELECT 1;" });
    await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 5 });
    const checksum = createHash("sha256").update("SELECT changed;").digest("hex");
    await sql`UPDATE schema_migrations
      SET checksum = ${checksum}, verification_state = 'verified'
      WHERE id = '0001_first.sql'`;

    await expect(
      applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 5 }),
    ).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_DRIFT" } satisfies Partial<MigrationRegistryError>);
  });
});
