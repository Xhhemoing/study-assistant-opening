import { courseLearningPreferencesUpdateSchema, learningPreferencesSchema, type CourseLearningPreferencesUpdate, type LearningPreferences, type Scope } from "@aistudy/contracts";
import { resolveLearningPreferences } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";

type LearningSql = Sql | TransactionSql;

function effective(row: Record<string, unknown>): LearningPreferences {
  const account = learningPreferencesSchema.parse({
    assessmentEnabled: row.account_assessment ?? false,
    retestSuggestionsEnabled: row.account_retest ?? false,
    automaticRemindersEnabled: row.account_reminders ?? false,
  });
  return resolveLearningPreferences(account, {
    assessmentEnabled: row.course_assessment == null ? undefined : row.course_assessment as boolean,
    retestSuggestionsEnabled: row.course_retest == null ? undefined : row.course_retest as boolean,
    automaticRemindersEnabled: row.course_reminders == null ? undefined : row.course_reminders as boolean,
  }, row.archived_at != null);
}

async function selectPreferenceRow(sql: LearningSql, scope: Scope, courseId: string) {
  const rows = await sql`SELECT p.assessment_enabled AS account_assessment,
      p.retest_suggestions_enabled AS account_retest,
      p.automatic_reminders_enabled AS account_reminders,
      c.assessment_enabled AS course_assessment,
      c.retest_suggestions_enabled AS course_retest,
      c.automatic_reminders_enabled AS course_reminders,c.archived_at,
      GREATEST(p.retest_suggestions_enabled_at,c.retest_suggestions_enabled_at) AS retest_enabled_at,
      GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at) AS reminders_enabled_at
    FROM workspaces w JOIN courses c ON c.workspace_id=w.id
    LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND c.id=${courseId}`;
  if (!rows.length) throw learningError("NOT_FOUND", "course not found");
  return rows[0] as Record<string, unknown>;
}

export async function readLearningPreferences(sql: LearningSql, scope: Scope, courseId: string): Promise<LearningPreferences> {
  return effective(await selectPreferenceRow(sql, scope, courseId));
}

export type LearningAutomationState = {
  preferences: LearningPreferences;
  retestSuggestionsEnabledAt: Date | null;
  automaticRemindersEnabledAt: Date | null;
};

/** Read after lockLearningPreferences when deciding whether to publish automatically. */
export async function readLearningAutomationState(
  sql: LearningSql, scope: Scope, courseId: string,
): Promise<LearningAutomationState> {
  const row = await selectPreferenceRow(sql, scope, courseId);
  const preferences = effective(row);
  return {
    preferences,
    retestSuggestionsEnabledAt: preferences.retestSuggestionsEnabled && row.retest_enabled_at != null
      ? new Date(row.retest_enabled_at as string | Date) : null,
    automaticRemindersEnabledAt: preferences.automaticRemindersEnabled && row.reminders_enabled_at != null
      ? new Date(row.reminders_enabled_at as string | Date) : null,
  };
}
/** Call before publishing in the same transaction; lock order is workspace, then course. */
export async function lockLearningPreferences(tx: TransactionSql, scope: Scope, courseId: string): Promise<LearningPreferences> {
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner.length) throw learningError("NOT_FOUND", "workspace not found");
  const course = await tx`SELECT id FROM courses WHERE id=${courseId}
    AND workspace_id=${scope.workspaceId} FOR SHARE`;
  if (!course.length) throw learningError("NOT_FOUND", "course not found");
  return effective(await selectPreferenceRow(tx, scope, courseId));
}

export async function setCourseLearningPreferences(
  sql: Sql, scope: Scope, courseId: string, update: CourseLearningPreferencesUpdate,
): Promise<LearningPreferences> {
  const parsed = courseLearningPreferencesUpdateSchema.parse(update);
  return sql.begin(async (tx) => {
    const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!owner.length) throw learningError("NOT_FOUND", "workspace not found");
    const course = await tx`SELECT id FROM courses WHERE id=${courseId}
      AND workspace_id=${scope.workspaceId} FOR UPDATE`;
    if (!course.length) throw learningError("NOT_FOUND", "course not found");
    await tx`UPDATE courses SET
      assessment_enabled=CASE WHEN ${parsed.assessmentEnabled === undefined} THEN assessment_enabled ELSE ${parsed.assessmentEnabled === true ? null : parsed.assessmentEnabled ?? null} END,
      retest_suggestions_enabled=CASE WHEN ${parsed.retestSuggestionsEnabled === undefined} THEN retest_suggestions_enabled ELSE ${parsed.retestSuggestionsEnabled === true ? null : parsed.retestSuggestionsEnabled ?? null} END,
      automatic_reminders_enabled=CASE WHEN ${parsed.automaticRemindersEnabled === undefined} THEN automatic_reminders_enabled ELSE ${parsed.automaticRemindersEnabled === true ? null : parsed.automaticRemindersEnabled ?? null} END,
      updated_at=now()
      WHERE id=${courseId} AND workspace_id=${scope.workspaceId}`;
    return effective(await selectPreferenceRow(tx, scope, courseId));
  });
}
