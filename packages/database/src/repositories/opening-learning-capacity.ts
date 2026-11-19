import {
  DAY_EXCEPTION_STRATEGY_VERSION,
  dayExceptionSnapshotSchema,
  learningActivityBudgetSchema,
  learningManagementSettingsSchema,
  openingPlanningSettingsSchema,
  plannedBlockSchema,
  type DayExceptionSnapshot,
  type PlannedBlock,
  type Scope,
} from "@aistudy/contracts";
import { evaluateDayExceptionCapacity, localDateKeyInZone, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { calculateDayExceptionUsageBounds, calculateSpanTutorBudgetUsage } from "./opening-learning-capacity-usage";
import { readUnusedStaleCourseRouteReservations } from "./opening-course-route-reservations";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export type StoredDayException = DayExceptionSnapshot & { id: string };
export type DayPlanEntry = { day: string | null; blocks: readonly PlannedBlock[] };

function normalizeSpilloverBlock(block: PlannedBlock): PlannedBlock {
  return {
    taskId: block.taskId,
    start: new Date(block.start).toISOString(),
    end: new Date(block.end).toISOString(),
    reason: block.reason,
  };
}

function spilloverBlockSignature(block: PlannedBlock): string {
  const normalized = normalizeSpilloverBlock(block);
  return `${normalized.taskId.toLowerCase()}|${normalized.start}|${normalized.end}|${normalized.reason}`;
}

function spilloverBlockOverlapsRange(block: PlannedBlock, rangeStartMs: number, rangeEndMs: number): boolean {
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < rangeEndMs && endMs > rangeStartMs;
}

/** Collects accepted blocks stored under other `day` rows whose instants overlap `[dayStartMs, nextDayStartMs)`. */
export function collectNonDaySpilloverBlocks(input: {
  day: string;
  dayStartMs: number;
  nextDayStartMs: number;
  planEntries: readonly DayPlanEntry[];
  excludeDays?: ReadonlySet<string>;
  excludeBlockSignatures?: ReadonlySet<string>;
}): PlannedBlock[] {
  const excludedDays = new Set<string>([input.day, ...(input.excludeDays ?? [])]);
  const spillover: PlannedBlock[] = [];
  for (const entry of input.planEntries) {
    if (entry.day !== null && excludedDays.has(entry.day)) continue;
    for (const block of entry.blocks) {
      if (entry.day === null && input.excludeBlockSignatures?.has(spilloverBlockSignature(block))) continue;
      if (spilloverBlockOverlapsRange(block, input.dayStartMs, input.nextDayStartMs)) {
        spillover.push(normalizeSpilloverBlock(block));
      }
    }
  }
  return spillover.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.taskId.localeCompare(b.taskId));
}

