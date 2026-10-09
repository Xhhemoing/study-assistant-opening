#!/usr/bin/env tsx
/**
 * Opening restore CLI (Q03) — fail-closed apply + dry-run preflight.
 *
 * CLI CAN apply (APPLY_OK, mutated: true) when confirm + draft + live DB+S3 env
 * are present (sql + createOpeningS3RestoreObjectPut). Dry-run stays non-mutating.
 *
 * Requires `--confirm-local-restore`.
 *
 * Dry-run (no DB/storage mutation):
 *   tsx scripts/opening-restore.ts --confirm-local-restore --dry-run --draft <backup.json>
 *     [--journal <deletion-journal.json>]
 *
 * Mutating apply (when live DB + S3 env present):
 *   tsx scripts/opening-restore.ts --confirm-local-restore --draft <backup.json>
 *     [--journal <deletion-journal.json>] [--staging <dir>]
 *
 * Live deps (fail-closed LIVE_DEPS_MISSING if incomplete on mutating path):
 *   DB URL preference: OPENING_RESTORE_DATABASE_URL → OPENING_TEST_DATABASE_URL → DATABASE_URL
 *   S3: S3_* / OPENING_S3_* (endpoint, region, bucket, accessKeyId, secretAccessKey)
 *
 * When confirm + draft + live env are present, calls applyOpeningRestore with
 * sql + createOpeningS3RestoreObjectPut → can return APPLY_OK (mutated: true).
 *
 * Never restores API keys/sessions/secrets. Pending paid jobs stay cancelled.
 * Never prints secrets / passphrases / connection URLs / access keys.
 */
import { readFile } from "node:fs/promises";
import { stderr, exit, env } from "node:process";
import { S3Client } from "@aws-sdk/client-s3";
import { createSqlClient } from "../packages/database/src/migrate.ts";
import {
  applyOpeningRestore,
  createOpeningS3RestoreObjectPut,
  resolveOpeningRestoreCliLiveDeps,
  type OpeningDeletionMark,
} from "../packages/database/src/repositories/opening-backup.ts";
import { OpeningS3 } from "../packages/database/src/storage/opening-s3.ts";

const CONFIRM = "--confirm-local-restore";
const DRY_RUN = "--dry-run";

function flagValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function usage(): never {
  stderr.write(
    [
      "Usage:",
      `  tsx scripts/opening-restore.ts ${CONFIRM} ${DRY_RUN} --draft <backup.json> [--journal <journal.json>]`,
      `  tsx scripts/opening-restore.ts ${CONFIRM} --draft <backup.json> [--journal <journal.json>] [--staging <dir>]`,
      "",
      "Dry-run (structural preflight only — no DB/storage mutation):",
      "  - validateOpeningRestore → allowed / errors / recordCounts",
      "  - planOpeningRestoreApply → batch table row counts + objectCount",
      "  - guarantees: secrets/apiKeys/sessions never restored; pendingJobs=cancelled",
      "",
      "Mutating apply (confirm + draft + live DB+S3 env):",
      "  - resolveOpeningRestoreCliLiveDeps → sql + OpeningS3 objectPut",
      "  - applyOpeningRestore → APPLY_OK when empty namespace + sql",
      "  - LIVE_DEPS_MISSING (exit 1) if DB/S3 env incomplete — never silent DEFERRED",
      "",
      "A clean dry-run plan is NOT authorization to restore.",
      "",
      `Refuses without explicit ${CONFIRM}.`,
      "",
    ].join("\n"),
  );
  exit(2);
}

function failClosed(message: string, details: string[] = []): never {
  stderr.write(`opening-restore: ${message}\n`);
  for (const line of details) stderr.write(`  - ${line}\n`);
  exit(1);
}

async function loadJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

function printGuarantees(result: Awaited<ReturnType<typeof applyOpeningRestore>>): void {
  stderr.write(`  guarantees: secretsRestored=${result.guarantees.secretsRestored}\n`);
  stderr.write(`  guarantees: apiKeysRestored=${result.guarantees.apiKeysRestored}\n`);
  stderr.write(`  guarantees: sessionsRestored=${result.guarantees.sessionsRestored}\n`);
  stderr.write(`  guarantees: pendingJobs=${result.guarantees.pendingJobs}\n`);
  stderr.write(`  mutated=${result.mutated}\n`);
}

