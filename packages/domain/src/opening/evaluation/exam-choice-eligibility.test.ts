import { describe, expect, it } from "vitest";
import type { ServerEvaluation } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, type EvidenceEligibilityContext, type EvidenceObservation } from "../evidence-eligibility";

const observation: EvidenceObservation = {
  observationId: "observation", attemptId: "attempt", problemId: "problem", itemVersionId: "item", courseId: "course",
  requirementKey: "exam-skill:node", startedAt: 100, submittedAt: 200, assistance: "independent", outcome: "correct", verdictSource: "deterministic",
};
const evaluation: ServerEvaluation = {
  observationId: "observation", attemptId: "attempt", problemId: "problem", itemVersionId: "item", requirementKey: "exam-skill:node",
  evaluatorVersion: "exam-choice-exact-v1", specVersion: "exam-choice-v1", decision: "correct", outcome: "correct",
  reasonCodes: ["exam_choice_compared"], evaluatedAt: "2026-10-17T12:00:00.000Z",
};
const context: EvidenceEligibilityContext = {
  serverEvaluation: evaluation, examAttempt: { firstFamilyExposure: true },
  helpHistory: { complete: true, exposures: [] }, version: { applicability: "exact", currentItemVersionId: "item" },
};

describe("exam choice evidence qualification", () => {
  it("qualifies only the identity-bound choice verdict and keeps delayed qualification separate", () => {
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown" });
  });

  it.each(["observationId", "attemptId", "problemId", "itemVersionId", "requirementKey"] as const)("rejects a copied verdict with mismatching %s", field => {
    expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: { ...evaluation, [field]: "other" } })).toMatchObject({
      verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining(["server_evaluation_identity_mismatch"]),
    });
  });

  it.each([
    { evaluatorVersion: "exam-choice-exact-v2", specVersion: "exam-choice-v1" },
    { evaluatorVersion: "exam-choice-exact-v1", specVersion: "matrix-arithmetic-v1" },
    { evaluatorVersion: "matrix-exact-v1", specVersion: "exam-choice-v1" },
    { evaluatorVersion: "arbitrary-ai-grader", specVersion: "exam-choice-v1" },
  ])("does not trust unsupported evaluator/spec pair %j", pair => {
    const invalid = { ...evaluation, ...pair } as unknown as ServerEvaluation;
    expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: invalid })).toMatchObject({
      verifiedCorrect: "unknown", reasonCodes: expect.arrayContaining(["server_evaluation_incomplete"]),
    });
  });

  it("never grants verification to self reports, model suggestions, abstentions or conflicting outcomes", () => {
    for (const verdictSource of ["self_report", "model_suggestion", "unknown"] as const) {
      expect(evaluateEvidenceEligibility({ ...observation, verdictSource }, context).verifiedCorrect).toBe("unknown");
    }
    expect(evaluateEvidenceEligibility(observation, { ...context, serverEvaluation: { ...evaluation, decision: "abstain", outcome: "unverified" } }).verifiedCorrect).toBe("unknown");
    expect(evaluateEvidenceEligibility({ ...observation, outcome: "incorrect" }, context).verifiedCorrect).toBe("unknown");
    expect(evaluateEvidenceEligibility({ ...observation, outcome: "incorrect" }, {
      ...context, serverEvaluation: { ...evaluation, decision: "incorrect", outcome: "incorrect" },
    }).verifiedCorrect).toBe("no");
  });

  it("retains assistance, version and family-exposure exclusions", () => {
    expect(evaluateEvidenceEligibility({ ...observation, assistance: "hinted" }, context)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes" });
    expect(evaluateEvidenceEligibility(observation, { ...context, version: { applicability: "changed_needs_check" } }).usableForCurrentVersion).toBe("unknown");
    expect(evaluateEvidenceEligibility(observation, { ...context, examAttempt: { firstFamilyExposure: false } })).toMatchObject({
      independentAttempt: "no", verifiedCorrect: "yes", reasonCodes: expect.arrayContaining(["exam_family_already_seen"]),
    });
    expect(evaluateEvidenceEligibility(observation, { ...context, helpHistory: { complete: false, exposures: [] } }).independentAttempt).toBe("unknown");
  });

  it("does not let reference checks or corrections upgrade a previously seen family", () => {
    const revised = { ...observation, observationId: "revision", verdictSource: "reference_checked" as const };
    expect(evaluateEvidenceEligibility(revised, {
      ...context, serverEvaluation: null, examAttempt: { firstFamilyExposure: false },
      referenceCheck: { attemptId: "attempt", problemId: "problem", itemVersionId: "item", referenceId: "reference", checkerId: "learner", method: "compare", scope: "whole_answer", outcome: "correct" },
    })).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes", usableForDelayedCheck: "no" });
  });

  it("uses the supplied exam retest protocol without assuming the measurement protocol", () => {
    const delayedCheck = { protocolId: "exam-sprint-24h-v1", attemptId: "attempt", earliestAt: 100, priorAnswerPolicy: "require_unseen_problem" as const };
    expect(evaluateEvidenceEligibility(observation, { ...context, delayedCheck }).usableForDelayedCheck).toBe("yes");
    expect(evaluateEvidenceEligibility(observation, { ...context, delayedCheck: { ...delayedCheck, earliestAt: 101 } }).usableForDelayedCheck).toBe("no");
    expect(evaluateEvidenceEligibility(observation, { ...context, delayedCheck, examAttempt: { firstFamilyExposure: false } }).usableForDelayedCheck).toBe("no");
  });
});
