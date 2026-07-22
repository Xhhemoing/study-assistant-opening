#!/usr/bin/env node
/**
 * Apply SQL migrations from packages/database/src/migrations.
 * Usage: DATABASE_URL=... npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/database/src/migrations",
);

const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const appliedRows = await sql`SELECT id FROM schema_migrations ORDER BY id`;
  const appliedSet = new Set(appliedRows.map((row) => row.id));

  const applied = [];
  const alreadyApplied = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      alreadyApplied.push(file);
      continue;
    }

    const body = await readFile(path.join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO schema_migrations (id) VALUES (${file})
        ON CONFLICT (id) DO NOTHING
      `;
    });
    applied.push(file);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        database: databaseUrl.replace(/:[^:@/]+@/, ":***@"),
        applied,
        alreadyApplied,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 5 });
}
