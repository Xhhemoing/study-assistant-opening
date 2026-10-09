import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_TIME_ZONE,
  isInstantOnBudgetLocalDay,
  resolveBudgetLocalDay,
  resolveBudgetTimeZone,
} from "./budget-local-day";

const SH = "Asia/Shanghai";

describe("budget-local-day (TZ01 AI)", () => {
  it("defaults missing planning TZ to Asia/Shanghai", () => {
    expect(resolveBudgetTimeZone(undefined)).toBe(DEFAULT_BUDGET_TIME_ZONE);
    expect(resolveBudgetTimeZone(null)).toBe(SH);
    expect(resolveBudgetTimeZone("  ")).toBe(SH);
    expect(resolveBudgetTimeZone("America/New_York")).toBe("America/New_York");
  });

  it("Shanghai 00:30 and 07:59 share one local budget day (UTC midnight must not split)", () => {
    // 2026-03-15 00:30 CST = 2026-03-14 16:30 UTC
    const early = new Date("2026-03-14T16:30:00.000Z");
    // 2026-03-15 07:59 CST = 2026-03-14 23:59 UTC
    const late = new Date("2026-03-14T23:59:00.000Z");
    const earlyDay = resolveBudgetLocalDay(early, SH);
    const lateDay = resolveBudgetLocalDay(late, SH);
    expect(earlyDay.localDate).toBe("2026-03-15");
    expect(lateDay.localDate).toBe("2026-03-15");
    expect(earlyDay.localDate).toBe(lateDay.localDate);
    expect(isInstantOnBudgetLocalDay(early, late, SH)).toBe(true);
    expect(isInstantOnBudgetLocalDay(late, early, SH)).toBe(true);
    // Crossing UTC midnight alone does not change the local day key.
    expect(early.toISOString().slice(0, 10)).toBe("2026-03-14");
    expect(late.toISOString().slice(0, 10)).toBe("2026-03-14");
  });

  it("exposes half-open [dayStart, nextDayStart) absolute bounds", () => {
    const day = resolveBudgetLocalDay(new Date("2026-03-14T16:30:00.000Z"), SH);
    expect(day.dayStart.toISOString()).toBe("2026-03-14T16:00:00.000Z"); // 00:00 CST
    expect(day.nextDayStart.toISOString()).toBe("2026-03-15T16:00:00.000Z");
    expect(day.nextDayStart.getTime()).toBeGreaterThan(day.dayStart.getTime());
    // Instant at nextDayStart is outside the day.
    expect(
      isInstantOnBudgetLocalDay(day.nextDayStart, day.dayStart, SH),
    ).toBe(false);
  });

  it("negative-offset zone keeps local calendar day for budget keys", () => {
    // 2026-03-15 01:00 America/New_York = 2026-03-15 05:00 UTC (EDT)
    const ny = resolveBudgetLocalDay(new Date("2026-03-15T05:00:00.000Z"), "America/New_York");
    expect(ny.localDate).toBe("2026-03-15");
    expect(ny.timeZone).toBe("America/New_York");
  });

  it("rejects invalid instants", () => {
    expect(() => resolveBudgetLocalDay(Number.NaN, SH)).toThrow(/invalid/);
    expect(() => isInstantOnBudgetLocalDay("not-a-date", new Date(), SH)).toThrow(/invalid/);
  });
});
