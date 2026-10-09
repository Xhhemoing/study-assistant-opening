/**
 * Q03 Create-list entrypoint for Opening backup export / restore preflight.
 *
 * Thin wrap over split `opening-backup-*` modules — does not rewrite
 * compose / prepare / records / archive ocean.
 *
 * Plan interfaces (08-delivery.md § Q03):
 * - `exportOpeningBackup(scope): Promise<OpeningBackup>`
 * - `validateOpeningRestore(backup, currentDeletionJournal): RestorePreview`
 *
 * Existing assemble path still needs `sql` + staging parent + object reader;
 * this wrapper keeps those deps and unwraps a successful draft to `OpeningBackup`.
 *
 * Archive/cipher/manifest storage helpers are re-exported for CLI thin wiring.
 * Restore **apply** is fail-closed without confirm/empty-namespace; with confirm +
 * empty-namespace + sql executor deps, Opening-scoped transactional apply runs.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import {
  planOpeningRestoreApply,
  validateOpeningRestore,
  type OpeningBackup,
  type OpeningDeletionMark,
  type OpeningRestoreApplyPlan,
  type OpeningRestoreLearningState,
  type RestorePreview,
} from "@aistudy/domain";
import {
  evaluateOpeningRestoreEmptyNamespace,
  type OpeningRestoreNamespaceCounts,
} from "./opening-backup-empty-namespace";
export {
  executeOpeningRestoreApply,
  createMemoryOpeningRestoreObjectPut,
  createOpeningS3RestoreObjectPut,
  parseOpeningRestoreObjectVersion,
  OPENING_RESTORE_ROW_COLUMNS,
  type OpeningRestoreObjectPut,
  type OpeningRestoreObjectStorage,
  type OpeningRestoreExecuteArgs,
  type OpeningRestoreExecuteResult,
} from "./opening-backup-apply";
export {
  resolveOpeningRestoreCliLiveDeps,
  type OpeningRestoreCliLiveDepsResult,
  type OpeningRestoreCliLiveDepsOk,
  type OpeningRestoreCliLiveDepsMissing,
} from "./opening-restore-cli-env";
export { OPENING_RESTORE_APPLY_ORDER } from "@aistudy/domain";
import {
  executeOpeningRestoreApply,
  type OpeningRestoreObjectPut,
  type OpeningRestoreExecuteArgs,
} from "./opening-backup-apply";
import { assembleOpeningBackupDraft } from "./opening-backup-compose";
import type { OpeningMemoryDeletions } from "./opening-backup-memory-deletions";
import { writeOpeningBackupArchive } from "../storage/opening-backup-archive";
import { encryptOpeningArchive } from "../storage/opening-backup-cipher";
import type { OpeningBackupObjectReader } from "../storage/opening-backup-stage";
import type { OpeningScope } from "./opening-sources";

export { assembleOpeningBackupDraft } from "./opening-backup-compose";
export {
  prepareOpeningSourceBackup,
  type OpeningSourceStaging,
} from "./opening-backup-prepare";
export {
  OPENING_BACKUP_TABLES,
  readOpeningBackupRecords,
  type OpeningBackupRecordSnapshot,
  type OpeningBackupTable,
} from "./opening-backup-records";
export {
  evaluateOpeningRestoreEmptyNamespace,
  readOpeningRestoreNamespaceCounts,
  isOpeningRestoreNeverTable,
  OPENING_RESTORE_NEVER_TABLES,
  type OpeningRestoreNamespaceCounts,
  type OpeningRestoreEmptyNamespaceResult,
} from "./opening-backup-empty-namespace";
export { writeOpeningBackupArchive } from "../storage/opening-backup-archive";
export { encryptOpeningArchive, decryptOpeningArchive } from "../storage/opening-backup-cipher";
export {
  snapshotOpeningBackupSources,
  verifyOpeningBackupObjects,
  type OpeningBackupSource,
} from "../storage/opening-backup-manifest";
export { createOpeningBackupReader } from "../storage/opening-backup-reader";
export { validateOpeningRestore };
export type {
  OpeningBackup,
  OpeningDeletionMark,
  OpeningMemoryDeletions,
  RestorePreview,
  OpeningScope,
  OpeningBackupObjectReader,
};
export { planOpeningRestoreApply };
export type { OpeningRestoreApplyPlan, OpeningRestoreLearningState };

export class OpeningBackupExportError extends Error {
  readonly code: string;
  readonly errors: readonly string[];

  constructor(code: string, errors: readonly string[]) {
    super(errors.join("; ") || code);
    this.name = "OpeningBackupExportError";
    this.code = code;
    this.errors = errors;
  }
}

/**
 * Named plan entrypoint: owner-scoped draft export unwrapped to `OpeningBackup`.
 *
 * A successful return is **not** a published archive, not a DB+S3 atomic
 * snapshot, and not restore authorization. Callers that need an encrypted
 * archive must still stage → write archive → encrypt via storage helpers.
 */
