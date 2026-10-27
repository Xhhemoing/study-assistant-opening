import { learningActivityBudgetSchema, learningManagementSettingsSchema, openingPlanningSettingsSchema, plannedBlockSchema, type Scope } from "@aistudy/contracts";
import { localDateKeyInZone, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { calculateSpanTutorBudgetUsage } from "./opening-learning-capacity-usage";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
/** Stored activity references carry reservations, not a second budget ledger. */
export function normalizeLearningCapacityActivities(rows: Row[]): Row[] {
  return rows.flatMap(row => {
    const goal = object(row.goal_json), intent = object(row.create_intent), card = object(object(row.checkpoint_json).cardReviewSession);
    if (intent.legacy && !goal.learningBudget && !goal.tutorBudget && !goal.sessionMinutes) return [];
    const saved = object(goal.learningBudget);
    if (!Object.keys(saved).length) return [row];
    const minutes = card.stoppedAt ? Number(card.elapsedSeconds) / 60 : saved.minutes;
    if (minutes === 0 && card.stoppedAt) return [];
    return [{ ...row, goal_json: { ...goal, learningBudget: { ...saved, minutes } } }];
  });
}
export async function readOpeningLearningCapacity(db: Sql | TransactionSql, scope: Scope, targetAt = new Date(), excludeActivityId?: string) {
  const [row] = await db`SELECT p.learning_management,p.planning_settings FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
  if (!row) throw learningError("NOT_FOUND", "工作区不存在。");
  const budget = row.learning_management == null ? null : learningManagementSettingsSchema.parse(row.learning_management);
  const settings = row.planning_settings == null ? null : openingPlanningSettingsSchema.parse(row.planning_settings);
  const timeZone = resolveWorkspaceTimeZone(settings?.timeZone), localDate = localDateKeyInZone(targetAt, timeZone), bounds = resolveLocalDayBounds(localDate, timeZone);
  const activities = await db`SELECT id,course_id,status,created_at,create_intent,checkpoint_json,goal_json FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND (${excludeActivityId ?? null}::uuid IS NULL OR id<>${excludeActivityId ?? null}::uuid)
      AND ((created_at>=${bounds.dayStart} AND created_at<${bounds.nextDayStart}) OR goal_json ? 'tutorBudget' OR goal_json ? 'learningBudget')
      AND (create_intent->>'protocol' IN ('span-lesson-v1','card-review-session-v1','course-route-v1') OR goal_json ? 'learningBudget' OR goal_json ? 'tutorBudget' OR goal_json ? 'sessionMinutes')`;
  const tasks = await db`SELECT t.*,r.id AS retest_id,r.candidate_id,r.candidate_reference_id,r.scheduled_start_at,r.recommended_at,r.not_before_at,r.snoozed_until,r.learning_protocol
    FROM opening_tasks t LEFT JOIN opening_retest_activities r ON r.task_id=t.id AND r.workspace_id=t.workspace_id AND r.owner_user_id=t.owner_user_id
    WHERE t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId} AND t.status IN ('pending','done')`;
  const plans = await db`SELECT accepted_blocks FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND accepted_version>0
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(accepted_blocks) b WHERE (b->>'start')::timestamptz<${bounds.nextDayStart} AND (b->>'end')::timestamptz>${bounds.dayStart})`;
  const blocks = plans.flatMap(plan => plannedBlockSchema.array().max(200).parse(plan.accepted_blocks));
  const normalized = normalizeLearningCapacityActivities(activities);
  const usedMinutes = calculateSpanTutorBudgetUsage({ localDate, timeZone }, normalized, tasks, blocks);
  return { budget, settings, localDate, timeZone, bounds, activities: normalized, tasks, blocks, usedMinutes };
}
export async function assertOpeningWorkspaceCapacity(tx: TransactionSql, scope: Scope, input: { minutes: number; targetAt?: Date; activityId?: string }, now = new Date()) {
  await lockWorkspaceLearningHistory(tx, scope);
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner.length) throw learningError("NOT_FOUND", "工作区不存在。");
  const state = await readOpeningLearningCapacity(tx, scope, input.targetAt ?? now, input.activityId);
  if (!Number.isFinite(input.minutes) || input.minutes <= 0) throw learningError("VALIDATION", "请指定本次真实学习时长。");
  const activities = input.activityId ? state.activities.filter(row => row.id !== input.activityId) : state.activities;
  const used = calculateSpanTutorBudgetUsage(state, activities, state.tasks, state.blocks);
  // A task-linked activity replaces that task's reservation rather than charging it again.
  const [activity] = input.activityId ? await tx`SELECT create_intent,checkpoint_json,goal_json,course_id FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}` : [];
  const intent = object(activity?.create_intent), checkpoint = object(object(activity?.checkpoint_json).spanLesson);
  const linked = intent.taskId ?? (checkpoint.retestId ? state.tasks.find(task => [task.retest_id, task.candidate_id, task.candidate_reference_id].includes(checkpoint.retestId))?.id : undefined);
  const withoutLinked = linked ? calculateSpanTutorBudgetUsage(state, activities.filter(row => object(row.create_intent).taskId !== linked), state.tasks.filter(task => task.id !== linked), state.blocks.filter(block => block.taskId !== linked)) : used;
  const recoveryId = object(object(activity?.goal_json).recovery).activityId;
  const withoutRecovery = recoveryId ? calculateSpanTutorBudgetUsage(state, activities.filter(row => row.id !== recoveryId || row.course_id !== activity?.course_id), state.tasks, state.blocks) : used;
  const proposed = used + Math.max(0, input.minutes - Math.max(used - withoutLinked, used - withoutRecovery));
  if (state.budget && proposed > state.budget.dailyMinutes - state.budget.bufferMinutes) throw learningError("CONFLICT", `工作区 ${state.localDate} 已占用 ${used} 分钟；共同预算不足，请缩短本次或调整未执行安排。`);
  return state;
}
export async function reserveOpeningLearningActivityBudget(tx: TransactionSql, scope: Scope, input: { activityId: string; minutes: number; goalId?: string; expectedGoalRevision?: number }, now = new Date()) {
  const [prior] = await tx`SELECT goal_json FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!prior) throw learningError("NOT_FOUND", "学习活动不存在。");
  const stored = object(prior.goal_json).learningBudget;
  if (stored) {
    const parsed = learningActivityBudgetSchema.parse(stored);
    if (parsed.minutes !== input.minutes || parsed.goalId !== input.goalId) throw learningError("CONFLICT", "原活动的时长或目标已改变，请恢复原请求。");
    return parsed;
  }
  const state = await assertOpeningWorkspaceCapacity(tx, scope, input, now);
  const reservation = { localDate: state.localDate, timeZone: state.timeZone, minutes: input.minutes,
    ...(state.budget ? { budgetRevision: state.budget.revision } : {}), ...(input.goalId ? { goalId: input.goalId, goalRevision: input.expectedGoalRevision } : {}) };
  await tx`UPDATE opening_teaching_activities SET goal_json=goal_json || ${tx.json({ learningBudget: reservation })} WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return reservation;
}
