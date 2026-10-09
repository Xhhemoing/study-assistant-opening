import { describe, expect, it } from "vitest";
import { planDay } from "@aistudy/domain";
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import {
  buildServerPlanDayOptions,
  DEFAULT_PLANNING_TIME_ZONE,
  resolvePlanningNowForLocalDay,
} from "./plan-service";

const SH = "Asia/Shanghai";
const day = "2026-10-09";
const at = (clock: string) => `2026-10-09T${clock}:00.000Z`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function task(n: number, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: id(n),
    title: `任务${n}`,
    minutes: 30,
    dueAt: null,
    priority: 1,
    status: "pending",
    ...overrides,
  };
}

function retest(n: number, recommendedAt: string): TaskItem {
  return task(n, {
    retest: {
      candidateId: id(90 + n),
      activityId: id(80 + n),
      courseId: id(70),
      skillLabel: "fractions",
      prompt: `隔天重做原题：${n}`,
      recommendedAt,
    },
  });
}

function slot(startClock: string, endClock: string): TimeBlock {
  return { start: at(startClock), end: at(endClock), kind: "free" };
}

describe("resolvePlanningNowForLocalDay", () => {
  it("returns ISO when now is inside the workspace local day", () => {
    // 2026-10-09 10:00 Asia/Shanghai = 02:00Z
    const now = new Date("2026-10-09T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBe("2026-10-09T02:00:00.000Z");
  });

  it("omits planningNow for a past local day (historical propose / tests)", () => {
    const now = new Date("2026-10-10T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBeUndefined();
  });

  it("omits planningNow for a future local day", () => {
    const now = new Date("2026-10-08T02:00:00.000Z");
    expect(resolvePlanningNowForLocalDay(day, SH, now)).toBeUndefined();
  });
});

describe("buildServerPlanDayOptions", () => {
  it("uses TZ01 localDate+timeZone and omits UTC dayEnd", () => {
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: SH,
      now: new Date("2026-10-08T02:00:00.000Z"),
    });
    expect(opts).toEqual({ localDate: day, timeZone: SH });
    expect(opts).not.toHaveProperty("dayEnd");
    expect(opts).not.toHaveProperty("planningNow");
  });

  it("includes planningNow when now is on the planned local day", () => {
    const now = new Date("2026-10-09T02:00:00.000Z");
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    expect(opts.planningNow).toBe(now.toISOString());
    expect(opts.localDate).toBe(day);
    expect(opts.timeZone).toBe(SH);
    expect(opts).not.toHaveProperty("dayEnd");
  });

  it("passes preferredOrder for daily-draft / delta paths", () => {
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: DEFAULT_PLANNING_TIME_ZONE,
      now: new Date("2026-10-08T02:00:00.000Z"),
      preferredOrder: [id(1), id(2)],
    });
    expect(opts.preferredOrder).toEqual([id(1), id(2)]);
  });
});

describe("plan-service → planDay earliest wire", () => {
  it("clamps ordinary tasks to planningNow when options come from the server builder", () => {
    const now = new Date(at("10:00"));
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    expect(opts.planningNow).toBe(at("10:00"));
    const result = planDay([task(1)], [slot("09:00", "12:00")], opts);
    expect(result.blocks).toEqual([
      { taskId: id(1), start: at("10:00"), end: at("10:30"), reason: expect.any(String) },
    ]);
  });

  it("does not schedule an afternoon retest before recommendedAt under server options", () => {
    const now = new Date(at("08:00"));
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now });
    const result = planDay([retest(1, at("14:00"))], [slot("09:00", "17:00")], opts);
    expect(result.unscheduledTaskIds).toEqual([]);
    expect(result.blocks[0]).toMatchObject({
      taskId: id(1),
      start: at("14:00"),
      end: at("14:30"),
    });
  });

  it("keeps morning free usable when preferredOrder would otherwise grab the afternoon retest first", () => {
    const now = new Date(at("08:00"));
    const opts = buildServerPlanDayOptions({
      date: day,
      timeZone: SH,
      now,
      preferredOrder: [id(1), id(2)],
    });
    const result = planDay(
      [retest(1, at("14:00")), task(2)],
      [slot("09:00", "17:00")],
      opts,
    );
    expect(result.blocks.map(({ taskId, start, end }) => ({ taskId, start, end }))).toEqual([
      { taskId: id(2), start: at("09:00"), end: at("09:30") },
      { taskId: id(1), start: at("14:00"), end: at("14:30") },
    ]);
  });

  it("does not clamp historical dates so past-day proposes still use slot.start", () => {
    const wallClock = new Date("2026-10-10T12:00:00.000Z");
    const opts = buildServerPlanDayOptions({ date: day, timeZone: SH, now: wallClock });
    expect(opts.planningNow).toBeUndefined();
    const result = planDay([task(1)], [slot("09:00", "12:00")], opts);
    expect(result.blocks[0]?.start).toBe(at("09:00"));
  });
});
