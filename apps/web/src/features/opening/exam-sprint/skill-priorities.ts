import type { ExamSprintOverview } from "@aistudy/contracts";

export function sprintSkillSupport(overview: ExamSprintOverview, skill: ExamSprintOverview["skills"][number]) {
  if (skill.status === "weak") return { priority: 0, label: "薄弱", reason: skill.reason };
  const latest = overview.attempts.filter(attempt => attempt.question.skillId === skill.skillId && attempt.answeredAt
    && !overview.state.runs.some(run => run.id === attempt.runId && run.mode.startsWith("mock") && !run.completedAt))
    .sort((left, right) => Date.parse(right.answeredAt!) - Date.parse(left.answeredAt!))[0];
  if (latest?.confidence !== null && latest?.confidence !== undefined && latest.confidence <= 2) {
    return { priority: 1, label: "不太确定", reason: `最近一次作答选择了“${latest.confidence === 1 ? "主要靠猜" : "不太确定"}”，可以先梳理关键步骤。` };
  }
  if (skill.status === "untested") return { priority: 2, label: "未测", reason: skill.reason };
  return null;
}
