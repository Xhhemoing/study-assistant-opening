import { describe, expect, it } from "vitest";
import type { TodayPlan } from "@aistudy/contracts";
import { getPlanCompletion, taskHref } from "./today-plan-model";

const plan: TodayPlan = {
  id: "plan-user-2026-08-03",
  ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  date: "2026-08-03",
  budgetMinutes: 45,
  totalMinutes: 15,
  tasks: [
    {
      id: "task-practice",
      kind: "practice",
      refId: "practice/1",
      title: "练习",
      estimatedMinutes: 10,
      reason: "建立基线",
      locked: false,
      status: "done",
    },
    {
      id: "task-review",
      kind: "review",
      refId: "card/1",
      title: "复习",
      estimatedMinutes: 5,
      reason: "今日到期",
      locked: false,
      status: "pending",
    },
  ],
  options: [],
  strategyVersion: "plan-1",
  generatedAt: "2026-08-03T00:00:00.000Z",
  evidenceSnapshotId: "snap-plan-ui",
};

describe("today plan model", () => {
  it("calculates completion from task statuses", () => {
    expect(getPlanCompletion(plan)).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it("encodes task entry points without losing task context", () => {
    expect(taskHref(plan.tasks[0]!, plan.date)).toBe("/learn/practice/practice%2F1?date=2026-08-03&taskId=task-practice");
    expect(taskHref(plan.tasks[1]!, plan.date)).toBe("/learn/review?cardId=card%2F1&date=2026-08-03&taskId=task-review");
  });
});
