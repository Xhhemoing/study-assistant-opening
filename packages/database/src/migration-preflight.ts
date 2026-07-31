import type { Sql } from "postgres";

export const IDENTITY_ORPHAN_WORKSPACES =
  "IDENTITY_ORPHAN_WORKSPACES" as const;

export type OrphanWorkspaceSummary = {
  workspaceId: string;
  ownerUserId: string;
  documentCount: number;
  blockCount: number;
  revisionCount: number;
  relationCount: number;
  propertyCount: number;
  courseCount: number;
  membershipCount: number;
};

export class IdentityMigrationPreflightError extends Error {
  readonly code = IDENTITY_ORPHAN_WORKSPACES;

  constructor(readonly workspaces: OrphanWorkspaceSummary[]) {
    super(
      `Identity migration blocked: ${workspaces.length} workspace(s) have no verified owner mapping`,
    );
    this.name = "IdentityMigrationPreflightError";
  }
}

export async function getIdentityDatabaseFingerprint(sql: Sql): Promise<string> {
  const [database] = await sql<{
    database_oid: string;
    schema_name: string;
  }[]>`
    SELECT
      (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
      current_schema() AS schema_name
  `;
  return `${database?.database_oid ?? "unknown"}:${database?.schema_name ?? "unknown"}`;
}

export async function prepareIdentityOwnerMappings(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      display_name text NOT NULL,
      password_hash text NOT NULL,
      schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      disabled_at timestamptz NULL,
      CONSTRAINT users_email_nonempty CHECK (char_length(trim(email)) > 0)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
      ON users (lower(email))
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS identity_owner_mappings (
      workspace_id uuid PRIMARY KEY,
      original_owner_user_id uuid NOT NULL,
      owner_user_id uuid NOT NULL,
      operator text NOT NULL CHECK (char_length(trim(operator)) > 0),
      source text NOT NULL CHECK (char_length(trim(source)) > 0),
      database_fingerprint text NOT NULL
        CHECK (char_length(trim(database_fingerprint)) > 0),
      backup_evidence text NOT NULL
        CHECK (char_length(trim(backup_evidence)) > 0),
      recorded_at timestamptz NOT NULL DEFAULT now(),
      applied_at timestamptz NULL
    )
  `;
  await sql`
    ALTER TABLE identity_owner_mappings
    ADD COLUMN IF NOT EXISTS original_owner_user_id uuid
  `;
}

export async function applyIdentityOwnerMappings(sql: Sql): Promise<void> {
  const [usersTable] = await sql<{ users_table: string | null }[]>`
    SELECT to_regclass(
      format('%I.%I', current_schema(), 'users')
    )::text AS users_table
  `;
  if (!usersTable?.users_table) return;
  const fingerprint = await getIdentityDatabaseFingerprint(sql);

  await sql`
    WITH applicable AS (
      SELECT m.workspace_id, m.original_owner_user_id, m.owner_user_id
      FROM identity_owner_mappings m
      INNER JOIN users u ON u.id = m.owner_user_id
      INNER JOIN workspaces w
        ON w.id = m.workspace_id
        AND w.owner_user_id = m.original_owner_user_id
      LEFT JOIN users original_owner ON original_owner.id = w.owner_user_id
      WHERE m.applied_at IS NULL
        AND m.database_fingerprint = ${fingerprint}
        AND original_owner.id IS NULL
    ), updated AS (
      UPDATE workspaces w
      SET owner_user_id = a.owner_user_id, updated_at = now()
      FROM applicable a
      WHERE w.id = a.workspace_id
        AND w.owner_user_id = a.original_owner_user_id
      RETURNING w.id
    )
    UPDATE identity_owner_mappings m
    SET applied_at = now()
    FROM updated u
    WHERE m.workspace_id = u.id
  `;
}

type PreflightRow = {
  workspace_id: string;
  owner_user_id: string;
  document_count: string;
  block_count: string;
  revision_count: string;
  relation_count: string;
  property_count: string;
  course_count: string;
  membership_count: string;
};

function toSummary(row: PreflightRow): OrphanWorkspaceSummary {
  return {
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    documentCount: Number(row.document_count),
    blockCount: Number(row.block_count),
    revisionCount: Number(row.revision_count),
    relationCount: Number(row.relation_count),
    propertyCount: Number(row.property_count),
    courseCount: Number(row.course_count),
    membershipCount: Number(row.membership_count),
  };
}

export async function inspectIdentityMigration(
  sql: Sql,
): Promise<OrphanWorkspaceSummary[]> {
  const [usersTable] = await sql<{ users_table: string | null }[]>`
    SELECT to_regclass(
      format('%I.%I', current_schema(), 'users')
    )::text AS users_table
  `;

  const ownerFilter = usersTable?.users_table
    ? sql`WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id)`
    : sql``;
  const rows = await sql<PreflightRow[]>`
    WITH
      document_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM library_documents GROUP BY workspace_id
      ),
      block_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM library_blocks GROUP BY workspace_id
      ),
      revision_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM library_revisions GROUP BY workspace_id
      ),
      relation_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM library_relations GROUP BY workspace_id
      ),
      property_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM library_properties GROUP BY workspace_id
      ),
      course_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM courses GROUP BY workspace_id
      ),
      membership_counts AS (
        SELECT workspace_id, count(*) AS count
        FROM course_asset_memberships GROUP BY workspace_id
      )
    SELECT
      w.id::text AS workspace_id,
      w.owner_user_id::text AS owner_user_id,
      coalesce(d.count, 0)::text AS document_count,
      coalesce(b.count, 0)::text AS block_count,
      coalesce(rv.count, 0)::text AS revision_count,
      coalesce(rl.count, 0)::text AS relation_count,
      coalesce(p.count, 0)::text AS property_count,
      coalesce(c.count, 0)::text AS course_count,
      coalesce(m.count, 0)::text AS membership_count
    FROM workspaces w
    LEFT JOIN document_counts d ON d.workspace_id = w.id
    LEFT JOIN block_counts b ON b.workspace_id = w.id
    LEFT JOIN revision_counts rv ON rv.workspace_id = w.id
    LEFT JOIN relation_counts rl ON rl.workspace_id = w.id
    LEFT JOIN property_counts p ON p.workspace_id = w.id
    LEFT JOIN course_counts c ON c.workspace_id = w.id
    LEFT JOIN membership_counts m ON m.workspace_id = w.id
    ${ownerFilter}
    ORDER BY w.id
  `;

  return rows.map(toSummary);
}

export async function restoreRevisionImmutability(sql: Sql): Promise<void> {
  await sql.unsafe(
    "ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_delete",
  );
  await sql.unsafe(
    "ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_update",
  );
}

export async function assertIdentityMigrationReady(sql: Sql): Promise<void> {
  const workspaces = await inspectIdentityMigration(sql);
  if (workspaces.length > 0) {
    throw new IdentityMigrationPreflightError(workspaces);
  }
}
