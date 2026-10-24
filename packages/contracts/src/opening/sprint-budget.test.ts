import { describe, expect, it } from "vitest";
import { sprintBudgetResponseSchema } from "./sprint-budget";

const response = {
  courseId: "11111111-1111-4111-8111-111111111111", generatedAt: "2026-10-23T00:00:00.000Z",
  status: "needs_goal", examDate: null, timeZone: null, dailyMinutes: null,
  horizonTruncated: false, tasks: [], days: [], unscheduled: [], deferredTaskIds: [], scheduledTaskIds: [], warnings: [],
};
describe("sprint budget response", () => {
  it("represents missing planning facts without inventing a deadline", () => {
    expect(sprintBudgetResponseSchema.parse(response)).toEqual(response);
  });
  it.each(["2026-02-30", "2026-13-01", "tomorrow"])("rejects invalid calendar date %s", examDate => {
    expect(sprintBudgetResponseSchema.safeParse({ ...response, examDate }).success).toBe(false);
  });
  it.each([-1, Infinity, NaN, 1441])("rejects impossible daily minutes %s", dailyMinutes => {
    expect(sprintBudgetResponseSchema.safeParse({ ...response, dailyMinutes }).success).toBe(false);
  });
  it("rejects malformed task identities and excess preview days", () => {
    expect(sprintBudgetResponseSchema.safeParse({ ...response, tasks: [{ id: "other", title: "题目" }] }).success).toBe(false);
    const day = { date: "2026-10-23", budgetMinutes: 0, committedMinutes: 0, plannedMinutes: 0, blocks: [] };
    expect(sprintBudgetResponseSchema.safeParse({ ...response, days: Array.from({ length: 29 }, () => day) }).success).toBe(false);
  });
  it("preserves a 25-hour DST day's accepted duration without increasing the new-task budget", () => {
    const day = { date: "2026-11-01", budgetMinutes: 60, committedMinutes: 1500, plannedMinutes: 0, blocks: [] };
    expect(sprintBudgetResponseSchema.parse({ ...response, days: [day] }).days[0]?.committedMinutes).toBe(1500);
  });
  it("does not accept a result pretending to change the formal plan", () => {
    expect(sprintBudgetResponseSchema.safeParse({ ...response, accepted: true }).success).toBe(false);
  });
});
