import { DEFAULT_OPENING_ADAPTIVE_PREFS, learningGoalSelectSchema, openingAdaptivePrefsSchema,
  type LearningGoalCreate, type LearningGoalUpdate, type LearningGoalList, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { createLearningGoalInTx, readLearningGoal, updateLearningGoalInTx } from "./opening-learning-goals";
import { projectOpeningAdaptiveGoals } from "./opening-learning-goal-bridge";

async function preferences(db: Sql | TransactionSql, scope: Scope) {
  const [row] = await db`SELECT p.adaptive_planning FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
  if (!row) throw learningError("NOT_FOUND", "工作区不存在。");
  const parsed = openingAdaptivePrefsSchema.safeParse(row.adaptive_planning ?? DEFAULT_OPENING_ADAPTIVE_PREFS);
  if (!parsed.success) throw learningError("CONFLICT", "已保存的规划偏好无法读取，未覆盖原数据。");
  return parsed.data;
}
async function list(db: Sql | TransactionSql, scope: Scope, courseId?: string): Promise<LearningGoalList> {
  const { prefs, goals, conflicts } = await projectOpeningAdaptiveGoals(db, scope, await preferences(db, scope));
  return { goals: courseId ? goals.filter(goal => goal.courseIds.includes(courseId)) : goals,
    selectedGoalIds: Object.fromEntries(Object.entries(prefs.courseGoalRefs ?? {}).filter(([id]) => !courseId || id === courseId)),
    legacyConflicts: conflicts.filter(item => !courseId || item.courseId === courseId) };
}
export function createOpeningLearningGoalRepository(sql: Sql) {
  return {
    list: (scope: Scope, courseId?: string) => list(sql, scope, courseId),
    create: (scope: Scope, input: LearningGoalCreate) => sql.begin(async tx => {
      const goal = await createLearningGoalInTx(tx, scope, input);
      const current = await preferences(tx, scope), projected = await projectOpeningAdaptiveGoals(tx, scope, current);
      const refs = { ...current.courseGoalRefs };
      for (const courseId of goal.courseIds) {
        if (!refs[courseId] && !current.courseGoals[courseId] && projected.prefs.courseGoalRefs?.[courseId] === goal.id) refs[courseId] = goal.id;
      }
      await tx`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${scope.workspaceId},${tx.json({ ...current, courseGoalRefs: refs })})
        ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning,updated_at=now()`;
      return goal;
    }),
    update: (scope: Scope, goalId: string, input: LearningGoalUpdate) => sql.begin(tx => updateLearningGoalInTx(tx, scope, { ...input, goalId })),
    select: (scope: Scope, raw: unknown) => sql.begin(async tx => {
      const input = learningGoalSelectSchema.parse(raw);
      await lockWorkspaceLearningHistory(tx, scope);
      await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
      const current = await preferences(tx, scope), projected = await projectOpeningAdaptiveGoals(tx, scope, current);
      const selected = projected.prefs.courseGoalRefs?.[input.courseId] ?? null;
      const goal = await readLearningGoal(tx, scope, input.goalId);
      if (!goal || !goal.courseIds.includes(input.courseId)) throw learningError("NOT_FOUND", "目标不属于此课程。");
      if (goal.revision !== input.expectedRevision) throw learningError("CONFLICT", "目标已更新，请重新读取。");
      if (["stopped", "archived"].includes(goal.lifecycle)) throw learningError("CONFLICT", "请先恢复目标，再选择它。");
      const legacy = current.courseGoals[input.courseId];
      if (selected === input.goalId && !legacy) return list(tx, scope, input.courseId);
      if (selected !== input.expectedSelectedGoalId) throw learningError("CONFLICT", "课程所选目标已变化，请重新读取。");
      if (legacy && !input.resolveLegacy) throw learningError("CONFLICT", "请选择如何处理旧课程目标，未覆盖原数据。");
      if (legacy) await tx`UPDATE course_goals SET definition_history=definition_history || ${tx.json([
        { legacyCourseId: input.courseId, legacyGoal: legacy, selectedAt: new Date().toISOString() },
      ])} WHERE id=${goal.id} AND workspace_id=${scope.workspaceId}`;
      const next = { ...current, courseGoals: { ...current.courseGoals }, courseGoalRefs: { ...current.courseGoalRefs, [input.courseId]: goal.id } };
      delete next.courseGoals[input.courseId];
      await tx`INSERT INTO workspace_preferences(workspace_id,adaptive_planning) VALUES(${scope.workspaceId},${tx.json(next)})
        ON CONFLICT(workspace_id) DO UPDATE SET adaptive_planning=EXCLUDED.adaptive_planning,updated_at=now()`;
      return list(tx, scope, input.courseId);
    }),
  };
}
