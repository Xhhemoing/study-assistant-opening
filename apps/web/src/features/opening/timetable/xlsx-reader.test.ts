import { expect, it } from "vitest";
import { parseTimetableSheets } from "./xlsx-reader";
import { parseTimetable } from "./xlsx-reader.node";
import { expandToTimeBlocks, parsePeriodTimes } from "./timezone";

const fixture = "tests/fixtures/opening/timetable-synthetic.xlsx";

it("rejects a nonexistent academic Monday instead of shifting imported classes", () => {
  expect(() => expandToTimeBlocks(
    [{ courseName: "数学", weekday: 1, weeks: [1], startPeriod: 1, endPeriod: 1 }],
    { weekOneMonday: "2026-02-30", periodTimes: { 1: { start: "08:00", end: "08:45" } }, timeZone: "Asia/Shanghai" },
  )).toThrow(/weekOneMonday/);
});

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

it("parseTimetableSheets maps synthetic rows without touching the filesystem", () => {
  const result = parseTimetableSheets([
    {
      sheet: "Sheet1",
      data: [
        ["课程", "星期", "周次", "节"],
        ["线性代数(1-8周) 1-2节", "周一", null, null],
        ["English Composition", "周六", null, null],
      ],
    },
  ]);
  expect(result.sessions).toEqual([
    expect.objectContaining({ courseName: "线性代数", weekday: 1, weeks: [1, 2, 3, 4, 5, 6, 7, 8], startPeriod: 1, endPeriod: 2 }),
  ]);
  expect(result.warnings.some((warning) => warning.raw === "English Composition")).toBe(true);
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

it.each([
  ["物理2（1-16周）", null, "物理2", Array.from({ length: 16 }, (_, i) => i + 1)],
  ["英语4（第3,5周）", null, "英语4", [3, 5]],
  ["物理2（1-16周）", "2,4", "物理2", [2, 4]],
  ["高数1（1-6单周）", null, "高数1", [1, 3, 5]],
  ["物理2", "1-6周（双周）", "物理2", [2, 4, 6]],
  ["物理2", "1-16周", "物理2", Array.from({ length: 16 }, (_, i) => i + 1)],
  ["物理2", "3周", "物理2", [3]],
  ["物理2", "周12", "物理2", [12]],
  ["物理2", "周60", "物理2", [60]],
  ["物理2", "周次：第 1-8周", "物理2", [1, 2, 3, 4, 5, 6, 7, 8]],
  ["物理2", "第 3 周", "物理2", [3]],
  ["物理2", "第 1, 3, 5 周", "物理2", [1, 3, 5]],
] as const)("reads marked weeks or the dedicated weeks column for %s / %s", (title, column, name, expected) => {
  const result = parseTimetableSheets([{ sheet: "课程表", data: [
    ["课程", "星期", "周次", "节次"], [title, "周二", column, "1-2节"],
  ] }]);
  expect(result.sessions).toMatchObject([{ courseName: name, weeks: expected }]);
  expect(result.warnings).toEqual([]);
});

it.each(["周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天", "周1", "周2", "周3", "周4", "周5", "周6", "周7", "(周1)", "【周1】", "(周次：周1)", "(1-3周);【周7】", "周0", "周61"])("rejects %s in the weeks column", column => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "周次", "节次"], ["物理2", "周三", column, "3-4节"],
  ] }]);
  expect(result.sessions).toEqual([]);
  expect(result.warnings).toMatchObject([{ raw: "物理2", address: "A2" }]);
});

it.each([
  ["线性代数(周1-8) 1-2节", "线性代数", [1, 2, 3, 4, 5, 6, 7, 8], 1, 2],
  ["线性代数(周：1－3，5) 1-2节", "线性代数", [1, 2, 3, 5], 1, 2],
  ["物理2（1-16周） 3-4节", "物理2", Array.from({ length: 16 }, (_, i) => i + 1), 3, 4],
  ["物理2 1-4周 3-4节", "物理2", [1, 2, 3, 4], 3, 4],
  ["物理2 周1-16单 3-4节", "物理2", [1, 3, 5, 7, 9, 11, 13, 15], 3, 4],
  ["英语（周1、3、5） 1-2节", "英语", [1, 3, 5], 1, 2],
  ["物理2（第 1-8 周） 3-4节", "物理2", [1, 2, 3, 4, 5, 6, 7, 8], 3, 4],
  ["物理2 周次：第 1, 3, 5 周 1-2节", "物理2", [1, 3, 5], 1, 2],
  ["物理2 1-16周（双周） 1-2节", "物理2", [2, 4, 6, 8, 10, 12, 14, 16], 1, 2],
  ["物理2 1-8周(单周) 1-2节", "物理2", [1, 3, 5, 7], 1, 2],
  ["数学（1-4周）；（6-8周） 1-2节", "数学", [1, 2, 3, 4, 6, 7, 8], 1, 2],
  ["数学 (1-4周), (6-8双周) 1-2节", "数学", [1, 2, 3, 4, 6, 8], 1, 2],
  ["数学 1-4周；6-8周 1-2节", "数学", [1, 2, 3, 4, 6, 7, 8], 1, 2],
  ["数学(1-4周)、(6周)、(8-10单周) 3-4节", "数学", [1, 2, 3, 4, 6, 9], 3, 4],
  ["数学【1-4周】；【6-8周】 1-2节", "数学", [1, 2, 3, 4, 6, 7, 8], 1, 2],
  ["数学（1-4单周；6-8双周） 1-2节", "数学", [1, 3, 6, 8], 1, 2],
  ["数学 1-4周（单周）；6-8周（双周） 1-2节", "数学", [1, 3, 6, 8], 1, 2],
  ["数学 周1-4；周6-8 1-2节", "数学", [1, 2, 3, 4, 6, 7, 8], 1, 2],
  ["周期信号分析（1-4周）；（6-8周） 1-2节", "周期信号分析", [1, 2, 3, 4, 6, 7, 8], 1, 2],
  ["高等数学（实验班）（1-4周）；（6-8周） 1-2节", "高等数学（实验班）", [1, 2, 3, 4, 6, 7, 8], 1, 2],
] as const)("separates the course, weeks and periods in %s", (title, courseName, weeks, startPeriod, endPeriod) => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [["课程", "星期"], [title, "周一"]] }]);
  expect(result.sessions).toMatchObject([{ courseName, weeks, weekday: 1, startPeriod, endPeriod }]);
  expect(result.warnings).toEqual([]);
});

