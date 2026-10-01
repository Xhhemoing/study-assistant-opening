import { describe, expect, it } from "vitest";
import type { LearningSummaryAggregate } from "@aistudy/contracts";
import { summarizeLearningAggregate } from "./learning-summary-aggregate";
const base: LearningSummaryAggregate = {
  identity: { courseId: "11111111-1111-4111-8111-111111111111", requirementKey: "fractions-1", skillLabel: "fractions" },
  sampleCount: 201, lastObservedAt: "2026-09-30T10:00:00.000Z", latestAttemptAt: 1790762400000, latestAttemptCount: 2,
  independentVerifiedCurrentCount: 200, latestIndependentVerifiedCurrentCount: 1, historicalIncorrectCount: 0, historicalSuccessCount: 199,
  unverifiedCount: 1, evidenceSources: ["reference_checked"], representatives: [],
  applicabilityCounts: { exact: 200, equivalent_confirmed: 0, changed_needs_check: 1, version_unknown: 0, unavailable: 0 },
  openChecks: { acceptedCount: 0, inProgressCount: 0, dueCount: 0 },
};
describe("complete learning summary conclusions", () => {
  it("does not let 199 old successes or the display sample hide an unresolved latest tie", () => {
    const result = summarizeLearningAggregate(base);
    expect(result.recentComparableEvidence).toMatchObject({ status: "needs_check", evidenceCount: 2, qualifiedCount: 1 });
    expect(result.historicalSuccess.count).toBe(199);
    expect(result.nextAction).toBe("check_evidence");
  });
  it("uses all latest original attempts for a comparable requirement", () => {
    expect(summarizeLearningAggregate({ ...base, latestIndependentVerifiedCurrentCount: 2 }).recentComparableEvidence.status).toBe("observed_independent");
  });
  it.each([null, ""])("is conservative over the whole group without a comparable requirement (%s)", requirementKey => {
    const group = { ...base, identity: { ...base.identity, requirementKey }, latestIndependentVerifiedCurrentCount: 2 };
    expect(summarizeLearningAggregate(group).recentComparableEvidence).toMatchObject({ status: "needs_check", evidenceCount: 201, comparable: false });
    expect(summarizeLearningAggregate({ ...group, independentVerifiedCurrentCount: 201 }).recentComparableEvidence.status).toBe("observed_independent");
  });
  it("keeps past success while current applicability requires a new check", () => {
    const result = summarizeLearningAggregate({ ...base, independentVerifiedCurrentCount: 0, latestIndependentVerifiedCurrentCount: 0,
      applicabilityCounts: { exact: 0, equivalent_confirmed: 0, changed_needs_check: 201, version_unknown: 0, unavailable: 0 } });
    expect(result.historicalSuccess.count).toBe(199);
    expect(result.applicability.changed_needs_check).toBe(201);
    expect(result.recentComparableEvidence.status).toBe("needs_check");
  });
  it("keeps pending checks separate from ability and uses server due counts", () => {
    const result = summarizeLearningAggregate({ ...base, sampleCount: 0, latestAttemptCount: 0, independentVerifiedCurrentCount: 0,
      latestIndependentVerifiedCurrentCount: 0, historicalSuccessCount: 0, openChecks: { acceptedCount: 1, inProgressCount: 0, dueCount: 1 } });
    expect(result.recentComparableEvidence.status).toBe("unobserved");
    expect(result.nextAction).toBe("complete_due_check");
  });
  it("does not derive any group conclusion from bounded representatives", () => {
    const representative = { observationId: "22222222-2222-4222-8222-222222222222", rootId: "33333333-3333-4333-8333-333333333333", attemptAt: 1,
      versionApplicability: "exact" as const, eligibility: { independentAttempt: "yes" as const, verifiedCorrect: "yes" as const,
        usableForCurrentVersion: "yes" as const, usableForDelayedCheck: "unknown" as const, reasonCodes: [], policyVersion: "opening-evidence-v1" } };
    expect(summarizeLearningAggregate({ ...base, representatives: Array.from({ length: 20 }, () => representative) })).toEqual(summarizeLearningAggregate(base));
  });
});
