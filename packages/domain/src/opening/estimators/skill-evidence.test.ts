import { describe, expect, it } from "vitest";
import { learningObservation, qualifiedInput } from "../learning-summary-fixtures";
import { toSkillEvidence } from "./skill-evidence";

describe("skill evidence adapter", () => {
  it("preserves all estimator fields and the full source facts", () => {
    const record = { ...learningObservation, requirementKey: "requirement-1", itemVersionId: "version-1" };
    const result = toSkillEvidence(record, qualifiedInput);
    expect(result).toEqual({
      observationId: record.id, courseId: record.courseId, skillLabel: record.skillLabel,
      requirementKey: "requirement-1", itemVersionId: "version-1", firstAttempt: null,
      outcome: record.outcome, assistance: record.assistance, verdictSource: record.verdictSource, occurredAt: record.occurredAt,
      record, eligibilityInput: qualifiedInput,
    });
    expect(result.record).toBe(record);
    expect(result.eligibilityInput).toBe(qualifiedInput);
  });

  it("keeps unavailable historical identity and first-attempt history unknown", () => {
    const result = toSkillEvidence(learningObservation, null);
    expect(result.requirementKey).toBeNull();
    expect(result.itemVersionId).toBeNull();
    expect(result.firstAttempt).toBeNull();
    expect(result.eligibilityInput).toBeNull();
  });

  it.each([true, false] as const)("preserves an explicit server first-attempt fact %s", firstAttempt => {
    expect(toSkillEvidence(learningObservation, qualifiedInput, firstAttempt).firstAttempt).toBe(firstAttempt);
  });
});
