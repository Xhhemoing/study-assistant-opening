import type { CourseGoal, GoalLearningContext } from "@aistudy/contracts";

/** Product policy defaults, adjustable after real use; not calibrated learning constants. */
const EXAM_WINDOW_DAYS = 14;
const PREREQUISITE_MINUTES = { exam: 5, understand: 10 } as const;

/** Resolve calendar dates in the caller's local day, without host-timezone conversion. */
export function resolveGoalLearningContext(goal: CourseGoal | null, date: string): GoalLearningContext {
  const dates = [goal?.targetDate, ...(goal?.milestones ?? [])
    .filter(milestone => milestone.status !== "confirmed_by_learner")
    .map(milestone => milestone.targetDate)]
    .filter((target): target is string => target != null && target >= date)
    .sort();
  const targetDate = dates[0] ?? null;
  const daysRemaining = targetDate === null ? null
    : Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const selected = goal?.learningMode ?? "auto";
  const near = daysRemaining !== null && daysRemaining <= EXAM_WINDOW_DAYS;
  const mode = selected === "auto" ? near ? "exam" : "understand" : selected;
  return {
    mode,
    reasonCode: selected === "exam" ? "selected_exam" : selected === "understand" ? "selected_understand"
      : near ? "deadline_near" : "long_term",
    targetDate,
    daysRemaining,
    priority: goal?.priority ?? 0,
    prerequisiteBudgetMinutes: PREREQUISITE_MINUTES[mode],
  };
}

/** Explicit goal priority wins; imminent targets break ties. No goal keeps legacy ordering. */
export function goalPlanningPriority(context: GoalLearningContext): number {
  const imminent = context.daysRemaining !== null && context.daysRemaining <= EXAM_WINDOW_DAYS;
  return context.priority * 10 + (imminent ? 5 : 0);
}

export function goalPlanningReason(context: GoalLearningContext): string {
  const action = context.mode === "exam" ? "应试练习" : "理解与应用";
  const timing = context.daysRemaining !== null && context.daysRemaining <= EXAM_WINDOW_DAYS
    ? context.daysRemaining === 0 ? `目标今天到期，优先安排${action}` : `距离目标 ${context.daysRemaining} 天，优先安排${action}`
    : "按当前学习目标优先安排";
  return context.priority > 0 ? `${timing}（目标优先级 ${context.priority}）` : timing;
}
