import "server-only";
import type { Scope } from "@aistudy/contracts";
import type { OpeningTeachingActivityService } from "../opening/teaching/activity-service";
import type { OpeningPlanService } from "../opening/planning/plan-service";
import type { createOpeningPlanningSettingsRepository } from "@aistudy/database";
import { localDateKeyInZone, resolveLocalDayBounds } from "@aistudy/domain";
import { ApiError } from "../auth/service";
import { firstLearningInputSchema, initialLearningSchedule } from "./first-learning-input";

export type FirstLearningDependencies = {
  activities: Pick<OpeningTeachingActivityService, "create">;
  plans: Pick<OpeningPlanService, "createTaskWithOutcome" | "getToday">;
  settings: ReturnType<typeof createOpeningPlanningSettingsRepository>;
  now?: () => Date;
};

/** Each durable step reuses its existing receipt; an interrupted setup can resume with the same intent. */
export async function startFirstLearning(deps: FirstLearningDependencies, scope: Scope, raw: unknown) {
  const input = firstLearningInputSchema.parse(raw);
  const preference = await deps.settings.get(scope);
  if (preference.invalidStoredSettings) throw new ApiError("CONFLICT", "原有学习时间设置需要修复，请先到设置页检查。", 409);
  const now = deps.now?.() ?? new Date();
  const timeZone = preference.settings?.timeZone ?? input.timeZone;
  const today = localDateKeyInZone(now, timeZone);
  const replayOnly = Boolean(input.targetDate && input.targetDate < today);
  const summary = [input.topic, input.goal && `希望做到：${input.goal}`, input.targetDate && `目标日期：${input.targetDate}`,
    `每天可用 ${input.minutes} 分钟`].filter(Boolean).join("\n");
  // Source and workspace admission remain owned by the established activity service.
  const activityInput = {
    clientKey: `first-learning:${input.clientKey}:activity`, intentKind: input.goal || input.targetDate ? "goal" : "topic",
    intentSummary: summary, sourceIds: input.sourceIds,
    goalJson: { learningGoal: input.goal, targetDate: input.targetDate, dailyMinutes: input.minutes },
    createIntent: { source: "onboarding", ...input },
  };
  // The repository performs replay-only admission under its existing transaction and owner lock.
  const activity = replayOnly ? await deps.activities.create(scope, activityInput, { replayOnly: true })
    : await deps.activities.create(scope, activityInput);
  const { task } = await deps.plans.createTaskWithOutcome(scope, {
    clientKey: `first-learning-activity:${activity.id}`, title: `${input.topic} · 首次学习`, minutes: input.minutes,
    // An explicit calendar goal is resolved in the submitted zone, keeping replays stable if settings change.
    dueAt: input.targetDate ? new Date(resolveLocalDayBounds(input.targetDate, input.timeZone).nextDayStart.getTime() - 1).toISOString() : null,
    priority: 1, candidateId: null, origin: "manual",
  });
  let scheduleInitialized = false;
  if (!preference.saved) scheduleInitialized = await deps.settings.initialize(scope, initialLearningSchedule(input, today));
  // Re-read: another tab may have initialized the schedule first.
  const current = await deps.settings.get(scope);
  if (current.invalidStoredSettings) throw new ApiError("CONFLICT", "学习时间设置已变化，请先到设置页检查。", 409);
  const planDate = localDateKeyInZone(now, current.settings?.timeZone ?? timeZone);
  const plan = await deps.plans.getToday(scope, planDate);
  return { activityId: activity.id, taskId: task.id, planDate, generateStatus: activity.generateStatus,
    contentVersion: activity.contentVersion, draftCreated: Boolean(plan.dailyDraft), scheduleInitialized,
    href: "/opening/today" as const };
}
