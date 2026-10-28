import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";
import { openingAdaptivePrefsSchema, type CourseGoal, type Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { learningError, learningIso } from "./opening-learning-facts";

export type OpeningTodayCourse = { id: string; title: string; archivedAt: string | null;
  targetDate?: CourseGoal["targetDate"]; weeklyMinutes?: number; learningMode?: CourseGoal["learningMode"] };

/** Includes archived courses: no active course does not mean the learner has never created one. */
export async function readOpeningTodayCourses(sql: Sql, scope: Scope): Promise<OpeningTodayCourse[]> {
  const rows = await sql`SELECT c.id,c.title,c.archived_at,p.adaptive_planning FROM workspaces w
    LEFT JOIN courses c ON c.workspace_id=w.id
    LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
    ORDER BY c.title,c.id`;
  if (!rows.length) throw learningError("NOT_FOUND", "workspace not found");
  const parsed = openingAdaptivePrefsSchema.safeParse(await readProjectedOpeningAdaptivePrefs(sql, scope, rows[0]?.adaptive_planning));
  return rows.flatMap(row => {
    if (row.id == null) return [];
    const id = String(row.id);
    const goal = parsed.success ? parsed.data.courseGoals[id] : undefined;
    return [{ id, title: String(row.title), archivedAt: learningIso(row.archived_at),
      ...(goal ? { targetDate: goal.targetDate, weeklyMinutes: goal.weeklyMinutes,
        ...(goal.learningMode ? { learningMode: goal.learningMode } : {}) } : {}) }];
  });
}
