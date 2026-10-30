import { expect, it } from "vitest";
import type { AiEvaluation } from "@aistudy/contracts";
import { acceptedAiGradingOutcome, AI_GRADING_MIN_CONFIDENCE, isAiGradedEvidence } from "./ai-evaluation";
import { evaluateEvidenceEligibility, type EvidenceEligibilityContext, type EvidenceObservation } from "./evidence-eligibility";
import { observation, context, exposure } from "./evidence-eligibility-fixtures";
import { courseEvidence, learningObservation } from "./learning-summary-fixtures";
import { toSnapshotEvidence } from "./adaptive/snapshot-evidence";


const answer: EvidenceObservation = { ...observation, observationId: learningObservation.id, verdictSource: "ai_graded" };
const evaluation: AiEvaluation = {
  observationId: learningObservation.id, attemptId: observation.attemptId!, problemId: observation.problemId!,
  itemVersionId: observation.itemVersionId!, requirementKey: observation.requirementKey!, evaluatorVersion: "ai-rubric-v1",
  outcome: "correct", confidence: AI_GRADING_MIN_CONFIDENCE, questionMatch: true, feedback: "答案正确。",
  criteria: [{ label: "结果", verdict: "correct", feedback: "计算与题目相符。" }],
  modelLabel: "configured-model", evaluatedAt: "2026-10-21T08:00:00Z",
};
const captured: EvidenceEligibilityContext = { ...context, aiEvaluation: evaluation };

it("keeps an otherwise valid ai-rubric-v1 assessment uncalibrated", () => {
  expect(evaluateEvidenceEligibility(answer, captured)).toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "yes" });
  expect(evaluateEvidenceEligibility(answer, captured).reasonCodes).toEqual(expect.arrayContaining(["ai_graded_correct", "ai_evaluation_uncalibrated"]));
  expect(evaluateEvidenceEligibility({ ...answer, requirementKey: null }, {
    ...captured, aiEvaluation: { ...evaluation, requirementKey: null },
  }).verifiedCorrect).toBe("unknown");
  expect(acceptedAiGradingOutcome(evaluation)).toBe("correct");
});

it.each(["correct", "incorrect"] as const)("does not promote confidence=1 AI %s to binary evidence", outcome => {
  const proposal = { ...evaluation, outcome, confidence: 1, criteria: [{ label: "结果", verdict: outcome, feedback: "核对结果。" }] };
  const result = evaluateEvidenceEligibility({ ...answer, outcome }, { ...captured, aiEvaluation: proposal });
  expect(result).toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "yes", usableForDelayedCheck: "unknown" });
  expect(acceptedAiGradingOutcome(proposal)).toBe(outcome);
});

it.each(["observationId", "attemptId", "problemId", "itemVersionId", "requirementKey"] as const)("rejects AI assessment attached to another %s", field => {
  expect(evaluateEvidenceEligibility(answer, { ...captured, aiEvaluation: { ...evaluation, [field]: "other" } })).toMatchObject({
    verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining(["ai_evaluation_identity_mismatch"]),
  });
});

it.each([
  { change: { confidence: 0.79 }, reason: "ai_evaluation_low_confidence" },
  { change: { questionMatch: false }, reason: "ai_evaluation_question_mismatch" },
  { change: { outcome: "unverified" as const }, reason: "ai_evaluation_abstained" },
  { change: { criteria: [{ label: "过程", verdict: "unverified" as const, feedback: "关键步骤看不清。" }] }, reason: "ai_evaluation_criteria_inconsistent" },
  { change: { criteria: [{ label: "过程", verdict: "incorrect" as const, feedback: "漏掉负号。" }] }, reason: "ai_evaluation_criteria_inconsistent" },
])("keeps uncertain or contradictory model grading out of binary evidence: $reason", ({ change, reason }) => {
  const proposal = { ...evaluation, ...change };
  expect(acceptedAiGradingOutcome(proposal)).toBe("unverified");
  expect(evaluateEvidenceEligibility(answer, { ...captured, aiEvaluation: proposal })).toMatchObject({
    verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining([reason]),
  });
});

it("does not infer AI authority from model_suggestion or a missing/mismatched assessment", () => {
  expect(evaluateEvidenceEligibility({ ...answer, verdictSource: "model_suggestion" }, captured).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility(answer, { ...captured, aiEvaluation: null }).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility({ ...answer, outcome: "incorrect" }, captured).verifiedCorrect).toBe("unknown");
});