async function loadDraftAndJournal(args: string[]): Promise<{
  backup: unknown;
  journal: readonly OpeningDeletionMark[];
  draftPath: string;
  stagingDirectory: string | undefined;
}> {
  const draftPath = flagValue(args, "--draft") ?? env.OPENING_RESTORE_DRAFT;
  const journalPath = flagValue(args, "--journal") ?? env.OPENING_RESTORE_JOURNAL;
  const stagingDirectory =
    (flagValue(args, "--staging") ?? env.OPENING_RESTORE_STAGING)?.trim() || undefined;

  if (!draftPath?.trim()) {
    failClosed("mutating/dry-run staging incomplete", [
      "--draft or OPENING_RESTORE_DRAFT required",
    ]);
  }

  let backup: unknown;
  try {
    backup = await loadJson(draftPath!.trim());
  } catch {
    failClosed("draft unreadable or invalid JSON", [draftPath!]);
  }

  let journal: readonly OpeningDeletionMark[] = [];
  if (journalPath?.trim()) {
    try {
      const raw = await loadJson(journalPath.trim());
      if (!Array.isArray(raw)) {
        failClosed("journal must be a JSON array of deletion marks", [journalPath]);
      }
      journal = raw as OpeningDeletionMark[];
    } catch {
      failClosed("journal unreadable or invalid JSON", [journalPath!]);
    }
  }

  return { backup, journal, draftPath: draftPath!.trim(), stagingDirectory };
}

async function runDryRun(args: string[]): Promise<never> {
  const { backup, journal } = await loadDraftAndJournal(args);

  const result = await applyOpeningRestore({
    confirmLocalRestore: true,
    dryRun: true,
    backup,
    currentDeletionJournal: journal,
  });

  stderr.write(`opening-restore: dry-run → ok=${result.ok} code=${result.code}\n`);
  for (const e of result.errors) stderr.write(`  - ${e}\n`);
  if (result.preview) {
    stderr.write(`  preview.allowed=${result.preview.allowed}\n`);
    const counts = Object.entries(result.preview.recordCounts)
      .filter(([, n]) => n > 0)
      .map(([table, n]) => `${table}:${n}`)
      .join(", ");
    stderr.write(`  preview.recordCounts={${counts}}\n`);
    if (result.preview.errors.length) {
      for (const e of result.preview.errors) stderr.write(`  preview.error: ${e}\n`);
    }
  }
  if (result.ok && result.plan) {
    const nonEmpty = result.plan.batches.filter((b) => b.rows > 0);
    stderr.write(`  plan.objectCount=${result.plan.objectCount}\n`);
    stderr.write(
      `  plan.batches(non-empty)=${nonEmpty.map((b) => `${b.table}:${b.rows}`).join(", ") || "(none)"}\n`,
    );
  }
  printGuarantees(result);
  stderr.write(
    result.ok
      ? "Exit 0 (dry-run plan only — not authorization to apply; no mutation).\n\n"
      : "Exit 1 (dry-run rejected or incomplete — no mutation).\n\n",
  );
  exit(result.ok ? 0 : 1);
}

async function runMutatingApply(args: string[]): Promise<never> {
  const { backup, journal, stagingDirectory } = await loadDraftAndJournal(args);

  const deps = resolveOpeningRestoreCliLiveDeps(env);
  if (!deps.ok) {
    failClosed(
      `LIVE_DEPS_MISSING — refusing mutating apply without live DB+S3 env (code=${deps.code})`,
      deps.missingKeys.map((k) => `missing: ${k}`),
    );
  }

  const sql = createSqlClient(deps.databaseUrl, { max: 1 });
  const storage = new OpeningS3(deps.s3);
  const objectPut = createOpeningS3RestoreObjectPut(storage);

  try {
    const result = await applyOpeningRestore({
      confirmLocalRestore: true,
      backup,
      currentDeletionJournal: journal,
      sql,
      objectPut,
      stagingDirectory,
    });

    stderr.write(`opening-restore: apply → ok=${result.ok} code=${result.code}\n`);
    for (const e of result.errors) stderr.write(`  - ${e}\n`);
    if (result.ok && result.code === "APPLY_OK") {
      stderr.write(`  rowsInserted=${result.rowsInserted}\n`);
      stderr.write(`  objectsApplied=${result.objectsApplied}\n`);
      stderr.write(`  objectApplyDeferred=${result.objectApplyDeferred}\n`);
      stderr.write(`  pendingJobsCancelled=${result.pendingJobsCancelled}\n`);
      stderr.write(`  emptyNamespaceVerified=${result.emptyNamespaceVerified}\n`);
    }
    if (result.preview) {
      stderr.write(`  preview.allowed=${result.preview.allowed}\n`);
    }
    printGuarantees(result);

    if (result.ok && result.code === "APPLY_OK") {
      stderr.write("Exit 0 (APPLY_OK — mutated).\n\n");
      exit(0);
    }

    stderr.write(
      `Exit 1 (fail-closed — code=${result.code}; no successful apply).\n\n`,
    );
    exit(1);
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
    if (storage.client instanceof S3Client) {
      try {
        storage.client.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  if (!args.includes(CONFIRM)) {
    stderr.write(
      `opening-restore: refusing to run without ${CONFIRM} (explicit local confirmation required)\n`,
    );
    usage();
  }

  const dryRun = args.includes(DRY_RUN);
  if (dryRun) {
    await runDryRun(args);
  }
  await runMutatingApply(args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // Never echo URLs / keys that might appear in driver messages — redact crudely.
  const redacted = message
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://***")
    .replace(/AKIA[0-9A-Z]{16}/g, "***")
    .replace(/minioadmin/gi, "***");
  failClosed("unexpected failure", [redacted]);
});
