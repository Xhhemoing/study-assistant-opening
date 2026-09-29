import { LEARNING_STATE_TABLES, validateBackupLearningState } from "./backup-learning-state";
import { isJournal, isRecord, isTables, isUuid, parseUuidArray, sourceReferences, validObject } from "./backup-validation";

export type OpeningDeletionMark = { sourceId: string; deletedAt: string; assetDeletedAt?: string | null };

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
  ...LEARNING_STATE_TABLES,
  "opening_sources", "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions",
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
  "opening_tasks", "opening_retest_activities",
  "opening_timetable_sessions",
  "opening_hard_blocks",
  "opening_plan_state",
  "opening_plan_drafts",
  "opening_plan_acceptances",
] as const;

function validateRetestReferences(
  tables: Record<string, Record<string, unknown>[]>,
  errors: string[],
): void {
  const tasks = new Map<string, { owner: string }>();
  const activities = new Map<string, { owner: string; course: string; skill: string }>();
  const conversations = new Map<string, { workspace: string; owner: string }>();
  const assistantCandidates = new Map<string, { workspace: string; owner: string }>();
  for (const row of tables.opening_conversations ?? []) {
    if (!isUuid(row.id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) continue;
    if (conversations.has(row.id.toLowerCase())) errors.push("opening conversation identity is duplicated");
    conversations.set(row.id.toLowerCase(), {
      workspace: row.workspace_id.toLowerCase(),
      owner: row.owner_user_id.toLowerCase(),
    });
  }
  for (const row of tables.opening_assistant_candidates ?? []) {
    if (!isUuid(row.id)) {
      errors.push("opening assistant candidate identity is missing or invalid");
      continue;
    }
    if (!isUuid(row.workspace_id)) {
      errors.push("opening assistant candidate workspace is missing or invalid");
      continue;
    }
    if (!isUuid(row.conversation_id)) {
      errors.push("opening assistant candidate conversation is missing or invalid");
      continue;
    }
    const conversation = conversations.get(row.conversation_id.toLowerCase());
    if (!conversation) {
      errors.push("opening assistant candidate conversation is missing");
      continue;
    }
    if (conversation.workspace !== row.workspace_id.toLowerCase()) {
      errors.push("opening assistant candidate conversation workspace mismatch");
      continue;
    }
    const id = row.id.toLowerCase();
    if (assistantCandidates.has(id)) errors.push("opening assistant candidate identity is duplicated");
    assistantCandidates.set(id, { workspace: row.workspace_id.toLowerCase(), owner: conversation.owner });
  }
  for (const row of tables.opening_tasks ?? []) {
    if (!isUuid(row.id)) {
      errors.push("opening task identity is missing or invalid");
      continue;
    }
    const owner = row.owner_user_id;
    if (!isUuid(owner)) {
      errors.push("opening task owner is missing or invalid");
      continue;
    }
    const id = row.id.toLowerCase();
    if (tasks.has(id)) errors.push("opening task identity is duplicated");
    tasks.set(id, { owner: owner.toLowerCase() });
    if (row.candidate_id !== undefined && row.candidate_id !== null) {
      if (!isUuid(row.candidate_id)) {
        errors.push("opening task candidate reference is invalid");
      } else {
        const candidate = assistantCandidates.get(row.candidate_id.toLowerCase());
        const taskWorkspace = isUuid(row.workspace_id) ? row.workspace_id.toLowerCase() : null;
        if (!candidate) {
          errors.push("opening task contains an unresolved transport candidate reference");
        } else if (taskWorkspace !== candidate.workspace) {
          errors.push("opening task candidate workspace mismatch");
        } else if (candidate.owner !== owner.toLowerCase()) {
          errors.push("opening task candidate owner mismatch");
        }
      }
    }
  }
  for (const row of tables.opening_retest_activities ?? []) {
    if (!isUuid(row.id)) {
      errors.push("retest activity identity is missing or invalid");
      continue;
    }
    const owner = row.owner_user_id;
    if (!isUuid(owner)) {
      errors.push("retest activity owner is missing or invalid");
      continue;
    }
    if (!isUuid(row.course_id)) errors.push("retest activity course is missing or invalid");
    const id = row.id.toLowerCase();
    if (activities.has(id)) errors.push("retest activity identity is duplicated");
    activities.set(id, {
      owner: owner.toLowerCase(),
      course: isUuid(row.course_id) ? row.course_id.toLowerCase() : "",
      skill: typeof row.skill_label === "string" ? row.skill_label : "",
    });
    if (row.candidate_id !== undefined && row.candidate_id !== null) {
      errors.push("retest activity contains an unresolved transport candidate reference");
    }
  }
  for (const row of tables.opening_learning_observations ?? []) {
    if (row.retest_id === undefined || row.retest_id === null) continue;
    if (!isUuid(row.retest_id)) {
      errors.push("learning observation retest reference is invalid");
      continue;
    }
    const activity = activities.get(row.retest_id.toLowerCase());
    if (!activity) errors.push("learning observation retest reference is missing");
    else {
      if (!isUuid(row.owner_user_id) || activity.owner !== row.owner_user_id.toLowerCase()) errors.push("learning observation retest owner mismatch");
      if (!isUuid(row.course_id) || activity.course !== row.course_id.toLowerCase()
        || typeof row.skill_label !== "string" || activity.skill !== row.skill_label) {
        errors.push("learning observation retest activity mismatch");
      }
    }
  }
  for (const row of tables.opening_retest_activities ?? []) {
    if (!isUuid(row.id) || !isUuid(row.owner_user_id)) continue;
    const activityOwner = row.owner_user_id.toLowerCase();
    if (row.task_id !== undefined && row.task_id !== null) {
      if (!isUuid(row.task_id)) {
        errors.push("retest activity task reference is invalid");
      } else {
        const task = tasks.get(row.task_id.toLowerCase());
        if (!task) errors.push("retest activity task reference is missing");
        else if (task.owner !== activityOwner) errors.push("retest activity task owner mismatch");
      }
    }
    if (row.reopened_from_activity_id !== undefined && row.reopened_from_activity_id !== null) {
      if (!isUuid(row.reopened_from_activity_id)) {
        errors.push("retest activity reopen reference is invalid");
      } else {
        const previous = activities.get(row.reopened_from_activity_id.toLowerCase());
        if (!previous) errors.push("retest activity reopen reference is missing");
        else if (previous.owner !== activityOwner) errors.push("retest activity reopen owner mismatch");
      }
    }
  }
}

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
  const sourceVersions = new Set([...ownedSources].map(([id, version]) => `${id}/${version}`));
  for (const row of tables.opening_source_versions ?? []) {
    if (isUuid(row.source_id) && ownedSources.has(row.source_id.toLowerCase()) && Number.isSafeInteger(row.version) && (row.version as number) >= 0) sourceVersions.add(`${row.source_id.toLowerCase()}/${row.version}`);
    else errors.push("source version has no owned source or valid version");
  }
  const turns = new Map((tables.opening_turns ?? [])
    .filter((row) => isUuid(row.id) && isUuid(row.workspace_id) && row.workspace_id.toLowerCase() === workspaceId)
    .map((row) => [(row.id as string).toLowerCase(), row]));
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
          || !sourceVersions.has(`${row.source_id.toLowerCase()}/${row.source_version}`)) {
          errors.push("chunk source version does not match included source");
        }
      } else if (!isUuid(row.workspace_id) || row.workspace_id.toLowerCase() !== workspaceId) {
        errors.push(`table ${name} has a foreign or missing workspace`);
      }
      if (name === "opening_turns") {
        if (row.role !== "user" && row.role !== "assistant") errors.push("turn role is missing or invalid");
        if (row.role === "assistant" && row.context_source_refs == null) {
          errors.push("assistant context provenance is missing or unknown");
        }
      }
      if (name === "opening_assistant_candidates") {
        const turn = isUuid(row.source_turn_id) ? turns.get(row.source_turn_id.toLowerCase()) : undefined;
        if (!turn || !isUuid(turn.conversation_id) || !isUuid(row.conversation_id)
          || turn.conversation_id.toLowerCase() !== row.conversation_id.toLowerCase()) {
          errors.push("assistant candidate source turn is missing or invalid");
        }
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
      if (name === "opening_privacy_exclusions") {
        if ("pending_object_keys" in row || "cleanup_not_before" in row) errors.push("storage cleanup state cannot be restored");
        const mark = backup.deletionJournal.find(item => item.sourceId.toLowerCase() === String(row.source_id).toLowerCase());
        const marker = row.asset_deleted_at;
        if (marker != null && (!(typeof marker === "string" || marker instanceof Date) || !Number.isFinite(new Date(marker as string | Date).getTime()))) errors.push("invalid asset deletion time");
        else if ((marker != null || mark?.assetDeletedAt != null)
          && (marker == null || mark?.assetDeletedAt == null || new Date(marker as string | Date).getTime() !== Date.parse(mark.assetDeletedAt))) {
          errors.push("asset deletion does not match deletion journal");
        }
      }
      if (name === "opening_sources" && "upload_url_expires_at" in row) errors.push("upload capabilities cannot be restored");
      if (name === "opening_memories") {
        if (row.status === "deleted") errors.push("deleted memory cannot be restored");
        const turnIds = parseUuidArray(row.source_turn_ids);
        if (!turnIds || turnIds.length === 0 || turnIds.some((id) => !turns.has(id.toLowerCase()))) {
          errors.push("memory source turn is missing or invalid");
        }
      }
    }
  }
  validateRetestReferences(tables, errors);
  validateBackupLearningState(tables, errors);
  for (const object of backup.objects as OpeningBackupObject[]) {
    if (deleted.has(object.sourceId.toLowerCase())) errors.push(`deleted source ${object.sourceId} cannot be restored`);
    if (object.actualSha256 !== undefined && object.actualSha256.toLowerCase() !== object.sha256.toLowerCase()) {
      errors.push(`source ${object.sourceId} hash mismatch`);
    }
  }
  return { allowed: errors.length === 0, errors,
    recordCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])) };
}