it("feeds only current, accepted incorrect criteria into the next lesson", () => {
  const mistake: AiEvaluation = { ...evaluation, outcome: "incorrect", misconceptionId: "denominator_changed", criteria: [
    { label: "分母", verdict: "incorrect", feedback: "同分母相加时分母保持不变。" },
    { label: "分子", verdict: "correct", feedback: "分子相加正确。" },
  ] };
  const facts = { observation: { ...answer, outcome: "incorrect" as const }, context: { ...captured, aiEvaluation: mistake } };
  const evidence = courseEvidence(facts);
  evidence.observations[0] = { ...learningObservation, verdictSource: "ai_graded", outcome: "incorrect", aiEvaluation: mistake };
  expect(toSnapshotEvidence(evidence, new Date()).observations[0]?.errors).toEqual([
    { observationId: learningObservation.id, label: "分母", feedback: "同分母相加时分母保持不变。", source: "ai_feedback", misconceptionId: "denominator_changed" },
  ]);
  facts.context.aiEvaluation = { ...mistake, confidence: 0.2 };
  expect(toSnapshotEvidence(evidence, new Date()).observations[0]?.errors).toBeUndefined();
  facts.context.aiEvaluation = mistake;
  facts.context.version = { applicability: "unavailable" };
  expect(toSnapshotEvidence(evidence, new Date()).observations[0]?.errors).toBeUndefined();
});

it("retains assistance and rejects independent credit after a hint or an unknown help history", () => {
  expect(evaluateEvidenceEligibility(answer, { ...captured, helpHistory: { complete: true, exposures: [exposure] } }))
    .toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "no", usableForDelayedCheck: "no" });
  expect(evaluateEvidenceEligibility(answer, { ...captured, helpHistory: { complete: false, exposures: [] } }))
    .toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "unknown" });
});

it("keeps valid AI delayed-check status unknown while retaining definite timing and availability exclusions", () => {
  expect(evaluateEvidenceEligibility(answer, captured)).toMatchObject({ verifiedCorrect: "unknown", usableForDelayedCheck: "unknown" });
  expect(evaluateEvidenceEligibility(answer, { ...captured, version: { applicability: "unavailable" } }))
    .toMatchObject({ verifiedCorrect: "unknown", usableForDelayedCheck: "no" });
  expect(evaluateEvidenceEligibility(answer, { ...captured,
    delayedCheck: { ...captured.delayedCheck!, earliestAt: answer.startedAt! + 1 },
  })).toMatchObject({ verifiedCorrect: "unknown", usableForDelayedCheck: "no" });
});

it.each([
  { outcome: "correct" as const, assistance: "hinted" as const },
  { outcome: "incorrect" as const, assistance: "independent" as const },
  { outcome: "correct" as const, assistance: "independent" as const },
  { outcome: "correct" as const, assistance: "unknown" as const },
])("keeps AI $outcome with $assistance out of strong snapshot status", ({ outcome, assistance }) => {
  const facts = { observation: { ...answer, outcome, assistance }, context: { ...captured,
    aiEvaluation: { ...evaluation, outcome, criteria: [{ label: "结果", verdict: outcome, feedback: "计算评阅。" }] },
  } };
  const evidence = courseEvidence(facts);
  evidence.observations[0] = { ...learningObservation, verdictSource: "ai_graded", outcome, assistance };
  const snapshot = toSnapshotEvidence(evidence, new Date("2026-10-21T08:00:00Z"));
  expect(snapshot.summaries[0]!.status).toBe("needs_check");
  expect(isAiGradedEvidence(evaluateEvidenceEligibility(facts.observation, facts.context))).toBe(true);
});

it("asks for independent practice after a correct photo without inventing a requirement or independent credit", () => {
  const facts = { observation: { ...answer, requirementKey: null, assistance: "unknown" as const },
    context: { ...captured, aiEvaluation: { ...evaluation, requirementKey: null } } };
  const evidence = courseEvidence(facts);
  evidence.observations[0] = { ...learningObservation, requirementKey: null, verdictSource: "ai_graded", assistance: "unknown" };
  const snapshot = toSnapshotEvidence(evidence, new Date("2026-10-21T08:00:00Z"));
  expect(snapshot.summaries[0]).toMatchObject({ requirementKey: null, status: "needs_check" });
  expect(snapshot.observations[0]).toMatchObject({ requirementKey: null, verifiedCorrect: "unknown", independentAttempt: "unknown" });
  expect(snapshot.summaries[0]!.status).toBe("needs_check");
});
