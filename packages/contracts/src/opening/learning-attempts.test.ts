import { expect, it } from "vitest";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema } from "./learning-attempts";
const sessionId = "11111111-1111-4111-8111-111111111111";
it("allows an unlinked server-issued attempt without inventing a problem", () => {
  expect(learningAttemptCreateInputSchema.parse({ sessionId, clientKey: "start-001" })).toEqual({ sessionId, clientKey: "start-001" });
});
it.each(["attemptId", "startedAt", "itemVersionId", "sourceVersions", "eligibility"])("rejects client-owned derived or identity field %s", (key) => {
  expect(learningAttemptCreateInputSchema.safeParse({ sessionId, clientKey: "start-001", [key]: "forged" }).success).toBe(false);
});
it("rejects client submitted server time and qualification", () => {
  const input = { clientKey: "submit-001", answer: "answer", outcome: "correct", assistance: "independent" };
  expect(learningAttemptSubmitInputSchema.safeParse(input).success).toBe(true);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, submittedAt: "2026-09-28T00:00:00Z" }).success).toBe(false);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, eligibility: { verifiedCorrect: "yes" } }).success).toBe(false);
});
it("accepts a pinned teaching block and rejects invalid versions", () => {
  const input = { sessionId, clientKey: "teaching-001", teachingBlock: { blockId: sessionId, contentVersion: 1 } };
  expect(learningAttemptCreateInputSchema.safeParse(input).success).toBe(true);
  expect(learningAttemptCreateInputSchema.safeParse({ ...input, teachingBlock: { blockId: sessionId, contentVersion: 0 } }).success).toBe(false);
});
it("accepts only a catalogue selector, never client operands, answers, or grading facts", () => {
  const input = { sessionId, clientKey: "matrix-001", matrixExercise: { sourceId: sessionId, exerciseKey: "multiplication", variant: 0 } };
  expect(learningAttemptCreateInputSchema.safeParse(input).success).toBe(true);
  expect(learningAttemptCreateInputSchema.safeParse({ ...input, matrixExercise: { ...input.matrixExercise, matrixA: [[1]], answer: [[1]] } }).success).toBe(false);
  expect(learningAttemptCreateInputSchema.safeParse({ ...input, requirementKey: "fake" }).success).toBe(false);
  expect(learningAttemptCreateInputSchema.safeParse({ ...input, problemId: sessionId }).success).toBe(false);
  expect(learningAttemptCreateInputSchema.safeParse({ ...input, matrixExercise: { ...input.matrixExercise, variant: 9 } }).success).toBe(false);
  const submit = { clientKey: "matrix-answer", answer: "[[1]]", outcome: "correct", assistance: "independent" };
  expect(learningAttemptSubmitInputSchema.safeParse({ ...submit, verdictSource: "deterministic" }).success).toBe(false);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...submit, serverEvaluation: {} }).success).toBe(false);
});
