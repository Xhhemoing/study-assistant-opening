import { describe, expect, it } from "vitest";
import {
  GOAL_SCENARIOS,
  GOAL_WIZARD_STEPS,
  clampDailyMinutes,
  defaultGoalInput,
  formatExamDate,
  goalPath,
  normalizeGoalTitle,
  scenarioLabel,
} from "./goal-model";

describe("goal model", () => {
  it("keeps the four wizard scenarios in product order", () => {
    expect(GOAL_SCENARIOS.map((item) => item.value)).toEqual([
      "final",
      "gaokao",
      "kaoyan",
      "custom",
    ]);
    expect(scenarioLabel("kaoyan")).toBe("考研");
  });

  it("formats optional exam dates without shifting the calendar day", () => {
    expect(formatExamDate(null)).toBe("暂不设置");
    expect(formatExamDate("2026-08-15")).toBe("2026年8月15日");
  });

  it("keeps daily study minutes within the wizard range", () => {
    expect(clampDailyMinutes(10)).toBe(15);
    expect(clampDailyMinutes(45)).toBe(45);
    expect(clampDailyMinutes(121)).toBe(120);
  });

  it("encodes goal detail paths", () => {
    expect(goalPath("goal/1")).toBe("/learn/goals/goal%2F1");
  });

  it("keeps the wizard focused on four skippable inputs with calm defaults", () => {
    expect(GOAL_WIZARD_STEPS).toEqual(["scenario", "examDate", "subjects", "dailyMinutes"]);
    expect(defaultGoalInput()).toMatchObject({
      title: "未命名目标",
      scenario: "final",
      examDate: null,
      subjects: [],
      dailyMinutes: 45,
    });
    expect(defaultGoalInput("55555555-5555-4555-8555-555555555501").courseId).toBe("55555555-5555-4555-8555-555555555501");
  });

  it("normalizes goal titles and rejects blank names", () => {
    expect(normalizeGoalTitle("  备考英语  ")).toBe("备考英语");
    expect(normalizeGoalTitle("   ")).toBeNull();
  });
});
