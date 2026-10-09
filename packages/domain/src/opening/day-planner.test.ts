import { describe, expect, it } from "vitest";
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay } from "./day-planner";

const at = (clock: string) => `2026-09-14T${clock}:00.000Z`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `任务${n}`, minutes: 30, dueAt: null, priority: 1, status: "pending", ...overrides,
});
const slot = (start: string, end: string, kind: TimeBlock["kind"] = "free"): TimeBlock => ({
  start: at(start), end: at(end), kind,
});

describe("planDay", () => {
  it("leaves tasks unscheduled instead of inventing free time", () => {
    expect(planDay([task(1)], [])).toEqual({ blocks: [], unscheduledTaskIds: [id(1)] });
  });

  it("fits exact boundaries, producing a concrete task and reason", () => {
    const result = planDay([task(1)], [slot("09:00", "09:30")]);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks).toEqual([{
      taskId: id(1), start: at("09:00"), end: at("09:30"), reason: expect.any(String),
    }]);
    expect(result.blocks[0]?.reason.length).toBeGreaterThan(0);
  });

  it("orders by confirmed deadline, descending priority, then stable ID", () => {
    const result = planDay([
      task(4, { priority: 100 }), task(3, { dueAt: at("13:00"), priority: 2 }),
      task(2, { dueAt: at("12:00") }), task(1, { dueAt: at("13:00"), priority: 2 }),
      task(5, { dueAt: at("13:00"), priority: 3 }),
    ], [slot("08:00", "12:00")]);
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(2), id(5), id(1), id(3), id(4)]);
  });

  it("protects all hard constraints, with no overlap or silent task splitting", () => {
    const result = planDay([task(1, { minutes: 60 }), task(2), task(3)], [
      slot("08:00", "12:00"), slot("08:00", "09:00", "sleep"),
      slot("09:30", "10:30", "class"), slot("11:00", "11:30", "meal"),
      slot("11:30", "12:00", "locked"),
    ]);
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
    expect(result.blocks.map(({ taskId, start, end }) => ({ taskId, start, end }))).toEqual([
      { taskId: id(2), start: at("09:00"), end: at("09:30") },
      { taskId: id(3), start: at("10:30"), end: at("11:00") },
    ]);
  });

  it("does not allocate the same minutes twice across overlapping free slots", () => {
    const result = planDay([task(1), task(2), task(3)], [slot("09:00", "09:45"), slot("09:15", "10:00")]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[1]?.start).toBe(at("09:30"));
    expect(result.unscheduledTaskIds).toEqual([id(3)]);
  });

  it("does not silently schedule overdue work after its deadline", () => {
    const result = planDay([
      task(1, { dueAt: at("08:00") }), task(2, { dueAt: at("09:15") }),
      task(3, { dueAt: at("09:30") }), task(4),
    ], [slot("09:00", "10:00")]);
    expect(result.unscheduledTaskIds).toEqual([id(1), id(2)]);
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(3), id(4)]);
  });

  it("skips done and skipped tasks without treating them as unfinished", () => {
    expect(planDay([task(1, { status: "done" }), task(2, { status: "skipped" })], []))
      .toEqual({ blocks: [], unscheduledTaskIds: [] });
  });

  it("tries a later slot for large tasks without wasting earlier small slots", () => {
    const result = planDay([task(1, { minutes: 60 }), task(2)], [slot("09:00", "09:30"), slot("10:00", "11:00")]);
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(2), id(1)]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("rejects duplicate task identities rather than scheduling them twice", () => {
    expect(() => planDay([task(1), task(1)], [slot("09:00", "10:00")])).toThrow(/duplicate/i);
  });

  it.each([0, -1, 0.5, Number.NaN, 1441])("rejects invalid duration %s", (minutes) => {
    expect(() => planDay([task(1, { minutes })], [slot("09:00", "10:00")])).toThrow();
  });

  it("is deterministic under input reordering and does not mutate inputs", () => {
    const tasks = [task(3), task(1), task(2)];
    const slots = [slot("11:00", "12:00"), slot("09:00", "10:00")];
    const original = structuredClone({ tasks, slots });
    expect(planDay(tasks, slots)).toEqual(planDay([...tasks].reverse(), [...slots].reverse()));
    expect({ tasks, slots }).toEqual(original);
  });

  it("skips retest tasks whose recommendedAt is after the planning day end", () => {
    const future = task(1, {
      retest: {
        candidateId: id(9),
        activityId: id(8),
        courseId: id(7),
        skillLabel: "fractions",
        prompt: "隔天重做原题（先不看之前的答案）：1/2+1/3",
        recommendedAt: "2026-09-16T10:00:00.000Z",
      },
    });
    const dueToday = task(2, {
      retest: {
        candidateId: id(6),
        activityId: id(5),
        courseId: id(7),
        skillLabel: "fractions",
        prompt: "隔天重做原题（先不看之前的答案）：2/3",
        recommendedAt: at("10:00"),
      },
    });
    const ordinary = task(3);
    const result = planDay([future, dueToday, ordinary], [slot("09:00", "12:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
    });
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(2), id(3)]);
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("schedules a retest on the day its recommendedAt falls", () => {
    const due = task(1, {
      retest: {
        candidateId: id(9),
        activityId: id(8),
        courseId: id(7),
        skillLabel: "fractions",
        prompt: "隔天重做",
        recommendedAt: at("08:00"),
      },
    });
    const result = planDay([due], [slot("09:00", "10:00")], { dayEnd: "2026-09-14T23:59:59.999Z" });
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(1)]);
  });

  it("keeps ordinary dueAt deadline behavior unchanged", () => {
    const result = planDay([
      task(1, { dueAt: at("08:00") }),
      task(2, { dueAt: at("10:00") }),
    ], [slot("09:00", "11:00")], { dayEnd: "2026-09-14T23:59:59.999Z" });
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(2)]);
  });
});
