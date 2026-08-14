import type { ScenarioPreset } from "@aistudy/contracts";
import { describe, expect, it } from "vitest";
import { buildTodayPlan, PLANNER_VERSION, type PlannerInput } from "./planner";
import { getScenarioPresetDefinition } from "./scenario-presets";

const BASE: PlannerInput = {
  ownerUserId: "u1",
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

describe("buildTodayPlan plan-1", () => {
  it("respects the budget cap", () => {
    const p = plan({
      points: [point("a", "weak", 30), point("b", "weak", 30), point("c", "untested", 10)],
    });
    expect(p.totalMinutes).toBeLessThanOrEqual(45);
    expect(p.tasks.map((t) => t.refId)).toEqual(["item-a", "item-c"]);
  });

  it("keeps locked tasks first and counts their minutes", () => {
    const p = plan({
      budgetMinutes: 30,
      lockedTasks: [
        {
          id: "plan-2026-08-02-practice-item-x",
          kind: "practice",
          refId: "item-x",
          title: "锁定任务",
          estimatedMinutes: 20,
          reason: "用户锁定",
          locked: true,
          status: "pending",
        },
      ],
      points: [point("a", "weak", 15), point("b", "untested", 10)],
    });
    expect(p.tasks[0].id).toBe("plan-2026-08-02-practice-item-x");
    expect(p.tasks.map((t) => t.refId)).toEqual(["item-x", "item-b"]);
    expect(p.totalMinutes).toBe(30);
  });

  it("orders tiers by scenario: final puts untested before usable", () => {
    const p = plan({
      scenario: "final" satisfies ScenarioPreset,
      dueReviews: [{ cardId: "card-1", front: "导数定义卡片", estimatedMinutes: 5 }],
      points: [
        point("u1", "usable", 10, "可用点"),
        point("w1", "weak", 10, "薄弱点"),
        point("t1", "untested", 10, "未测点"),
        point("s1", "stable", 10, "稳固点"),
      ],
    });
    // 验证 tierOrder 来自注册表而非硬编码
    const def = getScenarioPresetDefinition("final" as ScenarioPreset);
    expect(def.tierOrder).toEqual(["weak", "untested", "usable"]);
    expect(p.tasks.map((t) => t.id)).toEqual([
      "plan-2026-08-02-review-card-1",
      "plan-2026-08-02-practice-item-w1",
      "plan-2026-08-02-practice-item-t1",
      "plan-2026-08-02-practice-item-u1",
    ]);
  });

  it("gaokao puts usable before untested", () => {
    const p = plan({
      scenario: "gaokao" satisfies ScenarioPreset,
      points: [point("t1", "untested", 10, "未测点"), point("u1", "usable", 10, "可用点")],
    });
    expect(p.tasks.map((t) => t.refId)).toEqual(["item-u1", "item-t1"]);
  });

  it("excludes stable points", () => {
    const p = plan({ points: [point("s1", "stable", 5)] });
    expect(p.tasks).toEqual([]);
    expect(p.totalMinutes).toBe(0);
  });

  it("skips an overflowing candidate and tries the next smaller one", () => {
    const p = plan({
      budgetMinutes: 10,
      points: [point("big", "weak", 12), point("small", "untested", 8)],
    });
    expect(p.tasks.map((t) => t.refId)).toEqual(["item-small"]);
  });

  it("sorts reviews by cardId and points by title within a tier", () => {
    const p = plan({
      dueReviews: [
        { cardId: "card-b", front: "乙卡", estimatedMinutes: 5 },
        { cardId: "card-a", front: "甲卡", estimatedMinutes: 5 },
      ],
      points: [point("p2", "weak", 10, "乙考点"), point("p1", "weak", 10, "甲考点")],
    });
    expect(p.tasks.map((t) => t.id)).toEqual([
      "plan-2026-08-02-review-card-a",
      "plan-2026-08-02-review-card-b",
      "plan-2026-08-02-practice-item-p1",
      "plan-2026-08-02-practice-item-p2",
    ]);
  });

  it("emits exact reasons and truncates titles to 24 chars", () => {
    const p = plan({
      dueReviews: [{ cardId: "card-1", front: "这是一张名字特别特别特别特别特别特别特别长的复习卡片", estimatedMinutes: 5 }],
      points: [
        point("w", "weak", 10, "薄弱"),
        point("t", "untested", 10, "未测"),
        point("u", "usable", 10, "可用"),
      ],
    });
    expect(p.tasks[0].reason).toBe("今日到期的复习卡");
    expect(p.tasks[0].title.length).toBe(24);
    expect(p.tasks[1].reason).toBe("薄弱考点，优先补缺");
    expect(p.tasks[2].reason).toBe("尚未测评，先建立基线");
    expect(p.tasks[3].reason).toBe("做一道变式保持手感");
  });

  it("skips practice tasks when assessment is disabled but keeps reviews", () => {
    const p = plan({
      assessmentMode: "disabled",
      dueReviews: [{ cardId: "card-1", front: "导数定义卡片", estimatedMinutes: 5 }],
      points: [point("a", "weak", 10), point("b", "untested", 10)],
    });
    expect(p.tasks.map((t) => t.kind)).toEqual(["review"]);
    expect(p.tasks.every((t) => t.kind !== "practice")).toBe(true);
  });

  it("defaults to basic assessment mode and includes practice tasks", () => {
    const p = plan({ points: [point("a", "weak", 10)] });
    expect(p.tasks.map((t) => t.kind)).toEqual(["practice"]);
  });

  it("is deterministic and carries plan metadata", () => {
    const input: PlannerInput = { ...BASE, points: [point("a", "weak", 10)] };
    const p1 = buildTodayPlan(input);
    const p2 = buildTodayPlan(input);
    expect(p1).toEqual(p2);
    expect(p1.id).toBe("plan-u1-2026-08-02");
    expect(p1.budgetMinutes).toBe(45);
    expect(p1.options).toEqual([]);
    expect(p1.strategyVersion).toBe(PLANNER_VERSION);
    expect(p1.generatedAt).toBe("2026-08-02T00:00:00.000Z");
    expect(p1.tasks[0].status).toBe("pending");
    expect(p1.tasks[0].locked).toBe(false);
  });
});
