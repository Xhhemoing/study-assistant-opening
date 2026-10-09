import type { StudyGoal, StudyGoalInput } from "@aistudy/contracts";
export { GOAL_SCENARIOS, formatExamDate, goalPath, scenarioLabel } from "../courses/goal-presentation";

export const GOAL_WIZARD_STEPS = ["scenario", "examDate", "subjects", "dailyMinutes"] as const;
export type GoalWizardStep = (typeof GOAL_WIZARD_STEPS)[number];

export type GoalDraft = Required<Pick<StudyGoalInput, "title" | "scenario" | "examDate" | "subjects" | "dailyMinutes" | "courseId">>;

export function defaultGoalInput(courseId: string | null = null): GoalDraft {
  return {
    title: "未命名目标",
    scenario: "final",
    examDate: null,
    subjects: [],
    dailyMinutes: 45,
    courseId,
  };
}

export function normalizeGoalTitle(value: string): string | null {
  const title = value.trim();
  return title ? title : null;
}

export function goalDraftFromGoal(goal: StudyGoal): GoalDraft {
  return {
    title: goal.title,
    scenario: goal.scenario,
    examDate: goal.examDate,
    subjects: goal.subjects,
    dailyMinutes: goal.dailyMinutes,
    courseId: goal.courseId,
  };
}

export function clampDailyMinutes(value: number): number {
  if (!Number.isFinite(value)) return 45;
  return Math.min(120, Math.max(15, Math.round(value)));
}