export async function exportOpeningBackup(
  sql: Sql,
  scope: OpeningScope,
  parentDirectory: string,
  reader: OpeningBackupObjectReader,
): Promise<OpeningBackup> {
  const result = await assembleOpeningBackupDraft(sql, scope, parentDirectory, reader);
  if (!result.ok) {
    throw new OpeningBackupExportError(result.code, result.errors);
  }
  return result.backup;
}

export type PublishOpeningBackupArchiveOptions = {
  /** When set, encrypt the plain archive to this path (passphrase required). */
  encryptDestination?: string;
  /** Passphrase for AES-GCM envelope; never log or argv-echo. */
  passphrase?: string;
};

/**
 * Thin publish path: verify staged object files exist, write exclusive archive,
 * optionally encrypt. Fail-closed when staging inputs are incomplete.
 * Does not talk to S3 or the DB.
 */
export async function publishOpeningBackupArchive(
  backup: OpeningBackup,
  stagingDirectory: string,
  archiveDestination: string,
  options: PublishOpeningBackupArchiveOptions = {},
): Promise<void> {
  const errors: string[] = [];
  if (typeof stagingDirectory !== "string" || stagingDirectory.trim().length === 0) {
    errors.push("staging directory required");
  }
  if (typeof archiveDestination !== "string" || archiveDestination.trim().length === 0) {
    errors.push("archive destination required");
  }
  if (!backup || backup.format !== "opening-backup" || backup.version !== 1 || !Array.isArray(backup.objects)) {
    errors.push("invalid opening backup draft");
  }
  if (options.encryptDestination) {
    if (typeof options.encryptDestination !== "string" || options.encryptDestination.trim().length === 0) {
      errors.push("encrypt destination required when encrypting");
    }
    if (typeof options.passphrase !== "string" || options.passphrase.length === 0) {
      errors.push("passphrase required for encrypt (OPENING_BACKUP_PASSPHRASE)");
    }
  }
  if (errors.length) {
    throw new OpeningBackupExportError("STAGING_INCOMPLETE", errors);
  }

  const staging = stagingDirectory.trim();
  for (const object of backup.objects) {
    if (!object || typeof object.archivePath !== "string" || object.archivePath.length === 0) {
      throw new OpeningBackupExportError("STAGING_INCOMPLETE", ["backup object missing archivePath"]);
    }
    const relative = object.archivePath.replace(/^[/\\]+/, "");
    if (relative.includes("..") || path.isAbsolute(object.archivePath)) {
      throw new OpeningBackupExportError("STAGING_INCOMPLETE", [`unsafe archivePath: ${object.archivePath}`]);
    }
    try {
      await access(path.join(staging, relative));
    } catch {
      throw new OpeningBackupExportError("STAGING_INCOMPLETE", [
        `staged object missing: ${object.archivePath}`,
      ]);
    }
  }

  await writeOpeningBackupArchive(backup, staging, archiveDestination.trim());
  if (options.encryptDestination) {
    await encryptOpeningArchive(
      archiveDestination.trim(),
      options.encryptDestination.trim(),
      options.passphrase as string,
    );
  }
}

/**
 * Convenience alias for domain fail-closed preflight.
 * `allowed === true` is structural only — never authorization to apply.
 */
export function previewOpeningRestore(
  backup: unknown,
  currentDeletionJournal: readonly OpeningDeletionMark[],
  currentMemoryDeletions?: OpeningMemoryDeletions,
): RestorePreview {
  return validateOpeningRestore(backup, currentDeletionJournal, currentMemoryDeletions);
}

/** Guarantees every apply path asserts; real executor must keep them. */
export type OpeningRestoreApplyGuarantees = {
  secretsRestored: false;
  apiKeysRestored: false;
  sessionsRestored: false;
  /** Pending paid jobs / reminders stay cancelled until explicitly recreated. */
  pendingJobs: "cancelled";
};

