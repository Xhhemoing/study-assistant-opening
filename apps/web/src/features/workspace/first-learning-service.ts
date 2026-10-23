import "server-only";
import type { Scope } from "@aistudy/contracts";
import type { OpeningPlanService } from "../opening/planning/plan-service";
import type { OpeningFirstLearningRepository, createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { localDateKeyInZone, resolveLocalDayBounds } from "@aistudy/domain";
import { ApiError } from "../auth/service";
import { firstLearningInputSchema, initialLearningDays, initialLearningSchedule } from "./first-learning-input";

export type FirstLearningDependencies = {
  firstLearning: Pick<OpeningFirstLearningRepository, "initialize">;
  plans: Pick<OpeningPlanService, "createTaskWithOutcome" | "getToday">;
  settings: ReturnType<typeof createOpeningPlanningSettingsRepository>;
  now?: () => Date;
};

/** Course, goal, daily tasks and the first lesson share one durable initialization. */
export async function startFirstLearning(deps: FirstLearningDependencies, scope: Scope, raw: unknown) {
  const input = firstLearningInputSchema.parse(raw);
  const preference = await deps.settings.get(scope);
  if (preference.invalidStoredSettings) throw new ApiError("CONFLICT", "原有学习时间设置需要修复，请先到设置页检查。", 409);
  const now = deps.now?.() ?? new Date();
  const timeZone = preference.settings?.timeZone ?? input.timeZone;
  const today = localDateKeyInZone(now, timeZone);
  const initialized = await deps.firstLearning.initialize(scope, {
    intent: input, startDate: today, planTimeZone: timeZone, days: initialLearningDays(input, today, timeZone),
  }, { replayOnly: Boolean(input.targetDate && input.targetDate < today) });
  const { activity } = initialized;
  let taskId = initialized.firstTaskId;
  // Recover an older, interrupted onboarding without reattaching a course the learner may have removed.
  if (!taskId && initialized.legacy) {
    const { task } = await deps.plans.createTaskWithOutcome(scope, {
      clientKey: `first-learning-activity:${activity.id}`, title: `${input.topic} · 首次学习`, minutes: input.minutes,
      dueAt: input.targetDate ? new Date(resolveLocalDayBounds(input.targetDate, input.timeZone).nextDayStart.getTime() - 1).toISOString() : null,
      priority: 1, candidateId: null, origin: "manual",
    });
    taskId = task.id;
  }
  if (!taskId) throw new ApiError("CONFLICT", "首次学习任务已不可用，请从课程继续。", 409);
  let scheduleInitialized = false;
  if (!preference.saved) scheduleInitialized = await deps.settings.initialize(scope, initialLearningSchedule(input, initialized.startDate));
  const current = await deps.settings.get(scope);
  if (current.invalidStoredSettings) throw new ApiError("CONFLICT", "学习时间设置已变化，请先到设置页检查。", 409);
  const planDate = localDateKeyInZone(now, current.settings?.timeZone ?? timeZone);
  const plan = await deps.plans.getToday(scope, planDate);
  return { activityId: activity.id, taskId, courseId: initialized.courseId, planDate,
    planStartDate: initialized.startDate, planEndDate: initialized.endDate, plannedDays: initialized.legacy ? 0 : initialized.tasks.length,
    generateStatus: activity.generateStatus, contentVersion: activity.contentVersion,
    draftCreated: Boolean(plan.dailyDraft), scheduleInitialized,
    href: initialized.courseId ? `/opening/courses/${initialized.courseId}/study?activity=${activity.id}` : "/opening/today" };
}
