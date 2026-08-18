import { describe, expect, it } from "vitest";
import type { StorageLike } from "./storage";
import { createMockProvider } from "./provider";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-08-02T08:00:00.000Z");

function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("mock today planner wiring", () => {
  it("reserves protected exploration minutes on the today plan", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      protectedExplorationMinutes: 15,
    });
    const plan = await provider.getTodayPlan("2026-08-02");
    expect(plan.tasks.some((task) => task.kind === "explore" && task.estimatedMinutes === 15)).toBe(true);
    expect(plan.totalMinutes).toBeLessThanOrEqual(plan.budgetMinutes);
  });

  it("returns no generated tasks when planning is disabled", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
      planningEnabled: false,
    });
    const plan = await provider.getTodayPlan("2026-08-02");
    expect(plan.tasks).toEqual([]);
    expect(plan.options).toEqual([]);
  });

  it("offers options when final and entrance goals conflict and applies an explicit choice", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
    });
    await provider.createGoal({
      title: "高考冲刺",
      scenario: "gaokao",
      examDate: null,
      subjects: ["数学"],
      dailyMinutes: 20,
      courseId: null,
    });
    const before = await provider.getTodayPlan("2026-08-02");
    expect(before.options.length).toBeGreaterThanOrEqual(2);
    expect(before.options.length).toBeLessThanOrEqual(3);
    const chosen = before.options[0];
    expect(chosen).toBeDefined();
    const after = await provider.selectPlanOption("2026-08-02", chosen!.id);
    expect(after.tasks.some((task) => task.kind === "practice" || task.kind === "review")).toBe(true);
  });

  it("keeps a locked practice task when conflicting goals open options", async () => {
    const provider = createMockProvider({
      userId: USER_ID,
      now: NOW,
      delayMs: 0,
      storage: createMemoryStorage(),
    });
    const date = "2026-08-02";
    const initial = await provider.getTodayPlan(date);
    const practice = initial.tasks.find((task) => task.kind === "practice");
    expect(practice).toBeDefined();
    await provider.toggleTaskLock(date, practice!.id);
    await provider.createGoal({
      title: "高考冲刺",
      scenario: "gaokao",
      examDate: null,
      subjects: ["数学"],
      dailyMinutes: 20,
      courseId: null,
    });
    const conflicted = await provider.getTodayPlan(date);
    expect(conflicted.options.length).toBeGreaterThanOrEqual(2);
    expect(conflicted.tasks.some((task) => task.id === practice!.id && task.locked)).toBe(true);
    const chosen = await provider.selectPlanOption(date, conflicted.options[0]!.id);
    expect(chosen.tasks.some((task) => task.id === practice!.id && task.locked)).toBe(true);
  });
});