export async function readActiveDayException(
  db: Sql | TransactionSql,
  scope: Scope,
  localDate: string,
): Promise<StoredDayException | null> {
  const [row] = await db`
    SELECT id, version, input_snapshot
    FROM opening_plan_drafts
    WHERE workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId}
      AND day = ${localDate}::date
      AND strategy_version = ${DAY_EXCEPTION_STRATEGY_VERSION}
    ORDER BY version DESC, created_at DESC
    LIMIT 1`;
  if (!row) return null;
  const parsed = dayExceptionSnapshotSchema.safeParse(object(row.input_snapshot).dayException);
  if (!parsed.success || parsed.data.localDate !== localDate || parsed.data.revision !== Number(row.version)) {
    throw learningError("CONFLICT", "当日临时调整记录异常，请先刷新核对。");
  }
  return { id: String(row.id), ...parsed.data };
}

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
  const activities = await db`SELECT id,course_id,status,created_at,updated_at,create_intent,checkpoint_json,goal_json FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND (${excludeActivityId ?? null}::uuid IS NULL OR id<>${excludeActivityId ?? null}::uuid)
      AND ((created_at>=${bounds.dayStart} AND created_at<${bounds.nextDayStart}) OR goal_json ? 'tutorBudget' OR goal_json ? 'learningBudget')
      AND (create_intent->>'protocol' IN ('span-lesson-v1','card-review-session-v1','course-route-v1') OR goal_json ? 'learningBudget' OR goal_json ? 'tutorBudget' OR goal_json ? 'sessionMinutes')`;
  const tasks = await db`SELECT t.*,r.id AS retest_id,r.candidate_id,r.candidate_reference_id,r.scheduled_start_at,r.recommended_at,r.not_before_at,r.snoozed_until,r.learning_protocol
    FROM opening_tasks t LEFT JOIN opening_retest_activities r ON r.task_id=t.id AND r.workspace_id=t.workspace_id AND r.owner_user_id=t.owner_user_id
    WHERE t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId} AND t.status IN ('pending','done')`;
  const plans = await db`SELECT day, accepted_blocks FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND accepted_version>0
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(accepted_blocks) b WHERE (b->>'start')::timestamptz<${bounds.nextDayStart} AND (b->>'end')::timestamptz>${bounds.dayStart})`;
  const planEntries = plans.map((plan) => ({
    day: plan.day instanceof Date
      ? plan.day.toISOString().slice(0, 10)
      : typeof plan.day === "string" && plan.day.length >= 10
        ? plan.day.slice(0, 10)
        : null,
    blocks: plannedBlockSchema.array().max(200).parse(plan.accepted_blocks),
  }));
  const blocks = planEntries.flatMap((entry) => entry.blocks);
  const released = new Set((await readUnusedStaleCourseRouteReservations(db, scope)).map(row=>String(row.id)));
  const normalized = normalizeLearningCapacityActivities(activities.filter(row=>!released.has(String(row.id))));
  const usedMinutes = calculateSpanTutorBudgetUsage({ localDate, timeZone }, normalized, tasks, blocks);
  const dayException = await readActiveDayException(db, scope, localDate);
  return { budget, settings, localDate, timeZone, bounds, activities: normalized, tasks, blocks, planEntries, usedMinutes, dayException };
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
  if (state.dayException) {
    if (state.dayException.timeZone !== state.timeZone) {
      throw learningError("CONFLICT", "今日临时调整记录的时区与当前工作区时区不一致，请重新声明今日剩余时长。");
    }
    const baseActivities = activities.filter(row => {
      if (linked && object(row.create_intent).taskId === linked) return false;
      if (recoveryId && row.id === recoveryId && row.course_id === activity?.course_id) return false;
      return true;
    });
    const baseTasks = linked ? state.tasks.filter(task => task.id !== linked) : state.tasks;
    const baseBlocks = linked ? state.blocks.filter(block => block.taskId !== linked) : state.blocks;
    const bounds = calculateDayExceptionUsageBounds(state, state.dayException.effectiveAt, baseActivities, baseTasks, baseBlocks);
    const evaluated = evaluateDayExceptionCapacity({
      dailyMinutes: state.budget?.dailyMinutes ?? null,
      bufferMinutes: state.budget?.bufferMinutes ?? null,
      dayUsedMinutes: bounds.dayUsedMinutes,
      exceptionRemainingMinutes: state.dayException.remainingMinutes,
      afterLowerMinutes: bounds.afterLowerMinutes,
      afterUpperMinutes: bounds.afterUpperMinutes,
      requiredMinutes: input.minutes,
    });
    if (evaluated.usageUncertain) {
      throw learningError("CONFLICT", "存在跨过今日临时调整时刻的学习记录，当前剩余可用时长暂无法准确确认，请先刷新核对后再开始。");
    }
    if (evaluated.shortfallMinutes > 0) {
      throw learningError("CONFLICT", `今日临时可用时长上限为 ${state.dayException.remainingMinutes} 分钟，剩余容量不足以安排本次 ${input.minutes} 分钟学习，请先调整今日安排或缩短时长。`);
    }
  }
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
