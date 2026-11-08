import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
// Actual reviewed source candidates, not a truncated current release inventory.
const recovery108Commit = "996fc1d8623ae106c8dd0f5379fe533b9bb4efee";
const storage109Commit = "e2b9166adeb790e6a5f63520389aa38d7c69199a";
const artifactFixtures = path.resolve("tests/fixtures/migrations/recovery-artifacts");
const manifestDigests = {
  "108": "3fd0b3176bbf0cf242b7a9f524d2075dba8d781a05c237c38b7e0a9c85c08474",
  "109": "bc823e31e9834f8f91c615bc3d89a2bc483c529c2ce0e812fc5f20424ca6a3f9",
};
type ArtifactManifest = {
  repository: string; commit: string; baseManifest?: string;
  controls: Array<{ path: string; sha256: string; fixture: string }>;
  runtimeFiles: Array<{ path: string; sha256: string }>;
  migrations: Array<{ filename: string; sha256: string }>;
};
function verifyArtifactBytes(bytes: Buffer, digest: string, label: string) {
  if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error(`Historical artifact checksum mismatch: ${label}`);
  return bytes;
}

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

  async function readManifest(version: "108" | "109") {
    const bytes = verifyArtifactBytes(await readFile(path.join(artifactFixtures, version, "manifest.json")), manifestDigests[version], `${version}/manifest.json`);
    return JSON.parse(bytes.toString("utf8")) as ArtifactManifest;
  }

  it("binds fixed source provenance and rejects a one-byte change in every stored artifact and canonical SQL", async () => {
    for (const version of ["108", "109"] as const) {
      const manifest = await readManifest(version);
      expect(manifest.repository).toBe("Xhhemoing/study-assistant-opening");
      expect(manifest.commit).toBe(version === "108" ? recovery108Commit : storage109Commit);
      const entries = [
        ...manifest.controls.map(entry => ({ source: path.join(artifactFixtures, entry.fixture), digest: entry.sha256 })),
        ...manifest.migrations.map(entry => ({ source: path.resolve("packages/database/src/migrations", entry.filename), digest: entry.sha256 })),
        { source: path.join(artifactFixtures, version, "manifest.json"), digest: manifestDigests[version] },
      ];
      for (const entry of entries) {
        const bytes = await readFile(entry.source);
        expect(verifyArtifactBytes(bytes, entry.digest, entry.source)).toBe(bytes);
        const changed = Buffer.from(bytes); changed[0] = changed[0]! ^ 1;
        expect(() => verifyArtifactBytes(changed, entry.digest, entry.source)).toThrow("Historical artifact checksum mismatch");
      }
    }
  });

  async function sourceArtifact(version: "108" | "109") {
    const manifest = await readManifest(version);
    expect(manifest.repository).toBe("Xhhemoing/study-assistant-opening");
    expect(manifest.commit).toBe(version === "108" ? recovery108Commit : storage109Commit);
    const base = version === "109"
      ? await readManifest("108") : manifest;
    expect(base.repository).toBe("Xhhemoing/study-assistant-opening");
    expect(base.commit).toBe(recovery108Commit);
    expect(base.migrations).toHaveLength(108);
    if (version === "109") {
      expect(manifest.baseManifest).toBe("108/manifest.json"); expect(manifest.migrations).toHaveLength(1);
      expect(manifest.migrations[0]!.filename).toBe("0109_opening_course_reserved_questions.sql");
    }
    const migrations = version === "109" ? [...base.migrations, ...manifest.migrations] : base.migrations;
    const canonical = path.resolve("packages/database/src/migrations");
    const canonicalNames = (await readdir(canonical)).filter(name => name.endsWith(".sql"));
    for (const [index, entry] of migrations.entries()) {
      expect(entry.filename).toMatch(new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_-]+\\.sql$`));
      expect(canonicalNames).toContain(entry.filename);
    }
    // A newer checkout may have later numbered SQL, but it cannot redefine any
    // historical slot or inject a second filename into the manifest's range.
    const historicalNames = canonicalNames.filter(name => Number(name.split("_")[0]) <= Number(version)).sort();
    expect(historicalNames).toEqual(migrations.map(entry => entry.filename));
    const root = await mkdtemp(path.join(os.tmpdir(), "aistudy-recovery-artifact-"));
    directories.push(root);
    const writeVerified = async (relative: string, source: string, digest: string) => {
      const bytes = verifyArtifactBytes(await readFile(source), digest, relative);
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), bytes);
    };
    for (const entry of migrations) await writeVerified(`packages/database/src/migrations/${entry.filename}`,
      path.join(canonical, entry.filename), entry.sha256);
    for (const entry of manifest.controls) await writeVerified(entry.path, path.join(artifactFixtures, entry.fixture), entry.sha256);
    for (const entry of manifest.runtimeFiles) await writeVerified(entry.path, path.resolve(entry.path), entry.sha256);
    // Dependencies are runtime-only; all historical source/SQL bytes are verified.
    await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    return root;
  }

  it("checks the actual 108 recovery artifact and strictly rejects the actual 109 artifact", async () => {
    const artifactRoot = await sourceArtifact("108");
    const newerArtifact = await sourceArtifact("109");
    const migrations = path.join(artifactRoot, "packages/database/src/migrations");
    const names = (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort();
    expect(names).toHaveLength(108);
    expect((await readdir(path.join(newerArtifact, "packages/database/src/migrations"))).filter(name => name.endsWith(".sql"))).toHaveLength(109);
    const { schema, directory } = await createFixture(Object.fromEntries(await Promise.all(names.filter(name => name !== "0108_opening_knowledge_confirmations.sql")
      .map(async name => [name, await readFile(path.join(migrations, name), "utf8")]))));
    await applyMigrations(sql, { migrationsDir: directory, advisoryLockKey: lockKey + 8 });
    const artifactPaths = ["packages/database/src/migrate.ts", "packages/database/src/repositories/opening-knowledge.ts", "infra/deploy/hermes-db.mjs"];
    const hash = createHash("sha256");
    for (const relative of artifactPaths) hash.update(relative).update("\0").update(await readFile(path.join(artifactRoot, relative))).update("\0");
    const expectedArtifactContentDigest = hash.digest("hex");
    const config = path.join(directory, "test.env");
    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    await writeFile(config, `DATABASE_URL=${scopedUrl.href}\n`);
    const runHistorical = (candidate = artifactRoot, digest = expectedArtifactContentDigest) => spawnSync(process.execPath,
      [path.join(artifactRoot, "infra/deploy/hermes-db.mjs"), "confirmation-recovery-preflight", config, candidate, digest], { encoding: "utf8" });
    const preflight = async (candidate = artifactRoot, digest = expectedArtifactContentDigest) => {
      const result = runHistorical(candidate, digest);
      expect(result.stdout.length, result.stderr || String(result.error)).toBeGreaterThan(0);
      const report = JSON.parse(result.stdout);
      if (result.status !== 0) throw Object.assign(new Error("historical recovery rejected artifact"), { code: report.code });
      return report;
    };
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
    const helper = runHistorical();
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
      } finally {
        // Test-fixture cleanup only; production preflight has no repair/attestation path.
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
        await cp(path.join(artifactRoot, entry), path.join(old, entry));
      }
      await cp(migrations, path.join(old, "packages/database/src/migrations"), { recursive: true });
      // Negative integrity fixture, not a claimed historical-release restore drill.
      await writeFile(path.join(old, relative), "// incompatible reader/writer contents\n");
      await expect(preflight(old))
        .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
      expect(await ledger()).toEqual(before108);
    }
    await expect(preflight(artifactRoot, "0".repeat(64)))
      .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    expect(await ledger()).toEqual(before108);
    await expect(preflight(newerArtifact)).rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    await expect(preflight(path.resolve("."))).rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    // The CURRENT runner also stays fixed to its 108 recovery protocol; no new
    // profile or inventory truncation makes a 109+ release eligible.
    await expect(preflightConfirmationRecovery(sql, { artifactRoot: newerArtifact, expectedArtifactContentDigest }))
      .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    await expect(preflightConfirmationRecovery(sql, { artifactRoot: path.resolve("."), expectedArtifactContentDigest }))
      .rejects.toMatchObject({ code: "MIGRATION_RECOVERY_INCOMPATIBLE" });
    expect(await ledger()).toEqual(before108);
    const actual109Dir = path.join(newerArtifact, "packages/database/src/migrations");
    expect((await applyMigrations(sql, { migrationsDir: actual109Dir, advisoryLockKey: lockKey + 8 })).applied)
      .toEqual(["0109_opening_course_reserved_questions.sql"]);
    const before109 = await ledger();
    const denied = runHistorical();
    expect(denied.status).toBe(1);
    expect(JSON.parse(denied.stdout)).toEqual({ eligible: false, code: "MIGRATION_UNKNOWN_HISTORY", automaticRecovery: false });
    expect(denied.stdout).not.toContain(databaseUrl);
    expect(await ledger()).toEqual(before109);
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
