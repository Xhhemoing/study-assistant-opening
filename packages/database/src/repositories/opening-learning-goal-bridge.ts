import { DEFAULT_OPENING_ADAPTIVE_PREFS, openingAdaptivePrefsSchema, type CourseGoalUpdate, type LearningGoalList,
  type OpeningAdaptivePrefs, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";
import { assertCourseMilestoneEvidence, mergeCourseGoal } from "./opening-course-milestones";
import { createLearningGoalInTx, projectLearningGoal, readLearningGoals, updateLearningGoalInTx } from "./opening-learning-goals";

/** Compatibility projection only. The returned goal definitions must never be persisted in preferences. */
export async function projectOpeningAdaptiveGoals(db: Sql | TransactionSql, scope: Scope, raw: OpeningAdaptivePrefs) {
  const goals = await readLearningGoals(db, scope);
  const courseGoals = { ...raw.courseGoals }, refs = { ...raw.courseGoalRefs };
  const conflicts: LearningGoalList["legacyConflicts"] = [];
  const courses = new Set([...Object.keys(courseGoals), ...Object.keys(refs), ...goals.flatMap(goal => goal.courseIds)]);
  for (const courseId of courses) {
    const candidates = goals.filter(goal => goal.courseIds.includes(courseId) && !["stopped", "archived"].includes(goal.lifecycle));
    const selected = refs[courseId] ? goals.find(goal => goal.id === refs[courseId] && goal.courseIds.includes(courseId)) : undefined;
    if (refs[courseId] && !selected) { delete courseGoals[courseId]; continue; }
    if (selected) { courseGoals[courseId] = projectLearningGoal(selected); continue; }
    if (raw.courseGoals[courseId]) {
      conflicts.push({ courseId, legacyGoal: raw.courseGoals[courseId]!, candidateGoalIds: candidates.map(goal => goal.id) });
      continue;
    }
    if (candidates.length === 1 && currentSelectionWasNeverCleared(raw, courseId)) {
      refs[courseId] = candidates[0]!.id;
      courseGoals[courseId] = projectLearningGoal(candidates[0]!);
    }
  }
  return { prefs: { ...raw, courseGoals, courseGoalRefs: refs }, goals, conflicts };
}
function currentSelectionWasNeverCleared(raw: OpeningAdaptivePrefs, courseId: string): boolean {
  return raw.courseGoalRevisions?.[courseId] === undefined;
}
export async function readProjectedOpeningAdaptivePrefs(db: Sql | TransactionSql, scope: Scope, stored?: unknown): Promise<OpeningAdaptivePrefs | null> {
  if (stored === undefined) {
    const [row] = await db`SELECT p.adaptive_planning FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
    if (!row) throw learningError("NOT_FOUND", "工作区不存在。");
    stored = row.adaptive_planning;
  }
  const parsed = openingAdaptivePrefsSchema.safeParse(stored ?? DEFAULT_OPENING_ADAPTIVE_PREFS);
  return parsed.success ? (await projectOpeningAdaptiveGoals(db, scope, parsed.data)).prefs : null;
}
/** Old writes are adapted once to the formal goal, under the caller's history/workspace lock. */
export async function writeOpeningCourseGoalInTx(tx: TransactionSql, scope: Scope, current: OpeningAdaptivePrefs,
  input: { courseId: string; goal: CourseGoalUpdate | null; expectedRevision?: number }): Promise<OpeningAdaptivePrefs> {
  const projected = await projectOpeningAdaptiveGoals(tx, scope, current), courseId = input.courseId;
  const selectedId = projected.prefs.courseGoalRefs?.[courseId];
  const previous = projected.prefs.courseGoals[courseId];
  const priorRevision = previous?.revision ?? current.courseGoalRevisions?.[courseId] ?? 0;
  if (input.expectedRevision !== undefined && input.expectedRevision !== priorRevision) throw learningError("CONFLICT", "课程目标已更新，请重新读取后保存。");
  if (!selectedId && projected.conflicts.some(item => item.courseId === courseId && item.candidateGoalIds.length)) {
    throw learningError("CONFLICT", "旧课程目标与正式目标需要明确选择，未覆盖任一目标。");
  }
  const next = { ...current, courseGoals: { ...current.courseGoals }, courseGoalRefs: { ...current.courseGoalRefs },
    courseGoalRevisions: { ...current.courseGoalRevisions } };
  if (input.goal === null) {
    if (priorRevision > 0 && input.expectedRevision === undefined) throw learningError("CONFLICT", "请先读取当前目标，再停止它。");
    if (selectedId) await updateLearningGoalInTx(tx, scope, { goalId: selectedId, expectedRevision: priorRevision, lifecycle: "stopped" });
    delete next.courseGoalRefs[courseId]; delete next.courseGoals[courseId];
    next.courseGoalRevisions[courseId] = priorRevision + 1;
    const grant = current.spanTutorGrants?.[courseId];
    if (grant?.enabled) next.spanTutorGrants = { ...current.spanTutorGrants, [courseId]: {
      ...grant, enabled: false, revision: grant.revision + 1, updatedAt: new Date().toISOString(),
    } };
    return next;
  }
  if (selectedId) {
    const updated = await updateLearningGoalInTx(tx, scope, { goalId: selectedId, expectedRevision: priorRevision,
      targetDate: input.goal.targetDate, weeklyMinutes: input.goal.weeklyMinutes,
      ...(input.goal.learningMode !== undefined ? { learningMode: input.goal.learningMode } : {}),
      ...(input.goal.priority !== undefined ? { priority: input.goal.priority } : {}),
      ...(input.goal.milestones !== undefined ? { milestones: input.goal.milestones } : {}) });
    next.courseGoalRefs[courseId] = updated.id; next.courseGoalRevisions[courseId] = updated.revision;
  } else {
    for (const milestone of input.goal.milestones ?? []) {
      await assertCourseMilestoneEvidence(tx, scope, courseId, milestone.evidenceRefs);
    }
    // The course tombstone CAS was checked above; a new formal goal starts its own milestone history.
    const merged = mergeCourseGoal(previous, input.goal, previous?.revision ?? 0, new Date().toISOString());
    const [course] = await tx`SELECT title FROM courses WHERE id=${courseId} AND workspace_id=${scope.workspaceId}`;
    if (!course) throw learningError("NOT_FOUND", "课程不存在。");
    const goal = await createLearningGoalInTx(tx, scope, { clientKey: `opening-goal:${courseId}:${priorRevision}`,
      courseIds: [courseId], title: `${String(course.title).slice(0, 140)}学习目标`, kind: "custom", targetDate: merged.targetDate,
      examDate: null, weeklyMinutes: merged.weeklyMinutes, priority: merged.priority ?? 0, learningMode: merged.learningMode ?? "auto", successCriteria: "" });
    const revision = priorRevision + 1;
    await tx`UPDATE course_goals SET revision=${revision},milestones=${tx.json(merged.milestones ?? [])},
      user_override=COALESCE(user_override,'{}'::jsonb) || ${tx.json({ openingLegacy: previous ?? null })}
      WHERE id=${goal.id} AND workspace_id=${scope.workspaceId}`;
    next.courseGoalRefs[courseId] = goal.id; next.courseGoalRevisions[courseId] = revision;
  }
  delete next.courseGoals[courseId];
  return next;
}
