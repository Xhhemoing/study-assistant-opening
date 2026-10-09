#!/usr/bin/env tsx
/**
 * Opening backup CLI (Q03) — thin wiring to archive/cipher/manifest helpers.
 *
 * Requires `--confirm-local-backup`. Fail-closed when staging inputs are incomplete.
 * Full DB+S3 export via exportOpeningBackup remains deferred (no ocean boil).
 *
 * Never prints secrets / passphrases. Does not restore or replay paid jobs.
 *
 * Publish path (local staged draft → archive [→ encrypt]):
 *   OPENING_BACKUP_PASSPHRASE=... tsx scripts/opening-backup.ts --confirm-local-backup \
 *     --staging <dir> --draft <backup.json> --out <archive.opening> \
 *     [--encrypt-out <archive.opening.enc>]
 */
import { readFile } from "node:fs/promises";
import { stderr, exit, env } from "node:process";
import {
  publishOpeningBackupArchive,
  OpeningBackupExportError,
  type OpeningBackup,
} from "../packages/database/src/repositories/opening-backup.ts";

const CONFIRM = "--confirm-local-backup";

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
      `  tsx scripts/opening-backup.ts ${CONFIRM} \\`,
      "    --staging <dir> --draft <backup.json> --out <archive.opening> \\",
      "    [--encrypt-out <archive.opening.enc>]",
      "",
      "Fail-closed when staging/draft/out are missing after confirmation.",
      "Encrypt passphrase: OPENING_BACKUP_PASSPHRASE only (never argv).",
      "",
      "Still deferred: full exportOpeningBackup(sql, scope, parent, reader) + S3.",
      "Modules wired: opening-backup-{archive,cipher,manifest,reader}.",
      "",
      `Refuses without explicit ${CONFIRM}.`,
      "",
    ].join("\n"),
  );
  exit(2);
}

function failClosed(message: string, details: string[] = []): never {
  stderr.write(`opening-backup: ${message}\n`);
  for (const line of details) stderr.write(`  - ${line}\n`);
  exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  if (!args.includes(CONFIRM)) {
    stderr.write(
      `opening-backup: refusing to run without ${CONFIRM} (explicit local confirmation required)\n`,
    );
    usage();
  }

  const staging = flagValue(args, "--staging") ?? env.OPENING_BACKUP_STAGING;
  const draftPath = flagValue(args, "--draft") ?? env.OPENING_BACKUP_DRAFT;
  const outPath = flagValue(args, "--out") ?? env.OPENING_BACKUP_OUT;
  const encryptOut = flagValue(args, "--encrypt-out") ?? env.OPENING_BACKUP_ENCRYPT_OUT;
  const passphrase = env.OPENING_BACKUP_PASSPHRASE;

  const missing: string[] = [];
  if (!staging?.trim()) missing.push("--staging or OPENING_BACKUP_STAGING");
  if (!draftPath?.trim()) missing.push("--draft or OPENING_BACKUP_DRAFT");
  if (!outPath?.trim()) missing.push("--out or OPENING_BACKUP_OUT");
  if (encryptOut && !passphrase) missing.push("OPENING_BACKUP_PASSPHRASE (required with --encrypt-out)");
  if (missing.length) {
    failClosed("staging incomplete — refusing to publish", missing);
  }

  let backup: OpeningBackup;
  try {
    const raw = await readFile(draftPath!.trim(), "utf8");
    backup = JSON.parse(raw) as OpeningBackup;
  } catch {
    failClosed("staging incomplete — draft unreadable or invalid JSON", [draftPath!]);
  }

  try {
    await publishOpeningBackupArchive(backup!, staging!.trim(), outPath!.trim(), {
      encryptDestination: encryptOut?.trim() || undefined,
      passphrase: passphrase || undefined,
    });
  } catch (error) {
    if (error instanceof OpeningBackupExportError && error.code === "STAGING_INCOMPLETE") {
      failClosed("staging incomplete — refusing to publish", [...error.errors]);
    }
    const message = error instanceof Error ? error.message : String(error);
    // Never echo passphrase / env contents.
    failClosed("archive/encrypt publish failed", [message.replace(/passphrase[^\n]*/gi, "passphrase=[redacted]")]);
  }

  stderr.write(
    [
      "opening-backup: archive published (local staging path).",
      encryptOut ? "opening-backup: encrypted envelope written." : "opening-backup: encrypt skipped (no --encrypt-out).",
      "Note: this is not a DB+S3 atomic snapshot or restore authorization.",
      "",
    ].join("\n"),
  );
  exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  failClosed("unexpected failure", [message]);
});
