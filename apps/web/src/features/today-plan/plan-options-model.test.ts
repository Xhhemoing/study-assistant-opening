import { describe, expect, it } from "vitest";
import type { PlanOption, PlannedTask, TodayPlan } from "@aistudy/contracts";
import { applyPlanOption, needsOptionChoice } from "./plan-options-model";

const explore: PlannedTask = {
  id: "plan-2026-08-02-explore-protected",
  kind: "explore",
  refId: "protected-exploration",
  title: "自由探索",
  estimatedMinutes: 15,
  reason: "预留的探索时间，不被计划挤占",
  locked: true,
  status: "pending",
};

const optionA: PlanOption = {
  id: "option-final-exam",
  label: "期末优先",
  description: "先补未测考点，再做变式。",
  tasks: [
    {
      id: "plan-2026-08-02-practice-item-t1",
      kind: "practice",
      refId: "item-t1",
      title: "未测点",
      estimatedMinutes: 10,
      reason: "尚未测评，先建立基线",
      locked: false,
      status: "pending",
    },
    {
      id: "plan-2026-08-02-practice-item-t2",
      kind: "practice",
      refId: "item-t2",
      title: "另一未测点",
      estimatedMinutes: 10,
      reason: "尚未测评，先建立基线",
      locked: false,
      status: "pending",
    },
  ],
};

const optionB: PlanOption = {
  id: "option-maintenance",
  label: "保持优先",
  description: "只安排已会内容。",
  tasks: [
    {
      id: "plan-2026-08-02-practice-item-u1",
      kind: "practice",
      refId: "item-u1",
      title: "可用点",
      estimatedMinutes: 10,
      reason: "做一道变式保持手感",
      locked: false,
      status: "pending",
    },
  ],
};

const plan: TodayPlan = {
  id: "plan-user-2026-08-02",
  ownerUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  date: "2026-08-02",
  budgetMinutes: 45,
  totalMinutes: 15,
  tasks: [explore],
  options: [optionA, optionB],
  strategyVersion: "plan-1",
  generatedAt: "2026-08-02T00:00:00.000Z",
  evidenceSnapshotId: "snap-plan-01",
};

describe("plan option choice", () => {
  it("requires an explicit choice when conflicting options are present", () => {
    expect(needsOptionChoice(plan)).toBe(true);
    expect(needsOptionChoice({ ...plan, options: [] })).toBe(false);
  });

  it("still requires a choice when a locked practice task is already reserved", () => {
    const lockedPractice: PlannedTask = {
      ...optionA.tasks[0]!,
      locked: true,
    };
    expect(needsOptionChoice({ ...plan, tasks: [explore, lockedPractice] })).toBe(true);
  });

  it("applies the chosen option without dropping protected exploration", () => {
    const next = applyPlanOption(plan, "option-final-exam");
    expect(next.tasks.map((task) => task.refId)).toEqual(["protected-exploration", "item-t1", "item-t2"]);
    expect(needsOptionChoice(next)).toBe(false);
  });
});
