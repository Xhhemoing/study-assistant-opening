import { expect, it } from "vitest";
import type { TaskItem } from "@aistudy/contracts";
import { planDay } from "../day-planner";
import { rankForPlan } from "./rank-for-plan";

const carry: TaskItem = {
  id: "00000000-0000-4000-8000-000000000001", title: "Carry-over", minutes: 30,
  dueAt: null, priority: 5, status: "pending",
};
const fixed: TaskItem = {
  ...carry, id: "00000000-0000-4000-8000-000000000002", title: "Hard deadline", priority: 1,
  dueAt: "2026-09-15T07:00:00.000Z",
};

it("ranks a next-local-midnight deadline ahead of carry-over before assigning the sole window", () => {
  const date = "2026-09-14", timeZone = "America/Los_Angeles";
  const now = new Date("2026-09-15T06:00:00.000Z");
  const tasks = [carry, fixed];
  const ranked = rankForPlan({
    tasks, suggestions: [], date, timeZone, now,
    yesterdayAccepted: [{
      taskId: carry.id, start: "2026-09-14T06:00:00.000Z", end: "2026-09-14T06:30:00.000Z", reason: "accepted",
    }],
  });
  expect(ranked.orderedTaskIds).toEqual([fixed.id, carry.id]);
  expect(ranked.reasons[fixed.id]?.code).toBe("deadline");
  expect(ranked.reasons[carry.id]?.code).toBe("carry_over");
  const plan = planDay(tasks, [{
    start: "2026-09-15T06:30:00.000Z", end: "2026-09-15T07:00:00.000Z", kind: "free",
  }], { localDate: date, timeZone, planningNow: now.toISOString(), preferredOrder: ranked.orderedTaskIds });
  expect(plan.blocks.map(block => block.taskId)).toEqual([fixed.id]);
  expect(plan.unscheduledTaskIds).toEqual([carry.id]);
});
