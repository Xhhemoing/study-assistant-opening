import type { PlannedTask, TodayPlan } from "@aistudy/contracts";

export function getPlanCompletion(plan: TodayPlan): { done: number; total: number; percent: number } {
  const done = plan.tasks.filter((task) => task.status === "done").length;
  const total = plan.tasks.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export function taskHref(task: PlannedTask, date: string): string {
  const context = new URLSearchParams({ date, taskId: task.id });
  if (task.kind === "practice") return `/learn/practice/${encodeURIComponent(task.refId)}?${context.toString()}`;
  if (task.kind === "review") {
    return `/learn/review?${new URLSearchParams({ cardId: task.refId, date, taskId: task.id }).toString()}`;
  }
  return "/explore";
}
