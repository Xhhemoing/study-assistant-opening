import { openingAiSettingsSchema } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";

type Rows = Record<string, unknown>[];

/** The caller owns the workspace owner gate and repeatable-read transaction. */
export async function readOpeningBackupCourseRecords(tx: TransactionSql, workspaceId: string, sourceIds: readonly string[]) {
  const workspace_preferences: Rows = [...await tx`
    SELECT workspace_id, default_entry, ai_settings, assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled,
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at,
      created_at, updated_at
    FROM workspace_preferences WHERE workspace_id = ${workspaceId}`];
  for (const row of workspace_preferences) {
    if (row.ai_settings != null) row.ai_settings = openingAiSettingsSchema.parse(row.ai_settings);
  }
  const courses: Rows = [...await tx`
    SELECT id, workspace_id, title, slug, description, schema_version, archived_at,
      assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled,
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at,
      created_at, updated_at
    FROM courses WHERE workspace_id = ${workspaceId} ORDER BY id`];
  // Opening has no document/block/card bodies. Export only relationships whose source is in this exact inventory.
  const course_asset_memberships: Rows = sourceIds.length ? [...await tx`
    SELECT m.id, m.workspace_id, m.course_id, m.asset_type, m.asset_id, m.role, m.sort_order, m.visibility, m.created_at, m.updated_at
    FROM course_asset_memberships m JOIN courses c ON c.id = m.course_id AND c.workspace_id = ${workspaceId}
    WHERE m.workspace_id = ${workspaceId} AND m.asset_type = 'source' AND m.asset_id = ANY(${[...sourceIds]}::uuid[])
    ORDER BY m.id`] : [];
  return { workspace_preferences, courses, course_asset_memberships };
}
