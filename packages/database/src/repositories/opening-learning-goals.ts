import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { learningGoalCreateSchema, learningGoalSchema, learningGoalUpdateSchema,
  type LearningGoal, type LearningGoalCreate, type LearningGoalUpdate, type Scope } from "@aistudy/contracts";
import { defaultGoalAbilities } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError, learningIso, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { assertCourseMilestoneEvidence, mergeCourseGoal } from "./opening-course-milestones";

type Db = Sql | TransactionSql;
const date = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
function mapGoal(row: Record<string, unknown>): LearningGoal {
  return learningGoalSchema.parse({ id: row.id, workspaceId: row.workspace_id, courseIds: row.course_ids,
    title: row.title, kind: row.kind, targetDate: date(row.target_date), examDate: date(row.exam_date),
    weeklyMinutes: Number(row.weekly_minutes), priority: Number(row.priority), learningMode: row.learning_mode,
    successCriteria: row.success_criteria, revision: Number(row.revision), lifecycle: row.lifecycle,
    maintenanceIntervalDays: row.maintenance_interval_days == null ? null : Number(row.maintenance_interval_days),
    milestones: row.milestones, createdAt: learningIso(row.created_at), updatedAt: learningIso(row.updated_at) });
}
export async function readLearningGoals(db: Db, scope: Scope, courseId?: string): Promise<LearningGoal[]> {
  const rows = await db`SELECT g.*,ARRAY(SELECT DISTINCT course_id FROM (
      SELECT g.course_id UNION ALL SELECT l.course_id FROM course_goal_links l WHERE l.workspace_id=g.workspace_id AND l.goal_id=g.id
    ) linked ORDER BY course_id) AS course_ids
    FROM course_goals g JOIN workspaces w ON w.id=g.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE g.workspace_id=${scope.workspaceId} AND (${courseId ?? null}::uuid IS NULL OR g.course_id=${courseId ?? null}::uuid
      OR EXISTS(SELECT 1 FROM course_goal_links l WHERE l.workspace_id=g.workspace_id AND l.goal_id=g.id AND l.course_id=${courseId ?? null}::uuid))
    ORDER BY g.priority DESC,g.created_at,g.id`;
  return rows.map(mapGoal);
}
export async function readLearningGoal(db: Db, scope: Scope, goalId: string): Promise<LearningGoal | null> {
  const [row] = await db`SELECT g.*,ARRAY(SELECT DISTINCT course_id FROM (
      SELECT g.course_id UNION ALL SELECT l.course_id FROM course_goal_links l WHERE l.workspace_id=g.workspace_id AND l.goal_id=g.id
    ) linked ORDER BY course_id) AS course_ids FROM course_goals g JOIN workspaces w ON w.id=g.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE g.workspace_id=${scope.workspaceId} AND g.id=${goalId}`;
  return row ? mapGoal(row) : null;
}
async function lockOwner(tx: TransactionSql, scope: Scope) {
  await lockWorkspaceLearningHistory(tx, scope);
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner.length) throw learningError("NOT_FOUND", "工作区不存在。");
}
async function assertCourses(tx: TransactionSql, scope: Scope, ids: string[], allowArchived = false) {
  const rows = await tx`SELECT id,archived_at FROM courses WHERE workspace_id=${scope.workspaceId} AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  if (rows.length !== ids.length) throw learningError("NOT_FOUND", "目标包含不属于当前工作区的课程。");
  if (!allowArchived && rows.some(row => row.archived_at != null)) throw learningError("CONFLICT", "请先恢复归档课程，再为它安排学习。");
}
export function projectLearningGoal(goal: LearningGoal) {
  return { goalId: goal.id, targetDate: goal.targetDate, weeklyMinutes: goal.weeklyMinutes, learningMode: goal.learningMode,
    priority: goal.priority, revision: goal.revision, milestones: goal.milestones, kind: goal.kind, examDate: goal.examDate,
    lifecycle: goal.lifecycle, successCriteria: goal.successCriteria };
}
export async function createLearningGoalInTx(tx: TransactionSql, scope: Scope, raw: LearningGoalCreate): Promise<LearningGoal> {
  const input = learningGoalCreateSchema.parse(raw);
  input.courseIds = [...input.courseIds].sort();
  await lockOwner(tx, scope);
  const [old] = await tx`SELECT id,create_intent FROM course_goals WHERE workspace_id=${scope.workspaceId} AND client_key=${input.clientKey}`;
  if (old) {
    if (!isDeepStrictEqual(old.create_intent, input)) throw learningError("CONFLICT", "同一次目标创建请求的内容已改变。");
    return (await readLearningGoal(tx, scope, String(old.id)))!;
  }
  await assertCourses(tx, scope, input.courseIds);
  const id = randomUUID();
  await tx`INSERT INTO course_goals(id,workspace_id,course_id,kind,title,priority,intensity,abilities,strategy_version,
      target_date,exam_date,weekly_minutes,learning_mode,success_criteria,client_key,create_intent)
    VALUES(${id},${scope.workspaceId},${input.courseIds[0]!},${input.kind},${input.title},${input.priority},0.5,
      ${tx.json(defaultGoalAbilities(input.kind))},'effective-req-1',${input.targetDate},${input.examDate},${input.weeklyMinutes},
      ${input.learningMode},${input.successCriteria},${input.clientKey},${tx.json(input)})`;
  for (const courseId of input.courseIds) await tx`INSERT INTO course_goal_links(workspace_id,goal_id,course_id) VALUES(${scope.workspaceId},${id},${courseId})`;
  return (await readLearningGoal(tx, scope, id))!;
}
export async function updateLearningGoalInTx(tx: TransactionSql, scope: Scope, input: LearningGoalUpdate & { goalId: string }): Promise<LearningGoal> {
  const { goalId, ...raw } = input, patch = learningGoalUpdateSchema.parse(raw);
  await lockOwner(tx, scope);
  const current = await readLearningGoal(tx, scope, goalId);
  if (!current) throw learningError("NOT_FOUND", "目标不存在。");
  if (patch.expectedRevision !== current.revision) {
    const [receipt] = await tx`SELECT definition_history->-1 AS previous FROM course_goals WHERE id=${goalId} AND workspace_id=${scope.workspaceId}`;
    if (current.revision === patch.expectedRevision + 1 && isDeepStrictEqual(receipt?.previous?.appliedUpdate, patch)) return current;
    throw learningError("CONFLICT", "目标已更新，请重新读取后选择。");
  }
  const next = { ...current, ...patch, courseIds: patch.courseIds ? [...patch.courseIds].sort() : current.courseIds };
  if (next.examDate && !["final-exam", "entrance-exam"].includes(next.kind)) throw learningError("VALIDATION", "只有考试目标可以设置考试日期；普通期限请用目标截止日期。");
  await assertCourses(tx, scope, next.courseIds, true);
  const addedCourses = next.courseIds.filter(id => !current.courseIds.includes(id));
  if (addedCourses.length && ["active", "maintenance", "reduced"].includes(next.lifecycle)) await assertCourses(tx, scope, addedCourses);
  if (patch.milestones || patch.courseIds) {
    // Existing milestone evidence is course-scoped; a cross-course goal cannot borrow an unrelated record.
    for (const milestone of patch.milestones ?? current.milestones) for (const ref of milestone.evidenceRefs) {
      const table = ref.kind === "attempt" ? "opening_learning_attempts" : ref.kind === "observation" ? "opening_learning_observations" : "opening_teaching_activities";
      const [record] = await tx`SELECT course_id FROM ${tx(table)} WHERE id=${ref.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (!record || !next.courseIds.includes(String(record.course_id))) throw learningError("NOT_FOUND", "成果记录不属于目标关联的课程。");
      await assertCourseMilestoneEvidence(tx, scope, String(record.course_id), [ref]);
    }
  }
  if (patch.milestones) {
    next.milestones = mergeCourseGoal(projectLearningGoal(current), { targetDate: next.targetDate, weeklyMinutes: next.weeklyMinutes,
      learningMode: next.learningMode, priority: next.priority, milestones: patch.milestones }, current.revision, new Date().toISOString()).milestones ?? [];
  }
  if (patch.courseIds) {
    const removed = current.courseIds.filter(id => !next.courseIds.includes(id));
    const used = removed.length ? await tx`SELECT id FROM course_requirements WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND course_id=ANY(${removed}::uuid[]) AND lifecycle='active' AND ${goalId}::uuid=ANY(goal_ids) LIMIT 1` : [];
    if (used.length) throw learningError("CONFLICT", "请先调整课程要求与该目标的关联，再移除课程；已有活动保留。");
    if (removed.length) await tx`UPDATE workspace_preferences SET adaptive_planning=jsonb_set(adaptive_planning,'{courseGoalRefs}',
      COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(COALESCE(adaptive_planning->'courseGoalRefs','{}'::jsonb))
        WHERE NOT(key=ANY(${removed}::text[]) AND value=to_jsonb(${goalId}::text))),'{}'::jsonb)),updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND adaptive_planning IS NOT NULL`;
  }
  const active = ["active", "maintenance", "reduced"].includes(next.lifecycle);
  const history = { ...current, changedAt: new Date().toISOString(), appliedUpdate: patch };
  await tx`UPDATE course_goals SET title=${next.title},kind=${next.kind},priority=${next.priority},target_date=${next.targetDate},
    exam_date=${next.examDate},weekly_minutes=${next.weeklyMinutes},learning_mode=${next.learningMode},success_criteria=${next.successCriteria},
    revision=revision+1,lifecycle=${next.lifecycle},maintenance_interval_days=${next.maintenanceIntervalDays},milestones=${tx.json(next.milestones)},
    active=${active},archived_at=CASE WHEN ${next.lifecycle}='archived' THEN COALESCE(archived_at,now()) ELSE NULL END,
    course_id=${next.courseIds[0]!},definition_history=definition_history || ${tx.json([history])},updated_at=now()
    WHERE id=${goalId} AND workspace_id=${scope.workspaceId}`;
  await tx`DELETE FROM course_goal_links WHERE goal_id=${goalId} AND workspace_id=${scope.workspaceId}`;
  for (const courseId of next.courseIds) await tx`INSERT INTO course_goal_links(workspace_id,goal_id,course_id) VALUES(${scope.workspaceId},${goalId},${courseId})`;
  return (await readLearningGoal(tx, scope, goalId))!;
}
/** New actions recheck the goal inside their existing transaction; historical reads stay available. */
export async function assertLearningGoalAction(tx: TransactionSql, scope: Scope, goalId: string, expectedRevision: number): Promise<LearningGoal> {
  await lockOwner(tx, scope);
  const goal = await readLearningGoal(tx, scope, goalId);
  if (!goal) throw learningError("NOT_FOUND", "目标不存在。");
  if (goal.revision !== expectedRevision || !["active", "maintenance", "reduced"].includes(goal.lifecycle)) {
    throw learningError("CONFLICT", "目标或学习状态已变化，请重新读取；已有活动和记录保留。");
  }
  // Each action checks its actual course. An archived linked course must not block another active course.
  await assertCourses(tx, scope, goal.courseIds, true);
  return goal;
}
