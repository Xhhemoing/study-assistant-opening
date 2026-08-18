import { describe, expect, it } from "vitest";
import { buildTodayPlan, PLANNER_VERSION, type PlannerInput } from "./planner";

const BASE: PlannerInput = {
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  date: "2026-08-02",
  budgetMinutes: 45,
  scenario: "final",
  points: [],
  dueReviews: [],
  lockedTasks: [],
};

function point(
  pointId: string,
  status: PlannerInput["points"][number]["status"],
  estimatedMinutes: number,
  title = `点${pointId}`,
): PlannerInput["points"][number] {
  return { pointId, title, status, estimatedMinutes, practiceItemId: `item-${pointId}` };
}

function plan(overrides: Partial<PlannerInput>) {
  return buildTodayPlan({ ...BASE, ...overrides });
}

describe("planner policy plan-1", () => {
  it("reserves protected exploration time so practice cannot consume it", () => {
    const result = plan({
      budgetMinutes: 45,
      protectedExplorationMinutes: 15,
      points: [point("a", "weak", 40), point("b", "untested", 10)],
    });
    const explore = result.tasks.find((task) => task.kind === "explore");
    expect(explore?.estimatedMinutes).toBe(15);
    expect(explore?.reason).toMatch(/探索/);
    expect(result.totalMinutes).toBeLessThanOrEqual(45);
    expect(result.tasks.filter((task) => task.kind === "practice").map((task) => task.refId)).toEqual(["item-b"]);
  });

  it("ranks final-exam untested before usable and entrance-exam usable before untested", () => {
    const points = [point("t1", "untested", 10, "未测点"), point("u1", "usable", 10, "可用点")];
    expect(plan({ goalKind: "final-exam", points }).tasks.map((task) => task.refId)).toEqual([
      "item-t1",
      "item-u1",
    ]);
    expect(plan({ goalKind: "entrance-exam", points }).tasks.map((task) => task.refId)).toEqual([
      "item-u1",
      "item-t1",
    ]);
  });

  it("keeps maintenance goals on weak and usable points and skips untested", () => {
    const result = plan({
      goalKind: "maintenance",
      dueReviews: [{ cardId: "card-1", front: "导数卡片", estimatedMinutes: 5 }],
      points: [point("t1", "untested", 10, "未测点"), point("u1", "usable", 10, "可用点")],
    });
    expect(result.tasks.map((task) => task.refId)).toEqual(["card-1", "item-u1"]);
  });

  it("returns 2-3 options when final and maintenance goals conflict and does not auto-accept", () => {
    const result = plan({
      points: [point("t1", "untested", 10, "未测点"), point("u1", "usable", 10, "可用点")],
      goals: [
        { id: "goal-final", kind: "final-exam" },
        { id: "goal-maintain", kind: "maintenance" },
      ],
    });
    expect(result.options.length).toBeGreaterThanOrEqual(2);
    expect(result.options.length).toBeLessThanOrEqual(3);
    expect(result.tasks.filter((task) => task.kind === "practice")).toEqual([]);
    expect(new Set(result.options.map((option) => option.id)).size).toBe(result.options.length);
    expect(result.options.every((option) => option.tasks.length > 0 && option.label.length > 0)).toBe(true);
  });

  it("returns no generated tasks when planning is disabled", () => {
    const result = plan({
      planningEnabled: false,
      points: [point("a", "weak", 10)],
      dueReviews: [{ cardId: "card-1", front: "卡片", estimatedMinutes: 5 }],
    });
    expect(result.tasks).toEqual([]);
    expect(result.options).toEqual([]);
    expect(result.tasks.every((task) => task.status !== "skipped")).toBe(true);
  });

  it("echoes strategy version and evidence snapshot and stays deterministic", () => {
    const input: PlannerInput = {
      ...BASE,
      evidenceSnapshotId: "snap-planner-01",
      points: [point("a", "weak", 10)],
    };
    const first = buildTodayPlan(input);
    const second = buildTodayPlan(input);
    expect(first).toEqual(second);
    expect(first.strategyVersion).toBe(PLANNER_VERSION);
    expect(first.evidenceSnapshotId).toBe("snap-planner-01");
  });
});
