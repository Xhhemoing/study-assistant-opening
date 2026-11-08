import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import {
  applyIdentityOwnerMappings,
  assertIdentityMigrationReady,
  getIdentityDatabaseFingerprint,
  prepareIdentityOwnerMappings,
  restoreRevisionImmutability,
} from "./migration-preflight";

const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const filenamePattern = /^(\d{4})_([a-z0-9_-]+)\.sql$/;
const defaultAdvisoryLockKey = 791_002_300;

type VerificationState = "verified" | "legacy-unverified";
type MigrationFile = { id: string; version: number; body: string; checksum: string };
type RegistryRow = { id: string; checksum: string | null; verification_state: VerificationState };
export type Legacy0003Attestation = {
  databaseFingerprint: string;
  observedMigrationIds: string[];
  operator: string;
  preflightSummary: string;
  backupEvidence: string;
};

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };
export type ApplyMigrationsOptions = {
  migrationsDir?: string;
  advisoryLockKey?: number;
  legacy0003Attestation?: Legacy0003Attestation;
};
export type MigrationRegistryErrorCode =
  | "MIGRATION_INVALID_FILENAME"
  | "MIGRATION_DUPLICATE_VERSION"
  | "MIGRATION_VERSION_GAP"
  | "MIGRATION_UNKNOWN_HISTORY"
  | "MIGRATION_INVALID_VERIFICATION_STATE"
  | "MIGRATION_CHECKSUM_DRIFT"
  | "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED"
  | "MIGRATION_RECOVERY_INCOMPATIBLE";

export class MigrationRegistryError extends Error {
  constructor(readonly code: MigrationRegistryErrorCode, message: string) {
    super(message);
    this.name = "MigrationRegistryError";
  }
}

export function createSqlClient(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, { max: options.max ?? 10 });
}

async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql"));
  const versions = new Set<number>();
  const files = await Promise.all(names.map(async (id) => {
    const match = filenamePattern.exec(id);
    if (!match) throw new MigrationRegistryError("MIGRATION_INVALID_FILENAME", `Invalid migration filename: ${id}`);
    const version = Number(match[1]);
    if (versions.has(version)) throw new MigrationRegistryError("MIGRATION_DUPLICATE_VERSION", `Duplicate migration version: ${version}`);
    versions.add(version);
    const body = await readFile(path.join(migrationsDir, id), "utf8");
    return { id, version, body, checksum: createHash("sha256").update(body).digest("hex") };
  }));
  files.sort((a, b) => a.version - b.version);
  for (let index = 0; index < files.length; index += 1) {
    if (files[index]?.version !== index + 1) {
      throw new MigrationRegistryError("MIGRATION_VERSION_GAP", "Migration versions must start at 0001 and remain contiguous");
    }
  }
  return files;
}

export async function listMigrationFiles(migrationsDir = defaultMigrationsDir): Promise<string[]> {
  return (await loadMigrationFiles(migrationsDir)).map((file) => file.id);
}

async function bootstrapRegistry(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;
  await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS verification_state text`;
  await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS recorded_at timestamptz`;
  await sql`UPDATE schema_migrations
    SET verification_state = 'legacy-unverified', recorded_at = coalesce(recorded_at, applied_at)
    WHERE verification_state IS NULL`;
  await sql`CREATE TABLE IF NOT EXISTS migration_attestations (
    migration_id text PRIMARY KEY,
    database_fingerprint text NOT NULL,
    observed_migration_ids jsonb NOT NULL,
    operator text,
    preflight_summary text NOT NULL,
    backup_evidence text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE migration_attestations ADD COLUMN IF NOT EXISTS operator text`;
}

function verifyRegistry(files: MigrationFile[], rows: RegistryRow[]): void {
  const known = new Map(files.map((file) => [file.id, file]));
  for (const row of rows) {
    if (row.verification_state !== "verified" && row.verification_state !== "legacy-unverified") {
      throw new MigrationRegistryError(
        "MIGRATION_INVALID_VERIFICATION_STATE",
        `Invalid verification state for migration: ${row.id}`,
      );
    }
    const file = known.get(row.id);
    if (!file) throw new MigrationRegistryError("MIGRATION_UNKNOWN_HISTORY", `Unknown migration in registry: ${row.id}`);
    if (row.verification_state === "verified" && row.checksum !== file.checksum) {
      throw new MigrationRegistryError("MIGRATION_CHECKSUM_DRIFT", `Checksum drift for migration: ${row.id}`);
    }
  }
}

