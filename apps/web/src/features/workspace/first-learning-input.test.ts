import { describe, expect, it } from "vitest";
import { deriveDayBlocks } from "@aistudy/domain";
import { firstLearningInputSchema, initialLearningSchedule, initialLearningDays } from "./first-learning-input";
const input = { clientKey: "11111111-1111-4111-8111-111111111111", topic: "矩阵", minutes: 30, startTime: "19:00", timeZone: "Asia/Shanghai" };
describe("first-learning schedule integration", () => {
  it.each(["Asia/Shanghai", "America/Los_Angeles"])("produces real free study time without inventing a school timetable in %s", timeZone => {
    const schedule = initialLearningSchedule(firstLearningInputSchema.parse({ ...input, timeZone }), "2026-10-19");
    const blocks = deriveDayBlocks("2026-10-19", schedule, []);
    const freeMinutes = blocks.filter(block => block.kind === "free").reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60000, 0);
    expect(freeMinutes).toBe(30);
    expect(blocks.some(block => block.kind === "class")).toBe(false);
  });
  it("anchors week one to Monday across the year boundary", () => {
    const schedule = initialLearningSchedule(firstLearningInputSchema.parse(input), "2027-01-03");
    expect(schedule.weekOneMonday).toBe("2026-12-28");
  });
  it("keeps real meal conflicts visible rather than inventing availability", () => {
    const schedule = initialLearningSchedule(firstLearningInputSchema.parse({ ...input, startTime: "12:00" }), "2026-10-19");
    expect(deriveDayBlocks("2026-10-19", schedule, []).filter(block => block.kind === "free")).toEqual([]);
  });
});

describe("first-learning daily roadmap", () => {
  it("plans ten days before the exam with a separate day boundary for every task", () => {
    const days = initialLearningDays(firstLearningInputSchema.parse({ ...input, targetDate: "2026-10-31", minutes: 60 }), "2026-10-21", "Asia/Shanghai");
    expect(days).toHaveLength(10);
    expect(days[0]).toMatchObject({ date: "2026-10-21", minutes: 60, notBefore: "2026-10-20T16:00:00.000Z", dueAt: "2026-10-21T15:59:59.999Z" });
    expect(days[9]!.date).toBe("2026-10-30");
    expect(days.every((day, index) => index === 0 || Date.parse(day.notBefore) > Date.parse(days[index - 1]!.dueAt))).toBe(true);
  });
  it("honors daylight saving and bounds distant goals without losing the actual goal date", () => {
    const parsed = firstLearningInputSchema.parse({ ...input, targetDate: "2030-01-01" });
    const days = initialLearningDays(parsed, "2026-10-31", "America/Los_Angeles");
    expect(days).toHaveLength(28);
    expect(Date.parse(days[1]!.dueAt) + 1 - Date.parse(days[1]!.notBefore)).toBe(25 * 60 * 60 * 1000);
    expect(parsed.targetDate).toBe("2030-01-01");
  });
  it("starts one day for a same-day goal and seven days without a deadline", () => {
    expect(initialLearningDays(firstLearningInputSchema.parse({ ...input, targetDate: "2026-10-21" }), "2026-10-21", "UTC")).toHaveLength(1);
    expect(initialLearningDays(firstLearningInputSchema.parse(input), "2026-10-21", "UTC")).toHaveLength(7);
  });
});
