import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSqlClient,
  MigrationRegistryError,
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
