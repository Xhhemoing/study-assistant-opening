import { describe, expect, it } from "vitest";
import { evaluateAssistance } from "./evidence-eligibility-timing";
import type { EvidenceEligibilityReasonCode, EvidenceHelpExposure, EvidenceObservation } from "./evidence-eligibility-types";

const observation: EvidenceObservation = { attemptId: "current", problemId: "question", itemVersionId: "publication-2",
  startedAt: 200, submittedAt: 300, assistance: "independent", assessmentDomain: "math" };
const help: EvidenceHelpExposure = { attemptId: "prior", problemId: "question", delivered: true, deliveredAt: 100, level: "revealed" };
function qualify(exposures: EvidenceHelpExposure[], change: Partial<EvidenceObservation> = {}) {
  const observed = { ...observation, ...change }, history = { complete: true, answerRecordedAt: 500, exposures };
  const before = structuredClone({ observed, history });
  const reasons = new Set<EvidenceEligibilityReasonCode>();
  const result = evaluateAssistance(observed, history, reasons);
  expect({ observed, history }).toEqual(before);
  return { ...result, reasons: [...reasons].sort() };
}

describe("batch2 help-history branches without unrelated verification/version vetoes", () => {
  it("generic past revealed answer is familiarity, not current-attempt assistance; exact same saved question differs", () => {
    expect(qualify([help])).toEqual({ independent: "yes", priorAnswer: "yes", assistance: "independent", reasons: ["prior_answer_exposure"] });
    expect(qualify([{ ...help, sameQuestion: true }])).toEqual({ independent: "no", priorAnswer: "yes", assistance: "revealed", reasons: ["help_before_submission", "prior_answer_exposure"] });
  });
  it("generic past hint alone does not become answer exposure", () => {
    expect(qualify([{ ...help, level: "hinted" }])).toEqual({ independent: "yes", priorAnswer: "no", assistance: "independent", reasons: [] });
  });
  it("same-attempt wrong problem stays unknown instead of laundering a malformed binding", () => {
    expect(qualify([{ ...help, attemptId: "current", problemId: "other", deliveredAt: 250 }])).toEqual({ independent: "unknown", priorAnswer: "unknown", assistance: "independent", reasons: ["help_association_unknown"] });
    expect(qualify([{ ...help, attemptId: "other-attempt", problemId: "other", deliveredAt: 250 }])).toEqual({ independent: "yes", priorAnswer: "no", assistance: "independent", reasons: [] });
  });
  it("same-attempt receipt before start is order-unknown unless serialized server order proves capture relation", () => {
    const receipt = { ...help, attemptId: "current" };
    expect(qualify([receipt])).toEqual({ independent: "unknown", priorAnswer: "unknown", assistance: "independent", reasons: ["help_order_unknown"] });
    expect(qualify([{ ...receipt, serverOrder: "before_answer" }])).toEqual({ independent: "no", priorAnswer: "no", assistance: "revealed", reasons: ["help_before_submission"] });
  });
  it.each(["math", "unknown", undefined] as const)("language support cannot taint non-language domain %s", assessmentDomain => {
    expect(qualify([{ ...help, supportDomain: "language", sameQuestion: true }], { assessmentDomain })).toEqual({ independent: "yes", priorAnswer: "no", assistance: "independent", reasons: [] });
  });
  it("same receipt really affects language assessment, not universally filtered", () => {
    expect(qualify([{ ...help, supportDomain: "language", sameQuestion: true }], { assessmentDomain: "language" })).toMatchObject({ independent: "no", priorAnswer: "yes", assistance: "revealed" });
  });
  it.each([false, true])("unknown receipt cannot erase established prior answer evidence (reverse=%s)", reverse => {
    const receipts: EvidenceHelpExposure[] = [{ ...help, sameQuestion: true }, { ...help, delivered: null, deliveredAt: 250 }];
    const result = qualify(reverse ? receipts.reverse() : receipts);
    expect(result).toEqual({ independent: "no", priorAnswer: "yes", assistance: "revealed", reasons: ["help_before_submission", "help_delivery_unknown", "prior_answer_exposure"] });
  });
  it.each([false, true])("later weaker hint cannot demote revealed same-question help (reverse=%s)", reverse => {
    const receipts: EvidenceHelpExposure[] = [{ ...help, sameQuestion: true }, { ...help, sameQuestion: true, level: "hinted", deliveredAt: 400 }];
    expect(qualify(reverse ? receipts.reverse() : receipts)).toEqual({ independent: "no", priorAnswer: "yes", assistance: "revealed", reasons: ["help_before_submission", "prior_answer_exposure"] });
  });
  it.each([false, true])("evaluation feedback cannot erase a declared reveal (reverse=%s)", reverse => {
    const receipts: EvidenceHelpExposure[] = [{ ...help, kind: "evaluation_feedback", sameQuestion: true, problemId: "old-publication" }, { ...help, sameQuestion: true, level: "hinted" }];
    expect(qualify(reverse ? receipts.reverse() : receipts, { assistance: "revealed" })).toEqual({ independent: "no", priorAnswer: "no", assistance: "revealed", reasons: ["declared_help", "help_before_submission", "prior_evaluation_feedback"] });
  });
  it.each([false, true])("post-capture unknown delivery does not retroactively create uncertainty (server order=%s)", server => {
    const receipt: EvidenceHelpExposure = { ...help, delivered: null, deliveredAt: server ? 100 : 501, ...(server ? { serverOrder: "after_answer" } : {}) };
    expect(qualify([receipt])).toEqual({ independent: "yes", priorAnswer: "no", assistance: "independent", reasons: [] });
    expect(qualify([{ ...receipt, deliveredAt: 250, serverOrder: undefined }])).toMatchObject({ independent: "unknown", priorAnswer: "unknown", reasons: ["help_delivery_unknown"] });
  });
});
