import { isJournal, isRecord, isTables, isUuid, parseUuidArray, sourceReferences, validObject } from "./backup-validation";

export type OpeningDeletionMark = { sourceId: string; deletedAt: string };

export type OpeningBackupObject = {
  sourceId: string;
  sha256: string;
  bytes: number;
  archivePath: string;
  actualSha256?: string;
};

export type OpeningBackup = {
  format: "opening-backup";
  version: 1;
  workspaceId: string;
  privacyEpoch: number;
  deletionJournal: OpeningDeletionMark[];
  tables: Record<string, unknown[]>;
  objects: OpeningBackupObject[];
};

export type RestorePreview = {
  allowed: boolean;
  errors: string[];
  recordCounts: Record<string, number>;
};

const TABLE_ALLOWLIST = [
  "opening_sources",
  "opening_source_chunks",
  "opening_conversations",
  "opening_turns",
  "opening_learning_sessions",
  "opening_problem_refs",
  "opening_help_exposures",
  "opening_learning_observations",
  "opening_assistant_candidates",
  "opening_memories",
  "opening_privacy_exclusions",
  "opening_tasks",
  "opening_timetable_sessions",
  "opening_hard_blocks",
  "opening_plan_state",
  "opening_plan_drafts",
  "opening_plan_acceptances",
] as const;

/**
 * Fail-closed preflight only. allowed is NOT authorization to apply a restore.
 * The I/O layer must authenticate the owner, validate full rows/relations, read
 * the current journal under lock and independently hash actual archive bytes.
 * In particular, actualSha256 supplied inside an archive is not trusted proof.
 */
export function validateOpeningRestore(
  backup: unknown,
  currentDeletionJournal: readonly OpeningDeletionMark[],
): RestorePreview {
  const reject = (error: string): RestorePreview => ({ allowed: false, errors: [error], recordCounts: {} });
  if (!isRecord(backup) || backup.format !== "opening-backup" || backup.version !== 1) {
    return reject("unknown backup version");
  }
  if (!isUuid(backup.workspaceId) || !Number.isSafeInteger(backup.privacyEpoch)
    || (backup.privacyEpoch as number) < 0 || !isJournal(backup.deletionJournal)
    || !isJournal(currentDeletionJournal) || !isTables(backup.tables)
    || !Array.isArray(backup.objects) || !backup.objects.every(validObject)) {
    return reject("invalid backup structure or privacy metadata");
  }
  const errors: string[] = [];
  const tables = backup.tables;
  const deleted = new Set([...backup.deletionJournal, ...currentDeletionJournal]
    .map((mark) => mark.sourceId.toLowerCase()));
  const workspaceId = backup.workspaceId.toLowerCase();
  const ownedSources = new Map((tables.opening_sources ?? [])
    .filter((row) => isUuid(row.id) && isUuid(row.workspace_id) && row.workspace_id.toLowerCase() === workspaceId)
    .map((row) => [(row.id as string).toLowerCase(), row.version]));
  const turns = new Set((tables.opening_turns ?? [])
    .filter((row) => isUuid(row.id) && isUuid(row.workspace_id) && row.workspace_id.toLowerCase() === workspaceId)
    .map((row) => (row.id as string).toLowerCase()));
  for (const [name, rows] of Object.entries(tables)) {
    if (!TABLE_ALLOWLIST.includes(name as (typeof TABLE_ALLOWLIST)[number])) {
      errors.push(`table ${name} is not allowlisted`);
      continue;
    }
    for (const row of rows) {
      if (name === "opening_source_chunks") {
        if (!isUuid(row.source_id) || !ownedSources.has(row.source_id.toLowerCase())) {
          errors.push("chunk has no owned source");
        } else if (!Number.isSafeInteger(row.source_version)
          || row.source_version !== ownedSources.get(row.source_id.toLowerCase())) {
          errors.push("chunk source version does not match included source");
        }
      } else if (!isUuid(row.workspace_id) || row.workspace_id.toLowerCase() !== workspaceId) {
        errors.push(`table ${name} has a foreign or missing workspace`);
      }
      const refs = sourceReferences(row);
      if (refs === null) errors.push(`table ${name} has invalid source lineage`);
      if (name === "opening_sources") {
        if (!isUuid(row.id)) errors.push("source identity is missing or invalid");
        else if (deleted.has(row.id.toLowerCase())) errors.push("deleted source cannot be restored");
      }
      if (name !== "opening_privacy_exclusions" && refs?.some((id) => deleted.has(id))) {
        errors.push(`table ${name} references a deleted source`);
      }
      if (name === "opening_privacy_exclusions"
        && (!isUuid(row.source_id) || !deleted.has(row.source_id.toLowerCase()))) {
        errors.push("privacy exclusion does not match deletion journal");
      }
      if (name === "opening_memories") {
        if (row.status === "deleted") errors.push("deleted memory cannot be restored");
        const turnIds = parseUuidArray(row.source_turn_ids);
        if (!turnIds || turnIds.length === 0 || turnIds.some((id) => !turns.has(id.toLowerCase()))) {
          errors.push("memory source turn is missing or invalid");
        }
      }
    }
  }
  for (const object of backup.objects as OpeningBackupObject[]) {
    if (deleted.has(object.sourceId.toLowerCase())) errors.push(`deleted source ${object.sourceId} cannot be restored`);
    if (object.actualSha256 !== undefined && object.actualSha256.toLowerCase() !== object.sha256.toLowerCase()) {
      errors.push(`source ${object.sourceId} hash mismatch`);
    }
  }
  return { allowed: errors.length === 0, errors,
    recordCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])) };
}
