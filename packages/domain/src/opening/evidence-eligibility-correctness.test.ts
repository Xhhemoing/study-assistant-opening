import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility correctness", () => {
  it.each(["self_report", "model_suggestion", "unknown"] as const)(
    "does not verify correctness from %s even alongside reference metadata",
    (verdictSource) => {
      const result = evaluateEvidenceEligibility({ ...observation, verdictSource }, context);
      expect(result.verifiedCorrect).toBe("unknown");
      expect(result.usableForDelayedCheck).toBe("unknown");
    },
  );

  it("does not equate a reference_checked label with a completed reference check", () => {
    const result = evaluateEvidenceEligibility(observation, { ...context, referenceCheck: null });
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.reasonCodes).toContain("reference_check_incomplete");
  });

  it.each(["referenceId", "method", "checkerId", "outcome"] as const)(
    "requires reference-check %s",
    (field) => {
      const result = evaluateEvidenceEligibility(observation, {
        ...context, referenceCheck: { ...context.referenceCheck!, [field]: null },
      });
      expect(result.verifiedCorrect).toBe("unknown");
    },
  );

  it.each([
    ["partial check", { scope: "partial" }],
    ["other attempt", { attemptId: "attempt-1" }],
    ["other problem", { problemId: "other-problem" }],
    ["other version", { itemVersionId: "other-version" }],
    ["conflicting verdict", { outcome: "incorrect" }],
  ] as const)("does not verify the whole answer from %s", (_name, patch) => {
    expect(evaluateEvidenceEligibility(observation, {
      ...context, referenceCheck: { ...context.referenceCheck!, ...patch },
    }).verifiedCorrect).toBe("unknown");
  });

  it("separates independent work from a verified incorrect answer", () => {
    const result = evaluateEvidenceEligibility({ ...observation, outcome: "incorrect" }, {
      ...context, referenceCheck: { ...context.referenceCheck!, outcome: "incorrect" },
    });
    expect(result.independentAttempt).toBe("yes");
    expect(result.verifiedCorrect).toBe("no");
    expect(result.usableForDelayedCheck).toBe("no");
  });

  it("keeps a self-reported incorrect answer unverified", () => {
    expect(evaluateEvidenceEligibility({ ...observation, outcome: "incorrect", verdictSource: "self_report" }, context).verifiedCorrect).toBe("unknown");
  });
});

  it("keeps learner_self_compare whole_answer checks unverified while preserving attempt independence", () => {
    const result = evaluateEvidenceEligibility(observation, {
      ...context,
      referenceCheck: {
        ...context.referenceCheck!,
        method: "learner_self_compare 第3页",
        scope: "whole_answer",
      },
    });
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.independentAttempt).toBe("yes");
    expect(result.reasonCodes).toContain("learner_reference_compare");
  });

  it("keeps learner_self_compare partial scope unverified", () => {
    const result = evaluateEvidenceEligibility(observation, {
      ...context,
      referenceCheck: {
        ...context.referenceCheck!,
        method: "learner_self_compare 第3页",
        scope: "partial",
      },
    });
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.reasonCodes).toContain("reference_check_scope_incomplete");
  });

  it("labels self_report with reference metadata as a learner comparison", () => {
    const result = evaluateEvidenceEligibility(
      { ...observation, verdictSource: "self_report" },
      context,
    );
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.reasonCodes).toContain("learner_reference_compare");
  });

  it("does not trust complete historical reference metadata without independent-review authority", () => {
    const result = evaluateEvidenceEligibility(observation, { ...context, referenceCheckAuthority: undefined });
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.reasonCodes).toContain("reference_check_authority_unknown");
    expect(result.policyVersion).toBe("opening-evidence-v3");
  });

  it.each(["Compared every step", "已由另一名教师核对", "trusted_review"])("cannot upgrade a learner check by claiming method %s", method => {
    const result = evaluateEvidenceEligibility(observation, {
      ...context, referenceCheckAuthority: "learner",
      referenceCheck: { ...context.referenceCheck!, method, checkerId: "a-different-user" },
    });
    expect(result.independentAttempt).toBe("yes");
    expect(result.verifiedCorrect).toBe("unknown");
    expect(result.usableForDelayedCheck).toBe("unknown");
  });

it("requires the span verifier's complete core evidence before accepting its correct verdict", () => {
  const answer = { ...observation, observationId: "observation-span", verdictSource: "deterministic" as const };
  const serverEvaluation = { observationId: "observation-span", attemptId: answer.attemptId!, problemId: answer.problemId!, itemVersionId: answer.itemVersionId!,
    requirementKey: answer.requirementKey!, evaluatorVersion: "span-exact-v1" as const, specVersion: "span-v1" as const,
    decision: "correct" as const, outcome: "correct" as const, reasonCodes: [], evaluatedAt: "2026-10-19T00:00:00.000Z" };
  expect(evaluateEvidenceEligibility(answer, { ...context, serverEvaluation }).verifiedCorrect).toBe("unknown");
  expect(evaluateEvidenceEligibility(answer, { ...context, serverEvaluation: { ...serverEvaluation, coreEvidenceComplete: true } }).verifiedCorrect).toBe("yes");
});
