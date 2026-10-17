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
import { assertCourseMilestoneEvidence, mergeCourseGoal } from "./opening-course-milestones";
import { OpeningPlanError } from "./opening-plan-error";

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
      return readStored(rows[0]!.adaptive_planning);
    },

    /** Merges under the workspace row lock; unreadable stored data is never overwritten. */
    async patch(scope: Scope, raw: OpeningAdaptivePrefsPatch): Promise<OpeningAdaptivePrefsResponse> {
      const patch = openingAdaptivePrefsPatchSchema.parse(raw);
      return sql.begin(async (tx) => {
        const owner = await tx`SELECT id FROM workspaces WHERE id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new WorkspacePreferencesError("NOT_FOUND", "Workspace not found");
        const rows = await tx`SELECT adaptive_planning FROM workspace_preferences
          WHERE workspace_id = ${scope.workspaceId}`;
        const stored = readStored(rows[0]?.adaptive_planning);
        if (stored.invalidStoredPrefs) throw new OpeningPlanError("CONFLICT", "已保存的规划偏好无法读取，未修改任何数据。");
        const current = stored.prefs;
        const next: OpeningAdaptivePrefs = {
          autonomy: patch.autonomy ?? current.autonomy,
          coachBudgetMinutes: patch.coachBudgetMinutes ?? current.coachBudgetMinutes,
          ...(patch.coachAutoAcceptEnabled !== undefined || current.coachAutoAcceptEnabled !== undefined
            ? { coachAutoAcceptEnabled: patch.coachAutoAcceptEnabled ?? current.coachAutoAcceptEnabled } : {}),
          courseGoals: { ...current.courseGoals },
          ...(current.courseGoalRevisions ? { courseGoalRevisions: { ...current.courseGoalRevisions } } : {}),
        };
        if (patch.courseGoal) {
          const { courseId, goal, expectedRevision } = patch.courseGoal;
          const previous = current.courseGoals[courseId];
          const previousRevision = current.courseGoalRevisions?.[courseId] ?? previous?.revision ?? 0;
          if (expectedRevision !== undefined && expectedRevision !== previousRevision) {
            throw new OpeningPlanError("CONFLICT", "课程目标已更新，请重新读取后再保存。");
          }
          if (goal === null) {
            if (previousRevision > 0 && expectedRevision === undefined) {
              throw new OpeningPlanError("CONFLICT", "清除阶段成果需要先读取当前课程目标。");
            }
            delete next.courseGoals[courseId];
            if (previousRevision > 0) next.courseGoalRevisions = { ...next.courseGoalRevisions, [courseId]: previousRevision + 1 };
          } else {
            const course = await tx`SELECT 1 FROM courses
              WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL`;
            if (!course.length) throw new WorkspacePreferencesError("NOT_FOUND", "Course not found");
            for (const milestone of goal.milestones ?? []) {
              const known = previous?.milestones?.find(item => item.id === milestone.id);
              const refs = milestone.confirm ? milestone.evidenceRefs : milestone.evidenceRefs.filter(ref =>
                !known?.evidenceRefs.some(existing => existing.id === ref.id && existing.kind === ref.kind));
              await assertCourseMilestoneEvidence(tx, scope, courseId, refs);
            }
            const prior = previous ?? (previousRevision > 0 ? { targetDate: goal.targetDate, weeklyMinutes: goal.weeklyMinutes, revision: previousRevision } : undefined);
            const saved = mergeCourseGoal(prior, goal, expectedRevision, new Date().toISOString());
            next.courseGoals[courseId] = saved;
            if (saved.revision !== undefined) next.courseGoalRevisions = { ...next.courseGoalRevisions, [courseId]: saved.revision };
          }
        }
        const value = openingAdaptivePrefsSchema.parse(next);
        await tx`INSERT INTO workspace_preferences (workspace_id, adaptive_planning)
          VALUES (${scope.workspaceId}, ${tx.json(value as never)})
          ON CONFLICT (workspace_id) DO UPDATE SET adaptive_planning = EXCLUDED.adaptive_planning, updated_at = now()`;
        return { prefs: value, saved: true, invalidStoredPrefs: false };
      });
    },
  };
}

export type OpeningAdaptivePrefsRepository = ReturnType<typeof createOpeningAdaptivePrefsRepository>;
