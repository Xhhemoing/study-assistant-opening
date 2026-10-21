import { cardReadable } from "./card-sources";
import { interventionPrefsPatchSchema, interventionPrefsSchema, openingAiSettingsSchema, openingPlanningSettingsSchema } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";

type Rows = Record<string, unknown>[];

/** The caller owns the workspace owner gate and repeatable-read transaction. */
export async function readOpeningBackupCourseRecords(tx: TransactionSql, workspaceId: string, sourceIds: readonly string[]) {
  const workspace_preferences: Rows = [...await tx`
    SELECT workspace_id, default_entry, ai_settings, planning_settings, adaptive_planning, intervention_settings, assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled,
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at,
      created_at, updated_at
    FROM workspace_preferences WHERE workspace_id = ${workspaceId}`];
  for (const row of workspace_preferences) {
    if (row.ai_settings != null) row.ai_settings = openingAiSettingsSchema.parse(row.ai_settings);
    if (row.planning_settings != null) row.planning_settings = openingPlanningSettingsSchema.parse(row.planning_settings);
    if (row.intervention_settings != null) row.intervention_settings = interventionPrefsSchema.parse(row.intervention_settings);
  }
  const courses: Rows = [...await tx`
    SELECT id, workspace_id, title, slug, description, schema_version, archived_at,
      assessment_enabled, retest_suggestions_enabled, automatic_reminders_enabled, intervention_settings,
      to_char(retest_suggestions_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retest_suggestions_enabled_at,
      to_char(automatic_reminders_enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS automatic_reminders_enabled_at,
      created_at, updated_at
    FROM courses WHERE workspace_id = ${workspaceId} ORDER BY id`];
  for (const row of courses) {
    if (row.intervention_settings != null) {
      row.intervention_settings = interventionPrefsPatchSchema.parse(row.intervention_settings);
    }
  }
  // Source-note cards stay in native backup, which includes their notes and provenance.
  // Opening can restore independent cards completely without orphaning document references.
  const cards: Rows = [...await tx`
    SELECT id,workspace_id,owner_user_id,front,back,source_document_id,syllabus_point_id,tags,
      course_id,skill_label,source_ids,archived,content_version,paused_until,maintain_until,
      exclude_from_assessment,origin_observation_root_id,auto_paused,created_at,updated_at
    FROM cards c WHERE workspace_id=${workspaceId} AND source_document_id IS NULL
      AND ${cardReadable(tx, workspaceId)} ORDER BY id`];
  const cardIds = cards.map(row => String(row.id));
  const card_review_states: Rows = cardIds.length ? [...await tx`
    SELECT workspace_id,owner_user_id,card_id,ease,interval_days,due_at,reps,lapses,last_grade,updated_at,srs_version,fsrs_state
    FROM card_review_states WHERE workspace_id=${workspaceId} AND card_id=ANY(${cardIds}::uuid[])
    ORDER BY owner_user_id,card_id`] : [];
  const learning_events: Rows = cardIds.length ? [...await tx`
    SELECT id,workspace_id,owner_user_id,type,schema_version,idempotency_key,occurred_at,created_at,
      content_id,content_version,syllabus_point_id,corrects_event_id,payload
    FROM learning_events WHERE workspace_id=${workspaceId} AND type='review' AND content_id=ANY(${cardIds}::uuid[])
    ORDER BY id`] : [];
  // Export only source memberships from this exact inventory.
  const course_asset_memberships: Rows = sourceIds.length ? [...await tx`
    SELECT m.id, m.workspace_id, m.course_id, m.asset_type, m.asset_id, m.role, m.sort_order, m.visibility, m.created_at, m.updated_at
    FROM course_asset_memberships m JOIN courses c ON c.id = m.course_id AND c.workspace_id = ${workspaceId}
    WHERE m.workspace_id = ${workspaceId} AND m.asset_type = 'source' AND m.asset_id = ANY(${[...sourceIds]}::uuid[])
    ORDER BY m.id`] : [];
  return { workspace_preferences, courses, course_asset_memberships, cards, card_review_states, learning_events };
}
