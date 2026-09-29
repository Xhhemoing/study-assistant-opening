import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context, exposure, withHelp } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility", () => {
  it("qualifies a complete, independently attempted, reference-checked delayed answer", () => {
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({
      independentAttempt: "yes",
      verifiedCorrect: "yes",
      usableForCurrentVersion: "yes",
      usableForDelayedCheck: "yes",
      policyVersion: expect.any(String),
    });
  });

  it.each(["attemptId", "problemId", "itemVersionId"] as const)(
    "does not promote a legacy observation missing %s",
    (field) => {
      const result = evaluateEvidenceEligibility({ ...observation, [field]: null }, context);
      expect(result).toMatchObject({
        independentAttempt: "unknown",
        verifiedCorrect: "unknown",
        usableForCurrentVersion: "unknown",
        usableForDelayedCheck: "unknown",
      });
      expect(result.reasonCodes).toContain("observation_identity_incomplete");
    },
  );

  it("returns the same ordered, deduplicated reasons without mutating its inputs", () => {
    const exposures = [exposure, { ...exposure, deliveredAt: null }, exposure];
    const ctx = withHelp(exposures);
    const before = JSON.stringify({ observation, ctx });
    const first = evaluateEvidenceEligibility(observation, ctx);
    const second = evaluateEvidenceEligibility(observation, withHelp([...exposures].reverse()));
    expect(first).toEqual(second);
    expect(new Set(first.reasonCodes).size).toBe(first.reasonCodes.length);
    expect(JSON.stringify({ observation, ctx })).toBe(before);
  });
});
