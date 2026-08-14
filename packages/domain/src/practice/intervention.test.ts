import { describe, expect, it } from "vitest";
import type { PracticeItem } from "@aistudy/contracts";
import { classifyError } from "./intervention";

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

describe("classifyError", () => {
  it("returns a non-empty message for every known cause", () => {
    const causes = ["concept", "misread", "calculation", "steps", "time", "other", null] as const;
    for (const cause of causes) {
      const hint = classifyError(cause as never, item());
      expect(hint.message.length).toBeGreaterThan(5);
      expect(["review", "variant", "schedule"]).toContain(hint.action);
    }
  });

  it("suggests variant for calculation errors", () => {
    const hint = classifyError("calculation", item());
    expect(hint.action).toBe("variant");
  });
});
