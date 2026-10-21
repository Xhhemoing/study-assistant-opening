import { describe, expect, it } from "vitest";
import { spanExerciseInputSchema, spanProblemSchema } from "./span-learning";
import { spanHintRequestSchema, spanHintResponseSchema } from "./span-hints";
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
  it("defaults legacy hint requests to direction and rejects client supplied answers or levels outside the ladder", () => {
    expect(spanHintRequestSchema.parse({ attemptId: input.sourceId }).level).toBe(1);
    for (const level of [1, 2, 3, 4]) expect(spanHintRequestSchema.parse({ attemptId: input.sourceId, level }).level).toBe(level);
    for (const level of [0, 5, 1.5, "4", null]) expect(spanHintRequestSchema.safeParse({ attemptId: input.sourceId, level }).success).toBe(false);
    expect(spanHintRequestSchema.safeParse({ attemptId: input.sourceId, level: 4, answer: "invented original" }).success).toBe(false);
  });
  it("requires an actual release receipt and actual level in every successful response", () => {
    const response = { attemptId: input.sourceId, level: 1, text: "Direction", exposureReceipt: { id: input.sourceId,
      releaseKey: "span-hint-v1:attempt:1", contextAnchor: { attemptId: input.sourceId, purpose: "learning_help" }, origin: "assistant", supportDomain: "math",
      generatedAt: "2026-10-21T00:00:00Z", releasedAt: "2026-10-21T00:00:00Z", acknowledgedAt: null, historyRevision: 1 } };
    expect(spanHintResponseSchema.safeParse(response).success).toBe(true);
    expect(spanHintResponseSchema.safeParse({ ...response, exposureReceipt: undefined }).success).toBe(false);
    expect(spanHintResponseSchema.safeParse({ ...response, level: undefined }).success).toBe(false);
    expect(spanHintResponseSchema.safeParse({ ...response, independent: true }).success).toBe(false);
  });
});
