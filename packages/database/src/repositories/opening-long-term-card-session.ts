import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { learningActivityBudgetSchema, learningCardSessionCommandSchema, learningCardSessionSchema, type LearningCardSession, type Scope } from "@aistudy/contracts";
import { resolveLocalDayBounds } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { createCardRepository } from "./cards";
import { assertLearningGoalAction, readLearningGoal } from "./opening-learning-goals";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { readOpeningLearningCapacity, reserveOpeningLearningActivityBudget } from "./opening-learning-capacity";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export type CardSessionRecoveryAllowanceInput = {
  dailyExecutableMinutes: number;
  freeUnreservedMinutes: number;
  usedOrReservedCardSessionMinutes: number;
  isBacklogRecovery: boolean;
};

/**
 * Enforces the workspace-wide 30% daily card-recovery ceiling across all courses.
 * For non-backlog maintenance on tight daily budgets (`15 <= dailyExecutable < 34`) with zero
 * prior card usage today, permits one minimum 10-minute maintenance session; all backlog sessions,
 * repeat sessions, and budgets >= 34m enforce the strict `floor(0.30 * dailyExecutableMinutes)` cap.
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
  const strictCap = Math.floor((dailyExecutable * 3) / 10);
  const effectiveCap = !input.isBacklogRecovery && usedCardMinutes === 0 && dailyExecutable >= 15
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

function sumCardSessionMinutesForDay(
  activities: readonly Row[],
  day: { localDate: string; timeZone: string; bounds: { dayStart: Date; nextDayStart: Date } },
): number {
  let total = 0;
  for (const row of activities) {
    const intent = object(row.create_intent);
    const goal = object(row.goal_json);
    if (intent.protocol !== "card-review-session-v1" && goal.cardReviewSession == null) continue;
    const savedBudget = goal.learningBudget != null
      ? learningActivityBudgetSchema.safeParse(goal.learningBudget)
      : null;
    if (savedBudget) {
      if (!savedBudget.success) {
        throw learningError("CONFLICT", "已有卡片活动的共同预算记录无法读取，请先核对活动。");
      }
      if (!overlapsCapacityDay(savedBudget.data, day)) continue;
      total += savedBudget.data.minutes;
      continue;
    }
    const createdMs = row.created_at instanceof Date
      ? row.created_at.getTime()
      : typeof row.created_at === "string"
        ? Date.parse(row.created_at)
        : Number.NaN;
    if (
      !Number.isFinite(createdMs)
      || createdMs < day.bounds.dayStart.getTime()
      || createdMs >= day.bounds.nextDayStart.getTime()
    ) {
      continue;
    }
    const cardGoal = object(goal.cardReviewSession);
    const cardCheckpoint = object(object(row.checkpoint_json).cardReviewSession);
    const fallbackMinutes = cardCheckpoint.stoppedAt
      ? Number(cardCheckpoint.elapsedSeconds) / 60
      : Number(cardGoal.budgetMinutes);
    if (!Number.isFinite(fallbackMinutes) || fallbackMinutes < 0) {
      throw learningError("CONFLICT", "已有卡片活动的学习时长无法确认，请先核对活动。");
    }
    total += fallbackMinutes;
  }
  return total;
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
      const usedOrReservedCardSessionMinutes = sumCardSessionMinutesForDay(capacity.activities, capacity);
      const strictCap = Math.floor((dailyExecutableMinutes * 3) / 10);
      const isBacklogRecovery = dailyExecutableMinutes < 34
        && usedOrReservedCardSessionMinutes === 0
        && input.budgetMinutes > strictCap
        ? (await cards.listQueue({ ...scope, mode: "auto", now, timeZone: capacity.timeZone })).length > 200
        : true;
      const freeUnreservedMinutes = Math.max(0, dailyExecutableMinutes - capacity.usedMinutes);
      const allowance = computeCardSessionRecoveryAllowance({
        dailyExecutableMinutes,
        freeUnreservedMinutes,
        usedOrReservedCardSessionMinutes,
        isBacklogRecovery,
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
