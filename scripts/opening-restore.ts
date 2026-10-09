#!/usr/bin/env tsx
/**
 * Opening restore CLI (Q03) — fail-closed apply + dry-run preflight.
 *
 * Requires `--confirm-local-restore`.
 *
 * Dry-run (no DB/storage mutation):
 *   tsx scripts/opening-restore.ts --confirm-local-restore --dry-run --draft <backup.json>
 *     [--journal <deletion-journal.json>]
 *
 * Without `--dry-run` (CLI has no DB handle): APPLY_EXECUTOR_DEFERRED.
 * Library `applyOpeningRestore({ confirmLocalRestore, backup, sql, ... })` runs
 * Opening transactional apply when empty-namespace passes (see unit/integration).
 *
 * Never restores API keys/sessions/secrets. Pending paid jobs stay cancelled.
 * Never prints secrets / passphrases.
 */
import { readFile } from "node:fs/promises";
import { stderr, exit, env } from "node:process";
import {
  applyOpeningRestore,
  type OpeningDeletionMark,
} from "../packages/database/src/repositories/opening-backup.ts";

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
      `  tsx scripts/opening-restore.ts ${CONFIRM}`,
      "",
      "Dry-run (structural preflight only — no DB/storage mutation):",
      "  - validateOpeningRestore → allowed / errors / recordCounts",
      "  - planOpeningRestoreApply → batch table row counts + objectCount",
      "  - guarantees: secrets/apiKeys/sessions never restored; pendingJobs=cancelled",
      "",
      "Without --dry-run (this CLI): APPLY_EXECUTOR_DEFERRED — mutating apply needs sql via library entrypoint.",
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
  if (!dryRun) {
    const result = await applyOpeningRestore({ confirmLocalRestore: true });
    stderr.write(
      [
        `opening-restore: apply stub → ok=${result.ok} code=${result.code}`,
        ...result.errors.map((e) => `  - ${e}`),
        "",
      ].join("\n"),
    );
    printGuarantees(result);
    stderr.write("Exit 1 (fail-closed — no apply executed).\n\n");
    exit(1);
  }

  const draftPath = flagValue(args, "--draft") ?? env.OPENING_RESTORE_DRAFT;
  const journalPath = flagValue(args, "--journal") ?? env.OPENING_RESTORE_JOURNAL;
  if (!draftPath?.trim()) {
    failClosed("dry-run staging incomplete", ["--draft or OPENING_RESTORE_DRAFT required"]);
  }

  let backup: unknown;
  try {
    backup = await loadJson(draftPath!.trim());
  } catch {
    failClosed("dry-run draft unreadable or invalid JSON", [draftPath!]);
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
    stderr.write(`  plan.batches(non-empty)=${nonEmpty.map((b) => `${b.table}:${b.rows}`).join(", ") || "(none)"}\n`);
  }
  printGuarantees(result);
  stderr.write(
    result.ok
      ? "Exit 0 (dry-run plan only — not authorization to apply; no mutation).\n\n"
      : "Exit 1 (dry-run rejected or incomplete — no mutation).\n\n",
  );
  exit(result.ok ? 0 : 1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  failClosed("unexpected failure", [message]);
});
