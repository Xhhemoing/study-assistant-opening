import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { learningActivityBudgetSchema, learningCardSessionCommandSchema, learningCardSessionSchema, type LearningCardSession, type Scope } from "@aistudy/contracts";
import { resolveLocalDayBounds } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { createCardRepository } from "./cards";
import { assertLearningGoalAction, readLearningGoal } from "./opening-learning-goals";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readOpeningLearningCapacity, reserveOpeningLearningActivityBudget } from "./opening-learning-capacity";
import { plannerSuggestionKind } from "./opening-task-fields";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const timestampMs = (value: unknown): number =>
  value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;

export type CardSessionRecoveryAllowanceInput = {
  dailyExecutableMinutes: number;
  freeUnreservedMinutes: number;
  usedOrReservedCardSessionMinutes: number;
  isBacklogRecovery: boolean;
  /** True when any card-review session activity already exists on this local day (including 0-second stops). */
  hasPriorCardSessionToday?: boolean;
};

/**
 * Enforces the workspace-wide 30% daily card-recovery ceiling across all courses.
 * For non-backlog maintenance on tight daily budgets (`15 <= dailyExecutable < 34`) with zero
 * prior card sessions or recovery reservations today, permits one minimum 10-minute maintenance
 * session; all backlog sessions, repeat sessions (even after 0s pause/stop), and budgets >= 34m
 * enforce the strict `floor(0.30 * dailyExecutableMinutes)` cap.
 */
export function computeCardSessionRecoveryAllowance(input: CardSessionRecoveryAllowanceInput): number {
  if (
    !Number.isFinite(input.dailyExecutableMinutes)
    || !Number.isFinite(input.freeUnreservedMinutes)
    || !Number.isFinite(input.usedOrReservedCardSessionMinutes)
  ) {
    return 0;
  }
  const dailyExecutable = Math.max(0, input.dailyExecutableMinutes);
  const freeUnreserved = Math.max(0, input.freeUnreservedMinutes);
  const usedCardMinutes = Math.max(0, input.usedOrReservedCardSessionMinutes);
  const hasPriorToday = Boolean(input.hasPriorCardSessionToday) || usedCardMinutes > 0;
  const strictCap = Math.floor((dailyExecutable * 3) / 10);
  const effectiveCap = !input.isBacklogRecovery && !hasPriorToday && dailyExecutable >= 15
    ? Math.max(Math.min(10, Math.floor(dailyExecutable)), strictCap)
    : strictCap;
  return Math.max(0, Math.min(freeUnreserved, effectiveCap - usedCardMinutes));
}

function overlapsCapacityDay(
  stored: { localDate: string; timeZone: string },
  day: { localDate: string; timeZone: string },
): boolean {
  const a = resolveLocalDayBounds(stored.localDate, stored.timeZone);
  const b = resolveLocalDayBounds(day.localDate, day.timeZone);
  return a.dayStart < b.nextDayStart && b.dayStart < a.nextDayStart;
}

function requirePositiveMinutes(value: unknown, message: string): number {
  const minutes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw learningError("CONFLICT", message);
  return minutes;
}

export function isCardRecoveryTaskRow(task: Row): boolean {
  return (
    task.status !== "skipped"
    && (
      plannerSuggestionKind(task) === "review_cards"
      || task.suggestion_kind === "review_cards"
      || task.suggestionKind === "review_cards"
    )
  );
}

function cardSessionActivityBelongsToDay(
  row: Row,
  day: { localDate: string; timeZone: string; bounds: { dayStart: Date; nextDayStart: Date } },
): boolean {
  const goal = object(row.goal_json);
  if (goal.learningBudget != null) {
    const savedBudget = learningActivityBudgetSchema.safeParse(goal.learningBudget);
    if (!savedBudget.success) {
      throw learningError("CONFLICT", "已有卡片活动的共同预算记录无法读取，请先核对活动。");
    }
    return overlapsCapacityDay(savedBudget.data, day);
  }
  const createdMs = timestampMs(row.created_at);
  return (
    Number.isFinite(createdMs)
    && createdMs >= day.bounds.dayStart.getTime()
    && createdMs < day.bounds.nextDayStart.getTime()
  );
}

