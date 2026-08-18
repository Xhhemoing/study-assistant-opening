import { describe, expect, it } from "vitest";
import { plannedTaskSchema, todayPlanSchema } from "./plan";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-02T08:00:00.000Z";

const task = {
  id: "plan-2026-08-02-practice-p1",
  kind: "practice" as const,
  refId: "p1",
  title: "导数的定义",
  estimatedMinutes: 10,
  reason: "薄弱考点，优先补缺",
  locked: false,
  status: "pending" as const,
};

describe("today plan contract", () => {
  it("rejects marking a planned task as failure", () => {
    expect(() => plannedTaskSchema.parse({ ...task, status: "failed" })).toThrow();
  });

  it("requires an evidence snapshot on the plan", () => {
    expect(() =>
      todayPlanSchema.parse({
        id: "plan-u-2026-08-02",
        ownerUserId: UUID,
        date: "2026-08-02",
        budgetMinutes: 45,
        totalMinutes: 10,
        tasks: [task],
        options: [],
        strategyVersion: "plan-1",
        generatedAt: NOW,
      }),
    ).toThrow();
  });
});
