import { expect, it } from "vitest";
import type { LearningEvidenceEligibility } from "@aistudy/contracts";
import { buildLoopMetricsReport, type LoopMetricsInput } from "./loop-metrics";

const eligibility = (overrides: Partial<LearningEvidenceEligibility> = {}): LearningEvidenceEligibility => ({
  independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
  reasonCodes: [], policyVersion: "opening-evidence-v1", ...overrides,
});
export const metricsInput = (): LoopMetricsInput => ({
  asOf: "2026-10-16T16:00:00.000Z", windowStart: "2026-10-03T07:00:00.000Z", windowDays: 14, timeZone: "America/Los_Angeles",
  jobs: [], budget: [], observations: [], learningComplete: true, privacyExcludedCount: 0,
  feedback: { from: "2026-10-03T07:00:00.000Z", until: "2026-10-16T16:00:00.000Z", historicalActions: "unknown",
    actions: { done: 0, skipped: 0, deferred: 0, resumed: 0 },
    reasons: { eligible: 0, supplied: 0, declined: 0, missing: 0, coverage: null,
      counts: { time_short: 0, too_hard: 0, too_easy: 0, not_relevant: 0, other: 0 } } },
  suggestions: { complete: true, generated: 0, accepted: 0, minutes: 0 },
});
const metric = (input: LoopMetricsInput, group: "runtime" | "learning" | "burden", id: string) =>
  buildLoopMetricsReport(input).groups[group].find(row => row.id === id)!;

it("keeps all three groups separate and represents missing collection and empty samples with null", () => {
  const report = buildLoopMetricsReport(metricsInput());
  expect(Object.keys(report.groups)).toEqual(["runtime", "learning", "burden"]);
  expect(metric(metricsInput(), "learning", "learning.checked_correct")).toMatchObject({ value: null, denominator: 0, dataStatus: "no_samples" });
  expect(metric(metricsInput(), "runtime", "requests.failure_ratio")).toMatchObject({ value: null, denominator: null, dataStatus: "not_collected" });
  expect(JSON.stringify(report)).not.toContain("overallScore");
});

