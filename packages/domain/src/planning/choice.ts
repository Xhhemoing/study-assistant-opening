import type { TodayPlan } from "@aistudy/contracts";

export function needsOptionChoice(plan: TodayPlan): boolean {
  if (plan.options.length < 2) return false;
  return !plan.options.some((option) =>
    option.tasks.every((task) => plan.tasks.some((item) => item.id === task.id)),
  );
}

export function applyPlanOption(plan: TodayPlan, optionId: string): TodayPlan {
  const option = plan.options.find((item) => item.id === optionId);
  if (!option) return plan;
  const kept = plan.tasks.filter((task) => task.locked || task.kind === "explore");
  const extra = option.tasks.filter((task) => !kept.some((item) => item.id === task.id));
  const tasks = [...kept, ...extra];
  return {
    ...plan,
    tasks,
    totalMinutes: tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0),
  };
}
