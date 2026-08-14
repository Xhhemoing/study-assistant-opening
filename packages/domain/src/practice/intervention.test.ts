import { describe, expect, it } from "vitest";
import type { ErrorCause, PracticeItem } from "@aistudy/contracts";
import {
  actionForCause,
  classifyError,
  planIntervention,
  type InterventionAction,
} from "./intervention";

const item = (overrides: Partial<PracticeItem> = {}): PracticeItem => ({
  id: "22222222-2222-4222-8222-222222222201",
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  kind: "multiple_choice",
  stem: "关于函数极限的定义，下列说法正确的是？",
  options: ["A", "B"],
  answer: "A",
  hints: ["提示"],
  abilitySlice: "recall",
  estimatedMinutes: 5,
  contentVersion: 1,
  ...overrides,
});

const EXPECTED_ACTIONS: Array<[ErrorCause | null, InterventionAction]> = [
  ["concept", "review"],
  ["misread", "review"],
  ["calculation", "variant"],
  ["steps", "review"],
  ["time", "schedule"],
  ["other", "review"],
  [null, "review"],
];

describe("classifyError", () => {
  it("maps every known cause to its expected action", () => {
    for (const [cause, action] of EXPECTED_ACTIONS) {
      const hint = classifyError(cause, item());
      expect(hint.action).toBe(action);
    }
  });

  it("returns a non-empty message for every known cause", () => {
    for (const [cause] of EXPECTED_ACTIONS) {
      const hint = classifyError(cause, item());
      expect(hint.message.length).toBeGreaterThan(5);
    }
  });

  it("does not append ellipsis to short stems", () => {
    const hint = classifyError("concept", item({ stem: "极限" }));
    expect(hint.message).toContain("「极限」");
    expect(hint.message).not.toContain("极限…");
  });
});

describe("actionForCause", () => {
  it("maps calculation to variant and time to schedule", () => {
    expect(actionForCause("calculation")).toBe("variant");
    expect(actionForCause("time")).toBe("schedule");
    expect(actionForCause("concept")).toBe("review");
    expect(actionForCause("misread")).toBe("review");
    expect(actionForCause("steps")).toBe("review");
    expect(actionForCause("other")).toBe("review");
    expect(actionForCause(null)).toBe("review");
  });
});

describe("planIntervention", () => {
  const BASE = {
    cause: "concept" as ErrorCause,
    confidence: 3,
    occurredAt: "2026-08-14T08:00:00.000Z",
  };

  it("schedules a 7-day check window from occurredAt", () => {
    const plan = planIntervention(BASE);
    expect(plan.checkAt).toBe("2026-08-21T08:00:00.000Z");
  });

  it("defaults to low priority for a low-confidence first error", () => {
    expect(planIntervention(BASE).priority).toBe("low");
  });

  it("raises to medium on a high-confidence error", () => {
    expect(planIntervention({ ...BASE, confidence: 4 }).priority).toBe("medium");
    expect(planIntervention({ ...BASE, confidence: 5 }).priority).toBe("medium");
  });

  it("raises to high when the same cause repeats in history", () => {
    expect(planIntervention({ ...BASE, historyCauses: ["concept"] }).priority).toBe("high");
  });

  it("stays high when both repeat and high confidence apply", () => {
    expect(
      planIntervention({ ...BASE, confidence: 5, historyCauses: ["concept", "calculation"] }).priority,
    ).toBe("high");
  });

  it("derives the action from the cause", () => {
    expect(planIntervention({ ...BASE, cause: "calculation" }).action).toBe("variant");
    expect(planIntervention({ ...BASE, cause: "time" }).action).toBe("schedule");
  });
});
