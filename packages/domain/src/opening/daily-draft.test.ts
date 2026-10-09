import { describe, expect, it } from "vitest";
import type { PlannedBlock, TaskItem, TimeBlock } from "@aistudy/contracts";
import { buildDailyDraftInput } from "./daily-draft";

const tz = "Asia/Shanghai";
/** 2026-09-14 12:00 CST = 2026-09-14T04:00:00.000Z */
const now = new Date("2026-09-14T04:00:00.000Z");
const at = (clock: string) => `2026-09-14T${clock}:00.000Z`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const task = (n: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n),
  title: `任务${n}`,
  minutes: 30,
  dueAt: null,
  priority: 1,
  status: "pending",
  ...overrides,
});

const slot = (start: string, end: string, kind: TimeBlock["kind"] = "free"): TimeBlock => ({
  start: at(start),
  end: at(end),
  kind,
});

const yesterdayBlock = (n: number): PlannedBlock => ({
  taskId: id(n),
  start: "2026-09-13T01:00:00.000Z",
  end: "2026-09-13T01:30:00.000Z",
  reason: "昨天安排",
});

describe("buildDailyDraftInput", () => {
  it("puts carry-over tasks first with carry_over_yesterday reason", () => {
    const result = buildDailyDraftInput({
      tasks: [task(1), task(2, { priority: 99 }), task(3)],
      yesterdayAccepted: [yesterdayBlock(3), yesterdayBlock(1)],
      dueRetests: [],
      freeBlocks: [slot("09:00", "12:00")],
      now,
      timeZone: tz,
    });
    expect(result.orderedTaskIds.slice(0, 2)).toEqual([id(3), id(1)]);
    expect(result.orderedTaskIds).toContain(id(2));
    expect(result.reasons[id(3)]).toEqual({
      code: "carry_over_yesterday",
      label: "顺延自昨天",
    });
    expect(result.reasons[id(1)]?.code).toBe("carry_over_yesterday");
  });

  it("excludes retests whose recommendedAt is after the local day end", () => {
    const future = task(1, {
      retest: {
        candidateId: id(9),
        activityId: id(8),
        courseId: id(7),
        skillLabel: "fractions",
        prompt: "隔天重做",
        recommendedAt: "2026-09-16T10:00:00.000Z",
      },
    });
    const dueToday = task(2, {
      retest: {
        candidateId: id(6),
        activityId: id(5),
        courseId: id(7),
        skillLabel: "fractions",
        prompt: "今天补测",
        recommendedAt: at("10:00"),
      },
    });
    const result = buildDailyDraftInput({
      tasks: [future, dueToday, task(3)],
      yesterdayAccepted: [],
      dueRetests: [future, dueToday],
      freeBlocks: [slot("09:00", "12:00")],
      now,
      timeZone: tz,
    });
    expect(result.orderedTaskIds).toEqual([id(2), id(3)]);
    expect(result.orderedTaskIds).not.toContain(id(1));
  });

  it("marks overflow as unscheduled suggestions prefer_tomorrow or shorten_duration", () => {
    // One 30-min free slot; three 30-min tasks → two overflow prefer_tomorrow
    const tight = buildDailyDraftInput({
      tasks: [task(1), task(2), task(3)],
      yesterdayAccepted: [],
      dueRetests: [],
      freeBlocks: [slot("09:00", "09:30")],
      now,
      timeZone: tz,
    });
    expect(tight.orderedTaskIds).toHaveLength(3);
    expect(tight.reasons[id(2)]).toEqual({
      code: "prefer_tomorrow",
      label: "明天优先",
    });
    expect(tight.reasons[id(3)]?.code).toBe("prefer_tomorrow");

    // 20-min free, 30-min task → shorten_duration
    const short = buildDailyDraftInput({
      tasks: [task(1, { minutes: 30 })],
      yesterdayAccepted: [],
      dueRetests: [],
      freeBlocks: [slot("09:00", "09:20")],
      now,
      timeZone: tz,
    });
    expect(short.reasons[id(1)]).toEqual({
      code: "shorten_duration",
      label: "缩短时长",
    });
  });

  it("does not schedule into sleep/meal when there is no free time", () => {
    const result = buildDailyDraftInput({
      tasks: [task(1), task(2)],
      yesterdayAccepted: [yesterdayBlock(1)],
      dueRetests: [],
      freeBlocks: [
        slot("08:00", "12:00", "sleep"),
        slot("12:00", "13:00", "meal"),
      ],
      now,
      timeZone: tz,
    });
    // Still ordered (carry-over first) but both overflow — no free slots to pack into.
    expect(result.orderedTaskIds[0]).toBe(id(1));
    expect(result.reasons[id(1)]?.code).toBe("carry_over_yesterday");
    expect(result.reasons[id(2)]).toEqual({
      code: "prefer_tomorrow",
      label: "明天优先",
    });
  });

  it("skips done carry-over and ignores duplicate yesterday blocks", () => {
    const result = buildDailyDraftInput({
      tasks: [task(1, { status: "done" }), task(2)],
      yesterdayAccepted: [yesterdayBlock(1), yesterdayBlock(2), yesterdayBlock(2)],
      dueRetests: [],
      freeBlocks: [slot("09:00", "11:00")],
      now,
      timeZone: tz,
    });
    expect(result.orderedTaskIds).toEqual([id(2)]);
    expect(result.reasons[id(2)]?.code).toBe("carry_over_yesterday");
  });
});
