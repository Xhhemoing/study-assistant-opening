import { expect, it } from "vitest";
import { parseTimetable } from "./xlsx-reader";
import { expandToTimeBlocks, parsePeriodTimes } from "./timezone";

const fixture = "tests/fixtures/opening/timetable-synthetic.xlsx";

it("parses Saturday, split weeks, and deduplicates a merged display", async () => {
  const result = await parseTimetable(fixture);
  expect(result.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ courseName: "数学I", weekday: 6, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16] }),
  ]));
  expect(result.sessions.filter((row) => row.courseName === "数学I")).toHaveLength(1);
});

it("keeps raw text in a warning for a course without week information", async () => {
  const result = await parseTimetable(fixture);
  expect(result.warnings.some((warning) => warning.raw === "English Composition")).toBe(true);
  expect(result.raw.some((cell) => cell.text === "English Composition")).toBe(true);
});

it("rejects missing or invalid absolute timetable configuration", () => {
  expect(() => expandToTimeBlocks([], { timeZone: "Asia/Shanghai" })).toThrow(/weekOneMonday.*configure/i);
  expect(() => expandToTimeBlocks([], { weekOneMonday: "2026-03-08", periodTimes: { 1: { start: "09:00", end: "10:00" } }, timeZone: "Asia/Shanghai" })).toThrow(/Monday/i);
  expect(() => parsePeriodTimes({ 1: { start: "25:00", end: "10:00" } })).toThrow(/period 1 start.*HH:mm/i);
});

it("rejects DST gaps and ambiguous local times rather than shifting", () => {
  const rows = [{ courseName: "DST", weekday: 7, weeks: [1], startPeriod: 1, endPeriod: 1 }];
  const periodTimes = { 1: { start: "02:30", end: "03:30" } };
  expect(() => expandToTimeBlocks(rows, { weekOneMonday: "2026-03-02", periodTimes, timeZone: "America/New_York" })).toThrow(/nonexistent|DST/i);
  expect(() => expandToTimeBlocks(rows, { weekOneMonday: "2026-10-26", periodTimes: { 1: { start: "01:30", end: "02:30" } }, timeZone: "America/New_York" })).toThrow(/ambiguous|DST/i);
});
