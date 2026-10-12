import { describe, expect, it } from "vitest";
import type { TaskItem, TimeBlock } from "@aistudy/contracts";
import { buildDailyDraftInput, localDateKeyInZone } from "./daily-draft";
import { planDay } from "./day-planner";
import { isInstantOnLocalDay, resolveLocalDayBounds, zonedLocalInstant } from "./local-day-bounds";

/**
 * PR-B acceptance matrix (workspace zone Asia/Shanghai unless stated).
 * Every instant is built from a wall-clock + IANA zone; no "+8h" arithmetic.
 */
const SH = "Asia/Shanghai";
const DAY = "2026-10-12";
const sh = (clock: string, date = DAY) => zonedLocalInstant(`${date}T${clock}`, SH).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: id(n), title: `任务${n}`, minutes: 30, dueAt: null, priority: 1, status: "pending", ...overrides,
});
const retest = (n: number, recommendedAt: string): TaskItem => task(n, {
  retest: {
    candidateId: id(90 + n), activityId: id(80 + n), courseId: id(70),
    skillLabel: "fractions", prompt: `补测${n}`, recommendedAt,
  },
});
const free = (start: string, end: string): TimeBlock => ({ start: sh(start), end: sh(end), kind: "free" });
const morning = free("09:00", "11:00");
const afternoon = free("17:00", "18:00");
const localOpts = (planningNow?: string) => ({ localDate: DAY, timeZone: SH, ...(planningNow ? { planningNow } : {}) });

describe("local business day keys (Asia/Shanghai)", () => {
  it.each([
    ["00:30", "2026-10-11T16:30:00.000Z"],
    ["07:59", "2026-10-11T23:59:00.000Z"],
    ["08:00", "2026-10-12T00:00:00.000Z"],
  ])("Shanghai %s (UTC %s) is local day %s", (clock, utc) => {
    expect(sh(clock)).toBe(utc);
    expect(localDateKeyInZone(new Date(utc), SH)).toBe(DAY);
    expect(isInstantOnLocalDay(utc, DAY, SH)).toBe(true);
  });

  it("23:59:59.999 belongs to the day, the next 00:00:00.000 does not (half-open)", () => {
    const { nextDayStart } = resolveLocalDayBounds(DAY, SH);
    const lastMs = new Date(nextDayStart.getTime() - 1);
    expect(lastMs.toISOString()).toBe("2026-10-12T15:59:59.999Z");
    expect(localDateKeyInZone(lastMs, SH)).toBe(DAY);
    expect(isInstantOnLocalDay(lastMs, DAY, SH)).toBe(true);
    expect(localDateKeyInZone(nextDayStart, SH)).toBe("2026-10-13");
    expect(isInstantOnLocalDay(nextDayStart, DAY, SH)).toBe(false);
  });
});

