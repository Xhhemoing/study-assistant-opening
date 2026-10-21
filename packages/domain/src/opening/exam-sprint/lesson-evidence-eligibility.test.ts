import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "../evidence-eligibility";
import { observation, context } from "../evidence-eligibility-fixtures";

const exam = { firstFamilyExposure: true, answerUnchanged: true };
describe("canonical Sprint lesson facts", () => {
  it("cannot launder frozen lesson assistance by revising the observation to independent", () => {
    const captured = { ...context, examAttempt: { ...exam, lessonAssistance: true } };
    expect(resolveEvidenceAssistance(observation, captured)).toBe("hinted");
    expect(evaluateEvidenceEligibility(observation, captured)).toMatchObject({ independentAttempt: "no", usableForDelayedCheck: "no" });
    expect(evaluateEvidenceEligibility(observation, captured).reasonCodes).toContain("exam_lesson_assistance");
    expect(resolveEvidenceAssistance({ ...observation, assistance: "revealed" }, captured)).toBe("revealed");
  });
  it("leaves answered-before-reading and legacy no-ledger evidence independent", () => {
    for (const facts of [exam, { ...exam, lessonAssistance: false, partialExample: false }]) {
      expect(resolveEvidenceAssistance(observation, { ...context, examAttempt: facts })).toBe("independent");
      expect(evaluateEvidenceEligibility(observation, { ...context, examAttempt: facts }).independentAttempt).toBe("yes");
    }
  });
  it("separates seen complete examples from help during this run", () => {
    const captured = { ...context, examAttempt: { ...exam, firstFamilyExposure: false, lessonAssistance: false } };
    expect(resolveEvidenceAssistance(observation, captured)).toBe("independent");
    expect(evaluateEvidenceEligibility(observation, captured)).toMatchObject({ independentAttempt: "no", reasonCodes: expect.arrayContaining(["exam_family_already_seen"]) });
  });
  it("keeps broken references unknown instead of inventing independence or help", () => {
    for (const facts of [{ ...exam, partialExample: null }, { ...exam, lessonAssistance: null }, { ...exam, firstFamilyExposure: null }]) {
      const captured = { ...context, examAttempt: facts };
      expect(resolveEvidenceAssistance(observation, captured)).toBe("unknown");
      expect(evaluateEvidenceEligibility(observation, captured).independentAttempt).toBe("unknown");
    }
  });
  it.each([undefined, "legacy_untracked_source", "unverifiable"] as const)("keeps confirmed partial-answer help despite %s source coverage or an independent revision", exposureCoverage => {
    const captured = { ...context, examAttempt: { ...exam, lessonAssistance: false, partialExample: true, exposureCoverage } };
    expect(resolveEvidenceAssistance(observation, captured)).toBe("hinted");
    expect(evaluateEvidenceEligibility(observation, captured)).toMatchObject({ independentAttempt: "no", usableForDelayedCheck: "no" });
    expect(evaluateEvidenceEligibility(observation, captured).reasonCodes).toContain("exam_partial_example_exposure");
    expect(resolveEvidenceAssistance({ ...observation, assistance: "revealed" }, captured)).toBe("revealed");
  });
  it("retains confirmed help even when a different reference cannot be verified", () => {
    const captured = { ...context, examAttempt: { ...exam, firstFamilyExposure: null, lessonAssistance: true, partialExample: null } };
    expect(resolveEvidenceAssistance(observation, captured)).toBe("hinted");
    expect(evaluateEvidenceEligibility(observation, captured).independentAttempt).toBe("no");
  });
  it.each(["legacy_untracked_source", "unverifiable"] as const)("retains %s coverage through an independent observation revision without inventing help", exposureCoverage => {
    const captured = { ...context, examAttempt: { ...exam, exposureCoverage, lessonAssistance: false } };
    expect(resolveEvidenceAssistance(observation, captured)).toBe("unknown");
    expect(evaluateEvidenceEligibility(observation, captured)).toMatchObject({ independentAttempt: "unknown", usableForDelayedCheck: "unknown" });
    expect(resolveEvidenceAssistance(observation, { ...captured, examAttempt: { ...captured.examAttempt, lessonAssistance: true } })).toBe("hinted");
    expect(evaluateEvidenceEligibility(observation, { ...captured, examAttempt: { ...captured.examAttempt, lessonAssistance: true } }).independentAttempt).toBe("no");
  });

});
