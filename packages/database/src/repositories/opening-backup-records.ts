import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningBackupSourceError } from "./opening-backup-sources";
import { readOpeningBackupTableRows } from "./opening-backup-record-table-queries";
import { readOpeningMemoryDeletions, type OpeningMemoryDeletions } from "./opening-backup-memory-deletions";

export const OPENING_BACKUP_TABLES = [
  "workspace_preferences", "courses", "course_asset_memberships",
  "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
  "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
  "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
  "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
  "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
  "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions", "opening_workspace_history_revisions",
] as const;
export type OpeningBackupTable = (typeof OPENING_BACKUP_TABLES)[number];
export type OpeningBackupRecordSnapshot = {
  privacyEpoch: number;
  deletionJournal: Array<{ sourceId: string; deletedAt: string; assetDeletedAt?: string | null }>;
  memoryDeletions: OpeningMemoryDeletions;
  tables: Record<OpeningBackupTable, Record<string, unknown>[]>;
};

/** Durable Opening records only. This is an inventory, not a restore package. */
export async function readOpeningBackupRecords(
  sql: Sql,
  scope: OpeningScope,
): Promise<OpeningBackupRecordSnapshot> {
  const id = scope.workspaceId;
  const userId = scope.ownerUserId;
  return sql.begin("isolation level repeatable read, read only", async (tx) => {
    const owner = await tx`SELECT id, privacy_epoch FROM workspaces WHERE id = ${id} AND owner_user_id = ${userId} LIMIT 1`;
    if (!owner.length) throw new OpeningBackupSourceError();
    const privacyEpoch = Number((owner[0] as { privacy_epoch: number }).privacy_epoch);
    const memoryDeletions = await readOpeningMemoryDeletions(tx, id);
    const tables = await readOpeningBackupTableRows(tx, id, userId);
    const deletionJournal = tables.opening_privacy_exclusions
      .filter((row) => typeof row.source_id === "string"
        && (typeof row.deleted_at === "string" || row.deleted_at instanceof Date))
      .map((row) => ({
        sourceId: row.source_id as string,
        deletedAt: new Date(row.deleted_at as string | Date).toISOString(),
        ...(row.asset_deleted_at ? { assetDeletedAt: new Date(row.asset_deleted_at as string | Date).toISOString() } : {}),
      }));
    return { privacyEpoch, deletionJournal, memoryDeletions, tables };
  });
}
