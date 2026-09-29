import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility version", () => {
  it.each([
    ["version_unknown", "unknown"],
    ["changed_needs_check", "unknown"],
    ["unavailable", "no"],
    ["privacy_excluded", "no"],
  ] as const)("distinguishes %s version applicability", (applicability, expected) => {
    const result = evaluateEvidenceEligibility(observation, {
      ...context, version: { applicability, currentItemVersionId: "version-2" },
    });
    expect(result.usableForCurrentVersion).toBe(expected);
    expect(result.usableForDelayedCheck).toBe(expected);
    expect(result.verifiedCorrect).toBe("yes");
    expect(result.reasonCodes).toContain(applicability === "version_unknown" ? "version_unknown" : `version_${applicability}`);
  });

  it("requires exact version identity rather than accepting an exact label", () => {
    expect(evaluateEvidenceEligibility(observation, {
      ...context, version: { applicability: "exact", currentItemVersionId: "version-2" },
    }).usableForCurrentVersion).toBe("unknown");
  });

  const equivalence = {
    confirmationId: "confirmation-1",
    courseId: "course-1",
    requirementKey: "requirement-1",
    problemId: "problem-1",
    fromItemVersionId: "version-1",
    toItemVersionId: "version-2",
  };
  it("accepts an explicitly confirmed equivalence for this course, requirement and problem", () => {
    const result = evaluateEvidenceEligibility(observation, {
      ...context, version: { applicability: "equivalent_confirmed", currentItemVersionId: "version-2", equivalence },
    });
    expect(result.usableForCurrentVersion).toBe("yes");
    expect(result.usableForDelayedCheck).toBe("yes");
    expect(result.reasonCodes).toContain("version_equivalent_confirmed");
  });

  it.each(["confirmationId", "courseId", "requirementKey", "problemId", "fromItemVersionId", "toItemVersionId"] as const)(
    "does not reuse an equivalence with missing or mismatched %s",
    (field) => {
      const result = evaluateEvidenceEligibility(observation, {
        ...context, version: {
          applicability: "equivalent_confirmed", currentItemVersionId: "version-2",
          equivalence: { ...equivalence, [field]: field === "confirmationId" ? null : "other" },
        },
      });
      expect(result.usableForCurrentVersion).toBe("unknown");
    },
  );

  it("does not accept an equivalence label without a confirmation record", () => {
    expect(evaluateEvidenceEligibility(observation, {
      ...context, version: { applicability: "equivalent_confirmed", currentItemVersionId: "version-2" },
    }).usableForCurrentVersion).toBe("unknown");
  });
});
