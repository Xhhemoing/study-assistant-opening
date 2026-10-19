import { describe, expect, it } from "vitest";
import { spanExerciseInputSchema, spanProblemSchema } from "./span-learning";
import { serverEvaluationSchema } from "./matrix-evaluation";
describe("span HTTP and evaluator contracts", () => {
  const input = { sourceId: "00000000-0000-4000-8000-000000000001", problemId: "span-example-2d", version: 1 };
  it("accepts immutable item identity, rejecting arbitrary client operands", () => {
    expect(spanExerciseInputSchema.safeParse(input).success).toBe(true);
    expect(spanExerciseInputSchema.safeParse({ ...input, vectors: [["0"], ["0"]] }).success).toBe(false);
    expect(spanExerciseInputSchema.safeParse({ ...input, version: 0 }).success).toBe(false);
  });
  it("rejects mismatched dimensions and accepts exact fraction strings", () => {
    const problem = { id: "p", version: "1", familyId: "f", vectors: [["1/2", "0"], ["0", "1"]], target: ["1/2", "2"], knowledgeComponents: ["span:vector-equation"] };
    expect(spanProblemSchema.safeParse(problem).success).toBe(true);
    expect(spanProblemSchema.safeParse({ ...problem, target: ["1"] }).success).toBe(false);
  });
  it("requires the exact span evaluator/spec pair", () => {
    const id = input.sourceId;
    const facts = { observationId: id, attemptId: id, problemId: id, itemVersionId: id, requirementKey: "span:solve-coefficients", decision: "correct", outcome: "correct", reasonCodes: ["verified_exactly"], evaluatedAt: "2026-10-19T00:00:00Z", evaluatorVersion: "span-exact-v1", specVersion: "span-v1" };
    expect(serverEvaluationSchema.safeParse(facts).success).toBe(true);
    expect(serverEvaluationSchema.safeParse({ ...facts, specVersion: "matrix-arithmetic-v1" }).success).toBe(false);
  });
});
