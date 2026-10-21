import { describe, expect, it } from "vitest";
import { teachingHintRequestSchema, teachingPartialHintsSchema } from "./teaching-hints";

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
});
