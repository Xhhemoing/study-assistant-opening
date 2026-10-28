import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";
import { DEFAULT_OPENING_ADAPTIVE_PREFS, openingAdaptivePrefsSchema, openingPlanningSettingsSchema,
  type LearningPreferences, type Scope, type SpanTutorGrant } from "@aistudy/contracts";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { readLearningPreferences } from "./opening-learning-preferences";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";

export type SpanTutorAuthorization = {
  grant: SpanTutorGrant | null; authorized: boolean;
  reason: "not_enabled" | "account_disabled" | "course_archived" | "expired" | "goal_ended" | "invalid_preferences" | null;
  timeZone: string; localDate: string; goalTargetDate: string | null;
};
export function resolveSpanTutorAuthorization(input: {
  grant: SpanTutorGrant | null; preferences: LearningPreferences; archived: boolean;
  invalidPreferences: boolean; goalInactive?: boolean; timeZone: string; goalTargetDate: string | null; now: Date;
}): SpanTutorAuthorization {
  const localDate = localDateKeyInZone(input.now, input.timeZone);
  const reason: SpanTutorAuthorization["reason"] = input.invalidPreferences ? "invalid_preferences"
    : input.goalInactive ? "goal_ended" : input.archived ? "course_archived" : !input.grant?.enabled ? "not_enabled"
    : !input.preferences.assessmentEnabled || !input.preferences.retestSuggestionsEnabled ? "account_disabled"
    : input.grant.expiresOn && input.grant.expiresOn < localDate ? "expired"
    : input.goalTargetDate && input.goalTargetDate < localDate ? "goal_ended" : null;
  return { grant: input.grant, authorized: reason === null, reason, timeZone: input.timeZone,
    localDate, goalTargetDate: input.goalTargetDate };
}
export async function readSpanTutorAuthorization(sql: Sql | TransactionSql, scope: Scope, courseId: string,
  now = new Date()): Promise<SpanTutorAuthorization> {
  courseId = courseId.toLowerCase();
  const [row] = await sql`SELECT p.adaptive_planning,p.planning_settings,c.archived_at
    FROM workspaces w JOIN courses c ON c.workspace_id=w.id
    LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND c.id=${courseId}`;
  if (!row) throw learningError("NOT_FOUND", "course not found");
  const prefs = openingAdaptivePrefsSchema.safeParse(await readProjectedOpeningAdaptivePrefs(sql, scope, row.adaptive_planning ?? DEFAULT_OPENING_ADAPTIVE_PREFS));
  const settings = openingPlanningSettingsSchema.safeParse(row.planning_settings);
  return resolveSpanTutorAuthorization({ grant: prefs.success ? prefs.data.spanTutorGrants?.[courseId] ?? null : null,
    goalInactive: prefs.success && ["paused", "archived", "stopped"].includes(prefs.data.courseGoals[courseId]?.lifecycle ?? "active"),
    preferences: await readLearningPreferences(sql, scope, courseId), archived: row.archived_at != null,
    invalidPreferences: !prefs.success || (row.planning_settings != null && !settings.success),
    timeZone: resolveWorkspaceTimeZone(settings.success ? settings.data.timeZone : undefined),
    goalTargetDate: prefs.success ? prefs.data.courseGoals[courseId]?.targetDate ?? null : null, now });
}
/** The same history/workspace/course order protects new actions and preference changes. */
export async function lockSpanTutorAuthorization(tx: TransactionSql, scope: Scope, courseId: string,
  expectedRevision: number, now = new Date()): Promise<SpanTutorAuthorization & { grant: SpanTutorGrant }> {
  await lockWorkspaceLearningHistory(tx, scope);
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner.length) throw learningError("NOT_FOUND", "workspace not found");
  const course = await tx`SELECT id FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId} FOR SHARE`;
  if (!course.length) throw learningError("NOT_FOUND", "course not found");
  const current = await readSpanTutorAuthorization(tx, scope, courseId, now);
  if (!current.authorized || !current.grant || current.grant.revision !== expectedRevision) {
    throw learningError("CONFLICT", "导师试用授权或课程状态已变化，尚未新增安排；请重新读取后继续。");
  }
  return { ...current, grant: current.grant };
}
