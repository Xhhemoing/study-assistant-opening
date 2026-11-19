import {
  DAY_ADJUSTMENT_STRATEGY_VERSION,
  DAY_EXCEPTION_STRATEGY_VERSION,
  learningManagementDraftMetadataSchema,
  plannedBlockSchema,
  type Scope,
} from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { resolveLocalDayBounds } from "@aistudy/domain";
import { readOpeningLearningCapacity } from "./opening-learning-capacity";
import { calculateSpanTutorBudgetUsage, evaluateDayPlanCapacity } from "./opening-learning-capacity-usage";
import { assertLearningGoalAction } from "./opening-learning-goals";
import { learningError } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";

/** Existing accept transaction owns locks and historical receipt replay before this check. */
export async function assertOpeningLearningManagementDraft(tx: TransactionSql, scope: Scope, draft: Record<string, unknown>, now: Date) {
  const snapshot = draft.input_snapshot as { learningManagement?: unknown; dayException?: unknown; dayAdjustment?: unknown } | null;
  if (
    draft.strategy_version === DAY_EXCEPTION_STRATEGY_VERSION
    || draft.strategy_version === DAY_ADJUSTMENT_STRATEGY_VERSION
    || snapshot?.dayException !== undefined
    || snapshot?.dayAdjustment !== undefined
  ) {
    throw new OpeningPlanError("CONFLICT", "当日临时调整记录不能通过普通单日计划入口确认。", "stale_version");
  }
  const meta = snapshot?.learningManagement == null ? null : learningManagementDraftMetadataSchema.parse(snapshot.learningManagement);
  const current = await readOpeningLearningCapacity(tx, scope, now);
  const day = meta?.localDate ?? (draft.day instanceof Date ? draft.day.toISOString().slice(0, 10) : String(draft.day).slice(0, 10));
  const state = await readOpeningLearningCapacity(tx, scope, resolveLocalDayBounds(day, current.timeZone).dayStart);
  const blocks = plannedBlockSchema.array().parse(draft.blocks ?? []);
  const fresh = blocks.filter(block => !state.blocks.some(old => old.taskId === block.taskId && old.start === block.start && old.end === block.end));
  const suggestions = (draft.suggested_tasks ?? []) as Array<{ id: string; courseId?: string | null }>;
  const taskIds = fresh.map(block => block.taskId);
  const actualCourses = await tx`SELECT DISTINCT course_id FROM opening_tasks WHERE id=ANY(${taskIds}::uuid[]) AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id IS NOT NULL`;
  const courseIds = [...new Set([...actualCourses.map(row => String(row.course_id)), ...suggestions.filter(item => taskIds.includes(item.id) && item.courseId).map(item => item.courseId!)])];
  if (courseIds.length) {
    const active = await tx`SELECT id FROM courses WHERE id=ANY(${courseIds}::uuid[]) AND workspace_id=${scope.workspaceId} AND archived_at IS NULL FOR SHARE`;
    if (active.length !== courseIds.length) throw learningError("CONFLICT", "新安排关联的课程已归档或不可访问，请重新选择；已有安排保留。");
  }
  if (state.dayException && fresh.length) {
    const evaluated = evaluateDayPlanCapacity({
      day: { localDate: state.localDate, timeZone: state.timeZone },
      budget: state.budget,
      dayException: state.dayException,
      activities: state.activities,
      tasks: state.tasks,
      afterBlocks: blocks,
    });
    if (evaluated.usageUncertain) {
      throw new OpeningPlanError("CONFLICT", "当前存在跨过今日临时调整时刻的学习记录，剩余容量暂无法确认，请先刷新核对。", "stale_version");
    }
    if (evaluated.shortfallMinutes > 0) {
      throw new OpeningPlanError("CONFLICT", "新的安排超出今日临时可用时长上限，请先调整今日安排；已接受事项保留。", "stale_version");
    }
  }
  if (!current.budget && !meta) return;
  if (!state.budget || meta && state.budget.revision !== meta.budgetRevision) throw learningError("CONFLICT", "共同预算已变化，请重新预览后确认。");
  for (const goal of meta?.goalRevisions ?? []) await assertLearningGoalAction(tx, scope, goal.goalId, goal.revision);
  const proposed = calculateSpanTutorBudgetUsage(state, state.activities, state.tasks, [...state.blocks, ...blocks]);
  if (fresh.length && proposed > state.budget.dailyMinutes - state.budget.bufferMinutes) throw learningError("CONFLICT", "新的安排超出工作区共同预算，请重新选择；已接受事项保留。");
}
