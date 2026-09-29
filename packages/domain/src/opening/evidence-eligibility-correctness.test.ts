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
