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

it("uses the shorter gap for a carry-over and keeps first fit for ordinary work", () => {
  const date = "2026-09-14", timeZone = "UTC";
  const at = (time: string) => `${date}T${time}:00.000Z`;
  const now = new Date(at("08:00"));
  const pinned = { ...fixed, minutes: 10, notBefore: at("11:00"), dueAt: at("11:10") };
  const ordinary = { ...carry, id: "00000000-0000-4000-8000-000000000003", title: "Ordinary" };
  const tasks = [carry, pinned, ordinary];
  const { orderedTaskIds } = rankForPlan({
    tasks, suggestions: [], date, timeZone, now,
    yesterdayAccepted: [{
      taskId: carry.id, start: "2026-09-13T09:00:00.000Z", end: "2026-09-13T09:30:00.000Z", reason: "accepted",
    }],
  });
  const plan = planDay(tasks, [{ start: at("09:00"), end: at("12:20"), kind: "free" }], {
    localDate: date, timeZone, planningNow: now.toISOString(), preferredOrder: orderedTaskIds,
  });
  expect(plan.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
    [ordinary.id, at("09:00"), at("09:30")],
    [pinned.id, at("11:00"), at("11:10")],
    [carry.id, at("11:10"), at("11:40")],
  ]);
  expect(plan.unscheduled).toEqual([]);
});
