#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { migrateFromUrl, type Legacy0003Attestation } from "../packages/database/src/migrate.ts";

function parseLegacy0003Attestation(raw: string): Legacy0003Attestation {
  const value: unknown = JSON.parse(raw);
  if (
    !value || typeof value !== "object"
    || typeof (value as Legacy0003Attestation).databaseFingerprint !== "string"
    || !Array.isArray((value as Legacy0003Attestation).observedMigrationIds)
    || !(value as Legacy0003Attestation).observedMigrationIds.every((id) => typeof id === "string")
    || typeof (value as Legacy0003Attestation).operator !== "string"
    || typeof (value as Legacy0003Attestation).preflightSummary !== "string"
    || typeof (value as Legacy0003Attestation).backupEvidence !== "string"
  ) {
    throw new Error("Legacy 0003 attestation file has an invalid schema");
  }
  return value as Legacy0003Attestation;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const attestationFile = process.env.MIGRATION_LEGACY_0003_ATTESTATION_FILE;
  const legacy0003Attestation = attestationFile
    ? parseLegacy0003Attestation(await readFile(attestationFile, "utf8"))
    : undefined;

  const result = await migrateFromUrl(databaseUrl, { legacy0003Attestation });
  console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