function needsIdentitySafety(file: MigrationFile): boolean {
  return file.id === "0003_identity.sql" || file.id === "0004_identity_repair.sql";
}

async function requireLegacy0003Attestation(
  sql: Sql,
  rows: RegistryRow[],
  pendingIds: Set<string>,
  provided?: Legacy0003Attestation,
): Promise<void> {
  const legacy0003 = rows.find(
    (row) => row.id === "0003_identity.sql" && row.verification_state === "legacy-unverified",
  );
  if (!legacy0003 || !pendingIds.has("0004_identity_repair.sql")) return;

  const fingerprint = await getIdentityDatabaseFingerprint(sql);
  if (provided) {
    const expectedIds = rows.map((row) => row.id);
    const sameIds = provided.observedMigrationIds.length === expectedIds.length
      && provided.observedMigrationIds.every((id, index) => id === expectedIds[index]);
    if (
      provided.databaseFingerprint !== fingerprint
      || !sameIds
      || provided.operator.trim().length === 0
      || provided.preflightSummary.trim().length === 0
      || provided.backupEvidence.trim().length === 0
    ) {
      throw new MigrationRegistryError(
        "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
        "Legacy 0003 attestation does not match the current database state",
      );
    }
    await sql`INSERT INTO migration_attestations (
      migration_id, database_fingerprint, observed_migration_ids, operator, preflight_summary, backup_evidence
    ) VALUES (
      '0003_identity.sql', ${fingerprint}, ${sql.json(expectedIds)}, ${provided.operator},
      ${provided.preflightSummary}, ${provided.backupEvidence}
    ) ON CONFLICT (migration_id) DO UPDATE SET
      database_fingerprint = EXCLUDED.database_fingerprint,
      observed_migration_ids = EXCLUDED.observed_migration_ids,
      operator = EXCLUDED.operator,
      preflight_summary = EXCLUDED.preflight_summary,
      backup_evidence = EXCLUDED.backup_evidence,
      recorded_at = now()`;
  }

  const [attestation] = await sql<{
    database_fingerprint: string;
    observed_migration_ids: string[];
    operator: string | null;
    preflight_summary: string;
    backup_evidence: string;
  }[]>`SELECT database_fingerprint, observed_migration_ids, operator, preflight_summary, backup_evidence
    FROM migration_attestations WHERE migration_id = '0003_identity.sql'`;
  const expectedIds = rows.map((row) => row.id);
  if (
    !attestation
    || attestation.database_fingerprint !== fingerprint
    || JSON.stringify(attestation.observed_migration_ids) !== JSON.stringify(expectedIds)
    || typeof attestation.operator !== "string"
    || attestation.operator.trim().length === 0
    || attestation.preflight_summary.trim().length === 0
    || attestation.backup_evidence.trim().length === 0
  ) {
    throw new MigrationRegistryError(
      "MIGRATION_LEGACY_0003_ATTESTATION_REQUIRED",
      "Legacy 0003 requires a matching operator attestation before 0004",
    );
  }
}

