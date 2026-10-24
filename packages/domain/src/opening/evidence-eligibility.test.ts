import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context, exposure, withHelp } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility", () => {
  it.each(["changed", "unknown"] as const)("withholds %s material grades without falsifying byte applicability or help facts", materialAssessmentValidity => {
    const input = { ...context, materialAssessmentValidity };
    const result = evaluateEvidenceEligibility(observation, input);
    expect(result).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "unknown" });
    expect(result.usableForDelayedCheck).not.toBe("yes");
    expect(result.reasonCodes).toContain(materialAssessmentValidity === "changed" ? "material_assessment_changed" : "material_assessment_provenance_unknown");
    expect(result.reasonCodes).toContain("version_exact");
    expect(result.reasonCodes).not.toContain("version_changed_needs_check");
    expect(result.reasonCodes).not.toContain("reference_checked_correct");
    expect(input.version).toEqual(context.version);
    const incorrect = evaluateEvidenceEligibility({ ...observation, outcome: "incorrect" }, { ...input,
      referenceCheck: { ...context.referenceCheck!, outcome: "incorrect" } });
    expect(incorrect.verifiedCorrect).toBe("unknown");
    expect(incorrect.reasonCodes).not.toContain("reference_checked_incorrect");
  });
  it("does not restore an old grade when a dispute is cleared on a newer material revision", () => {
    const disputed = evaluateEvidenceEligibility(observation, { ...context, materialAnswerDisputed: true, materialAssessmentValidity: "changed" });
    const cleared = evaluateEvidenceEligibility(observation, { ...context, materialAnswerDisputed: false, materialAssessmentValidity: "changed" });
    expect(disputed).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "no" });
    expect(cleared).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown", usableForCurrentVersion: "unknown" });
    expect(cleared.reasonCodes).toContain("material_assessment_changed");
    expect(cleared.reasonCodes).not.toContain("material_answer_disputed");
    expect(evaluateEvidenceEligibility(observation, { ...context, materialAssessmentValidity: "changed", version: { applicability: "privacy_excluded" } }).usableForCurrentVersion).toBe("no");
  });
  it("excludes disputed material answers even after an otherwise valid independent score",()=>{
    expect(evaluateEvidenceEligibility(observation,{...context,materialAnswerDisputed:true})).toMatchObject({
      verifiedCorrect:"unknown",usableForCurrentVersion:"no",usableForDelayedCheck:"no",reasonCodes:expect.arrayContaining(["material_answer_disputed"]),
    });
  });
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
