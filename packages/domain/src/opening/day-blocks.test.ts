import { describe, expect, it } from "vitest";
import type { OpeningPlanningSettings, WeekSession } from "@aistudy/contracts";
import { deriveDayBlocks } from "./day-blocks";

const baseSettings: OpeningPlanningSettings = {
  weekOneMonday: "2024-09-02",
  periodTimes: {
    "1": { start: "08:00", end: "08:45" },
    "2": { start: "08:55", end: "09:40" },
    "3": { start: "10:00", end: "10:45" },
    "4": { start: "10:55", end: "11:40" },
  },
  dailyWindow: { start: "07:30", end: "22:30" },
  lunch: { start: "12:00", end: "13:00" },
  dinner: { start: "17:30", end: "18:30" },
  sleep: { start: "23:00", end: "07:00" },
  timeZone: "Asia/Shanghai",
};

const mathWeek2Mon: WeekSession = {
  courseName: "数学I",
  weekday: 1,
  weeks: [2],
  startPeriod: 1,
  endPeriod: 2,
};

describe("deriveDayBlocks", () => {
  it("places week-N class blocks on the correct local date", () => {
    // week 2 Monday of weekOneMonday 2024-09-02 → 2024-09-09
    const blocks = deriveDayBlocks("2024-09-09", baseSettings, [mathWeek2Mon]);
    const classes = blocks.filter((b) => b.kind === "class");
    expect(classes).toEqual([
      { start: "2024-09-09T00:00:00.000Z", end: "2024-09-09T01:40:00.000Z", kind: "class" },
    ]);
    const free = blocks.filter((b) => b.kind === "free");
    // Window 07:30–22:30 CST (= 23:30 prev–14:30 UTC), minus class 08:00–09:40, lunch, dinner.
    expect(free.length).toBeGreaterThan(0);
    expect(free.some((b) => b.start === "2024-09-08T23:30:00.000Z")).toBe(true);
    // Class carves morning free before 08:00 CST = 00:00Z
    expect(free).toContainEqual({
      start: "2024-09-08T23:30:00.000Z",
      end: "2024-09-09T00:00:00.000Z",
      kind: "free",
    });
  });

  it("supports sleep that crosses midnight without inventing free inside it", () => {
    // Widen window so evening sleep overlaps: 07:00–23:30
    const settings: OpeningPlanningSettings = {
      ...baseSettings,
      dailyWindow: { start: "07:00", end: "23:30" },
      sleep: { start: "23:00", end: "07:00" },
    };
    const blocks = deriveDayBlocks("2024-09-10", settings, []);
    const sleep = blocks.filter((b) => b.kind === "sleep");
    expect(sleep).toEqual([
      // previous night → this morning
      { start: "2024-09-09T15:00:00.000Z", end: "2024-09-09T23:00:00.000Z", kind: "sleep" },
      // this evening → next morning
      { start: "2024-09-10T15:00:00.000Z", end: "2024-09-10T23:00:00.000Z", kind: "sleep" },
    ]);
    const free = blocks.filter((b) => b.kind === "free");
    // Window starts at 07:00 CST = 23:00Z prev; morning sleep ends at 07:00 so free starts at 07:00
    // Evening free must end at sleep 23:00 CST = 15:00Z, not run into sleep.
    expect(free.every((b) => b.end <= "2024-09-10T15:00:00.000Z" || b.start >= "2024-09-10T15:00:00.000Z")).toBe(true);
    expect(free.some((b) => b.end === "2024-09-10T15:00:00.000Z")).toBe(true);
  });

  it("rejects missing period times instead of guessing", () => {
    const settings: OpeningPlanningSettings = {
      ...baseSettings,
      periodTimes: { "1": { start: "08:00", end: "08:45" } },
    };
    expect(() => deriveDayBlocks("2024-09-09", settings, [mathWeek2Mon])).toThrow(
      /periodTimes is missing period 2/i,
    );
  });

  it("on a no-class day, free equals the window minus meals (and overlapping sleep)", () => {
    // Default sleep 23:00–07:00 does not overlap 07:30–22:30
    const blocks = deriveDayBlocks("2024-09-08", baseSettings, []); // Sunday, no sessions
    expect(blocks.filter((b) => b.kind === "class")).toEqual([]);
    const free = blocks.filter((b) => b.kind === "free");
    const meals = blocks.filter((b) => b.kind === "meal");
    expect(meals).toHaveLength(2);
    // 07:30–12:00, 13:00–17:30, 18:30–22:30 CST
    expect(free).toEqual([
      { start: "2024-09-07T23:30:00.000Z", end: "2024-09-08T04:00:00.000Z", kind: "free" },
      { start: "2024-09-08T05:00:00.000Z", end: "2024-09-08T09:30:00.000Z", kind: "free" },
      { start: "2024-09-08T10:30:00.000Z", end: "2024-09-08T14:30:00.000Z", kind: "free" },
    ]);
  });

  it("subtracts caller hard blocks from free time", () => {
    const locked = {
      start: "2024-09-08T06:00:00.000Z", // 14:00 CST
      end: "2024-09-08T07:00:00.000Z", // 15:00 CST
      kind: "locked" as const,
    };
    const blocks = deriveDayBlocks("2024-09-08", baseSettings, [], [locked]);
    expect(blocks).toContainEqual(locked);
    const free = blocks.filter((b) => b.kind === "free");
    expect(free).toContainEqual({
      start: "2024-09-08T05:00:00.000Z",
      end: "2024-09-08T06:00:00.000Z",
      kind: "free",
    });
    expect(free).toContainEqual({
      start: "2024-09-08T07:00:00.000Z",
      end: "2024-09-08T09:30:00.000Z",
      kind: "free",
    });
  });
});
