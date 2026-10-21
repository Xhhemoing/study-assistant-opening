import { expect, it } from "vitest";
import { aiEvaluationSchema, aiGradingInputSchema, aiGradingProposalSchema } from "./ai-evaluation";
import { learningAttemptSubmitInputSchema } from "./learning-attempts";
import { observationInputSchema } from "./learning";
import { observationReplacementSchema } from "./learning-revisions";

const id = "11111111-1111-4111-8111-111111111111";
const proposal = { outcome: "correct", confidence: 0.9, questionMatch: true, feedback: "计算正确。",
  criteria: [{ label: "结果", verdict: "correct", feedback: "1 + 1 = 2。" }] };

it("accepts text and pinned photos, and rejects incomplete photo identity", () => {
  expect(aiGradingInputSchema.parse({ observationId: id })).toEqual({ observationId: id });
  expect(aiGradingInputSchema.safeParse({ observationId: id, workSourceId: id, workSourceVersion: 0, physicalPage: 1 }).success).toBe(true);
  for (const photo of [{ workSourceId: id }, { workSourceVersion: 0 }, { physicalPage: 1 },
    { workSourceId: id, workSourceVersion: 0, physicalPage: 0 }]) {
    expect(aiGradingInputSchema.safeParse({ observationId: id, ...photo }).success).toBe(false);
  }
});

it("requires a bounded confidence and rubric before trusting external model output", () => {
  expect(aiGradingProposalSchema.safeParse(proposal).success).toBe(true);
  for (const invalid of [{ confidence: -0.1 }, { confidence: 1.1 }, { confidence: Number.NaN },
    { criteria: [] }, { feedback: " " }, { criteria: [{ label: "结果", verdict: "partial", feedback: "部分正确" }] }]) {
    expect(aiGradingProposalSchema.safeParse({ ...proposal, ...invalid }).success).toBe(false);
  }
});

it("reads a server assessment for an ordinary exercise without a requirement key", () => {
  const evaluation = { ...proposal, observationId: id, attemptId: id, problemId: id, itemVersionId: id,
    requirementKey: null, evaluatorVersion: "ai-rubric-v1", modelLabel: "configured-model", evaluatedAt: "2026-10-21T08:00:00Z" };
  expect(aiEvaluationSchema.parse(evaluation)).toEqual(evaluation);
  const withPhoto = { ...evaluation, workSource: { id, version: 0, physicalPage: 1 } };
  expect(aiEvaluationSchema.parse(withPhoto)).toEqual(withPhoto);
  expect(aiEvaluationSchema.safeParse({ ...withPhoto, workSource: { id, version: -1, physicalPage: 1 } }).success).toBe(false);
});

it("rejects forged AI authority from grading, submission, observation and revision HTTP inputs", () => {
  const answer = { answer: "2", outcome: "correct", assistance: "independent" };
  const submit = { ...answer, clientKey: "submit-ai-test" };
  const observation = { ...submit, sessionId: id, courseId: id, skillLabel: "addition", sourceIds: [] };
  for (const forged of [{ verdictSource: "ai_graded" }, { aiEvaluation: proposal }]) {
    expect(learningAttemptSubmitInputSchema.safeParse({ ...submit, ...forged }).success).toBe(false);
    expect(observationInputSchema.safeParse({ ...observation, ...forged }).success).toBe(false);
    expect(observationReplacementSchema.safeParse({ ...answer, ...forged }).success).toBe(false);
    expect(aiGradingInputSchema.safeParse({ observationId: id, ...forged }).success).toBe(false);
  }
});

it("validates a follow-up answer against its own distinct choices", () => {
  const followUp = { prompt: "2+3=?", options: [{ id: "A", label: "5" }, { id: "B", label: "6" }], answerId: "A", explanation: "2+3=5。" };
  expect(aiGradingProposalSchema.parse({ ...proposal, followUp }).followUp).toEqual(followUp);
  for (const change of [{ answerId: "C" }, { options: [followUp.options[0], followUp.options[0]] }]) {
    expect(aiGradingProposalSchema.safeParse({ ...proposal, followUp: { ...followUp, ...change } }).success).toBe(false);
  }
});
