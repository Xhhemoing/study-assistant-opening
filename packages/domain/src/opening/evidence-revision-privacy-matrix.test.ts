import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "./evidence-eligibility";
import type { EvidenceHelpExposure } from "./evidence-eligibility-types";
import { revisionEvidence } from "./revision-privacy.fixtures";

const levels = ["hinted", "revealed"] as const;
const timings = [100, 250, 400] as const;
describe("saved teaching question across publication/revised answer boundaries (pure)", () => {
  it.each(levels.flatMap(level => timings.map(deliveredAt => ({ level, deliveredAt }))))(
    "inherits $level at $deliveredAt from the exact prior saved question", ({ level, deliveredAt }) => {
      const { observation, context } = revisionEvidence({ level, deliveredAt });
      const before = structuredClone({ observation, context });
      const result = evaluateEvidenceEligibility(observation, context);
      expect(result).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes", usableForDelayedCheck: "no" });
      expect(result.reasonCodes).toContain("help_before_submission");
      expect(resolveEvidenceAssistance(observation, context)).toBe(level);
      expect({ observation, context }).toEqual(before);
    });

  it.each(levels.flatMap(level => [501, 800].map(deliveredAt => ({ level, deliveredAt }))))(
    "does not rewrite captured answers using later $level at $deliveredAt", ({ level, deliveredAt }) => {
      const { observation, context } = revisionEvidence({ level, deliveredAt });
      expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", usableForDelayedCheck: "yes" });
      expect(resolveEvidenceAssistance(observation, context)).toBe("independent");
    });

  it.each(levels)("ties at actual answer capture stay unknown for %s", level => {
    const { observation, context } = revisionEvidence({ level, deliveredAt: 500 });
    const result = evaluateEvidenceEligibility(observation, context);
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("help_order_unknown");
  });

  it.each([
    { serverOrder: "before_answer", deliveredAt: 900, expected: "no" },
    { serverOrder: "before_answer", deliveredAt: null, expected: "no" },
    { serverOrder: "after_answer", deliveredAt: 100, expected: "yes" },
    { serverOrder: "after_answer", deliveredAt: 500, expected: "yes" },
  ] as const)("serialized $serverOrder outranks clock $deliveredAt", ({ serverOrder, deliveredAt, expected }) => {
    const { observation, context } = revisionEvidence({ serverOrder, deliveredAt });
    expect(evaluateEvidenceEligibility(observation, context).independentAttempt).toBe(expected);
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, 299])("never fills an invalid answer capture time %s using metadata", answerRecordedAt => {
    const { observation, context } = revisionEvidence({ delivered: false }, answerRecordedAt);
    const result = evaluateEvidenceEligibility(observation, context);
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("attempt_timing_unknown");
  });

  it.each([
    { attemptId: null }, { problemId: null }, { attemptId: null, problemId: null },
  ])("legacy exact-question association stays unknown: %j", missing => {
    const { observation, context } = revisionEvidence({ ...missing, deliveredAt: 250 });
    const result = evaluateEvidenceEligibility(observation, context);
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("help_association_unknown");
  });

  it.each(["hint", "solution", "evaluation_feedback"] as const)("known non-delivery of %s does not fabricate help", kind => {
    const { observation, context } = revisionEvidence({ kind, delivered: false });
    expect(evaluateEvidenceEligibility(observation, context).independentAttempt).toBe("yes");
  });

  it.each([true, null] as const)("concept instruction (delivered=%s) is not item assistance", delivered => {
    const { observation, context } = revisionEvidence({ kind: "instruction", delivered });
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", usableForDelayedCheck: "yes" });
  });

  it.each(levels)("unknown %s delivery fails closed without claiming delivery", level => {
    const { observation, context } = revisionEvidence({ level, delivered: null });
    const result = evaluateEvidenceEligibility(observation, context);
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("help_delivery_unknown");
    expect(result.reasonCodes).not.toContain("help_before_submission");
  });

  it.each([false, undefined])("different prior question (sameQuestion=%s) does not taint current publication", sameQuestion => {
    const { observation, context } = revisionEvidence({ sameQuestion, problemId: "genuinely-new-question" });
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", usableForDelayedCheck: "yes" });
  });

  it.each(levels)("exact-question feedback %s is non-independent but not a fabricated answer reveal", level => {
    const { observation, context } = revisionEvidence({ kind: "evaluation_feedback", level, problemId: "prior-publication-problem" });
    const result = evaluateEvidenceEligibility(observation, context);
    expect(result).toMatchObject({ independentAttempt: "no", usableForDelayedCheck: "no" });
    expect(result.reasonCodes).toContain("prior_evaluation_feedback");
    expect(result.reasonCodes).not.toContain("prior_answer_exposure");
  });

  it.each(["privacy_excluded", "unavailable"] as const)("current %s blocks delayed credit without erasing original correctness", applicability => {
    const { observation, context } = revisionEvidence({ delivered: false });
    context.version = { applicability };
    const before = structuredClone({ observation, context });
    expect(evaluateEvidenceEligibility(observation, context)).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "no", usableForDelayedCheck: "no" });
    expect({ observation, context }).toEqual(before);
  });

  it.each(levels)("repeated pure qualification never upgrades or accumulates %s receipts", level => {
    const { observation, context } = revisionEvidence({ level });
    const first = evaluateEvidenceEligibility(observation, context);
    for (let i = 0; i < 3; i++) expect(evaluateEvidenceEligibility(observation, context)).toEqual(first);
    expect(context.helpHistory!.exposures).toHaveLength(1);
    expect(observation.assistance).toBe("independent");
  });

  it.each([false, true])("a metadata reread keeps actual answer time fixed (reverse receipts=%s)", reverse => {
    const { observation, context } = revisionEvidence({ deliveredAt: 400 }, 300);
    const receipts: EvidenceHelpExposure[] = [context.helpHistory!.exposures[0]!, { ...context.helpHistory!.exposures[0]!, deliveredAt: 600, level: "revealed" }];
    context.helpHistory!.exposures = reverse ? receipts.reverse() : receipts;
    expect(evaluateEvidenceEligibility(observation, context).independentAttempt).toBe("yes");
    context.helpHistory!.answerRecordedAt = 500;
    expect(evaluateEvidenceEligibility(observation, context).independentAttempt).toBe("no");
    expect(observation.submittedAt).toBe(300);
  });
});
