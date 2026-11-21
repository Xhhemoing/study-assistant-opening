import {
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_STRATEGY_VERSION,
  isReservedDayAdjustmentProposeKey,
  isReservedDayExceptionProposeKey,
  learningManagementDraftMetadataSchema,
  plannedBlockSchema,
  type PlannedBlock,
  type Scope,
} from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { addLocalDays, localDateKeyInZone, resolveLocalDayBounds } from "@aistudy/domain";
import { collectNonDaySpilloverBlocks, readOpeningLearningCapacity } from "./opening-learning-capacity";
import { calculateSpanTutorBudgetUsage, evaluateDayPlanCapacity } from "./opening-learning-capacity-usage";
import { assertLearningGoalAction } from "./opening-learning-goals";
import { hasWorkspaceLearningHistoryLockForTx, learningError } from "./opening-learning-facts";
import { assertCardRecoveryPlanDayCap, isCardRecoveryTaskRow } from "./opening-long-term-card-session";
import { OpeningPlanError } from "./opening-plan-error";

type DraftSuggestionLike = {
  id: string;
  courseId?: string | null;
  key?: string;
  kind?: string;
  minutes?: number;
};

type PendingDraftAcceptance = {
  scope: Scope;
  draftDay: string;
  draft: Record<string, unknown>;
  now: Date;
};

const pendingDraftAcceptances = new WeakMap<object, PendingDraftAcceptance>();
const deferredStandaloneCardCapTxs = new WeakSet<object>();

export function registerPendingDraftAcceptanceForTx(
  tx: TransactionSql,
  entry: PendingDraftAcceptance,
): void {
  pendingDraftAcceptances.set(tx as unknown as object, entry);
}

export function consumePendingDraftAcceptanceForTx(
  tx: TransactionSql,
  scope: Scope,
  day: string,
): PendingDraftAcceptance | null {
  const key = tx as unknown as object;
  const entry = pendingDraftAcceptances.get(key);
  if (!entry) return null;
  pendingDraftAcceptances.delete(key);
  if (
    entry.scope.workspaceId !== scope.workspaceId
    || entry.scope.ownerUserId !== scope.ownerUserId
    || entry.draftDay !== day
  ) {
    return null;
  }
  return entry;
}

export function isDeferredStandaloneCardCapActiveForTx(tx: TransactionSql): boolean {
  return deferredStandaloneCardCapTxs.has(tx as unknown as object);
}

export async function withDeferredStandaloneCardCapForTx<T>(
  tx: TransactionSql,
  fn: () => Promise<T>,
): Promise<T> {
  const key = tx as unknown as object;
  deferredStandaloneCardCapTxs.add(key);
  try {
    return await fn();
  } finally {
    deferredStandaloneCardCapTxs.delete(key);
  }
}

export const isLocalReplanConstraintsCheckActiveForTx = isDeferredStandaloneCardCapActiveForTx;
export const withLocalReplanConstraintsCheckForTx = withDeferredStandaloneCardCapForTx;

