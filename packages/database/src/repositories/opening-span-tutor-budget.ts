import { calculateSpanTutorBudgetUsage } from "./opening-learning-capacity-usage";
import { readUnusedStaleCourseRouteReservations } from "./opening-course-route-reservations";
import { assertOpeningWorkspaceCapacity, normalizeLearningCapacityActivities } from "./opening-learning-capacity";
export { calculateSpanTutorBudgetUsage } from "./opening-learning-capacity-usage";
import { controlledLearningToolPermission, spanTutorAutomationSchema, spanTutorBudgetSchema, plannedBlockSchema, openingAdaptivePrefsSchema,
  type Scope, type SpanTutorBudget } from "@aistudy/contracts";
import { localDateKeyInZone, resolveLocalDayBounds, SPAN_REQUIREMENT_KEY, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { lockSpanTutorAuthorization } from "./opening-span-tutor-grant";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const conflict = (message: string) => learningError("CONFLICT", message);
async function assertBudget(tx: TransactionSql, scope: Scope, input: { courseId: string; minutes: number;
  expectedGrantRevision: number; targetAt: Date; excludeActivityId?: string }, now: Date): Promise<SpanTutorBudget> {
  await lockWorkspaceLearningHistory(tx, scope);
  const authorization = await lockSpanTutorAuthorization(tx, scope, input.courseId, input.expectedGrantRevision, now);
  if (controlledLearningToolPermission(input.excludeActivityId ? "next_question" : "schedule_retest",
    { enabled: true, authorized: authorization.authorized }) !== "automatic") throw conflict("导师工具尚未授权。");
  if (!authorization.authorized || !authorization.grant) throw conflict(`导师自动安排已停止：${authorization.reason}。请核对课程授权，或手动安排。`);
  const localDate = localDateKeyInZone(input.targetAt, authorization.timeZone);
  if ((authorization.grant.expiresOn && localDate > authorization.grant.expiresOn)
    || (authorization.goalTargetDate && localDate > authorization.goalTargetDate)) throw conflict("复测日期已超过课程授权或目标日期，请先调整目标或手动安排。");
  if (input.targetAt.getTime() < now.getTime() && localDate !== localDateKeyInZone(now, authorization.timeZone)) throw conflict("复测目标日已过去，请手动确认新的安排。");
  const reservation = spanTutorBudgetSchema.parse({ localDate, timeZone: authorization.timeZone, minutes: input.minutes, grantRevision: authorization.grant.revision });
  await assertOpeningWorkspaceCapacity(tx, scope, { minutes: input.minutes, targetAt: input.targetAt, activityId: input.excludeActivityId }, now);
  const bounds = resolveLocalDayBounds(localDate, reservation.timeZone);
  const activities = await tx`SELECT id,created_at,create_intent,checkpoint_json,goal_json FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND ((created_at>=${bounds.dayStart} AND created_at<${bounds.nextDayStart}) OR goal_json ? 'tutorBudget')`;
  const tasks = await tx`SELECT t.*,r.id AS retest_id,r.candidate_id,r.candidate_reference_id,r.scheduled_start_at,r.recommended_at,r.not_before_at,r.snoozed_until,r.learning_protocol
    FROM opening_tasks t LEFT JOIN opening_retest_activities r ON r.task_id=t.id AND r.workspace_id=t.workspace_id AND r.owner_user_id=t.owner_user_id
    WHERE t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId} AND t.status IN ('pending','done')`;
  const [plan] = await tx`SELECT accepted_blocks FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${localDate}::date AND accepted_version>0`;
  const blocks = plannedBlockSchema.array().max(200).safeParse(plan?.accepted_blocks ?? []);
  if (!blocks.success) throw conflict("已接受的学习安排无法读取，请先核对今日安排。");
  const requestedActivities = input.excludeActivityId ? activities.map(activity => activity.id === input.excludeActivityId
    ? { ...activity, goal_json: { ...object(activity.goal_json), tutorBudget: reservation } } : activity) : activities;
  if (input.excludeActivityId && !requestedActivities.some(activity => activity.id === input.excludeActivityId)) throw conflict("导师活动不在当前预算日，请恢复原活动。");
  const released = new Set((await readUnusedStaleCourseRouteReservations(tx, scope)).map(row => String(row.id)));
  const budgetActivities = requestedActivities.filter(activity => !released.has(String(activity.id)));
  const used = calculateSpanTutorBudgetUsage(reservation, normalizeLearningCapacityActivities(budgetActivities), tasks, blocks.data);
  const requestedMinutes = input.excludeActivityId ? 0 : input.minutes;
  const [preferences] = await tx`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const adaptive = openingAdaptivePrefsSchema.safeParse(preferences?.adaptive_planning);
  const limit = adaptive.success && adaptive.data.autonomy === "coach" && adaptive.data.coachAutoAcceptEnabled === true
    ? Math.min(authorization.grant.dailyMinutes, adaptive.data.coachBudgetMinutes) : authorization.grant.dailyMinutes;
  if (used + requestedMinutes > limit) throw conflict(`目标日 ${localDate} 已占用 ${used} 分钟；${limit} 分钟预算不足，请缩短本次活动、调整安排或手动接受复测。`);
  return reservation;
}

/** Caller owns the session transaction; storing this reference reserves no second ledger. */
export async function reserveSpanTutorActivityBudget(tx: TransactionSql, scope: Scope,
  input: { courseId: string; activityId: string; minutes: number; expectedGrantRevision: number }, now = new Date()): Promise<SpanTutorBudget> {
  const reservation = await assertBudget(tx, scope, { ...input, targetAt: now, excludeActivityId: input.activityId }, now);
  const [activity] = await tx`SELECT goal_json,course_id FROM opening_teaching_activities WHERE id=${input.activityId}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!activity || activity.course_id !== input.courseId) throw conflict("导师活动归属已变化，未保存预算。");
  const prior = object(activity.goal_json).tutorBudget;
  if (prior != null) {
    const parsed = spanTutorBudgetSchema.safeParse(prior);
    if (!parsed.success || parsed.data.minutes !== input.minutes || parsed.data.grantRevision !== input.expectedGrantRevision) throw conflict("导师活动的预算请求已变化，请恢复原活动。");
    return parsed.data;
  }
  await tx`UPDATE opening_teaching_activities SET goal_json=goal_json || ${tx.json({ tutorBudget: reservation })},updated_at=now()
    WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  return reservation;
}

/** No write here: the caller stores this in the original retest acceptance transaction. */
export async function assertSpanTutorRetestBudget(tx: TransactionSql, scope: Scope,
  input: { courseId: string; notBeforeAt: string; minutes: number; expectedGrantRevision: number }, now = new Date()): Promise<SpanTutorBudget> {
  return assertBudget(tx, scope, { ...input, targetAt: new Date(input.notBeforeAt) }, now);
}

/** Conditional system closure preserves started, edited and explicitly accepted learner work. */
export async function cancelOwnedSpanTutorRetests(tx: TransactionSql, scope: Scope,
  input: { courseId?: string; activityIds?: string[]; reason: string }): Promise<string[]> {
  if (input.activityIds && input.activityIds.length === 0) return [];
  await lockWorkspaceLearningHistory(tx, scope);
  const rows = await tx`SELECT r.id,r.task_id,r.learning_protocol,t.version,t.status FROM opening_retest_activities r
    JOIN opening_tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id AND t.owner_user_id=r.owner_user_id
    JOIN opening_jobs j ON j.id=r.candidate_id AND j.workspace_id=r.workspace_id AND j.owner_user_id=r.owner_user_id
      AND j.kind='retest' AND j.payload->>'accepted'='true'
      AND j.payload->>'acceptClientKey'=r.accept_client_key AND j.payload->>'taskId'=t.id::text
    WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId}
      AND (${input.courseId ?? null}::uuid IS NULL OR r.course_id=${input.courseId ?? null})
      AND (${input.activityIds ?? null}::uuid[] IS NULL OR r.id=ANY(${input.activityIds ?? []}::uuid[]))
      AND r.requirement_key=${SPAN_REQUIREMENT_KEY} AND r.skill_label=${SPAN_SKILL_LABEL}
      AND r.status IN ('accepted','invalidated') AND r.started_at IS NULL AND t.status='pending'
      AND r.learning_protocol ? 'tutorAutomation'
      AND NOT EXISTS (SELECT 1 FROM opening_plan_state p, LATERAL jsonb_array_elements(p.accepted_blocks) b
        WHERE p.workspace_id=r.workspace_id AND p.accepted_version>0 AND b->>'taskId'=t.id::text)
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_activities a WHERE a.workspace_id=r.workspace_id AND a.owner_user_id=r.owner_user_id
        AND (a.create_intent->>'taskId'=t.id::text OR a.checkpoint_json->'spanLesson'->>'retestId' IN (r.id::text,r.candidate_id::text,r.candidate_reference_id::text)))
    ORDER BY r.id FOR UPDATE OF r,t`;
  const closed: string[] = [];
  for (const row of rows) {
    const automation = spanTutorAutomationSchema.safeParse(object(row.learning_protocol).tutorAutomation);
    if (!automation.success || Number(row.version) !== automation.data.createdTaskVersion) continue;
    await tx`UPDATE opening_tasks SET status='skipped',close_source='system',version=version+1,updated_at=now()
      WHERE id=${row.task_id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    await tx`UPDATE opening_retest_activities SET status='cancelled',reason=${input.reason},cancelled_at=now(),version=version+1,updated_at=now()
      WHERE id=${row.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    closed.push(String(row.task_id));
  }
  if (closed.length) await nextWorkspaceLearningHistoryRevision(tx, scope);
  return closed;
}
