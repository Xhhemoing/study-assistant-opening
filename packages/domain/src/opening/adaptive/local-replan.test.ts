import { describe, expect, it } from "vitest";
import type { PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { buildLocalReplan } from "./local-replan";
import { shouldOfferReplan } from "./replan-trigger";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (clock: string) => `2026-10-16T${clock}:00.000Z`;
const task = (n: number, extra: Partial<TaskItem> = {}): TaskItem => ({ id: id(n), version: 1, title: `任务${n}`, minutes: 30, status: "pending", dueAt: null, priority: 0, ...extra });
const block = (n: number, start: string, end: string): PlannedBlock => ({ taskId: id(n), start: at(start), end: at(end), reason: "已确认" });
const constraints: TimeBlock[] = [{ start: at("08:00"), end: at("18:00"), kind: "free" }];
const now = new Date(at("10:00"));
const build = (acceptedBlocks: PlannedBlock[], tasks: TaskItem[], preserveAll = false) => buildLocalReplan({ acceptedBlocks, tasks, constraints, now, preserveAll,
  options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
describe("local replanning", () => {
  it("preserves missed history and unaffected future work while filling unused space", () => {
    const baseline = [block(1, "09:00", "09:30"), block(2, "11:00", "11:30")];
    const result = build(baseline, [task(1), task(2), task(3)]);
    expect(result.fixedBlocks).toEqual(baseline);
    expect(result.blocks).toEqual(expect.arrayContaining(baseline));
    expect(result.blocks.filter(b => b.taskId === id(1))).toHaveLength(2);
    expect(result.blocks.filter(b => b.taskId === id(2))).toHaveLength(1);
    expect(shouldOfferReplan({ acceptedBlocks: result.blocks, tasks: [task(1), task(2), task(3)], now })).toEqual({ offer: false, taskIds: [], reason: null });
  });
  it("releases only future closed or deferred work and does not re-place deferrals", () => {
    const baseline = [block(1, "09:00", "09:30"), block(2, "11:00", "11:30"), block(3, "12:00", "12:30")];
    const result = build(baseline, [task(1, { status: "done" }), task(2, { status: "skipped", version: 2 }), task(3, { notBefore: at("19:00"), version: 2 }), task(4)]);
    expect(result.fixedBlocks).toEqual([baseline[0]]);
    expect(result.releasedTaskVersions.map(t => t.id)).toEqual([id(2), id(3)]);
    expect(result.blocks.some(b => b.taskId === id(3))).toBe(false);
    expect(result.blocks.some(b => b.taskId === id(4))).toBe(true);
  });
  it("preserveAll keeps closed future blocks for explicit conversation additions", () => {
    const baseline = [block(1, "11:00", "11:30")];
    expect(build(baseline, [task(1, { status: "done" }), task(2)], true).fixedBlocks).toEqual(baseline);
  });
  it("does not invent a change when all work is already arranged or deferred", () => {
    const baseline = [block(1, "11:00", "11:30")];
    expect(build(baseline, [task(1), task(2, { notBefore: at("19:00") })]).changed).toBe(false);
  });
  it("keeps an ongoing block and excludes new blocks from it", () => {
    const baseline = [block(1, "09:45", "10:30")];
    const result = build(baseline, [task(1), task(2)]);
    expect(result.fixedBlocks).toEqual(baseline);
    expect(result.blocks.find(b => b.taskId === id(2))?.start).toBe(at("10:30"));
  });
  it("conversation addition does not reschedule a missed baseline task", () => {
    const baseline = [block(1, "09:00", "09:30")];
    const result = buildLocalReplan({ acceptedBlocks: baseline, tasks: [task(1), task(2)], constraints, now,
      preserveAll: true, candidateTaskIds: new Set([id(2)]),
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
    expect(result.blocks.filter(block => block.taskId === id(1))).toEqual(baseline);
    expect(result.blocks.filter(block => block.taskId === id(2))).toHaveLength(1);
  });
  it("does not move a missed task whose learning is already active", () => {
    const baseline = [block(1, "09:00", "09:30")];
    const result = buildLocalReplan({ acceptedBlocks: baseline, tasks: [task(1)], constraints, now,
      excludedTaskIds: new Set([id(1)]), options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: at("10:01") } });
    expect(result.blocks).toEqual(baseline);
    expect(result.changed).toBe(false);
  });

  it("preserves a legal same-day future retest reservation in fixedBlocks and releases it only after user deferral", () => {
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const eveningConstraints: TimeBlock[] = [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }];
    const reservedBlock: PlannedBlock = {
      taskId: id(10),
      start: "2026-10-16T19:15:00.000Z",
      end: "2026-10-16T19:40:00.000Z",
      reason: "延迟复测预约",
    };
    const retestTask = task(10, {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
      retest: {
        candidateId: id(110),
        activityId: id(210),
        courseId: id(310),
        skillLabel: "矩阵秩",
        prompt: "延迟复测",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-16T19:15:00.000Z",
      },
    });
    const extraTask = task(11, { minutes: 30 });

    const kept = buildLocalReplan({
      acceptedBlocks: [reservedBlock],
      tasks: [retestTask, extraTask],
      constraints: eveningConstraints,
      now: fridayNow,
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
    });
    expect(kept.fixedBlocks).toEqual([reservedBlock]);
    expect(kept.releasedTaskVersions).toEqual([]);
    expect(kept.blocks).toEqual(expect.arrayContaining([reservedBlock]));
    expect(kept.blocks.some(b => b.taskId === id(11))).toBe(true);

    // User defers the task to 20:00 (> 19:15): fixed block MUST be released and not re-placed.
    const deferredRetest = { ...retestTask, version: 2, notBefore: "2026-10-16T20:00:00.000Z" };
    const released = buildLocalReplan({
      acceptedBlocks: [reservedBlock],
      tasks: [deferredRetest, extraTask],
      constraints: eveningConstraints,
      now: fridayNow,
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
    });
    expect(released.fixedBlocks).toEqual([]);
    expect(released.releasedTaskVersions).toEqual([{ id: id(10), version: 2, status: "pending" }]);
    expect(released.blocks.some(b => b.taskId === id(10))).toBe(false);
    expect(released.blocks.some(b => b.taskId === id(11))).toBe(true);
  });

  it("releases cross-day futureFixed retest reservations and excludes cross-day reservations from candidates", () => {
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const eveningConstraints: TimeBlock[] = [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }];
    const thursdayReserved = task(20, {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
      retest: {
        candidateId: id(120),
        activityId: id(220),
        courseId: id(320),
        skillLabel: "矩阵秩",
        prompt: "周四预约",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-15T19:15:00.000Z",
      },
    });
    const saturdayReserved = task(21, {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
      retest: {
        candidateId: id(121),
        activityId: id(221),
        courseId: id(320),
        skillLabel: "特征值",
        prompt: "周六预约",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-17T19:15:00.000Z",
      },
    });
    const forgedBlock: PlannedBlock = {
      taskId: id(20),
      start: "2026-10-16T19:15:00.000Z",
      end: "2026-10-16T19:40:00.000Z",
      reason: "跨日块",
    };

    const result = buildLocalReplan({
      acceptedBlocks: [forgedBlock],
      tasks: [thursdayReserved, saturdayReserved],
      constraints: eveningConstraints,
      now: fridayNow,
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
    });
    expect(result.fixedBlocks).toEqual([]);
    expect(result.releasedTaskVersions).toEqual([{ id: id(20), version: 1, status: "pending" }]);
    expect(result.blocks).toEqual([]);
  });

  it("releases an ordinary future block when deferred past now even if notBefore precedes block.start (matching replan-trigger)", () => {
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const eveningConstraints: TimeBlock[] = [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }];
    const ordinaryBlock: PlannedBlock = {
      taskId: id(30),
      start: "2026-10-16T19:15:00.000Z",
      end: "2026-10-16T19:45:00.000Z",
      reason: "已确认",
    };
    const deferredOrdinary = task(30, {
      version: 2,
      minutes: 30,
      notBefore: "2026-10-16T19:10:00.000Z",
    });
    const waitingTask = task(31, { minutes: 30 });

    expect(shouldOfferReplan({
      acceptedBlocks: [ordinaryBlock],
      tasks: [deferredOrdinary, waitingTask],
      now: fridayNow,
    })).toEqual({
      offer: true,
      taskIds: [id(31)],
      reason: "freed_time",
    });

    const result = buildLocalReplan({
      acceptedBlocks: [ordinaryBlock],
      tasks: [deferredOrdinary, waitingTask],
      constraints: eveningConstraints,
      now: fridayNow,
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
    });
    expect(result.fixedBlocks).toEqual([]);
    expect(result.releasedTaskVersions).toEqual([{ id: id(30), version: 2, status: "pending" }]);
    expect(result.blocks.some(b => b.taskId === id(30))).toBe(false);
    expect(result.blocks).toEqual([
      expect.objectContaining({ taskId: id(31), start: "2026-10-16T19:01:00.000Z", end: "2026-10-16T19:31:00.000Z" }),
    ]);
  });

  it("releases unstarted inactive retest blocks regardless of preserveAll while keeping already-started blocks", () => {
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const eveningConstraints: TimeBlock[] = [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }];
    const startedBlock: PlannedBlock = {
      taskId: id(40),
      start: "2026-10-16T18:50:00.000Z",
      end: "2026-10-16T19:15:00.000Z",
      reason: "进行中复测",
    };
    const futureBlock: PlannedBlock = {
      taskId: id(41),
      start: "2026-10-16T19:15:00.000Z",
      end: "2026-10-16T19:40:00.000Z",
      reason: "未开始复测",
    };
    const startedRetest = task(40, {
      minutes: 25,
      retest: {
        candidateId: id(140),
        activityId: id(240),
        courseId: id(340),
        skillLabel: "矩阵秩",
        prompt: "延迟复测",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-16T18:50:00.000Z",
      },
    });
    const inactiveRetest = task(41, {
      minutes: 25,
      retest: {
        candidateId: id(141),
        activityId: id(241),
        courseId: id(340),
        skillLabel: "特征值",
        prompt: "延迟复测",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-16T19:15:00.000Z",
      },
    });
    const inactiveIds = new Set([id(40), id(41)]);

    for (const preserveAll of [false, true]) {
      const result = buildLocalReplan({
        acceptedBlocks: [startedBlock, futureBlock],
        tasks: [startedRetest, inactiveRetest],
        constraints: eveningConstraints,
        now: fridayNow,
        preserveAll,
        inactiveRetestTaskIds: inactiveIds,
        options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
      });
      expect(result.changed).toBe(true);
      expect(result.fixedBlocks).toEqual([startedBlock]);
      expect(result.releasedTaskVersions).toEqual([{ id: id(41), version: 1, status: "pending" }]);
      expect(result.blocks).toEqual([startedBlock]);
    }
  });

  it("releases a forged cross-day block for a same-day reserved retest even under preserveAll", () => {
    const fridayNow = new Date("2026-10-16T19:00:00.000Z");
    const eveningConstraints: TimeBlock[] = [{ start: "2026-10-16T19:00:00.000Z", end: "2026-10-16T21:00:00.000Z", kind: "free" }];
    const fridayRetest = task(50, {
      minutes: 25,
      notBefore: "2026-10-15T19:00:00.000Z",
      dueAt: "2026-10-26T19:00:00.000Z",
      retest: {
        candidateId: id(150),
        activityId: id(250),
        courseId: id(350),
        skillLabel: "线性变换",
        prompt: "周五预约",
        recommendedAt: "2026-10-15T19:00:00.000Z",
        scheduledStartAt: "2026-10-16T19:15:00.000Z",
      },
    });
    const forgedSaturdayBlock: PlannedBlock = {
      taskId: id(50),
      start: "2026-10-17T19:15:00.000Z",
      end: "2026-10-17T19:40:00.000Z",
      reason: "伪造周六块",
    };

    const result = buildLocalReplan({
      acceptedBlocks: [forgedSaturdayBlock],
      tasks: [fridayRetest],
      constraints: eveningConstraints,
      now: fridayNow,
      preserveAll: true,
      candidateTaskIds: new Set(),
      options: { localDate: "2026-10-16", timeZone: "UTC", planningNow: "2026-10-16T19:01:00.000Z" },
    });
    expect(result.fixedBlocks).toEqual([]);
    expect(result.releasedTaskVersions).toEqual([{ id: id(50), version: 1, status: "pending" }]);
  });
});
