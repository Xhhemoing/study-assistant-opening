import { describe, expect, it } from "vitest";
import { teachingHintRequestSchema, teachingPartialHintsSchema, teachingMisconceptionsSchema, teachingStartChoiceSchema } from "./teaching-hints";
import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";

describe("teaching hints boundary", () => {
  const attemptId = "00000000-0000-4000-8000-000000000001";
  it.each([1, 2, 3, 4])("accepts an explicit level %s for one server-issued attempt", level => {
    expect(teachingHintRequestSchema.parse({ attemptId, level })).toEqual({ attemptId, level });
  });
  it.each([0, 5, 1.5, "1", undefined])("rejects ambiguous hint level %s", level => {
    expect(teachingHintRequestSchema.safeParse({ attemptId, level }).success).toBe(false);
  });
  it("rejects client-supplied help qualifications or absent generated stages", () => {
    expect(teachingHintRequestSchema.safeParse({ attemptId, level: 1, supportDomain: "language" }).success).toBe(false);
    expect(teachingPartialHintsSchema.safeParse({ direction: "方向", concept: "概念" }).success).toBe(false);
    expect(teachingPartialHintsSchema.safeParse({ direction: " ", concept: "概念", firstStep: "第一步" }).success).toBe(false);
    expect(teachingPartialHintsSchema.safeParse({ direction: "方向", concept: "概念", firstStep: "第一步", answer: "答案" }).success).toBe(false);
  });
  it("requires 2–3 distinct, actionable misconceptions and different starting directions", () => {
    expect(teachingMisconceptionsSchema.parse(rankPedagogy.misconceptions)).toEqual(rankPedagogy.misconceptions);
    for (const items of [[], [rankPedagogy.misconceptions[0]], [rankPedagogy.misconceptions[0], rankPedagogy.misconceptions[0]],
      rankPedagogy.misconceptions.map(item => ({ ...item, correction: " " }))]) {
      expect(teachingMisconceptionsSchema.safeParse(items).success).toBe(false);
    }
    expect(teachingStartChoiceSchema.safeParse({ ...rankPedagogy.startChoice, misconception: {
      ...rankPedagogy.startChoice.misconception, step: rankPedagogy.startChoice.correct.step,
    } }).success).toBe(false);
  });
});