export type OpeningRestoreApplyArgs = {
  confirmLocalRestore?: boolean;
  /**
   * Plan-only path: run validateOpeningRestore + planOpeningRestoreApply and
   * return a structured report. Never mutates DB/storage.
   */
  dryRun?: boolean;
  /** Required for dry-run and for confirm+counts empty-namespace preflight. */
  backup?: unknown;
  currentDeletionJournal?: readonly OpeningDeletionMark[];
  currentMemoryDeletions?: OpeningMemoryDeletions;
  availableCourseIds?: readonly string[];
  currentLearningState?: OpeningRestoreLearningState;
  /**
   * Pre-counted durable rows for the target workspace (from
   * readOpeningRestoreNamespaceCounts). Required to advance past
   * TARGET_NOT_EMPTY on the confirm path without live sql re-read.
   */
  emptyNamespaceCounts?: OpeningRestoreNamespaceCounts;
  /**
   * When set with confirm + backup (+ empty namespace), runs the Opening
   * transactional row/object apply executor (removes APPLY_EXECUTOR_DEFERRED).
   */
  sql?: import("postgres").Sql;
  objectPut?: OpeningRestoreObjectPut;
  stagingDirectory?: string;
  objectBodies?: OpeningRestoreExecuteArgs["objectBodies"];
};

export type OpeningRestoreApplyResult =
  | {
      ok: true;
      code: "DRY_RUN_OK";
      mode: "dry-run";
      mutated: false;
      errors: string[];
      guarantees: OpeningRestoreApplyGuarantees;
      preview: RestorePreview;
      plan: OpeningRestoreApplyPlan;
    }
  | {
      ok: true;
      code: "APPLY_OK";
      mutated: true;
      errors: string[];
      guarantees: OpeningRestoreApplyGuarantees;
      preview: RestorePreview;
      plan: OpeningRestoreApplyPlan;
      emptyNamespaceVerified: true;
      rowsInserted: number;
      objectsApplied: number;
      objectApplyDeferred: boolean;
      pendingJobsCancelled: number;
    }
  | {
      ok: false;
      code:
        | "REQUIRES_EXPLICIT_CONFIRMATION"
        | "APPLY_EXECUTOR_DEFERRED"
        | "DRY_RUN_MISSING_BACKUP"
        | "PREFLIGHT_REJECTED"
        | "JOURNAL_DRIFT"
        | "TARGET_NOT_EMPTY"
        | "APPLY_FAILED";
      mode?: "dry-run";
      mutated: false;
      errors: string[];
      guarantees: OpeningRestoreApplyGuarantees;
      preview?: RestorePreview;
      plan?: OpeningRestoreApplyPlan;
      /** Set when empty-namespace policy ran and passed (still not apply auth without sql). */
      emptyNamespaceVerified?: boolean;
    };

const RESTORE_GUARANTEES: OpeningRestoreApplyGuarantees = {
  secretsRestored: false,
  apiKeysRestored: false,
  sessionsRestored: false,
  pendingJobs: "cancelled",
};

/**
 * Fail-closed restore apply entry (Q03).
 *
 * - Without `confirmLocalRestore: true` → REQUIRES_EXPLICIT_CONFIRMATION.
 * - With confirm + `dryRun: true` → structural preflight only (validate + plan);
 *   returns allowed/errors/recordCounts + batch plan; `mutated: false`.
 * - With confirm + backup + empty namespace + `sql` → Opening transactional
 *   row/object apply (`APPLY_OK`, `mutated: true`). Re-reads empty counts in-tx.
 * - With confirm + backup + empty namespace and **no** `sql` → still
 *   APPLY_EXECUTOR_DEFERRED (executor needs a Sql handle).
 * - With confirm and no dry-run (no counts / no sql) → APPLY_EXECUTOR_DEFERRED.
 *
 * Never restores API keys/sessions/secrets. Pending paid jobs stay cancelled.
 * Native `backup-restore` / `applyRestorePlan` is a different schema — unused.
 */
