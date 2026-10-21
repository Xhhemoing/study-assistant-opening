import { expect, it } from "vitest";
import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningAttemptContextReadSchema } from "./learning-attempts";
import { evidenceEligibilitySchema } from "./learning-evidence";
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
it("allows learner comparison metadata while rejecting claimed review authority", () => {
  const input = { clientKey: "compare-001", answer: "1", outcome: "correct", assistance: "independent", verdictSource: "self_report",
    referenceCheck: { referenceSourceId: sessionId, method: "learner_self_compare", scope: "whole_answer" } };
  expect(learningAttemptSubmitInputSchema.safeParse(input).success).toBe(true);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, referenceCheck: { ...input.referenceCheck, authority: "independent_review" } }).success).toBe(false);
  expect(learningAttemptSubmitInputSchema.safeParse({ ...input, referenceCheckAuthority: "independent_review" }).success).toBe(false);
});
it.each(["opening-evidence-v1", "opening-evidence-v2", "opening-evidence-v3"])("reads captured policy %s without upgrading it", policyVersion => {
  const input = { independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "yes",
    usableForDelayedCheck: "unknown", reasonCodes: [], policyVersion };
  expect(evidenceEligibilitySchema.parse(input)).toEqual(input);
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

const contextAttempt = {
  id: sessionId, workspaceId: sessionId, sessionId, courseId: sessionId, skillLabel: "span", requirementKey: "span:v1",
  problemId: sessionId, itemVersionId: sessionId, sourceIds: [sessionId], sourceVersions: { [sessionId]: 2 },
  startedAt: "2026-10-21T00:00:00Z", submittedAt: null, observationId: null, historyRevision: 1,
  contextAnchor: { attemptId: sessionId, activityId: sessionId, itemVersionId: sessionId, courseId: sessionId,
    sourceId: sessionId, sourceVersion: 2, purpose: "learning_help" },
};
it("reads only a complete canonical assistant context without an answer or grading payload", () => {
  const result = { attempt: contextAttempt, deliveredAssistance: "hinted" };
  expect(learningAttemptContextReadSchema.parse(result)).toEqual(result);
  expect(learningAttemptContextReadSchema.safeParse({ ...result, answer: "sealed answer" }).success).toBe(false);
  expect(learningAttemptContextReadSchema.safeParse({ ...result, attempt: { ...contextAttempt, answer: "sealed answer" } }).success).toBe(false);
});
it.each([
  { contextAnchor: undefined }, { sourceIds: [] }, { sourceVersions: {} }, { itemVersionId: null }, { problemId: null },
  { contextAnchor: { ...contextAttempt.contextAnchor, attemptId: "22222222-2222-4222-8222-222222222222" } },
  { contextAnchor: { ...contextAttempt.contextAnchor, sourceVersion: 3 } },
])("rejects incomplete or inconsistent assistant restore identities: %j", change => {
  expect(learningAttemptContextReadSchema.safeParse({ attempt: { ...contextAttempt, ...change }, deliveredAssistance: "none" }).success).toBe(false);
});
