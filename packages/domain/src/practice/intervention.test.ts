import { describe, expect, it } from "vitest";
import type { ErrorCause, PracticeItem } from "@aistudy/contracts";
import { classifyError, type InterventionAction } from "./intervention";

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
