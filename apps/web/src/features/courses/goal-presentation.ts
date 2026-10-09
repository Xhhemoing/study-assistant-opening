import type { ScenarioPreset, StudyGoal } from "@aistudy/contracts";

export const GOAL_SCENARIOS: Array<{
  value: ScenarioPreset;
  label: string;
  description: string;
}> = [
  { value: "final", label: "课程 / 期末", description: "围绕一门课程建立稳定节奏。" },
  { value: "gaokao", label: "高考", description: "优先补齐薄弱点，再保持熟练度。" },
  { value: "kaoyan", label: "考研", description: "为长期备考安排可持续的每日投入。" },
  { value: "custom", label: "自定义", description: "从一个明确的个人学习方向开始。" },
];

const SCENARIO_LABELS: Record<ScenarioPreset, string> = Object.fromEntries(
  GOAL_SCENARIOS.map((item) => [item.value, item.label]),
) as Record<ScenarioPreset, string>;

export function scenarioLabel(scenario: ScenarioPreset): string {
  return SCENARIO_LABELS[scenario];
}

export function formatExamDate(examDate: string | null): string {
  if (!examDate) return "暂不设置";
  const [year, month, day] = examDate.split("-").map(Number);
  if (!year || !month || !day) return "暂不设置";
  return `${year}年${month}月${day}日`;
}

export function goalPath(id: string): string {
  return `/learn/goals/${encodeURIComponent(id)}`;
}

export type { StudyGoal };