async function readHasPriorCardSessionForDay(
  tx: TransactionSql,
  scope: Scope,
  day: { localDate: string; timeZone: string; bounds: { dayStart: Date; nextDayStart: Date } },
): Promise<boolean> {
  const priorCardRows = await tx`SELECT created_at,goal_json FROM opening_teaching_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND (create_intent->>'protocol'='card-review-session-v1' OR goal_json ? 'cardReviewSession')
      AND ((created_at>=${day.bounds.dayStart} AND created_at<${day.bounds.nextDayStart}) OR goal_json ? 'learningBudget')`;
  return priorCardRows.some((row) => cardSessionActivityBelongsToDay(row as Row, day));
}

/**
 * Sums all workspace-wide card-recovery commitments overlapping `day`:
 * accepted `review_cards` plan blocks (clipped to `day`), due/completed `review_cards` tasks,
 * and `card-review-session-v1` activities — deduplicating linked `task:${id}` / `activity:${id}`
 * references via `Math.max`.
 */
export function sumCardRecoveryMinutesForDay(input: {
  localDate: string;
  timeZone: string;
  bounds: { dayStart: Date; nextDayStart: Date };
  activities: readonly Row[];
  tasks?: readonly Row[];
  blocks?: readonly Row[];
}): number {
  const dayStartMs = input.bounds.dayStart.getTime();
  const nextDayStartMs = input.bounds.nextDayStart.getTime();
  const inDay = (value: unknown): boolean => {
    const ms = timestampMs(value);
    return Number.isFinite(ms) && ms >= dayStartMs && ms < nextDayStartMs;
  };

  const usage = new Map<string, number>();
  const charge = (key: string, minutes: number) => {
    usage.set(key, Math.max(usage.get(key) ?? 0, minutes));
  };

  const intervalsByTask = new Map<string, Array<[number, number]>>();
  for (const block of input.blocks ?? []) {
    const rawStart = timestampMs(block.start);
    const rawEnd = timestampMs(block.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      throw learningError("CONFLICT", "已接受安排的日期无法确认，请先核对今日安排。");
    }
    const start = Math.max(rawStart, dayStartMs);
    const end = Math.min(rawEnd, nextDayStartMs);
    if (end > start) {
      const taskId = String(block.taskId);
      const list = intervalsByTask.get(taskId);
      if (list) list.push([start, end]);
      else intervalsByTask.set(taskId, [[start, end]]);
    }
  }

  const blockMinutes = new Map<string, number>();
  for (const [taskId, ranges] of intervalsByTask) {
    let previousEnd = -Infinity;
    let minutes = 0;
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
      minutes += Math.max(0, end - Math.max(start, previousEnd)) / 60_000;
      previousEnd = Math.max(previousEnd, end);
    }
    if (minutes > 0) blockMinutes.set(taskId, minutes);
  }

  for (const task of input.tasks ?? []) {
    if (!isCardRecoveryTaskRow(task)) continue;
    const taskId = String(task.id);
    const scheduledMinutes = blockMinutes.get(taskId);
    if (scheduledMinutes !== undefined) {
      charge(`task:${taskId}`, scheduledMinutes);
    }
    if (inDay(task.due_at) || (task.status === "done" && inDay(task.updated_at))) {
      const taskMinutes = requirePositiveMinutes(task.minutes, "已有卡片恢复任务的学习时长无法确认，请先核对今日安排。");
      charge(`task:${taskId}`, taskMinutes);
    }
  }

  for (const row of input.activities) {
    const intent = object(row.create_intent);
    const goal = object(row.goal_json);
    if (intent.protocol !== "card-review-session-v1" && goal.cardReviewSession == null) continue;
    const savedBudget = goal.learningBudget != null
      ? learningActivityBudgetSchema.safeParse(goal.learningBudget)
      : null;
    let minutes: number;
    if (savedBudget) {
      if (!savedBudget.success) {
        throw learningError("CONFLICT", "已有卡片活动的共同预算记录无法读取，请先核对活动。");
      }
      if (!overlapsCapacityDay(savedBudget.data, input)) continue;
      minutes = savedBudget.data.minutes;
    } else {
      if (!inDay(row.created_at)) continue;
      const cardGoal = object(goal.cardReviewSession);
      const cardCheckpoint = object(object(row.checkpoint_json).cardReviewSession);
      const fallbackMinutes = cardCheckpoint.stoppedAt
        ? Number(cardCheckpoint.elapsedSeconds) / 60
        : Number(cardGoal.budgetMinutes);
      if (!Number.isFinite(fallbackMinutes) || fallbackMinutes < 0) {
        throw learningError("CONFLICT", "已有卡片活动的学习时长无法确认，请先核对活动。");
      }
      minutes = fallbackMinutes;
    }
    const linkedTask = intent.taskId;
    const recoveryId = object(goal.recovery).activityId;
    const original = recoveryId
      ? input.activities.find((candidate) => candidate.id === recoveryId && candidate.course_id === row.course_id)
      : undefined;
    const key = linkedTask
      ? `task:${String(linkedTask)}`
      : `activity:${String(original?.id ?? row.id)}`;
    charge(key, minutes);
  }

  let total = 0;
  for (const minutes of usage.values()) total += minutes;
  return total;
}

