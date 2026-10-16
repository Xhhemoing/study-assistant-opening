import { expect, it } from "vitest";
import type { ServerEvaluation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, type EvidenceObservation, type EvidenceEligibilityContext } from "../evidence-eligibility";
const observation: EvidenceObservation = { observationId: "observation", attemptId: "attempt", problemId: "problem", itemVersionId: "item",
  courseId: "course", requirementKey: "matrix:req", startedAt: 100, submittedAt: 200, assistance: "independent", outcome: "correct", verdictSource: "deterministic" };
const evaluation: ServerEvaluation = { observationId: "observation", attemptId: "attempt", problemId: "problem", itemVersionId: "item", requirementKey: "matrix:req",
  evaluatorVersion: "matrix-exact-v1", specVersion: "matrix-arithmetic-v1", decision: "correct", outcome: "correct", reasonCodes: ["matrix_entries_compared"], evaluatedAt: "2026-10-16T12:00:00Z" };
const context: EvidenceEligibilityContext = { serverEvaluation: evaluation, helpHistory: { complete: true, exposures: [] }, version: { applicability: "exact", currentItemVersionId: "item" } };
it("qualifies an identity-bound server verdict while delayed learning remains unknown", () => {
  expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown" });
});
it.each(["observationId", "attemptId", "problemId", "itemVersionId", "requirementKey"] as const)("refuses a server verdict copied onto a different %s", field => {
  expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: { ...evaluation, [field]: "other" } })).toMatchObject({ verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining(["server_evaluation_identity_mismatch"]) });
});
it("does not trust labels, refused verdicts, conflicting outcomes or a student's copied fact", () => {
  expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: null }).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: { ...evaluation, decision: "abstain", outcome: "unverified" } }).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility({ ...observation, outcome: "incorrect" }, context).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility({ ...observation, verdictSource: "self_report" }, context).verifiedCorrect).toBe("unknown");
});
it("keeps help and version qualification independent from mathematical correctness", () => {
  expect(evaluateEvidenceEligibility({ ...observation, assistance: "hinted" }, context)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes" });
  expect(evaluateEvidenceEligibility(observation, { ...context, version: { applicability: "changed_needs_check" } })).toMatchObject({ verifiedCorrect: "yes", usableForCurrentVersion: "unknown" });
  expect(evaluateEvidenceEligibility(observation, { ...context, version: { applicability: "privacy_excluded" } })).toMatchObject({ usableForCurrentVersion: "no" });
});
it("retains catalogue feedback across overlapping attempts, revisions and changed source identities", () => {
  const withFeedback: EvidenceEligibilityContext = { ...context, helpHistory: { complete: true, exposures: [{
    attemptId: "previous-attempt", problemId: "same-catalogue-other-source", level: "hinted", kind: "evaluation_feedback",
    sameQuestion: true, delivered: true, deliveredAt: 150,
  }] } };
  expect(evaluateEvidenceEligibility(observation, withFeedback)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes",
    reasonCodes: expect.arrayContaining(["prior_evaluation_feedback"]) });
  expect(evaluateEvidenceEligibility({ ...observation, submittedAt: 125 }, withFeedback).independentAttempt).toBe("yes");
  expect(evaluateEvidenceEligibility(observation, { ...withFeedback, helpHistory: { ...withFeedback.helpHistory!,
    exposures: withFeedback.helpHistory!.exposures.map(exposure => ({ ...exposure, sameQuestion: false })),
  } }).independentAttempt).toBe("yes");
});
