import {
  DEFAULT_OPENING_ADAPTIVE_PREFS,
  openingAdaptivePrefsPatchSchema,
  openingAdaptivePrefsSchema,
  type OpeningAdaptivePrefs,
  type OpeningAdaptivePrefsPatch,
  type OpeningAdaptivePrefsResponse,
  type Scope,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import { WorkspacePreferencesError } from "./preferences";
import { projectOpeningAdaptiveGoals, writeOpeningCourseGoalInTx } from "./opening-learning-goal-bridge";
import { OpeningPlanError } from "./opening-plan-error";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";

function readStored(stored: unknown): OpeningAdaptivePrefsResponse {
  if (stored == null) return { prefs: DEFAULT_OPENING_ADAPTIVE_PREFS, saved: false, invalidStoredPrefs: false };
  const parsed = openingAdaptivePrefsSchema.safeParse(stored);
  return parsed.success
    ? { prefs: parsed.data, saved: true, invalidStoredPrefs: false }
    : { prefs: DEFAULT_OPENING_ADAPTIVE_PREFS, saved: true, invalidStoredPrefs: true };
}

/** workspace_preferences.adaptive_planning (0061): autonomy mode, coach budget, course goals. */
export function createOpeningAdaptivePrefsRepository(sql: Sql) {
  return {
    async get(scope: Scope): Promise<OpeningAdaptivePrefsResponse> {
      const rows = await sql`SELECT p.adaptive_planning FROM workspaces w
        LEFT JOIN workspace_preferences p ON p.workspace_id = w.id
        WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId}`;
      if (!rows.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
      const stored = readStored(rows[0]!.adaptive_planning);
      return stored.invalidStoredPrefs ? stored : { ...stored, prefs: (await projectOpeningAdaptiveGoals(sql, scope, stored.prefs)).prefs };
    },

    /** Merges under the workspace row lock; unreadable stored data is never overwritten. */
    async patch(scope: Scope, raw: OpeningAdaptivePrefsPatch): Promise<OpeningAdaptivePrefsResponse> {
      const patch = openingAdaptivePrefsPatchSchema.parse(raw);
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const owner = await tx`SELECT id FROM workspaces WHERE id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        const rows = await tx`SELECT adaptive_planning FROM workspace_preferences
          WHERE workspace_id = ${scope.workspaceId}`;
        const stored = readStored(rows[0]?.adaptive_planning);
        if (stored.invalidStoredPrefs) throw new OpeningPlanError("CONFLICT", "已保存的规划偏好无法读取，未修改任何数据。");
        const current = stored.prefs;
        let next: OpeningAdaptivePrefs = {
          autonomy: patch.autonomy ?? current.autonomy,
          coachBudgetMinutes: patch.coachBudgetMinutes ?? current.coachBudgetMinutes,
          ...(patch.coachAutoAcceptEnabled !== undefined || current.coachAutoAcceptEnabled !== undefined
            ? { coachAutoAcceptEnabled: patch.coachAutoAcceptEnabled ?? current.coachAutoAcceptEnabled } : {}),
          courseGoals: { ...current.courseGoals },
          ...(current.courseGoalRefs ? { courseGoalRefs: { ...current.courseGoalRefs } } : {}),
          ...(current.courseGoalRevisions ? { courseGoalRevisions: { ...current.courseGoalRevisions } } : {}),
          ...(current.spanTutorGrants ? { spanTutorGrants: { ...current.spanTutorGrants } } : {}),
        };
        if (patch.spanTutorGrant) {
          const { courseId, enabled, dailyMinutes, expiresOn, expectedRevision } = patch.spanTutorGrant;
          const [course] = await tx`SELECT archived_at FROM courses WHERE id=${courseId}
            AND workspace_id=${scope.workspaceId} FOR SHARE`;
          if (!course) throw new WorkspacePreferencesError("NOT_FOUND", "Course not found");
          const previous = current.spanTutorGrants?.[courseId];
          if (expectedRevision !== (previous?.revision ?? 0)) {
            throw new OpeningPlanError("CONFLICT", "导师授权已变化，请重新读取后再确认。");
          }
          if (enabled && course.archived_at != null) throw new OpeningPlanError("CONFLICT", "归档课程不能开启导师试用。");
          const now = new Date().toISOString();
          next.spanTutorGrants = { ...current.spanTutorGrants, [courseId]: {
            enabled, dailyMinutes, expiresOn, revision: expectedRevision + 1,
            confirmedAt: enabled ? now : previous?.confirmedAt ?? now, updatedAt: now,
          } };
        }
        if (patch.courseGoal) next = await writeOpeningCourseGoalInTx(tx, scope, next, patch.courseGoal);
        const value = openingAdaptivePrefsSchema.parse(next);
        await tx`INSERT INTO workspace_preferences (workspace_id, adaptive_planning)
          VALUES (${scope.workspaceId}, ${tx.json(value as never)})
          ON CONFLICT (workspace_id) DO UPDATE SET adaptive_planning = EXCLUDED.adaptive_planning, updated_at = now()`;
        return { prefs: (await projectOpeningAdaptiveGoals(tx, scope, value)).prefs, saved: true, invalidStoredPrefs: false };
      });
    },
  };
}

export type OpeningAdaptivePrefsRepository = ReturnType<typeof createOpeningAdaptivePrefsRepository>;