describe("planDay with workspace local day", () => {
  it("next-day 07:00 retest is not pulled into today (UTC fallback would include it)", () => {
    const nextMorning = retest(1, sh("07:00", "2026-10-13"));
    expect(nextMorning.retest?.recommendedAt).toBe("2026-10-12T23:00:00.000Z");
    const local = planDay([nextMorning], [morning, afternoon], localOpts());
    expect(local.blocks).toEqual([]);
    expect(local.unscheduledTaskIds).toEqual([]);
    // Legacy UTC-day fallback (no localDate/timeZone) treats 23:00Z as "today" — the bug class.
    const utcFallback = planDay([nextMorning], [morning, afternoon]);
    expect(utcFallback.unscheduledTaskIds.concat(utcFallback.blocks.map((b) => b.taskId))).toContain(id(1));
  });

  it("overdue task is kept (unscheduled with deadline_passed), never dropped", () => {
    const overdue = task(2, { dueAt: sh("09:00") });
    const result = planDay([overdue], [afternoon], localOpts(sh("16:00")));
    expect(result.blocks).toEqual([]);
    expect(result.unscheduledTaskIds).toEqual([id(2)]);
    expect(result.unscheduled).toEqual([{ taskId: id(2), reason: "deadline_passed" }]);
  });

  it("16:00 retest with morning + afternoon free → scheduled in the afternoon slot", () => {
    const due = retest(3, sh("16:00"));
    const result = planDay([due], [morning, afternoon], localOpts(sh("16:00")));
    expect(result.unscheduled).toEqual([]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.start).toBe(sh("17:00"));
  });

  it("16:00 retest with morning-only free → unscheduled with explicit reason", () => {
    const due = retest(3, sh("16:00"));
    const result = planDay([due], [morning], localOpts(sh("16:00")));
    expect(result.blocks).toEqual([]);
    expect(result.unscheduledTaskIds).toEqual([id(3)]);
    expect(result.unscheduled).toEqual([{ taskId: id(3), reason: "no_compliant_slot_after_not_before" }]);
  });

  it("other unscheduled reasons are explicit too", () => {
    const tooLong = task(4, { minutes: 180 });
    const crowd = [task(5, { minutes: 60 }), task(6, { minutes: 60 }), task(7, { minutes: 60 })];
    const result = planDay([tooLong, ...crowd], [morning], localOpts());
    const reasons = Object.fromEntries(result.unscheduled.map((u) => [u.taskId, u.reason]));
    expect(reasons[id(4)]).toBe("duration_exceeds_free_slots");
    expect(reasons[id(7)]).toBe("free_time_exhausted");
    expect(result.unscheduled.map((u) => u.taskId)).toEqual(result.unscheduledTaskIds);
  });

  it("same output regardless of process TZ", () => {
    const original = process.env.TZ;
    const outputs: string[] = [];
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Asia/Shanghai", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        outputs.push(JSON.stringify([
          planDay([retest(3, sh("16:00")), task(2, { dueAt: sh("09:00") })], [morning, afternoon], localOpts(sh("16:00"))),
          localDateKeyInZone(new Date("2026-10-11T16:30:00.000Z"), SH),
          resolveLocalDayBounds(DAY, SH),
        ]));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(new Set(outputs).size).toBe(1);
  });
});

describe("daily draft reasons", () => {
  it("overdue overflow is overdue_needs_reschedule, not prefer_tomorrow", () => {
    const result = buildDailyDraftInput({
      tasks: [task(1, { dueAt: sh("09:00"), minutes: 30 }), task(2), task(3)],
      yesterdayAccepted: [],
      dueRetests: [],
      freeBlocks: [free("17:00", "17:30")],
      now: new Date(sh("16:00")),
      timeZone: SH,
    });
    expect(result.reasons[id(1)]).toEqual({ code: "overdue_needs_reschedule", label: "已逾期，需重新确认时间" });
    // Not overdue + no capacity left → still prefer_tomorrow.
    expect(result.reasons[id(3)]?.code).toBe("prefer_tomorrow");
  });
});

describe("explicit failures", () => {
  it("DST: America/New_York spring-forward day is 23h, fall-back day is 25h", () => {
    const spring = resolveLocalDayBounds("2026-03-08", "America/New_York");
    expect(spring.nextDayStart.getTime() - spring.dayStart.getTime()).toBe(23 * 3_600_000);
    const fall = resolveLocalDayBounds("2026-11-01", "America/New_York");
    expect(fall.nextDayStart.getTime() - fall.dayStart.getTime()).toBe(25 * 3_600_000);
  });

  it("DST: nonexistent and ambiguous wall-clock times throw RangeError", () => {
    expect(() => zonedLocalInstant("2026-03-08T02:30", "America/New_York")).toThrow(RangeError);
    expect(() => zonedLocalInstant("2026-11-01T01:30", "America/New_York")).toThrow(RangeError);
  });

  it("invalid time zone throws RangeError (no silent UTC/default fallback)", () => {
    expect(() => resolveLocalDayBounds(DAY, "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => localDateKeyInZone(new Date(), "Mars/Olympus_Mons")).toThrow(RangeError);
    expect(() => planDay([task(1)], [morning], { localDate: DAY, timeZone: "Mars/Olympus_Mons" })).toThrow(RangeError);
  });
});

describe("resolveWorkspaceTimeZone", () => {
  it("blank -> default, valid passes, invalid throws RangeError", async () => {
    const { resolveWorkspaceTimeZone } = await import("./local-day-bounds");
    expect(resolveWorkspaceTimeZone(null)).toBe("Asia/Shanghai");
    expect(resolveWorkspaceTimeZone("  ")).toBe("Asia/Shanghai");
    expect(resolveWorkspaceTimeZone(" America/New_York ")).toBe("America/New_York");
    expect(() => resolveWorkspaceTimeZone("Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

