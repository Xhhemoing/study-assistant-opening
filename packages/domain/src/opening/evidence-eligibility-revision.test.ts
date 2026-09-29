import { describe, expect, it } from "vitest";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import { context, exposure, observation } from "./evidence-eligibility-fixtures";

const revised = (answerRecordedAt: number | null, deliveredAt?: number) => ({
  ...context, helpHistory: { complete: true, answerRecordedAt, exposures: deliveredAt === undefined ? [] : [{ ...exposure, deliveredAt }] },
});

describe("revised answer help timing", () => {
  it.each(["hinted", "revealed"] as const)("includes %s delivered after original submission but before the revised answer", level => {
    const ctx = revised(500, 400);
    ctx.helpHistory.exposures[0]!.level = level;
    expect(evaluateEvidenceEligibility(observation, ctx)).toMatchObject({ independentAttempt: "no", usableForDelayedCheck: "no" });
  });

  it("does not retrospectively apply feedback delivered after the revised answer", () => {
    expect(evaluateEvidenceEligibility(observation, revised(500, 501)).independentAttempt).toBe("yes");
  });

  it.each([null, Number.NaN, 250])("leaves independence unknown for missing or inconsistent answer time %s", answerRecordedAt => {
    const result = evaluateEvidenceEligibility(observation, revised(answerRecordedAt));
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("attempt_timing_unknown");
  });

  it("keeps a delivery tied with the revision timestamp unresolved", () => {
    const result = evaluateEvidenceEligibility(observation, revised(500, 500));
    expect(result.independentAttempt).toBe("unknown");
    expect(result.reasonCodes).toContain("help_order_unknown");
  });

  it("preserves original attempt times so a later correction cannot earn delayed credit", () => {
    const ctx = revised(500);
    ctx.delayedCheck = { ...context.delayedCheck!, earliestAt: 400 };
    const before = structuredClone({ observation, ctx });
    const result = evaluateEvidenceEligibility(observation, ctx);
    expect(result).toMatchObject({ independentAttempt: "yes", usableForDelayedCheck: "no" });
    expect(result.reasonCodes).toContain("delayed_check_too_early");
    expect({ observation, ctx }).toEqual(before);
  });

  it("does not use a correction timestamp to fill missing original attempt timing", () => {
    const result = evaluateEvidenceEligibility({ ...observation, submittedAt: null }, revised(500));
    expect(result).toMatchObject({ independentAttempt: "unknown", usableForDelayedCheck: "unknown" });
    expect(result.reasonCodes).toContain("attempt_timing_unknown");
  });
});