/** Applies validated migrations under one PostgreSQL advisory lock. */
export async function applyMigrations(sql: Sql, options: ApplyMigrationsOptions = {}): Promise<MigrationResult> {
  const files = await loadMigrationFiles(options.migrationsDir ?? defaultMigrationsDir);
  const lockKey = options.advisoryLockKey ?? defaultAdvisoryLockKey;
  const lockedSql = await sql.reserve();
  await lockedSql`SELECT pg_advisory_lock(${lockKey})`;
  try {
    await bootstrapRegistry(lockedSql);
    const rows = await lockedSql<RegistryRow[]>`SELECT id, checksum, verification_state FROM schema_migrations ORDER BY id`;
    verifyRegistry(files, rows);
    const appliedIds = new Set(rows.map((row) => row.id));
    const pendingIds = new Set(files.filter((file) => !appliedIds.has(file.id)).map((file) => file.id));
    if (appliedIds.has("0003_identity.sql") && pendingIds.has("0004_identity_repair.sql")) {
      await restoreRevisionImmutability(lockedSql);
    }
    await requireLegacy0003Attestation(lockedSql, rows, pendingIds, options.legacy0003Attestation);
    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of files) {
      if (appliedIds.has(file.id)) {
        alreadyApplied.push(file.id);
        continue;
      }
      if (needsIdentitySafety(file)) await prepareIdentityOwnerMappings(lockedSql);
      await lockedSql.unsafe("BEGIN");
      try {
        if (needsIdentitySafety(file)) {
          await lockedSql.unsafe("LOCK TABLE workspaces IN SHARE ROW EXCLUSIVE MODE");
          await lockedSql.unsafe("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
          await applyIdentityOwnerMappings(lockedSql);
          await assertIdentityMigrationReady(lockedSql);
        }
        await lockedSql.unsafe(file.body);
        await lockedSql`INSERT INTO schema_migrations (id, checksum, verification_state, recorded_at)
          VALUES (${file.id}, ${file.checksum}, 'verified', now())`;
        await lockedSql.unsafe("COMMIT");
      } catch (error) {
        await lockedSql.unsafe("ROLLBACK");
        throw error;
      }
      applied.push(file.id);
    }
    return { applied, alreadyApplied };
  } finally {
    await lockedSql`SELECT pg_advisory_unlock(${lockKey})`;
    lockedSql.release();
  }
}

// This profile is deliberately not an allowUnknown mode. It knows exactly 0001..0108.
const confirmationMigration = {
  id: "0108_opening_knowledge_confirmations.sql",
  checksum: "c0cbf85e3d4036f0c7dcecf1a69df5941cd31aa84a520d7bf62e6e6f3b240110",
};

export type ConfirmationRecoveryReport = {
  profile: "knowledge-confirmations-0108-v1";
  ledgerThrough: 108;
  migrationChecksum: string;
  artifactContentDigest: string;
  writerProtocol: "graph-source-revocation-v1";
  readOnly: true;
  automaticRecovery: false;
};

/** Read-only eligibility report, never migration, attestation, pointer switching or writer startup.
 * expectedArtifactContentDigest must come from an independently reviewed release inventory,
 * never from the candidate itself. No historical artifact is implicitly approved here.
 */
