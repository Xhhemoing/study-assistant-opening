import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSqlClient,
  getIdentityDatabaseFingerprint,
  prepareIdentityOwnerMappings,
} from "@aistudy/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for identity migration compatibility tests");
}
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/migrations/legacy-0001-0002.sql",
);

describe("identity migration compatibility", () => {
  const sql = createSqlClient(databaseUrl, { max: 1 });
  const schemas: string[] = [];

  async function createLegacySchema() {
    const schema = `identity_compat_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}, public`);
    await sql.unsafe(await readFile(fixturePath, "utf8"));
    return schema;
  }

  async function legacy0003Attestation() {
    const fingerprint = await getIdentityDatabaseFingerprint(sql);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM schema_migrations ORDER BY id
    `;
    return {
      databaseFingerprint: fingerprint,
      observedMigrationIds: rows.map((row) => row.id),
      operator: "identity-migration-operator",
      preflightSummary: "identity preflight reviewed by migration operator",
      backupEvidence: "s3://verified-backups/pre-identity.dump",
    };
  }

  afterAll(async () => {
    await sql.unsafe("SET search_path TO public");
    for (const schema of schemas) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    await sql.end({ timeout: 5 });
  });

  it("blocks before legacy identity migration can delete orphan workspace assets", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();
    const blockId = randomUUID();
    const courseId = randomUUID();

    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId})
    `;
    await sql`
      INSERT INTO library_documents (id, workspace_id, title, lifecycle)
      VALUES (${documentId}, ${workspaceId}, 'Legacy note', 'confirmed')
    `;
    await sql`
      INSERT INTO library_blocks (id, workspace_id, document_id, type, position, content)
      VALUES (${blockId}, ${workspaceId}, ${documentId}, 'paragraph', 0, ${sql.json({ text: "keep" })})
    `;
    await sql`
      INSERT INTO library_revisions (
        id, workspace_id, document_id, revision_number, title, lifecycle, blocks
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, ${documentId}, 1,
        'Legacy note', 'confirmed', ${sql.json([{ id: blockId, type: "paragraph" }])}
      )
    `;
    await sql`
      INSERT INTO library_relations (
        id, workspace_id, from_type, from_id, to_type, to_id, relation_type
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, 'document', ${documentId},
        'block', ${blockId}, 'references'
      )
    `;
    await sql`
      INSERT INTO library_properties (
        id, workspace_id, subject_type, subject_id, key, value_type, value
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, 'document', ${documentId},
        'topic', 'string', ${"migration"}
      )
    `;
    await sql`
      INSERT INTO courses (id, workspace_id, title, slug)
      VALUES (${courseId}, ${workspaceId}, 'Legacy course', 'legacy-course')
    `;
    await sql`
      INSERT INTO course_asset_memberships (
        id, workspace_id, course_id, asset_type, asset_id, role, visibility
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, ${courseId},
        'document', ${documentId}, 'core', 'private'
      )
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "IDENTITY_ORPHAN_WORKSPACES",
      workspaces: [
        expect.objectContaining({
          workspaceId,
          documentCount: 1,
          blockCount: 1,
          revisionCount: 1,
          relationCount: 1,
          propertyCount: 1,
          courseCount: 1,
          membershipCount: 1,
        }),
      ],
    });

    for (const table of [
      "workspaces",
      "library_documents",
      "library_blocks",
      "library_revisions",
      "library_relations",
      "library_properties",
      "courses",
      "course_asset_memberships",
    ]) {
      const rows = await sql.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(rows[0]?.count, table).toBe("1");
    }
  });

  it("continues when a verified owner already exists before identity migration", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();

    await sql.unsafe(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        schema_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz NULL
      )
    `);
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${ownerId}, 'verified@example.com', 'Verified Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId})
    `;

    const result = await applyMigrations(sql);

    expect(result.applied).toEqual(["0003_identity.sql", "0004_identity_repair.sql"]);
    const workspaces = await sql<{ id: string; owner_user_id: string }[]>`
      SELECT id, owner_user_id FROM workspaces
    `;
    expect(workspaces).toEqual([{ id: workspaceId, owner_user_id: ownerId }]);
  });

  it("applies an auditable owner mapping before rerunning identity migration", async () => {
    await createLegacySchema();
    const legacyOwnerId = randomUUID();
    const verifiedOwnerId = randomUUID();
    const workspaceId = randomUUID();

    await sql`
      INSERT INTO workspaces (id, owner_user_id)
      VALUES (${workspaceId}, ${legacyOwnerId})
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "IDENTITY_ORPHAN_WORKSPACES",
    });
    const fingerprint = await getIdentityDatabaseFingerprint(sql);
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${verifiedOwnerId}, 'mapped@example.com', 'Mapped Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO identity_owner_mappings (
        workspace_id, original_owner_user_id, owner_user_id, operator, source, database_fingerprint,
        backup_evidence
      ) VALUES (
        ${workspaceId}, ${legacyOwnerId}, ${verifiedOwnerId}, 'migration-operator',
        'approved ownership export', ${fingerprint},
        's3://verified-backups/pre-identity.dump'
      )
    `;

    const result = await applyMigrations(sql);

    expect(result.applied).toEqual(["0003_identity.sql", "0004_identity_repair.sql"]);
    const [workspace] = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId}
    `;
    expect(workspace?.owner_user_id).toBe(verifiedOwnerId);
    const [mapping] = await sql<{ applied_at: Date | null }[]>`
      SELECT applied_at FROM identity_owner_mappings WHERE workspace_id = ${workspaceId}
    `;
    expect(mapping?.applied_at).toBeInstanceOf(Date);
  });

  it("does not apply a mapping that was prepared for another database fingerprint", async () => {
    await createLegacySchema();
    const legacyOwnerId = randomUUID();
    const verifiedOwnerId = randomUUID();
    const workspaceId = randomUUID();

    await sql`
      INSERT INTO workspaces (id, owner_user_id)
      VALUES (${workspaceId}, ${legacyOwnerId})
    `;
    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "IDENTITY_ORPHAN_WORKSPACES",
    });
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${verifiedOwnerId}, 'other-db@example.com', 'Other DB Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO identity_owner_mappings (
        workspace_id, original_owner_user_id, owner_user_id, operator, source, database_fingerprint,
        backup_evidence
      ) VALUES (
        ${workspaceId}, ${legacyOwnerId}, ${verifiedOwnerId}, 'migration-operator',
        'approved ownership export', 'sha256:another-database',
        's3://verified-backups/another-database.dump'
      )
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "IDENTITY_ORPHAN_WORKSPACES",
    });
    const [workspace] = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId}
    `;
    expect(workspace?.owner_user_id).toBe(legacyOwnerId);
  });

  it("does not let an owner mapping take over a workspace with a valid owner", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const mappedOwnerId = randomUUID();
    const workspaceId = randomUUID();

    await prepareIdentityOwnerMappings(sql);
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES
        (${ownerId}, 'existing@example.com', 'Existing Owner', 'operator-staged'),
        (${mappedOwnerId}, 'mapped-valid@example.com', 'Mapped Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id)
      VALUES (${workspaceId}, ${ownerId})
    `;
    const fingerprint = await getIdentityDatabaseFingerprint(sql);
    await sql`
      INSERT INTO identity_owner_mappings (
        workspace_id, original_owner_user_id, owner_user_id, operator, source,
        database_fingerprint, backup_evidence
      ) VALUES (
        ${workspaceId}, ${ownerId}, ${mappedOwnerId}, 'migration-operator',
        'stale ownership export', ${fingerprint},
        's3://verified-backups/pre-identity.dump'
      )
    `;

    await applyMigrations(sql);

    const [workspace] = await sql<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM workspaces WHERE id = ${workspaceId}
    `;
    expect(workspace?.owner_user_id).toBe(ownerId);
    const [mapping] = await sql<{ applied_at: Date | null }[]>`
      SELECT applied_at FROM identity_owner_mappings WHERE workspace_id = ${workspaceId}
    `;
    expect(mapping?.applied_at).toBeNull();
  });

  it("blocks the corrective migration with a structured report when orphan data remains", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();

    await sql.unsafe(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        schema_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz NULL
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await sql`
      INSERT INTO schema_migrations (id) VALUES ('0003_identity.sql')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId})
    `;
    await sql`
      INSERT INTO library_documents (id, workspace_id, title, lifecycle)
      VALUES (${documentId}, ${workspaceId}, 'Unmapped legacy note', 'confirmed')
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
    });
    const invalidAttestation = await legacy0003Attestation();
    invalidAttestation.databaseFingerprint = "sha256:wrong-database";
    await expect(
      applyMigrations(sql, { legacy0003Attestation: invalidAttestation }),
    ).rejects.toMatchObject({
      code: "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
    });
    await expect(
      applyMigrations(sql, { legacy0003Attestation: await legacy0003Attestation() }),
    ).rejects.toMatchObject({
      code: "IDENTITY_ORPHAN_WORKSPACES",
      workspaces: [
        expect.objectContaining({
          workspaceId,
          documentCount: 1,
        }),
      ],
    });

    const applied = await sql<{ id: string }[]>`
      SELECT id FROM schema_migrations ORDER BY id
    `;
    expect(applied.map((row) => row.id)).toEqual([
      "0001_library.sql",
      "0002_courses.sql",
      "0003_identity.sql",
    ]);
    const triggers = await sql<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE tgrelid = 'library_revisions'::regclass
        AND tgname IN (
          'library_revisions_no_delete',
          'library_revisions_no_update'
        )
      ORDER BY tgname
    `;
    expect(triggers).toEqual([
      { tgname: "library_revisions_no_delete", tgenabled: "O" },
      { tgname: "library_revisions_no_update", tgenabled: "O" },
    ]);
  });

  it("restores revision immutability before rejecting a legacy corrective migration", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();

    await sql.unsafe(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        schema_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz NULL
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${ownerId}, 'attestation@example.com', 'Attestation Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId})
    `;
    await sql.unsafe(`
      ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_delete;
      ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_update
    `);
    await sql`
      INSERT INTO schema_migrations (id) VALUES ('0003_identity.sql')
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
    });

    const triggers = await sql<{ tgname: string; tgenabled: string }[]>`
      SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE tgrelid = 'library_revisions'::regclass
        AND tgname IN (
          'library_revisions_no_delete',
          'library_revisions_no_update'
        )
      ORDER BY tgname
    `;
    expect(triggers).toEqual([
      { tgname: "library_revisions_no_delete", tgenabled: "O" },
      { tgname: "library_revisions_no_update", tgenabled: "O" },
    ]);
  });

  it("reenables append-only revision triggers in the corrective migration", async () => {
    await createLegacySchema();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const documentId = randomUUID();

    await sql.unsafe(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        schema_version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz NULL
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await sql`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES (${ownerId}, 'repair@example.com', 'Repair Owner', 'operator-staged')
    `;
    await sql`
      INSERT INTO workspaces (id, owner_user_id) VALUES (${workspaceId}, ${ownerId})
    `;
    await sql`
      INSERT INTO library_documents (id, workspace_id, title, lifecycle)
      VALUES (${documentId}, ${workspaceId}, 'Protected history', 'confirmed')
    `;
    await sql`
      INSERT INTO library_revisions (
        id, workspace_id, document_id, revision_number, title, lifecycle, blocks
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, ${documentId}, 1,
        'Protected history', 'confirmed', ${sql.json([])}
      )
    `;
    await sql.unsafe(`
      ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_delete;
      ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_update
    `);
    await sql`
      INSERT INTO schema_migrations (id) VALUES ('0003_identity.sql')
    `;

    await expect(applyMigrations(sql)).rejects.toMatchObject({
      code: "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
    });
    const result = await applyMigrations(sql, {
      legacy0003Attestation: await legacy0003Attestation(),
    });

    expect(result.applied).toEqual(["0004_identity_repair.sql"]);
    const [attestation] = await sql<{ operator: string }[]>`
      SELECT operator FROM migration_attestations
      WHERE migration_id = '0003_identity.sql'
    `;
    expect(attestation?.operator).toBe("identity-migration-operator");
    await expect(
      sql`DELETE FROM library_revisions WHERE document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23000" });
    const [revisionCount] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM library_revisions
      WHERE document_id = ${documentId}
    `;
    expect(revisionCount?.count).toBe("1");
  });
});
