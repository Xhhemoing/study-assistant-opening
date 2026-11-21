import { describe, expect, it } from "vitest";
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import { planDay, taskNotBeforeAt } from "./day-planner";

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
    expect(planDay([task(1)], [])).toEqual({
      blocks: [],
      unscheduledTaskIds: [id(1)],
      unscheduled: [{ taskId: id(1), reason: "duration_exceeds_free_slots" }],
    });
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
      .toEqual({ blocks: [], unscheduledTaskIds: [], unscheduled: [] });
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

  it("treats a deferral's notBefore like a retest not-before", () => {
    const deferredToTomorrow = task(1, { notBefore: "2026-09-15T00:00:00.000Z" });
    const deferredToLater = task(2, { notBefore: at("10:30") });
    const ordinary = task(3);
    const result = planDay([deferredToTomorrow, deferredToLater, ordinary], [slot("09:00", "12:00")], {
      dayEnd: "2026-09-14T23:59:59.999Z",
    });
    // Tomorrow's deferral is neither placed nor reported unscheduled; today's starts at notBefore.
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(3), id(2)]);
    expect(result.blocks.find((b) => b.taskId === id(2))).toMatchObject({ start: at("10:30") });
    expect(result.unscheduledTaskIds).toEqual([]);
  });

  it("uses the later of retest recommendedAt and notBefore", () => {
    expect(taskNotBeforeAt(retest(1, at("10:00"), { notBefore: at("11:00") }))).toBe(at("11:00"));
    expect(taskNotBeforeAt(retest(1, at("12:00"), { notBefore: at("11:00") }))).toBe(at("12:00"));
    expect(taskNotBeforeAt(task(1))).toBeNull();
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

  it("handles the 3-way delayed retest window comparison on Friday 19:15-19:40 UTC", () => {
    const fridaySlot: TimeBlock[] = [
      { start: "2026-10-16T19:15:00.000Z", end: "2026-10-16T19:40:00.000Z", kind: "free" },
    ];
    const thursdayEarliest = "2026-10-15T19:00:00.000Z";
    const fourteenDayDeadline = "2026-10-26T19:00:00.000Z";

    // 1) True 14-day hard deadline -> schedules the complete 25-minute Friday slot.
    const realWindow = retest(1, thursdayEarliest, {
      minutes: 25,
      notBefore: thursdayEarliest,
      dueAt: fourteenDayDeadline,
    });
    const scheduled = planDay([realWindow], fridaySlot, {
      localDate: "2026-10-16",
      timeZone: "UTC",
      planningNow: "2026-10-16T10:00:00.000Z",
    });
    expect(scheduled.unscheduled).toEqual([]);
    expect(scheduled.blocks).toEqual([{
      taskId: id(1),
      start: "2026-10-16T19:15:00.000Z",
      end: "2026-10-16T19:40:00.000Z",
      reason: expect.any(String),
    }]);

    // 2) Confirmed earlier hard deadline (Friday 19:30) -> blocked with no_slot_before_deadline.
    const earlierRetest = retest(2, thursdayEarliest, {
      minutes: 25,
      notBefore: thursdayEarliest,
      dueAt: "2026-10-16T19:30:00.000Z",
    });
    const earlierOrdinary = task(3, {
      minutes: 25,
      dueAt: "2026-10-16T19:30:00.000Z",
    });
    const blocked = planDay([earlierRetest, earlierOrdinary], fridaySlot, {
      localDate: "2026-10-16",
      timeZone: "UTC",
      planningNow: "2026-10-16T10:00:00.000Z",
    });
    expect(blocked.blocks).toEqual([]);
    expect(blocked.unscheduled).toEqual([
      { taskId: id(2), reason: "no_slot_before_deadline" },
      { taskId: id(3), reason: "no_slot_before_deadline" },
    ]);

    // 3) Truly past the 14-day hard deadline -> still returns deadline_passed.
    const afterDeadline = planDay(
      [realWindow],
      [{ start: "2026-10-27T19:15:00.000Z", end: "2026-10-27T19:40:00.000Z", kind: "free" }],
      {
        localDate: "2026-10-27",
        timeZone: "UTC",
        planningNow: "2026-10-27T10:00:00.000Z",
      },
    );
    expect(afterDeadline.blocks).toEqual([]);
    expect(afterDeadline.unscheduled).toEqual([{ taskId: id(1), reason: "deadline_passed" }]);
  });

  it("uses scheduledStartAt ?? recommendedAt alongside task.notBefore without pulling another day's reservation", () => {
    const base = retest(1, at("12:00"), { notBefore: at("10:00") });
    // Explicit scheduledStartAt overrides recommendedAt (earlier than recommendedAt, still >= notBefore).
    const reservedEarlier: TaskItem = {
      ...base,
      retest: { ...base.retest!, scheduledStartAt: at("10:30") },
    };
    expect(taskNotBeforeAt(reservedEarlier)).toBe(at("10:30"));

    // Explicit scheduledStartAt earlier than protocol notBefore still honors task.notBefore.
    const reservedTooEarly: TaskItem = {
      ...base,
      retest: { ...base.retest!, scheduledStartAt: at("09:00") },
    };
    expect(taskNotBeforeAt(reservedTooEarly)).toBe(at("10:00"));

    // Explicit scheduledStartAt later than recommendedAt delays start and preserves prefix.
    const reservedLater: TaskItem = {
      ...base,
      retest: { ...base.retest!, scheduledStartAt: at("14:00") },
    };
    expect(taskNotBeforeAt(reservedLater)).toBe(at("14:00"));
    const sameDay = planDay([reservedLater, task(2)], [slot("09:00", "16:00")], {
      localDate: "2026-09-14",
      timeZone: "UTC",
    });
    expect(sameDay.blocks.map(({ taskId, start, end }) => ({ taskId, start, end }))).toEqual([
      { taskId: id(2), start: at("09:00"), end: at("09:30") },
      { taskId: id(1), start: at("14:00"), end: at("14:30") },
    ]);

    // Reservation on a later day is skipped on today's single-day plan (never moved into today).
    const reservedTomorrow: TaskItem = {
      ...base,
      retest: { ...base.retest!, scheduledStartAt: "2026-09-15T10:00:00.000Z" },
    };
    const todayOnly = planDay([reservedTomorrow], [slot("09:00", "16:00")], {
      localDate: "2026-09-14",
      timeZone: "UTC",
    });
    expect(todayOnly).toEqual({ blocks: [], unscheduledTaskIds: [], unscheduled: [] });
  });

  it("pins explicit scheduledStartAt to its workspace-timezone calendar day (blocks both Thursday-on-Friday and Saturday-on-Friday)", () => {
    const fridaySlot: TimeBlock[] = [
      { start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T20:00:00.000Z", kind: "free" },
    ];
    const thursdayReserved = retest(1, "2026-10-15T19:00:00.000Z", {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
    });
    thursdayReserved.retest = {
      ...thursdayReserved.retest!,
      scheduledStartAt: "2026-10-15T19:15:00.000Z",
    };
    const saturdayReserved = retest(2, "2026-10-15T19:00:00.000Z", {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
    });
    saturdayReserved.retest = {
      ...saturdayReserved.retest!,
      scheduledStartAt: "2026-10-17T19:15:00.000Z",
    };

    // Neither Thursday's reservation nor Saturday's reservation may enter Friday.
    expect(planDay([thursdayReserved, saturdayReserved], fridaySlot, {
      localDate: "2026-10-16",
      timeZone: "UTC",
      planningNow: "2026-10-16T18:00:00.000Z",
    })).toEqual({ blocks: [], unscheduledTaskIds: [], unscheduled: [] });

    // Thursday's reservation still schedules normally on Thursday.
    const thursdayPlan = planDay([thursdayReserved], [
      { start: "2026-10-15T19:00:00.000Z", end: "2026-10-15T20:00:00.000Z", kind: "free" },
    ], {
      localDate: "2026-10-15",
      timeZone: "UTC",
    });
    expect(thursdayPlan.blocks).toEqual([
      expect.objectContaining({
        taskId: id(1),
        start: "2026-10-15T19:15:00.000Z",
        end: "2026-10-15T19:40:00.000Z",
      }),
    ]);

    // Workspace timezone boundary (Asia/Shanghai = UTC+8):
    // 2026-10-15T15:30Z is Thursday 23:30 Shanghai -> excluded on Friday 2026-10-16.
    // 2026-10-15T16:30Z is Friday   00:30 Shanghai -> included on Friday 2026-10-16, excluded on Thursday & Saturday.
    const shanghaiThursdayLate = retest(3, "2026-10-15T15:00:00.000Z", {
      minutes: 25,
      dueAt: "2026-10-26T19:00:00.000Z",
    });
    shanghaiThursdayLate.retest = {
      ...shanghaiThursdayLate.retest!,
      scheduledStartAt: "2026-10-15T15:30:00.000Z",
    };
    const shanghaiFridayEarly = retest(4, "2026-10-15T15:00:00.000Z", {
      minutes: 25,
      dueAt: "2026-10-26T19:00:00.000Z",
    });
    shanghaiFridayEarly.retest = {
      ...shanghaiFridayEarly.retest!,
      scheduledStartAt: "2026-10-15T16:30:00.000Z",
    };
    const shanghaiFridaySlot: TimeBlock[] = [
      { start: "2026-10-15T16:00:00.000Z", end: "2026-10-15T18:00:00.000Z", kind: "free" },
    ];
    const shanghaiFridayPlan = planDay(
      [shanghaiThursdayLate, shanghaiFridayEarly],
      shanghaiFridaySlot,
      { localDate: "2026-10-16", timeZone: "Asia/Shanghai" },
    );
    expect(shanghaiFridayPlan.blocks).toEqual([
      expect.objectContaining({
        taskId: id(4),
        start: "2026-10-15T16:30:00.000Z",
        end: "2026-10-15T16:55:00.000Z",
      }),
    ]);
    expect(shanghaiFridayPlan.unscheduledTaskIds).toEqual([]);
  });
});

describe("bounded feasibility repair", () => {
  it.each([
    ["in deadline order", undefined],
    ["after the longer task was already placed", [id(2), id(1), id(3), id(4)]],
  ] as const)("preserves today's three deadlines amid a 40-minute carry-over %s", (_, preferredOrder) => {
    const result = planDay([
      task(1, { minutes: 10, notBefore: at("09:30"), dueAt: at("09:40") }),
      task(2, { minutes: 30, dueAt: at("10:30") }),
      task(3, { minutes: 20, notBefore: at("09:20"), dueAt: at("10:40") }),
      task(4, { minutes: 40, dueAt: "2026-09-15T10:30:00.000Z" }),
    ], [slot("09:00", "09:40"), slot("10:00", "10:30")], { preferredOrder });
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(2), at("09:00"), at("09:30")],
      [id(1), at("09:30"), at("09:40")],
      [id(3), at("10:00"), at("10:20")],
    ]);
    expect(result.unscheduledTaskIds).toEqual([id(4)]);
  });

  it("releases a reservation as soon as a placement makes it unusable", () => {
    const result = planDay([
      task(1, { minutes: 10, notBefore: at("09:30"), dueAt: at("09:40") }),
      task(2, { minutes: 30, dueAt: at("10:30") }),
      task(3, { minutes: 40, dueAt: "2026-09-15T10:30:00.000Z" }),
    ], [slot("09:00", "09:40"), slot("10:00", "10:30")]);
    expect(result.blocks.map(({ taskId, start }) => [taskId, start])).toEqual([
      [id(2), at("09:00")],
      [id(1), at("09:30")],
    ]);
    expect(result.unscheduledTaskIds).toEqual([id(3)]);
  });

  it("places a preferred carry-over in the earliest shortest feasible gap", () => {
    const result = planDay([
      task(1, { minutes: 30 }), task(2, { minutes: 60 }),
    ], [
      slot("09:00", "10:00"), slot("11:00", "11:35"),
      slot("12:00", "12:30"), slot("13:00", "13:30"),
    ], { preferredOrder: [id(1), id(2)] });
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(2), at("09:00"), at("10:00")],
      [id(1), at("12:00"), at("12:30")],
    ]);
    expect(result.unscheduled).toEqual([]);
  });

  it("protects a sole feasible gap before applying the carry-over best fit", () => {
    const result = planDay([
      task(1, { minutes: 30 }),
      task(2, { minutes: 30, notBefore: at("11:00"), dueAt: "2026-09-15T10:30:00.000Z" }),
    ], [slot("09:00", "10:00"), slot("11:00", "11:30")], {
      preferredOrder: [id(1), id(2)],
    });
    expect(result.blocks.map(({ taskId, start }) => [taskId, start])).toEqual([
      [id(1), at("09:00")], [id(2), at("11:00")],
    ]);
    expect(result.unscheduled).toEqual([]);
  });

  it("saves the only long pre-deadline slot for the task that needs it", () => {
    const tasks = [
      task(1, { minutes: 20, dueAt: at("10:30") }),
      task(2, { minutes: 40, dueAt: at("10:40") }),
    ];
    const windows = [slot("09:00", "09:40"), slot("10:00", "10:20")];
    const result = planDay(tasks, windows);
    expect(result.unscheduled).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(2), at("09:00"), at("09:40")],
      [id(1), at("10:00"), at("10:20")],
    ]);
    expect(planDay([...tasks].reverse(), [...windows].reverse())).toEqual(result);
  });

  it("protects a hard deadline against a preferred undated carry-over", () => {
    const result = planDay([task(1), task(2, { dueAt: at("09:30") })], [
      slot("09:00", "09:30"),
    ], { preferredOrder: [id(1), id(2)] });
    expect(result.blocks.map(block => block.taskId)).toEqual([id(2)]);
    expect(result.unscheduledTaskIds).toEqual([id(1)]);
  });

  it("relocates two draft blocks to make a contiguous deadline window", () => {
    const tasks = [
      task(1, { minutes: 10, dueAt: at("10:00"), notBefore: at("09:00") }),
      retest(2, at("09:05"), { minutes: 10, dueAt: at("10:00") }),
      task(3, { minutes: 40, dueAt: at("09:40") }),
    ];
    const windows = [slot("08:50", "10:10"), slot("10:00", "10:05", "locked")];
    const result = planDay(tasks, windows, {
      planningNow: at("09:00"), preferredOrder: [id(1), id(2), id(3)],
    });
    expect(result.unscheduled).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(3), at("09:00"), at("09:40")],
      [id(1), at("09:40"), at("09:50")],
      [id(2), at("09:50"), at("10:00")],
    ]);
  });

  it("tries the next occupied window after a relocation would miss its deadline", () => {
    const result = planDay([
      task(1, { minutes: 20, dueAt: at("10:20") }),
      task(2, { minutes: 20, dueAt: at("11:20"), notBefore: at("10:00") }),
      task(3, { minutes: 40, dueAt: at("10:40") }),
    ], [slot("09:00", "09:40"), slot("10:00", "10:40"), slot("11:00", "11:20")], {
      preferredOrder: [id(1), id(2), id(3)],
    });
    expect(result.unscheduled).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(1), at("09:00"), at("09:20")],
      [id(3), at("10:00"), at("10:40")],
      [id(2), at("11:00"), at("11:20")],
    ]);
  });

  it("keeps the original placement after a failed repair and leaves locked time untouched", () => {
    const result = planDay([
      task(1, { minutes: 20, notBefore: at("09:10"), dueAt: at("09:30") }),
      task(2, { minutes: 40, dueAt: at("09:40") }),
      task(3, { minutes: 20 }),
    ], [slot("09:00", "10:10"), slot("09:40", "09:50", "locked")]);
    expect(result.unscheduled).toEqual([{ taskId: id(2), reason: "free_time_exhausted" }]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(1), at("09:10"), at("09:30")],
      [id(3), at("09:50"), at("10:10")],
    ]);
  });

  it("supports explicit options.carryOverTaskIds in a single split window without symbol metadata", () => {
    const pinned = task(1, { minutes: 10, notBefore: at("11:00"), dueAt: at("11:10") });
    const carry = task(2, { minutes: 30, priority: 5 });
    const ordinary = task(3, { minutes: 30, priority: 1 });
    const result = planDay([carry, pinned, ordinary], [slot("09:00", "12:20")], {
      localDate: "2026-09-14",
      timeZone: "UTC",
      planningNow: at("08:00"),
      preferredOrder: [pinned.id, carry.id, ordinary.id],
      carryOverTaskIds: new Set([carry.id]),
    });
    expect(result.unscheduled).toEqual([]);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [ordinary.id, at("09:00"), at("09:30")],
      [pinned.id, at("11:00"), at("11:10")],
      [carry.id, at("11:10"), at("11:40")],
    ]);
  });

  it.each([
    ["default dayEnd", undefined],
    ["explicit localDate/timeZone with future task ranked first", {
      localDate: "2026-09-14",
      timeZone: "UTC",
      preferredOrder: [id(6), id(1), id(2), id(3), id(4), id(5)],
    }],
  ] as const)("does not let a tomorrow-deadline reservation steer today's deadlines (%s)", (_, options) => {
    const result = planDay([
      task(1, { minutes: 10, dueAt: at("12:00") }),
      task(2, { minutes: 10, dueAt: at("12:00") }),
      task(3, { minutes: 10, dueAt: at("12:00") }),
      task(4, { minutes: 60, notBefore: at("11:00"), dueAt: at("14:00") }),
      task(5, { minutes: 60, notBefore: at("11:00"), dueAt: at("14:00") }),
      task(6, { minutes: 90, dueAt: "2026-09-15T10:00:00.000Z" }),
    ], [
      slot("09:00", "10:30"),
      slot("11:00", "12:00"),
      slot("13:00", "14:00"),
    ], options);
    expect(result.blocks.map(({ taskId, start, end }) => [taskId, start, end])).toEqual([
      [id(1), at("09:00"), at("09:10")],
      [id(2), at("09:10"), at("09:20")],
      [id(3), at("09:20"), at("09:30")],
      [id(4), at("11:00"), at("12:00")],
      [id(5), at("13:00"), at("14:00")],
    ]);
    expect(result.unscheduled).toEqual([{ taskId: id(6), reason: "free_time_exhausted" }]);
  });

  it("does not let a later future-deadline reservation starve earlier future deadlines while still guarding against undated carry-over", () => {
    const earlierFuture = planDay([
      task(1, { minutes: 10, dueAt: "2026-09-15T12:00:00.000Z" }),
      task(2, { minutes: 10, dueAt: "2026-09-15T12:00:00.000Z" }),
      task(3, { minutes: 10, dueAt: "2026-09-15T12:00:00.000Z" }),
      task(4, { minutes: 60, notBefore: at("11:00"), dueAt: "2026-09-15T14:00:00.000Z" }),
      task(5, { minutes: 60, notBefore: at("11:00"), dueAt: "2026-09-15T14:00:00.000Z" }),
      task(6, { minutes: 90, dueAt: "2026-09-16T10:00:00.000Z" }),
    ], [
      slot("09:00", "10:30"),
      slot("11:00", "12:00"),
      slot("13:00", "14:00"),
    ]);
    expect(earlierFuture.blocks.map(({ taskId }) => taskId)).toEqual([id(1), id(2), id(3), id(4), id(5)]);
    expect(earlierFuture.unscheduled).toEqual([{ taskId: id(6), reason: "free_time_exhausted" }]);

    const carryOverVsFuture = planDay([
      task(1, { minutes: 10 }),
      task(2, { minutes: 10 }),
      task(3, { minutes: 10 }),
      task(4, { minutes: 30, notBefore: at("11:00"), dueAt: "2026-09-15T10:30:00.000Z" }),
    ], [slot("09:00", "10:00"), slot("11:00", "11:30")], {
      preferredOrder: [id(1), id(2), id(3), id(4)],
    });
    expect(carryOverVsFuture.unscheduled).toEqual([]);
    expect(carryOverVsFuture.blocks.map(({ taskId, start }) => [taskId, start])).toEqual([
      [id(1), at("09:00")],
      [id(2), at("09:10")],
      [id(3), at("09:20")],
      [id(4), at("11:00")],
    ]);
  });
});