export async function preflightConfirmationRecovery(sql: Sql, options: {
  artifactRoot: string;
  expectedArtifactContentDigest: string;
}): Promise<ConfirmationRecoveryReport> {
  const reject = (message: string): never => {
    throw new MigrationRegistryError("MIGRATION_RECOVERY_INCOMPATIBLE", message);
  };
  const files = await loadMigrationFiles(defaultMigrationsDir);
  if (files.length !== 108 || files[107]?.id !== confirmationMigration.id
    || files[107]?.checksum !== confirmationMigration.checksum) {
    reject("Recovery profile requires the registered, unchanged 0001..0108 migration inventory");
  }
  // Bind actual bytes, not a claimed protocol string or arbitrary SHA supplied by a candidate.
  // This is an unpacked source-release profile, not a promise about unrelated compiled bundles.
  const artifactPaths = [
    "packages/database/src/migrate.ts",
    "packages/database/src/repositories/opening-knowledge.ts",
    "infra/deploy/hermes-db.mjs",
  ];
  const digest = createHash("sha256");
  for (const relative of artifactPaths) {
    const body = await readFile(path.join(options.artifactRoot, relative));
    const local = await readFile(path.resolve(defaultMigrationsDir, "../../../..", relative));
    if (!body.equals(local)) reject(`Candidate is not this compatibility reader/writer anchor: ${relative}`);
    digest.update(relative).update("\0").update(body).update("\0");
  }
  const candidateFiles = await loadMigrationFiles(path.join(options.artifactRoot, "packages/database/src/migrations"));
  if (candidateFiles.length !== files.length || candidateFiles.some((file, index) =>
    file.id !== files[index]?.id || file.checksum !== files[index]?.checksum)) {
    reject("Candidate migration inventory differs from this compatibility anchor");
  }
  const artifactContentDigest = digest.digest("hex");
  if (!/^[a-f0-9]{64}$/.test(options.expectedArtifactContentDigest)
    || artifactContentDigest !== options.expectedArtifactContentDigest) {
    reject("Candidate content is absent from the independently reviewed release inventory");
  }
  await sql.begin("isolation level repeatable read read only", async tx => {
    const rows = await tx<RegistryRow[]>`SELECT id, checksum, verification_state FROM schema_migrations ORDER BY id`;
    verifyRegistry(files, rows);
    if (rows.length !== files.length || rows.some((row, index) => row.id !== files[index]?.id
      || row.verification_state !== "verified" || row.checksum !== files[index]?.checksum)) {
      reject("Recovery requires every ledger row 0001..0108 to have its original verified checksum");
    }
    // Compare the real catalog against 0108's columns, keys/checks and index. No DDL repair.
    const [table] = await tx`SELECT relkind, relpersistence, relrowsecurity FROM pg_class
      WHERE oid=to_regclass('opening_knowledge_confirmations')`;
    if (!table || table.relkind !== "r" || table.relpersistence !== "p" || table.relrowsecurity) {
      reject("Confirmation storage is missing or is not the registered ordinary table");
    }
    const columns = await tx<{ name: string; type: string; required: boolean; default_value: string | null }[]>`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS required,
        pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass('opening_knowledge_confirmations')
        AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
    const expected = [
      ["id", "uuid"], ["workspace_id", "uuid"], ["owner_user_id", "uuid"], ["course_id", "uuid"],
      ["node_id", "uuid"], ["node_label", "text"], ["node_kind", "text"], ["confirmed_at", "timestamp with time zone"],
      ["graph_version_before", "integer"], ["graph_version_after", "integer"],
      ["source_versions", "jsonb"], ["evidence_chunk_ids", "jsonb"],
    ];
    if (columns.length !== expected.length || columns.some((column, index) => !column.required
      || column.name !== expected[index]?.[0] || column.type !== expected[index]?.[1]
      || column.default_value !== (column.name === "confirmed_at" ? "now()" : null))) {
      reject("Confirmation table is missing or has incompatible columns");
    }
    const constraints = await tx<{ definition: string; validated: boolean }[]>`
      SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated
      FROM pg_constraint WHERE conrelid=to_regclass('opening_knowledge_confirmations')`;
    const required = [
      "PRIMARY KEY (id)", "UNIQUE (workspace_id, course_id, graph_version_after)",
      "FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE",
      "FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE",
      "FOREIGN KEY (workspace_id, course_id) REFERENCES courses(workspace_id, id) ON DELETE CASCADE",
      "CHECK ((graph_version_before >= 0))",
      "CHECK ((graph_version_after = (graph_version_before + 1)))",
      "CHECK ((jsonb_typeof(source_versions) = 'object'::text))",
      "CHECK (((jsonb_typeof(evidence_chunk_ids) = 'array'::text) AND (jsonb_array_length(evidence_chunk_ids) > 0)))",
      "CHECK ((node_kind = ANY (ARRAY['chapter'::text, 'concept'::text, 'procedure'::text, 'problem_type'::text])))",
    ];
    if (constraints.length !== required.length || required.some(definition =>
      !constraints.some(constraint => constraint.validated && constraint.definition === definition))) {
      reject("Confirmation table constraints differ from the registered 0108 write protocol");
    }
    const indexes = await tx<{ definition: string }[]>`SELECT pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid=to_regclass('opening_knowledge_confirmations') AND i.indisvalid AND i.indisready
        AND c.relname='opening_knowledge_confirmations_node_idx'`;
    if (!indexes.some(index => index.definition.endsWith(
      "USING btree (workspace_id, owner_user_id, course_id, node_id, graph_version_after DESC)"))) {
      reject("Confirmation lookup index is missing or incompatible");
    }
  });
  return { profile: "knowledge-confirmations-0108-v1", ledgerThrough: 108,
    migrationChecksum: confirmationMigration.checksum, artifactContentDigest,
    writerProtocol: "graph-source-revocation-v1", readOnly: true, automaticRecovery: false };
}

export async function migrateFromUrl(
  databaseUrl: string,
  options: ApplyMigrationsOptions = {},
): Promise<MigrationResult> {
  const sql = createSqlClient(databaseUrl);
  try { return await applyMigrations(sql, options); } finally { await sql.end({ timeout: 5 }); }
}