/**
 * Symmetrically enforces the workspace-wide 30% daily card-recovery ceiling during plan confirmation
 * whenever a draft adds or changes card-recovery (`review_cards`) blocks.
 */
export async function assertCardRecoveryPlanDayCap(
  tx: TransactionSql,
  scope: Scope,
  input: {
    day: {
      budget: { dailyMinutes: number; bufferMinutes: number } | null;
      localDate: string;
      timeZone: string;
      bounds: { dayStart: Date; nextDayStart: Date };
      activities: readonly Row[];
      tasks: readonly Row[];
      blocks: readonly Row[];
    };
    postTasks: readonly Row[];
    postBlocks: readonly Row[];
    now: Date;
  },
): Promise<void> {
  if (input.day.budget === null) return;
  const dailyExecutableMinutes = Math.max(0, input.day.budget.dailyMinutes - input.day.budget.bufferMinutes);
  const preCardMinutes = sumCardRecoveryMinutesForDay(input.day);
  const postCardMinutes = sumCardRecoveryMinutesForDay({
    localDate: input.day.localDate,
    timeZone: input.day.timeZone,
    bounds: input.day.bounds,
    activities: input.day.activities,
    tasks: input.postTasks,
    blocks: input.postBlocks,
  });
  if (postCardMinutes <= preCardMinutes + 1e-6) return;

  const strictCap = Math.floor((dailyExecutableMinutes * 3) / 10);
  let effectiveCap = strictCap;
  if (
    dailyExecutableMinutes >= 15
    && dailyExecutableMinutes < 34
    && preCardMinutes === 0
    && postCardMinutes > strictCap
    && postCardMinutes <= Math.min(10, Math.floor(dailyExecutableMinutes))
  ) {
    const hasPriorToday = await readHasPriorCardSessionForDay(tx, scope, input.day);
    if (!hasPriorToday) {
      const cards = createCardRepository(tx as unknown as Sql);
      const isBacklogRecovery = (await cards.listQueue({
        ...scope,
        mode: "auto",
        now: input.now,
        timeZone: input.day.timeZone,
      })).length >= 200;
      if (!isBacklogRecovery) {
        effectiveCap = Math.max(Math.min(10, Math.floor(dailyExecutableMinutes)), strictCap);
      }
    }
  }

  if (postCardMinutes > effectiveCap + 1e-6) {
    const displayCap = Number.isInteger(effectiveCap) ? effectiveCap : Number(effectiveCap.toFixed(2));
    throw learningError(
      "CONFLICT",
      `新的安排超出今日卡片恢复可用上限（${displayCap} 分钟，不超过每日可执行学习时长的 30%），请缩短或调整卡片复习安排；已接受事项保留。`,
    );
  }
}
export function mapLearningCardSession(row: Row): LearningCardSession {
  const goal = object(object(row.goal_json).cardReviewSession), state = object(object(row.checkpoint_json).cardReviewSession);
  const cardIds = Array.isArray(goal.orderedCardIds) ? goal.orderedCardIds : goal.cardIds;
  return learningCardSessionSchema.parse({ activityId: row.id, status: row.status, revision: Number(row.path_version), cardIds,
    reviewedCardIds: state.reviewedCardIds ?? [], budgetMinutes: goal.budgetMinutes, elapsedSeconds: state.elapsedSeconds ?? 0,
    startedAt: goal.startedAt, stoppedAt: state.stoppedAt ?? null, href: `/opening/review?cardSession=${row.id}` });
}
export async function readLearningCardSessions(db: Sql | TransactionSql, scope: Scope, id?: string) {
  const rows = await db`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND create_intent->>'protocol'='card-review-session-v1' AND (${id ?? null}::uuid IS NULL OR id=${id ?? null}::uuid)
    ORDER BY updated_at DESC LIMIT 200`;
  return rows.map(mapLearningCardSession);
}
export function assertCardSessionStop(input: { budgetMinutes: number; startedAt: string; elapsedSeconds: number; now: Date }) {
  if (input.elapsedSeconds > input.budgetMinutes * 60 || input.elapsedSeconds > Math.max(0, (input.now.getTime() - Date.parse(input.startedAt)) / 1000) + 2) {
    throw learningError("VALIDATION", "本次有效复习时间超过已授权时长或实际经过时间，请核对停止点。");
  }
}
export async function writeLearningCardSession(sql: Sql, scope: Scope, raw: unknown, now = new Date()): Promise<LearningCardSession> {
  const input = learningCardSessionCommandSchema.parse(raw);
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!owner) throw learningError("NOT_FOUND", "工作区不存在。");
    if (input.action === "stop") return stop(tx, scope, input, now);
    const orderedCardIds = [...new Set(input.cardIds)];
    const sortedCardIds = [...orderedCardIds].sort();
    const sortedGoalIds = [...new Set(input.goalIds)].sort();
    const intent = { protocol: "card-review-session-v1", cardIds: sortedCardIds, orderedCardIds, goalIds: sortedGoalIds, budgetMinutes: input.budgetMinutes };
    const legacyIntent = { protocol: "card-review-session-v1", cardIds: sortedCardIds, goalIds: sortedGoalIds, budgetMinutes: input.budgetMinutes };
    const [prior] = await tx`SELECT * FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${`card-session:${input.clientKey}`}`;
    if (prior) {
      const priorIntent = object(prior.create_intent);
      const expected = "orderedCardIds" in priorIntent ? intent : legacyIntent;
      if (!isDeepStrictEqual(prior.create_intent, expected)) throw learningError("CONFLICT", "原卡片会话请求内容已变化。");
      return mapLearningCardSession(prior);
    }
    const active = await tx`SELECT id FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND create_intent->>'protocol'='card-review-session-v1' AND status='active' LIMIT 1`;
    if (active.length) throw learningError("CONFLICT", "请先恢复或停止当前卡片会话，再开始下一次。");
    const cards = createCardRepository(tx as unknown as Sql);
    const capacity = await readOpeningLearningCapacity(tx, scope, now);
    if (capacity.budget !== null) {
      const dailyExecutableMinutes = Math.max(0, capacity.budget.dailyMinutes - capacity.budget.bufferMinutes);
      const usedOrReservedCardSessionMinutes = sumCardRecoveryMinutesForDay(capacity);
      const hasPriorCardSessionToday = usedOrReservedCardSessionMinutes > 0
        || await readHasPriorCardSessionForDay(tx, scope, capacity);
      const strictCap = Math.floor((dailyExecutableMinutes * 3) / 10);
      const isBacklogRecovery = dailyExecutableMinutes < 34
        && !hasPriorCardSessionToday
        && input.budgetMinutes > strictCap
        ? (await cards.listQueue({ ...scope, mode: "auto", now, timeZone: capacity.timeZone })).length >= 200
        : true;
      const freeUnreservedMinutes = Math.max(0, dailyExecutableMinutes - capacity.usedMinutes);
      const allowance = computeCardSessionRecoveryAllowance({
        dailyExecutableMinutes,
        freeUnreservedMinutes,
        usedOrReservedCardSessionMinutes,
        isBacklogRecovery,
        hasPriorCardSessionToday,
      });
      if (input.budgetMinutes > allowance) {
        const displayAllowance = Number.isInteger(allowance) ? allowance : Number(allowance.toFixed(2));
        throw learningError("CONFLICT", `今日卡片恢复可用上限为 ${displayAllowance} 分钟（不超过每日可执行学习时长的 30%），请缩短本次时长。`);
      }
    }
    for (const cardId of sortedCardIds) {
      const card = await cards.getCard({ workspaceId: scope.workspaceId, cardId });
      if (card.ownerUserId !== scope.ownerUserId || card.archived || card.autoPaused || (card.pausedUntil && Date.parse(card.pausedUntil) > now.getTime())) throw learningError("CONFLICT", "所选卡片已暂停、归档或不可读取。");
    }
    for (const goalId of sortedGoalIds) {
      const goal = await readLearningGoal(tx, scope, goalId);
      if (!goal) throw learningError("NOT_FOUND", "卡片关联目标不存在。");
      await assertLearningGoalAction(tx, scope, goalId, goal.revision);
    }
    const id = randomUUID(), startedAt = now.toISOString();
    const goal = { cardReviewSession: { protocol: intent.protocol, cardIds: orderedCardIds, orderedCardIds, goalIds: sortedGoalIds, budgetMinutes: input.budgetMinutes, startedAt } };
    const checkpoint = { cardReviewSession: { reviewedCardIds: [], elapsedSeconds: 0, stoppedAt: null } };
    await tx`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,status,intent_kind,intent_summary,goal_json,checkpoint_json,client_key,create_intent)
      VALUES(${id},${scope.workspaceId},${scope.ownerUserId},'active','course_continue','有界卡片复习',${tx.json(goal)},${tx.json(checkpoint)},${`card-session:${input.clientKey}`},${tx.json(intent)})`;
    await reserveOpeningLearningActivityBudget(tx, scope, { activityId: id, minutes: input.budgetMinutes }, now);
    const [created] = await tx`SELECT * FROM opening_teaching_activities WHERE id=${id}`;
    return mapLearningCardSession(created!);
  }) as Promise<LearningCardSession>;
}
async function stop(tx: TransactionSql, scope: Scope, input: Extract<ReturnType<typeof learningCardSessionCommandSchema.parse>, { action: "stop" }>, now: Date) {
  const [row] = await tx`SELECT * FROM opening_teaching_activities WHERE id=${input.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND create_intent->>'protocol'='card-review-session-v1' FOR UPDATE`;
  if (!row) throw learningError("NOT_FOUND", "卡片复习会话不存在。");
  const current = mapLearningCardSession(row), state = object(object(row.checkpoint_json).cardReviewSession);
  const receipt = { expectedRevision: input.expectedRevision, elapsedSeconds: input.elapsedSeconds, reviewedCardIds: [...new Set(input.reviewedCardIds)].sort(), reason: input.reason };
  if (state.stopIntent) {
    if (!isDeepStrictEqual(state.stopIntent, receipt)) throw learningError("CONFLICT", "本次停止点已保存，请读取原会话。");
    return current;
  }
  if (current.revision !== input.expectedRevision || current.status !== "active") throw learningError("CONFLICT", "卡片会话已更新，请恢复原停止点。");
  assertCardSessionStop({ ...current, elapsedSeconds: input.elapsedSeconds, now });
  if (receipt.reviewedCardIds.some(id => !current.cardIds.includes(id))) throw learningError("VALIDATION", "复习记录不属于本次选定卡片。");
  const events = await tx`SELECT DISTINCT content_id FROM learning_events WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND type='review' AND content_id=ANY(${receipt.reviewedCardIds}::uuid[]) AND created_at>=${current.startedAt}::timestamptz AND created_at<=${now}`;
  if (events.length !== receipt.reviewedCardIds.length) throw learningError("CONFLICT", "尚无已保存的卡片评分，请先恢复真实评分记录。");
  const next = { ...object(row.checkpoint_json), cardReviewSession: { ...state, elapsedSeconds: input.elapsedSeconds, reviewedCardIds: receipt.reviewedCardIds,
    stoppedAt: now.toISOString(), stopReason: input.reason, stopIntent: receipt } };
  const [updated] = await tx`UPDATE opening_teaching_activities SET status=${input.reason === "pause" ? "paused" : "completed"},path_version=path_version+1,
    checkpoint_json=${tx.json(next)},updated_at=${now} WHERE id=${input.activityId} RETURNING *`;
  return mapLearningCardSession(updated!);
}
