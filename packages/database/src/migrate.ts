import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export type MigrationResult = {
  applied: string[];
  alreadyApplied: string[];
};

export function createSqlClient(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 10 });
}

export async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Applies SQL migrations in lexical order, tracking rows in schema_migrations.
 * Safe to call repeatedly (idempotent).
 */
export async function applyMigrations(sql: Sql): Promise<MigrationResult> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = await listMigrationFiles();
  const appliedRows = await sql<{ id: string }[]>`
    SELECT id FROM schema_migrations ORDER BY id
  `;
  const appliedSet = new Set(appliedRows.map((row) => row.id));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      alreadyApplied.push(file);
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
    const body = await readFile(fullPath, "utf8");

    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO schema_migrations (id) VALUES (${file})
        ON CONFLICT (id) DO NOTHING
      `;
    });

    applied.push(file);
  }

  return { applied, alreadyApplied };
}

export async function migrateFromUrl(
  databaseUrl: string,
): Promise<MigrationResult> {
  const sql = createSqlClient(databaseUrl);
  try {
    return await applyMigrations(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
