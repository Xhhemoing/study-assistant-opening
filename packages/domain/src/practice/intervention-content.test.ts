import { describe, expect, it } from "vitest";
import type { PracticeItem } from "@aistudy/contracts";
import { planIntervention } from "./intervention";
import { generateInterventionContent } from "./intervention-content";

const item = (overrides: Partial<PracticeItem> = {}): PracticeItem => ({
  id: "22222222-2222-4222-8222-222222222201",
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  kind: "multiple_choice",
  stem: "关于函数极限的定义，下列说法正确的是？",
  options: ["A. 教材定义表述", "B. 常见误解", "C. 无关结论", "D. 以偏概全"],
  answer: "A",
  hints: ["提示"],
  abilitySlice: "recall",
  estimatedMinutes: 5,
  contentVersion: 1,
  ...overrides,
});

function planFor(cause: Parameters<typeof planIntervention>[0]["cause"], confidence = 3) {
  return planIntervention({ cause, confidence, occurredAt: "2026-08-14T08:00:00.000Z" });
}

describe("generateInterventionContent", () => {
  it("generates a step guide for a steps error", () => {
    const result = generateInterventionContent(planFor("steps"), item());
    expect(result.kind).toBe("step-guide");
    if (result.kind === "step-guide") {
      expect(result.guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(result.guide.steps.join("")).toContain("检验");
    }
  });

  it("generates a shuffled variant for a calculation error", () => {
    const source = item();
    const result = generateInterventionContent(planFor("calculation"), source);
    expect(result.kind).toBe("variant");
    if (result.kind === "variant") {
      expect(result.variant.options).toHaveLength(source.options!.length);
      // 循环左移一位：原 "A. 教材定义表述" 移到最后一个位置，正确答案字母相应变化。
      expect(result.variant.options![0]).toBe("B. 常见误解");
      expect(result.variant.answer).toBe("D");
    }
  });

  it("keeps the original item as a variant for non-choice kinds", () => {
    const source = item({ kind: "short_answer", options: undefined, answer: "极限" });
    const result = generateInterventionContent(planFor("calculation"), source);
    expect(result.kind).toBe("variant");
    if (result.kind === "variant") {
      expect(result.variant.stem).toBe(source.stem);
      expect(result.variant.answer).toBe("极限");
    }
  });

  it("generates a review card with the answer for a concept error", () => {
    const result = generateInterventionContent(planFor("concept"), item());
    expect(result.kind).toBe("review-card");
    if (result.kind === "review-card") {
      expect(result.card.front).toBe(item().stem);
      expect(result.card.back).toContain(item().answer);
      expect(result.card.tags).toContain("概念理解");
    }
  });

  it("schedules a time-intervention review card at the 7-day check window", () => {
    const plan = planFor("time");
    const result = generateInterventionContent(plan, item());
    expect(result.kind).toBe("review-card");
    if (result.kind === "review-card") {
      expect(result.card.dueAt).toBe("2026-08-21T08:00:00.000Z");
      expect(result.card.tags).toContain("时间不足");
    }
  });
});