it.each([
  "数学（1-4周）；（8-6周） 1-2节",
  "数学（1-4周）；（5-61周） 1-2节",
  "数学（1-4周）；（周三） 1-2节",
  "数学（1-4周）；（周7） 1-2节",
  "数学（1-4周）；（6-8周 1-2节",
  "数学（1-4周）；6-8周） 1-2节",
  "数学（1-4周）；第周 1-2节",
  "数学 1-4周（单周)；6-8周 1-2节",
  "数学 1-4周(单周） 1-2节",
  "数学 1-4周(单周 1-2节",
  "数学 1-4周单周) 1-2节",
])("warns and drops inline course cell with unparseable residual week segment %s", title => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [["课程", "星期"], [title, "周一"]] }]);
  expect(result.sessions).toEqual([]);
  expect(result.warnings).toMatchObject([{ raw: title, address: "A2" }]);
});

it.each([
  "数学（8-6周）",
  "数学（1-4周）；（6-8周",
  "数学 1-4周（单周)；6-8周",
  "数学（1-4周）；（周7）",
])("warns and drops malformed inline week expression %s even when the dedicated weeks column is valid", title => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "周次", "节次"],
    [title, "周一", "1-8周", "1-2节"],
  ] }]);
  expect(result.sessions).toEqual([]);
  expect(result.warnings).toMatchObject([{ raw: title, address: "A2" }]);
});

it.each(["物理2", "英语4", "高数1 1-2节", "物理2 周三", "物理2 周一", "物理2 周1"])("warns about missing weeks for %s", title => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "节次"], [title, "周三", "3-4节"],
  ] }]);
  expect(result.sessions).toEqual([]);
  expect(result.warnings).toMatchObject([{ raw: title, address: "A2" }]);
});

const semesterWeeks = Array.from({ length: 16 }, (_, i) => i + 1);

it.each([
  ["【周次：(周1-16)】", semesterWeeks],
  ["周次：(1-16周)", semesterWeeks],
  ["(周：【1-8周】)", semesterWeeks.slice(0, 8)],
  ["(1-16周)", semesterWeeks],
  ["（1-16周）", semesterWeeks],
  ["[1-16周]", semesterWeeks],
  ["【1-16周】", semesterWeeks],
  [" 【 （ [ ( 1-16周 ) ] ） 】 ", semesterWeeks],
  ["(第1-8周单)", [1, 3, 5, 7]],
  ["(第1周)", [1]],
  ["(1周)", [1]],
  ["(周1-16)", semesterWeeks],
  ["(周：1－3)", [1, 2, 3]],
  ["周次：(1-3周)", [1, 2, 3]],
  ["(1-8周), (10-16双周)", [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16]],
  ["【(1-4周)、[6周]；（8周）】; (10周)，12周", [1, 2, 3, 4, 6, 8, 10, 12]],
  ["1-8周(单)", [1, 3, 5, 7]],
  ["(1-16周单)", [1, 3, 5, 7, 9, 11, 13, 15]],
  ["(1-4,7-10周（双周）)", [2, 4, 8, 10]],
] as const)("imports the entire wrapped weeks expression %s", (column, weeks) => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "周次", "节次"], ["物理", "周三", column, "1-2节"],
  ] }]);
  expect(result.sessions).toMatchObject([{ courseName: "物理", weeks }]);
  expect(result.warnings).toEqual([]);
});

it("preserves both courses in a workbook mixing plain and wrapped week columns", () => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "周次", "节次"],
    ["数学", "周一", "1-16周", "1-2节"],
    ["物理", "周三", "(1-16周)", "1-2节"],
  ] }]);
  expect(result.warnings).toEqual([]);
  expect(result.sessions).toEqual([
    { courseName: "数学", weekday: 1, weeks: semesterWeeks, startPeriod: 1, endPeriod: 2 },
    { courseName: "物理", weekday: 3, weeks: semesterWeeks, startPeriod: 1, endPeriod: 2 },
  ]);
});

it.each([
  "【周次：(周1-16】", "【周次：(周1-16】)", "【周次：(周1-16)】末",
  "(1-16周", "1-16周)", "（1-16周)", "【(1-16周】)", "(周1-8", "周次：1周）",
  "1-8周(单", "1-8周(单）", "1-8周单)", "(1-8周), (周三)", "星期三", "(星期三)",
  "(1周)(2周)", "(1周),", "(1周);()", "(1周);(2-61周)",
])("warns and drops the entire row for invalid week expression %s", column => {
  const result = parseTimetableSheets([{ sheet: "课表", data: [
    ["课程", "星期", "周次", "节次"], ["物理", "周三", column, "1-2节"],
  ] }]);
  expect(result.warnings).toMatchObject([{ raw: "物理", address: "A2" }]);
  expect(result.sessions).toEqual([]);
});