export async function applyOpeningRestore(
  args?: OpeningRestoreApplyArgs,
): Promise<OpeningRestoreApplyResult> {
  if (!args || args.confirmLocalRestore !== true) {
    return {
      ok: false,
      code: "REQUIRES_EXPLICIT_CONFIRMATION",
      mutated: false,
      errors: ["explicit local confirmation is required (--confirm-local-restore)"],
      guarantees: RESTORE_GUARANTEES,
    };
  }

  if (args.dryRun === true) {
    if (args.backup === undefined) {
      return {
        ok: false,
        code: "DRY_RUN_MISSING_BACKUP",
        mode: "dry-run",
        mutated: false,
        errors: ["dry-run requires a backup draft (--draft)"],
        guarantees: RESTORE_GUARANTEES,
      };
    }
    const journal = args.currentDeletionJournal ?? [];
    const preview = validateOpeningRestore(args.backup, journal, args.currentMemoryDeletions);
    const planned = planOpeningRestoreApply(args.backup, journal, {
      confirmLocalRestore: true,
      availableCourseIds: args.availableCourseIds,
      currentLearningState: args.currentLearningState,
      currentMemoryDeletions: args.currentMemoryDeletions,
    });
    if (!planned.ok) {
      return {
        ok: false,
        code: planned.code === "REQUIRES_EXPLICIT_CONFIRMATION"
          ? "REQUIRES_EXPLICIT_CONFIRMATION"
          : planned.code,
        mode: "dry-run",
        mutated: false,
        errors: planned.errors,
        guarantees: RESTORE_GUARANTEES,
        preview,
      };
    }
    return {
      ok: true,
      code: "DRY_RUN_OK",
      mode: "dry-run",
      mutated: false,
      errors: [],
      guarantees: RESTORE_GUARANTEES,
      preview,
      plan: planned.plan,
    };
  }

  // Confirm path without dry-run: structural preflight + empty-namespace, then
  // Opening apply when sql is provided.
  if (args.backup !== undefined) {
    const journal = args.currentDeletionJournal ?? [];
    const preview = validateOpeningRestore(args.backup, journal, args.currentMemoryDeletions);
    const planned = planOpeningRestoreApply(args.backup, journal, {
      confirmLocalRestore: true,
      availableCourseIds: args.availableCourseIds,
      currentLearningState: args.currentLearningState,
      currentMemoryDeletions: args.currentMemoryDeletions,
    });
    if (!planned.ok) {
      return {
        ok: false,
        code: planned.code === "REQUIRES_EXPLICIT_CONFIRMATION"
          ? "REQUIRES_EXPLICIT_CONFIRMATION"
          : planned.code,
        mutated: false,
        errors: planned.errors,
        guarantees: RESTORE_GUARANTEES,
        preview,
      };
    }

    // Prefer live empty-namespace re-read when sql is present; otherwise require counts.
    if (!args.sql) {
      const empty = evaluateOpeningRestoreEmptyNamespace(args.emptyNamespaceCounts);
      if (!empty.ok) {
        return {
          ok: false,
          code: "TARGET_NOT_EMPTY",
          mutated: false,
          errors: empty.errors,
          guarantees: RESTORE_GUARANTEES,
          preview,
          plan: planned.plan,
          emptyNamespaceVerified: false,
        };
      }
      return {
        ok: false,
        code: "APPLY_EXECUTOR_DEFERRED",
        mutated: false,
        errors: [
          "empty-namespace verified; pass sql to run Opening transactional apply executor",
          "pending paid jobs / reminders stay cancelled until explicitly recreated",
          "API keys, sessions, and other secrets are never restored by this entrypoint",
        ],
        guarantees: RESTORE_GUARANTEES,
        preview,
        plan: planned.plan,
        emptyNamespaceVerified: true,
      };
    }

    const executed = await executeOpeningRestoreApply(args.sql, {
      confirmLocalRestore: true,
      backup: args.backup,
      currentDeletionJournal: journal,
      currentMemoryDeletions: args.currentMemoryDeletions,
      availableCourseIds: args.availableCourseIds,
      currentLearningState: args.currentLearningState,
      emptyNamespaceCounts: args.emptyNamespaceCounts,
      stagingDirectory: args.stagingDirectory,
      objectBodies: args.objectBodies,
      objectPut: args.objectPut,
    });
    if (!executed.ok) {
      return {
        ok: false,
        code: executed.code,
        mutated: false,
        errors: executed.errors,
        guarantees: RESTORE_GUARANTEES,
        preview: executed.preview ?? preview,
        plan: executed.plan ?? planned.plan,
        emptyNamespaceVerified: executed.emptyNamespaceVerified,
      };
    }
    return {
      ok: true,
      code: "APPLY_OK",
      mutated: true,
      errors: executed.errors,
      guarantees: RESTORE_GUARANTEES,
      preview: executed.preview,
      plan: executed.plan,
      emptyNamespaceVerified: true,
      rowsInserted: executed.rowsInserted,
      objectsApplied: executed.objectsApplied,
      objectApplyDeferred: executed.objectApplyDeferred,
      pendingJobsCancelled: executed.pendingJobsCancelled,
    };
  }

  return {
    ok: false,
    code: "APPLY_EXECUTOR_DEFERRED",
    mutated: false,
    errors: [
      "restore apply executor is deferred: supply --draft/backup plus sql (and empty-namespace)",
      "use --dry-run with --draft for structural preflight (planOpeningRestoreApply)",
      "pending paid jobs / reminders stay cancelled until explicitly recreated",
      "API keys, sessions, and other secrets are never restored by this entrypoint",
    ],
    guarantees: RESTORE_GUARANTEES,
  };
}
