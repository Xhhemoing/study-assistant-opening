import { describe, expect, it } from "vitest";
import { examChoiceSpecSchema, serverEvaluationSchema } from "./matrix-evaluation";
import { learningAttemptSubmitInputSchema } from "./learning-attempts";

const uuid = "00000000-0000-4000-8000-000000000001";
const facts = {
  observationId: uuid, attemptId: uuid, problemId: uuid, itemVersionId: uuid, requirementKey: "exam-skill:node",
  decision: "correct", outcome: "correct", reasonCodes: ["compared"], evaluatedAt: "2026-10-17T12:00:00.000Z",
};

describe("controlled server evaluation contracts", () => {
  it("accepts both supported evaluator/spec pairs", () => {
    expect(serverEvaluationSchema.safeParse({ ...facts, evaluatorVersion: "matrix-exact-v1", specVersion: "matrix-arithmetic-v1" }).success).toBe(true);
    expect(serverEvaluationSchema.safeParse({ ...facts, evaluatorVersion: "exam-choice-exact-v1", specVersion: "exam-choice-v1" }).success).toBe(true);
  });

  it.each([
    ["exam-choice-exact-v1", "matrix-arithmetic-v1"], ["matrix-exact-v1", "exam-choice-v1"],
    ["exam-choice-exact-v2", "exam-choice-v1"], ["anything", "exam-choice-v1"],
  ])("rejects unsupported pair %s / %s", (evaluatorVersion, specVersion) => {
    expect(serverEvaluationSchema.safeParse({ ...facts, evaluatorVersion, specVersion }).success).toBe(false);
  });

  it("keeps answers and grading facts out of both item selectors and public submit requests", () => {
    const spec = { kind: "exam_choice", specVersion: "exam-choice-v1", packId: "pack", packVersion: "1", questionId: "question", familyId: "family" };
    expect(examChoiceSpecSchema.parse(spec)).toEqual(spec);
    expect(examChoiceSpecSchema.safeParse({ ...spec, answer: "A" }).success).toBe(false);
    expect(examChoiceSpecSchema.safeParse({ ...spec, evaluatorVersion: "exam-choice-exact-v1" }).success).toBe(false);
    const submit = { clientKey: "submit-test", answer: "A", outcome: "correct", assistance: "independent" };
    expect(learningAttemptSubmitInputSchema.safeParse({ ...submit, verdictSource: "deterministic" }).success).toBe(false);
    expect(learningAttemptSubmitInputSchema.safeParse({ ...submit, serverEvaluation: facts }).success).toBe(false);
  });
});
