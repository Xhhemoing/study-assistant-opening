import { expect, it } from "vitest";
import { expandWeekSessions, normalizeWeekSessions } from "./timetable";

const row = { courseName: "数学I", weekday: 6, weeks: [2], startPeriod: 1, endPeriod: 4 };

it("deduplicates repeated spreadsheet display without removing week differences", () => {
  expect(normalizeWeekSessions([row, row, { ...row, weeks: [3] }])).toHaveLength(2);
});

it("validates weekdays, periods, and returns sorted unique weeks", () => {
  expect(normalizeWeekSessions([{ ...row, weekday: 1, weeks: [3, 1, 3] }])[0].weeks).toEqual([1, 3]);
  expect(normalizeWeekSessions([{ ...row, weekday: 7 }])).toHaveLength(1);
  expect(() => normalizeWeekSessions([{ ...row, weekday: 0 }])).toThrow(/weekday.*1.*7/i);
  expect(() => normalizeWeekSessions([{ ...row, startPeriod: 4, endPeriod: 1 }])).toThrow(/startPeriod.*endPeriod/i);
});

it("expands academic weeks and periods into timezone-aware class blocks", () => {
  const blocks = expandWeekSessions(
    [{ ...row, weekday: 1, weeks: [2], startPeriod: 1, endPeriod: 2 }],
    {
      weekOneMonday: "2024-09-02",
      periodTimes: { 1: { start: "08:00", end: "08:45" }, 2: { start: "08:55", end: "09:40" } },
      timeZone: "Asia/Shanghai",
    },
  );
  expect(blocks).toEqual([{ start: "2024-09-09T00:00:00.000Z", end: "2024-09-09T01:40:00.000Z", kind: "class" }]);
});

it("blocks absolute expansion with actionable missing configuration errors", () => {
  expect(() => expandWeekSessions([row], { periodTimes: { 1: { start: "08:00", end: "09:00" } }, timeZone: "Asia/Shanghai" }))
    .toThrow(/weekOneMonday/i);
  expect(() => expandWeekSessions([row], { weekOneMonday: "2024-09-02", periodTimes: {}, timeZone: "Asia/Shanghai" }))
    .toThrow(/periodTimes/i);
});

it("rejects nonexistent DST wall-clock times", () => {
  expect(() => expandWeekSessions(
    [{ ...row, weekday: 7, weeks: [1], startPeriod: 1, endPeriod: 1 }],
    { weekOneMonday: "2024-03-04", periodTimes: { 1: { start: "02:30", end: "03:30" } }, timeZone: "America/New_York" },
  )).toThrow(/DST|nonexistent|invalid local time/i);
});

it("rejects ambiguous DST wall-clock times", () => {
  expect(() => expandWeekSessions(
    [{ ...row, weekday: 7, weeks: [1], startPeriod: 1, endPeriod: 1 }],
    { weekOneMonday: "2024-10-28", periodTimes: { 1: { start: "01:30", end: "02:30" } }, timeZone: "America/New_York" },
  )).toThrow(/ambiguous/i);
});
