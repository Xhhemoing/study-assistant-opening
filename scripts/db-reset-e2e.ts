#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import { createSqlClient, migrateFromUrl } from "../packages/database/src/migrate.ts";

export function assertE2eDatabaseUrl(databaseUrl: string): string {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!databaseName.endsWith("_e2e")) {
    throw new Error(
      `E2E database reset must target a database whose name ends in _e2e; received ${databaseName || "(empty)"}`,
    );
  }
  return databaseUrl;
}

export async function resetE2eDatabase(databaseUrl: string): Promise<void> {
  assertE2eDatabaseUrl(databaseUrl);
  await migrateFromUrl(databaseUrl);
  const sql = createSqlClient(databaseUrl);
  try {
    await sql`TRUNCATE
      course_asset_memberships,
      courses,
      library_properties,
      library_relations,
      library_revisions,
      library_blocks,
      library_documents,
      sessions,
      workspaces,
      users
      RESTART IDENTITY CASCADE`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("E2E_DATABASE_URL is required for browser E2E database reset");
  }
  await resetE2eDatabase(databaseUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
