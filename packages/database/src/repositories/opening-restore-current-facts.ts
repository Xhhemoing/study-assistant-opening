import type { Sql, TransactionSql } from "postgres";
import type { OpeningDeletionMark, OpeningRestoreLearningState } from "@aistudy/domain";
import { readOpeningMemoryDeletions, type OpeningMemoryDeletions } from "./opening-backup-memory-deletions";

export type OpeningRestoreCurrentFacts = {
  currentDeletionJournal: readonly OpeningDeletionMark[];
  currentMemoryDeletions: OpeningMemoryDeletions;
  currentLearningState: OpeningRestoreLearningState;
  availableCourseIds: readonly string[];
};

/** Only the target identity is taken from the untrusted draft, never its owner or live facts. */
export function openingRestoreWorkspaceId(backup: unknown): string {
  const workspaceId = backup && typeof backup === "object" && "workspaceId" in backup ? backup.workspaceId : undefined;
  if (typeof workspaceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error("restore workspace identity is invalid");
  }
  return workspaceId.toLowerCase();
}

/** Caller holds an owner-checked snapshot/lock. No source, memory or credential bodies. */
export async function readOpeningRestoreCurrentFacts(
  tx: TransactionSql, workspaceId: string, ownerUserId: string,
): Promise<OpeningRestoreCurrentFacts> {
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${workspaceId} AND owner_user_id=${ownerUserId}`;
  if (!owner) throw new Error("restore workspace owner is missing or changed");
  const marks = await tx`SELECT e.source_id, e.deleted_at, e.asset_deleted_at FROM opening_privacy_exclusions e
    WHERE e.workspace_id=${workspaceId} AND e.source_id IS NOT NULL
      AND NOT (
        e.id::text = overlay(e.source_id::text placing '8' from 15 for 1)
        AND e.memory_id IS NULL
        AND e.asset_deleted_at IS NOT NULL
        AND cardinality(e.pending_object_keys) = 1
        AND EXISTS (
          SELECT 1 FROM opening_source_versions v
          WHERE v.workspace_id = e.workspace_id
            AND v.source_id = e.source_id
            AND v.version = 0
            AND v.availability = 'unavailable'
            AND v.sha256 IS NULL
            AND v.material_manifest IS NULL
        )
      )
    ORDER BY e.source_id`;
  const currentDeletionJournal = marks.map(row => ({
    sourceId: String(row.source_id), deletedAt: new Date(row.deleted_at as string | Date).toISOString(),
    ...(row.asset_deleted_at ? { assetDeletedAt: new Date(row.asset_deleted_at as string | Date).toISOString() } : {}),
  }));
  const currentMemoryDeletions = await readOpeningMemoryDeletions(tx, workspaceId);
  const [preferences] = await tx`SELECT workspace_id, assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled,
    to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
    to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at
    FROM workspace_preferences WHERE workspace_id=${workspaceId}`;
  const courses = await tx`SELECT id, workspace_id, title, slug, schema_version,
    to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archived_at,
    assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled,
    to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
    to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at
    FROM courses WHERE workspace_id=${workspaceId} ORDER BY id`;
  return {
    currentDeletionJournal, currentMemoryDeletions,
    currentLearningState: { workspacePreferences: preferences ?? null, courses: [...courses] },
    availableCourseIds: courses.map(row => String(row.id)),
  };
}

/** Read-only, consistent CLI preflight; executor independently re-reads under its write lock. */
export async function snapshotOpeningRestoreCurrentFacts(sql: Sql, backup: unknown): Promise<OpeningRestoreCurrentFacts> {
  const workspaceId = openingRestoreWorkspaceId(backup);
  return sql.begin("isolation level repeatable read, read only", async tx => {
    const [workspace] = await tx`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`;
    if (!workspace) throw new Error("restore workspace owner is missing");
    return readOpeningRestoreCurrentFacts(tx, workspaceId, String(workspace.owner_user_id));
  });
}
