import { describe, expect, it } from "vitest";
import { deriveDayBlocks } from "@aistudy/domain";
import { firstLearningInputSchema, initialLearningSchedule } from "./first-learning-input";
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