export function overlappedLocalDays(blocks: readonly PlannedBlock[], timeZone: string): Set<string> {
  const days = new Set<string>();
  for (const block of blocks) {
    const startMs = Date.parse(block.start);
    const endMs = Date.parse(block.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    let cursor = localDateKeyInZone(new Date(startMs), timeZone);
    const endDate = localDateKeyInZone(new Date(endMs - 1), timeZone);
    for (let step = 0; step < 3; step += 1) {
      days.add(cursor);
      if (cursor >= endDate) break;
      cursor = addLocalDays(cursor, 1);
    }
  }
  return days;
}

/**
 * Enforces the 30% daily card-recovery cap strictly against the exact persisted `acceptedBlocks`
 * (after `acceptSuggestedKeys` / coach filtering) and only synthesizes `draft.suggested_tasks`
 * whose task IDs actually appear in `acceptedBlocks`.
 */
export async function assertAcceptedBlocksCardRecoveryCap(
  tx: TransactionSql,
  scope: Scope,
  draftDay: string,
  acceptedBlocks: readonly PlannedBlock[],
  draft: Record<string, unknown>,
  now: Date,
  preloadedState?: Awaited<ReturnType<typeof readOpeningLearningCapacity>>,
): Promise<void> {
  if (!acceptedBlocks.length) return;
  const suggestions = (draft.suggested_tasks ?? []) as DraftSuggestionLike[];
  const placedTaskIds = new Set(acceptedBlocks.map((block) => block.taskId));
  const suggestionIds = new Set(suggestions.map((item) => item.id));

  // Pre-filter before loading full learning capacity so non-card local replans and minimal tx mocks
  // execute zero extra capacity queries when no card-recovery block is being persisted.
  if (!preloadedState) {
    const hasCardSuggestion = suggestions.some(
      (item) => placedTaskIds.has(item.id) && isCardRecoveryTaskRow({
        id: item.id,
        origin: "planner",
        client_key: item.key ?? null,
        suggestion_kind: item.kind ?? null,
        status: "pending",
      }),
    );
    if (!hasCardSuggestion) {
      const existingPlacedIds = [...placedTaskIds].filter((id) => !suggestionIds.has(id));
      if (!existingPlacedIds.length) return;
      const existingRows = await tx`SELECT id, origin, client_key, status FROM opening_tasks
        WHERE id = ANY(${existingPlacedIds}::uuid[]) AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
      const hasExistingCardTask = existingRows.some((row) => isCardRecoveryTaskRow(row as Record<string, unknown>));
      if (!hasExistingCardTask) return;
    }
  }

  const baseState = preloadedState
    ?? await readOpeningLearningCapacity(
      tx,
      scope,
      resolveLocalDayBounds(draftDay, (await readOpeningLearningCapacity(tx, scope, now)).timeZone).dayStart,
    );
  const fresh = acceptedBlocks.filter(
    (block) => !baseState.blocks.some(
      (old) => old.taskId === block.taskId && old.start === block.start && old.end === block.end,
    ),
  );
  if (!fresh.length) return;

  const syntheticSuggestionsFor = (existingTasks: readonly Record<string, unknown>[]) => {
    const existingIds = new Set(existingTasks.map((task) => String(task.id)));
    return suggestions
      .filter((item) => placedTaskIds.has(item.id) && !existingIds.has(item.id))
      .map((item) => ({
        id: item.id,
        origin: "planner",
        client_key: item.key ?? null,
        suggestion_kind: item.kind ?? null,
        minutes: item.minutes,
        due_at: null,
        status: "pending",
        course_id: item.courseId ?? null,
      }));
  };

  const dayPostTasks = [...baseState.tasks, ...syntheticSuggestionsFor(baseState.tasks)];
  const cardRecoveryTaskIds = new Set(
    dayPostTasks.filter(isCardRecoveryTaskRow).map((task) => String(task.id)),
  );
  const freshCardBlocks = fresh.filter((block) => cardRecoveryTaskIds.has(block.taskId));
  if (!freshCardBlocks.length) return;

  const daysToCheck = overlappedLocalDays(freshCardBlocks, baseState.timeZone);
  for (const targetDay of daysToCheck) {
    const targetState = targetDay === baseState.localDate
      ? baseState
      : await readOpeningLearningCapacity(
          tx,
          scope,
          resolveLocalDayBounds(targetDay, baseState.timeZone).dayStart,
        );
    const targetPostTasks = targetDay === baseState.localDate
      ? dayPostTasks
      : [...targetState.tasks, ...syntheticSuggestionsFor(targetState.tasks)];
    const spilloverBlocks = collectNonDaySpilloverBlocks({
      day: draftDay,
      dayStartMs: targetState.bounds.dayStart.getTime(),
      nextDayStartMs: targetState.bounds.nextDayStart.getTime(),
      planEntries: targetState.planEntries,
    });
    await assertCardRecoveryPlanDayCap(tx, scope, {
      day: targetState,
      postTasks: targetPostTasks,
      postBlocks: [...acceptedBlocks, ...spilloverBlocks],
      now,
    });
  }
}

/**
 * Enforces the 30% card-recovery cap for standalone `assertOpeningPlanConstraints` callers
 * when `blocks` adds existing `review_cards` tasks onto `day`.
 * Executes zero extra capacity queries when `blocks` contains no card-recovery tasks.
 */
export async function assertStandaloneBlocksCardRecoveryCap(
  tx: TransactionSql,
  scope: Scope,
  day: string,
  blocks: readonly PlannedBlock[],
  now: Date = new Date(),
): Promise<void> {
  if (!blocks.length) return;
  const uniqueTaskIds = [...new Set(blocks.map((block) => block.taskId))];
  const taskRows = await tx`SELECT id, origin, client_key, status FROM opening_tasks
    WHERE id = ANY(${uniqueTaskIds}::uuid[]) AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
  const cardTaskIds = new Set(
    taskRows.filter((row) => isCardRecoveryTaskRow(row as Record<string, unknown>)).map((row) => String(row.id)),
  );
  const cardBlocks = blocks.filter((block) => cardTaskIds.has(block.taskId));
  if (!cardBlocks.length) return;

  const current = await readOpeningLearningCapacity(tx, scope, now);
  const daysToCheck = overlappedLocalDays(cardBlocks, current.timeZone);
  if (!daysToCheck.size) daysToCheck.add(day);
  for (const targetDay of daysToCheck) {
    const targetState = await readOpeningLearningCapacity(
      tx,
      scope,
      resolveLocalDayBounds(targetDay, current.timeZone).dayStart,
    );
    await assertCardRecoveryPlanDayCap(tx, scope, {
      day: targetState,
      postTasks: targetState.tasks,
      postBlocks: [...targetState.blocks, ...blocks],
      now,
    });
  }
}

/** Existing accept transaction owns locks and historical receipt replay before this check. */
export async function assertOpeningLearningManagementDraft(
  tx: TransactionSql,
  scope: Scope,
  draft: Record<string, unknown>,
  now: Date,
  options?: { acceptedBlocks?: readonly PlannedBlock[]; deferToPlanAccept?: boolean; standalone?: boolean },
) {
  const snapshot = draft.input_snapshot as { learningManagement?: unknown; dayException?: unknown; dayAdjustment?: unknown } | null;
  const reasons = draft.reasons && typeof draft.reasons === "object" && !Array.isArray(draft.reasons)
    ? (draft.reasons as { dayException?: unknown; dayAdjustment?: unknown })
    : null;
  if (
    draft.strategy_version === DAY_EXCEPTION_STRATEGY_VERSION
    || draft.strategy_version === DAY_ADJUSTMENT_STRATEGY_VERSION
    || snapshot?.dayException !== undefined
    || snapshot?.dayAdjustment !== undefined
    || reasons?.dayException !== undefined
    || reasons?.dayAdjustment !== undefined
    || isReservedDayExceptionProposeKey(draft.propose_client_key, draft.strategy_version, draft.input_snapshot)
    || isReservedDayAdjustmentProposeKey(draft.propose_client_key, draft.strategy_version, draft.input_snapshot, draft.id)
  ) {
    throw new OpeningPlanError("CONFLICT", "当日临时调整记录不能通过普通单日计划入口确认。", "stale_version");
  }
  const meta = snapshot?.learningManagement == null ? null : learningManagementDraftMetadataSchema.parse(snapshot.learningManagement);
  const current = await readOpeningLearningCapacity(tx, scope, now);
  const draftDay = draft.day instanceof Date ? draft.day.toISOString().slice(0, 10) : String(draft.day).slice(0, 10);
  const day = meta?.localDate ?? draftDay;
  const state = await readOpeningLearningCapacity(tx, scope, resolveLocalDayBounds(day, current.timeZone).dayStart);
  const blocks = plannedBlockSchema.array().parse(draft.blocks ?? []);
  const fresh = blocks.filter(block => !state.blocks.some(old => old.taskId === block.taskId && old.start === block.start && old.end === block.end));
  const suggestions = (draft.suggested_tasks ?? []) as DraftSuggestionLike[];
  const taskIds = fresh.map(block => block.taskId);
  const actualCourses = await tx`SELECT DISTINCT course_id FROM opening_tasks WHERE id=ANY(${taskIds}::uuid[]) AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id IS NOT NULL`;
  const courseIds = [...new Set([...actualCourses.map(row => String(row.course_id)), ...suggestions.filter(item => taskIds.includes(item.id) && item.courseId).map(item => item.courseId!)])];
  if (courseIds.length) {
    const active = await tx`SELECT id FROM courses WHERE id=ANY(${courseIds}::uuid[]) AND workspace_id=${scope.workspaceId} AND archived_at IS NULL FOR SHARE`;
    if (active.length !== courseIds.length) throw learningError("CONFLICT", "新安排关联的课程已归档或不可访问，请重新选择；已有安排保留。");
  }
  if (state.dayException && fresh.length) {
    if (state.dayException.timeZone !== state.timeZone) {
      throw new OpeningPlanError("CONFLICT", "今日临时调整记录的时区与当前工作区时区不一致，请重新声明今日剩余时长。", "stale_version");
    }
    const effectiveAtMs = Date.parse(state.dayException.effectiveAt);
    if (fresh.some((block) => Date.parse(block.start) < effectiveAtMs)) {
      throw new OpeningPlanError("CONFLICT", "新增安排时段早于今日临时调整时刻，请重新生成后再确认。", "slot_expired");
    }
    const spilloverBlocks = collectNonDaySpilloverBlocks({
      day: draftDay,
      dayStartMs: state.bounds.dayStart.getTime(),
      nextDayStartMs: state.bounds.nextDayStart.getTime(),
      planEntries: state.planEntries,
    });
    const evaluated = evaluateDayPlanCapacity({
      day: { localDate: state.localDate, timeZone: state.timeZone },
      budget: state.budget,
      dayException: state.dayException,
      activities: state.activities,
      tasks: state.tasks,
      afterBlocks: [...blocks, ...spilloverBlocks],
    });
    if (evaluated.usageUncertain) {
      throw new OpeningPlanError("CONFLICT", "当前存在跨过今日临时调整时刻的学习记录，剩余容量暂无法确认，请先刷新核对。", "stale_version");
    }
    if (evaluated.shortfallMinutes > 0) {
      throw new OpeningPlanError("CONFLICT", "新的安排超出今日临时可用时长上限，请先调整今日安排；已接受事项保留。", "stale_version");
    }
  }
  const suggestionIds = new Set(suggestions.map((item) => item.id));
  if (options?.acceptedBlocks !== undefined) {
    pendingDraftAcceptances.delete(tx as unknown as object);
    await assertAcceptedBlocksCardRecoveryCap(tx, scope, draftDay, options.acceptedBlocks, draft, now, state);
  } else if (
    !options?.standalone
    && blocks.some((block) => suggestionIds.has(block.taskId))
    && (options?.deferToPlanAccept === true || hasWorkspaceLearningHistoryLockForTx(tx))
  ) {
    // Inside `acceptOpeningPlan` (which holds `lockWorkspaceLearningHistory`), placed suggestions
    // may still be deselected by `acceptSuggestedKeys` / coach selection before persistence;
    // defer enforcement to `validateOpeningLocalReplan` / `assertOpeningPlanConstraints`
    // so deselected `review_cards` suggestions never block unrelated ordinary tasks.
    registerPendingDraftAcceptanceForTx(tx, { scope, draftDay, draft, now });
  } else {
    pendingDraftAcceptances.delete(tx as unknown as object);
    await assertAcceptedBlocksCardRecoveryCap(tx, scope, draftDay, blocks, draft, now, state);
  }
  if (!current.budget && !meta) return;
  if (!state.budget || meta && state.budget.revision !== meta.budgetRevision) throw learningError("CONFLICT", "共同预算已变化，请重新预览后确认。");
  for (const goal of meta?.goalRevisions ?? []) await assertLearningGoalAction(tx, scope, goal.goalId, goal.revision);
  const proposed = calculateSpanTutorBudgetUsage(state, state.activities, state.tasks, [...state.blocks, ...blocks]);
  if (fresh.length && proposed > state.budget.dailyMinutes - state.budget.bufferMinutes) throw learningError("CONFLICT", "新的安排超出工作区共同预算，请重新选择；已接受事项保留。");
}
