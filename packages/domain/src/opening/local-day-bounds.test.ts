import { describe, expect, it } from "vitest";
import {
  assertValidLocalDate,
  isInstantOnLocalDay,
  resolveLocalDayBounds,
  zonedLocalInstant,
} from "./local-day-bounds";
import { planDay } from "./day-planner";
import type { TaskItem, TimeBlock } from "@aistudy/contracts";

const SH = "Asia/Shanghai";

describe("resolveLocalDayBounds", () => {
  it("Asia/Shanghai: 00:30 and 07:59 are the same local day (UTC midnight must not split them)", () => {
    const localDate = "2026-10-09";
    const { dayStart, nextDayStart } = resolveLocalDayBounds(localDate, SH);

    // Shanghai midnight = previous UTC day 16:00
    expect(dayStart.toISOString()).toBe("2026-10-08T16:00:00.000Z");
    expect(nextDayStart.toISOString()).toBe("2026-10-09T16:00:00.000Z");

    const at0030 = zonedLocalInstant(`${localDate}T00:30`, SH);
    const at0759 = zonedLocalInstant(`${localDate}T07:59`, SH);
    expect(at0030.toISOString()).toBe("2026-10-08T16:30:00.000Z");
    expect(at0759.toISOString()).toBe("2026-10-08T23:59:00.000Z");

    // Both before UTC midnight of Oct 9 — would be "different UTC days" if naively split
    expect(at0030.toISOString().slice(0, 10)).toBe("2026-10-08");
    expect(at0759.toISOString().slice(0, 10)).toBe("2026-10-08");

    expect(isInstantOnLocalDay(at0030, localDate, SH)).toBe(true);
    expect(isInstantOnLocalDay(at0759, localDate, SH)).toBe(true);

    // UTC midnight Oct 9 is still morning of Shanghai Oct 9
    const utcMidnight = new Date("2026-10-09T00:00:00.000Z");
    expect(isInstantOnLocalDay(utcMidnight, localDate, SH)).toBe(true);
    expect(isInstantOnLocalDay(utcMidnight, "2026-10-08", SH)).toBe(false);
  });

  it("next-day boundary is exclusive (half-open)", () => {
    const { dayStart, nextDayStart } = resolveLocalDayBounds("2026-10-09", SH);
    expect(isInstantOnLocalDay(dayStart, "2026-10-09", SH)).toBe(true);
    expect(isInstantOnLocalDay(nextDayStart, "2026-10-09", SH)).toBe(false);
    expect(isInstantOnLocalDay(nextDayStart, "2026-10-10", SH)).toBe(true);
    expect(nextDayStart.getTime() - dayStart.getTime()).toBe(86_400_000);
  });

  it("supports negative-offset zones (America/New_York)", () => {
    const tz = "America/New_York";
    const { dayStart, nextDayStart } = resolveLocalDayBounds("2026-03-10", tz);
    // EDT starts 2026-03-08; Mar 10 is EDT (UTC-4)
    expect(dayStart.toISOString()).toBe("2026-03-10T04:00:00.000Z");
    expect(nextDayStart.toISOString()).toBe("2026-03-11T04:00:00.000Z");
    expect(isInstantOnLocalDay(new Date("2026-03-10T04:00:00.000Z"), "2026-03-10", tz)).toBe(true);
    expect(isInstantOnLocalDay(new Date("2026-03-11T04:00:00.000Z"), "2026-03-10", tz)).toBe(false);
  });

  it("hard-errors on illegal dates and invalid time zones (no silent unconstrained bounds)", () => {
    expect(() => resolveLocalDayBounds("2026-02-30", SH)).toThrow(RangeError);
    expect(() => resolveLocalDayBounds("not-a-date", SH)).toThrow(RangeError);
    expect(() => resolveLocalDayBounds("2026-13-01", SH)).toThrow(RangeError);
    expect(() => resolveLocalDayBounds("2026-10-09", "Not/AZone")).toThrow(RangeError);
    expect(() => assertValidLocalDate("2026-02-30")).toThrow(/illegal localDate/);
  });
});

describe("planDay localDate+timeZone day boundary", () => {
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
  const retest = (n: number, recommendedAt: string): TaskItem =>
    task(n, {
      retest: {
        candidateId: id(90 + n),
        activityId: id(80 + n),
        courseId: id(70),
        skillLabel: "fractions",
        prompt: `隔天重做原题：${n}`,
        recommendedAt,
      },
    });

  // Free blocks on Shanghai local 2026-10-09 morning (01:00–10:00 CST = UTC Oct 8 17:00–Oct 9 02:00)
  const free: TimeBlock[] = [
    {
      start: "2026-10-08T17:00:00.000Z",
      end: "2026-10-09T02:00:00.000Z",
      kind: "free",
    },
  ];

  it("uses resolveLocalDayBounds when localDate+timeZone set (skips retest at/after nextDayStart)", () => {
    const onDay = retest(1, "2026-10-09T00:00:00.000Z"); // 08:00 SH — still on Oct 9
    const nextDay = retest(2, "2026-10-09T16:00:00.000Z"); // nextDayStart SH (= Oct 10 00:00)
    const result = planDay([onDay, nextDay], free, {
      localDate: "2026-10-09",
      timeZone: SH,
    });
    expect(result.blocks.map((b) => b.taskId)).toEqual([id(1)]);
    expect(result.unscheduledTaskIds).toEqual([]);
    // next-day retest skipped entirely (not listed unscheduled) — same as dayEnd skip
  });

  it("explicit dayEnd still overrides localDate+timeZone", () => {
    const late = retest(1, "2026-10-09T20:00:00.000Z");
    // Without override, SH Oct 9 ends at 16:00Z so this would be skipped.
    // With dayEnd past the retest, it is considered for the day (may unschedule for fit).
    const withOverride = planDay([late], free, {
      localDate: "2026-10-09",
      timeZone: SH,
      dayEnd: "2026-10-10T00:00:00.000Z",
    });
    expect(withOverride.unscheduledTaskIds).toEqual([id(1)]); // in day but does not fit morning slot
    const without = planDay([late], free, {
      localDate: "2026-10-09",
      timeZone: SH,
    });
    expect(without.blocks).toEqual([]);
    expect(without.unscheduledTaskIds).toEqual([]);
  });
});
