import { describe, expect, it } from "vitest";
import { firstLearningInputSchema } from "./first-learning";
const input = { clientKey: "11111111-1111-4111-8111-111111111111", topic: "矩阵", minutes: 20, timeZone: "Asia/Shanghai" };
describe("first-learning optional schedule", () => {
  it.each([null, undefined])("accepts no fixed time without inventing a daily budget (%s)", startTime => {
    const parsed = firstLearningInputSchema.parse({ ...input, startTime });
    expect(parsed.startTime).toBeNull();
    expect(parsed.dailyMinutes).toBeUndefined();
    expect(parsed.minutes).toBe(20);
  });
  it("accepts a separate explicit daily budget", () => {
    expect(firstLearningInputSchema.parse({ ...input, dailyMinutes: 45 })).toMatchObject({ startTime: null, minutes: 20, dailyMinutes: 45 });
  });
  it.each([0, -1, 30.5, 181])("rejects an invalid explicit daily budget %s", dailyMinutes => {
    expect(firstLearningInputSchema.safeParse({ ...input, dailyMinutes }).success).toBe(false);
  });
  it("preserves explicit legacy time and its midnight validation", () => {
    expect(firstLearningInputSchema.parse({ ...input, startTime: "19:00" }).startTime).toBe("19:00");
    expect(firstLearningInputSchema.safeParse({ ...input, startTime: "23:50" }).success).toBe(false);
  });
});
