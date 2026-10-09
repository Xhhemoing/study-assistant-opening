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
const retest = (n: number, recommendedAt: string, overrides: Partial<TaskItem> = {}): TaskItem =>
  task(n, {
    retest: {
      candidateId: id(90 + n),
      activityId: id(80 + n),
      courseId: id(70),
      skillLabel: "fractions",
      prompt: `隔天重做原题：${n}`,
      recommendedAt,
    },
    ...overrides,
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
    const future = retest(1, "2026-09-16T10:00:00.000Z");
    const dueToday = retest(2, at("10:00"));
    const ordinary = task(3);
    const result = planDay([future, dueToday, ordinary], [slot("09:00", "12:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
    });
    // Ordinary fills the morning prefix; retest starts at recommendedAt (10:00).
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(3), id(2)]);
    expect(result.blocks.find((b) => b.taskId === id(2))).toMatchObject({
      start: at("10:00"), end: at("10:30"),
    });
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("schedules a retest on the day its recommendedAt falls", () => {
    const due = retest(1, at("08:00"));
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

  // research §5.2 for day-planner / retest earliest was not found in docs;
  // cover the required earliest-clamp + prefix-preservation behavior below.

  it("does not schedule an afternoon retest before recommendedAt when planningNow is earlier", () => {
    const afternoon = retest(1, at("14:00"));
    const result = planDay([afternoon], [slot("09:00", "17:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
      planningNow: at("08:00"),
    });
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks).toEqual([{
      taskId: id(1), start: at("14:00"), end: at("14:30"), reason: expect.any(String),
    }]);
  });

  it("keeps the empty slot prefix usable for other tasks after placing a future retest", () => {
    // Prefer retest first so it would greedily take 09:00 without the earliest clamp.
    const afternoon = retest(1, at("14:00"), { priority: 10 });
    const ordinary = task(2, { priority: 1 });
    const result = planDay([afternoon, ordinary], [slot("09:00", "17:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
      planningNow: at("08:00"),
      preferredOrder: [id(1), id(2)],
    });
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => ({ taskId, start, end }))).toEqual([
      { taskId: id(2), start: at("09:00"), end: at("09:30") },
      { taskId: id(1), start: at("14:00"), end: at("14:30") },
    ]);
  });

  it("clamps ordinary tasks to planningNow without changing confirmed-plan semantics", () => {
    const result = planDay([task(1)], [slot("09:00", "12:00")], {
      planningNow: at("10:00"),
    });
    expect(result.blocks).toEqual([{
      taskId: id(1), start: at("10:00"), end: at("10:30"), reason: expect.any(String),
    }]);
    // planDay only proposes; inputs and task status are untouched (no accept side effects).
    const input = task(1, { status: "pending" });
    const before = structuredClone(input);
    planDay([input], [slot("09:00", "12:00")], { planningNow: at("10:00") });
    expect(input).toEqual(before);
    expect(input.status).toBe("pending");
  });

  it("leaves a retest unscheduled when recommendedAt leaves no room before dueAt", () => {
    const squeezed = retest(1, at("15:00"), { dueAt: at("15:20"), minutes: 30 });
    const result = planDay([squeezed], [slot("09:00", "17:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
      planningNow: at("08:00"),
    });
    expect(result.blocks).toEqual([]);
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
  });
});
