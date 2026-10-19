import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { observation, context } from "./evidence-eligibility-fixtures";

describe("evaluateEvidenceEligibility delayed", () => {
  it.each(["protocolId", "earliestAt", "attemptId"] as const)(
    "does not qualify a delayed check without %s",
    (field) => {
      expect(evaluateEvidenceEligibility(observation, {
        ...context, delayedCheck: { ...context.delayedCheck!, [field]: null },
      }).usableForDelayedCheck).toBe("unknown");
    },
  );

  it("does not infer a delayed protocol or an answer-exposure policy", () => {
    expect(evaluateEvidenceEligibility(observation, { ...context, delayedCheck: null }).usableForDelayedCheck).toBe("unknown");
    expect(evaluateEvidenceEligibility(observation, {
      ...context, delayedCheck: { ...context.delayedCheck!, priorAnswerPolicy: "unknown" },
    }).usableForDelayedCheck).toBe("unknown");
  });

  it("measures the delay at attempt start rather than permitting early work followed by a late submission", () => {
    const result = evaluateEvidenceEligibility({ ...observation, startedAt: 199 }, context);
    expect(result.usableForDelayedCheck).toBe("no");
    expect(result.reasonCodes).toContain("delayed_check_too_early");
  });

  it.each(["startedAt", "submittedAt"] as const)("keeps missing %s timing unknown", (field) => {
    expect(evaluateEvidenceEligibility({ ...observation, [field]: null }, context).usableForDelayedCheck).toBe("unknown");
  });

  it("does not borrow another attempt's delayed protocol", () => {
    expect(evaluateEvidenceEligibility(observation, {
      ...context, delayedCheck: { ...context.delayedCheck!, attemptId: "attempt-1" },
    }).usableForDelayedCheck).toBe("unknown");
  });
});

it("distinguishes an elapsed diagnostic check from retention of established prior performance", () => {
  const result = evaluateEvidenceEligibility(observation, { ...context, delayedCheck: { ...context.delayedCheck!, baselineEstablished: false } });
  expect(result.usableForDelayedCheck).toBe("unknown");
  expect(result.reasonCodes).toContain("delayed_baseline_not_established");
  expect(evaluateEvidenceEligibility(observation, { ...context, delayedCheck: { ...context.delayedCheck!, baselineEstablished: true,
    intervalExposure: { from: 0, to: 200, recordedCount: 1, recordedPracticeCount: 1, complete: false } } }).usableForDelayedCheck).toBe("yes");
});