it("counts qualified errors in independent check coverage, never as missing or correct", () => {
  const input = metricsInput();
  input.observations = [
    { identity: "R1", occurredAt: "2026-10-10T10:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ verifiedCorrect: "no" }) },
    { identity: "R1", occurredAt: "2026-10-10T11:00:00Z", verificationSource: "reference_checked", eligibility: eligibility() },
    { identity: "R2", occurredAt: "2026-10-10T12:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ independentAttempt: "unknown", reasonCodes: ["help_history_incomplete"] }) },
    { identity: "R2", occurredAt: "2026-10-10T13:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ usableForCurrentVersion: "unknown", reasonCodes: ["version_changed_needs_check"] }) },
  ];
  input.privacyExcludedCount = 2;
  expect(metric(input, "learning", "learning.independent_check_coverage")).toMatchObject({ value: 0.5, numerator: 2, denominator: 4,
    excludedReasonCounts: { privacy_excluded: 2, help_history_incomplete: 1, version_changed_needs_check: 1 } });
  expect(metric(input, "learning", "learning.checked_correct")).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
  expect(metric(input, "learning", "learning.qualification_unknown").value).toBe(0.5);
});

it("keeps waiting cohorts scoped and reports right-censored errors without inventing a zero interval", () => {
  const input = metricsInput();
  input.observations = [
    { identity: "course:R1", occurredAt: "2026-10-10T10:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ verifiedCorrect: "no" }) },
    { identity: "course:R2", occurredAt: "2026-10-10T10:30:00Z", verificationSource: "reference_checked", eligibility: eligibility() },
    { identity: "course:R1", occurredAt: "2026-10-10T11:00:00Z", verificationSource: "reference_checked", eligibility: eligibility() },
    { identity: "other:R1", occurredAt: "2026-10-10T12:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ verifiedCorrect: "no" }) },
  ];
  expect(metric(input, "learning", "learning.next_check_wait")).toMatchObject({ value: 60, numerator: null, denominator: 1,
    sampleSize: 2, excludedReasonCounts: { right_censored: 1 } });
  input.observations = input.observations.slice(-1);
  expect(metric(input, "learning", "learning.next_check_wait")).toMatchObject({ value: null, denominator: 0, sampleSize: 1,
    dataStatus: "no_samples", excludedReasonCounts: { right_censored: 1 } });
});

it("does not publish truncated reads as a complete rate or median", () => {
  const input = metricsInput(); input.learningComplete = false; input.suggestions.complete = false;
  expect(metric(input, "learning", "learning.independent_check_coverage")).toMatchObject({ value: null, denominator: null, dataStatus: "unknown" });
  expect(metric(input, "learning", "learning.next_check_wait")).toMatchObject({ value: null, dataStatus: "unknown" });
  expect(metric(input, "burden", "suggestions.generated_acceptance")).toMatchObject({ value: null, denominator: null, dataStatus: "unknown" });
});

it("separates deterministic scoring from learner reference checks and does not list positive facts as exclusions", () => {
  const input = metricsInput();
  input.observations = [
    { identity: "R1", occurredAt: "2026-10-10T10:00:00Z", verificationSource: "reference_checked", eligibility: eligibility() },
    { identity: "R1", occurredAt: "2026-10-10T11:00:00Z", verificationSource: "deterministic", eligibility: eligibility({ verifiedCorrect: "no" }) },
    { identity: "R2", occurredAt: "2026-10-10T12:00:00Z", verificationSource: "reference_checked", eligibility: eligibility({ independentAttempt: "no",
      reasonCodes: ["declared_help", "reference_checked_correct", "version_exact", "delayed_protocol_incomplete"] }) },
  ];
  expect(metric(input, "learning", "learning.checked_correct")).toMatchObject({ value: 1, denominator: 1 });
  expect(metric(input, "learning", "learning.deterministic_correct")).toMatchObject({ value: 0, denominator: 1 });
  const reasons = metric(input, "learning", "learning.independent_check_coverage").excludedReasonCounts;
  expect(reasons.declared_help).toBe(1);
  expect(reasons).not.toHaveProperty("reference_checked_correct");
  expect(reasons).not.toHaveProperty("version_exact");
  expect(reasons).not.toHaveProperty("delayed_protocol_incomplete");
});

it("retains failed, unknown, cancelled and pending job states in the same creation-cohort denominator", () => {
  const input = metricsInput();
  input.jobs = ["succeeded", "failed", "outcome_unknown", "cancelled", "queued", "running"].map(state => ({ kind: "tutor", state, count: 1 }));
  expect(metric(input, "runtime", "jobs.tutor.succeeded_ratio")).toMatchObject({ value: 1 / 6, numerator: 1, denominator: 6 });
  expect(metric(input, "runtime", "jobs.tutor.outcome_unknown")).toMatchObject({ value: 1, sampleSize: 6 });
  expect(metric(input, "runtime", "jobs.tutor.failed").value).toBe(1);
});

it("keeps settled, provisional TTL, unresolved and ordinary reserved cents separate", () => {
  const input = metricsInput();
  input.budget = [{ category: "settled", count: 2, cents: 12 }, { category: "ttl_provisional", count: 1, cents: 20 },
    { category: "unknown_reserved", count: 1, cents: 30 }, { category: "active_reserved", count: 1, cents: 40 }];
  for (const [id, cents] of [["settled", 12], ["ttl_provisional", 20], ["unknown_reserved", 30], ["active_reserved", 40]] as const) {
    expect(metric(input, "runtime", `budget.${id}`)).toMatchObject({ value: cents, unit: "cents", denominator: 5 });
  }
});

it("separates recorded task actions, optional reasons and generated suggestions from display adoption", () => {
  const input = metricsInput();
  input.feedback.actions = { done: 1, skipped: 2, deferred: 2, resumed: 3 };
  input.feedback.reasons = { eligible: 4, supplied: 2, declined: 1, missing: 1, coverage: 0.5,
    counts: { time_short: 1, too_hard: 1, too_easy: 0, not_relevant: 0, other: 0 } };
  input.suggestions = { complete: true, generated: 4, accepted: 1, minutes: 75 };
  input.suggestionFeedback = [{ reason: "too_hard", count: 1 }, { reason: "prefer_not_say", count: 1 }];
  expect(metric(input, "burden", "feedback.resumed")).toMatchObject({ value: 3, denominator: 8 });
  expect(metric(input, "burden", "feedback.reason_coverage")).toMatchObject({ value: 0.5, numerator: 2, denominator: 4,
    excludedReasonCounts: { reason_missing: 1, prefer_not_say: 1 } });
  expect(metric(input, "burden", "suggestions.generated_acceptance")).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
  expect(metric(input, "burden", "suggestions.display_acceptance")).toMatchObject({ value: null, dataStatus: "not_collected" });
  expect(metric(input, "burden", "suggestions.generated_minutes")).toMatchObject({ value: 75, unit: "minutes" });
  expect(metric(input, "burden", "suggestions.not_suitable")).toMatchObject({ value: 2, denominator: 2 });
  expect(metric(input, "burden", "suggestions.reason.too_hard")).toMatchObject({ value: 1, denominator: 2 });
});

it("uses recorded coach/replan creation cohorts without mistaking missing confirmations for zero success", () => {
  const input = metricsInput(); input.coach = { accepted: 4, undone: 1 }; input.replans = { created: 5, accepted: 2, rejected: 1 };
  expect(metric(input, "burden", "coach.undo")).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
  expect(metric(input, "burden", "replan.acceptance")).toMatchObject({ value: 0.4, numerator: 2, denominator: 5 });
  expect(metric(input, "burden", "replan.rejected")).toMatchObject({ value: 1, denominator: 5 });
  input.coach = { accepted: 0, undone: 0 };
  expect(metric(input, "burden", "coach.undo")).toMatchObject({ value: null, dataStatus: "no_samples" });
  input.evaluations = { recorded: 4, abstained: 1 };
  expect(metric(input, "runtime", "evaluation.abstention")).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
});

it("reports automatic grading independently of help, and real browser timing/click samples", () => {
  const input = metricsInput();
  input.observations = [
    { identity: "a", occurredAt: input.asOf, verificationSource: "ai_graded", eligibility: eligibility({ independentAttempt: "no", verifiedCorrect: "no" }) },
    { identity: "b", occurredAt: input.asOf, verificationSource: "self_report", eligibility: eligibility() },
  ];
  input.experience = { firstTextMedianMs: 1543, firstTextSamples: 2, shown: 4, started: 1 };
  expect(metric(input, "learning", "learning.automatic_grading_coverage")).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
  expect(metric(input, "runtime", "experience.first_text")).toMatchObject({ value: 1543, sampleSize: 2, unit: "milliseconds" });
  expect(metric(input, "burden", "experience.next_step_started")).toMatchObject({ value: 0.25, numerator: 1, denominator: 4 });
  expect(metric(metricsInput(), "runtime", "experience.first_text")).toMatchObject({ value: null, dataStatus: "not_collected" });
});
