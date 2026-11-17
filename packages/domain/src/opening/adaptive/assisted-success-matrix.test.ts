import { describe, expect, it } from "vitest";
import { captureNextLearningStep, nextLearningStep } from "./next-learning-step";
import { buildDecisionInput } from "./decision-input";
import { toSnapshotEvidence } from "./snapshot-evidence";
import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "../evidence-eligibility";
import { exposure, observation, withHelp } from "../evidence-eligibility-fixtures";
import { courseEvidence, learningObservation, qualifiedInput } from "../learning-summary-fixtures";

const helped = (assistance: "hinted" | "revealed", extra: Partial<SnapshotObservation> = {}): SnapshotObservation => ({
  id: "latest-helped", skillLabel: "fractions", attemptedAt: "2026-10-16T07:00:00Z", problemId: "problem",
  assistance, verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes", ...extra,
});
const request = (rows: SnapshotObservation[], extra: Partial<NextLearningStepInput> = {}): NextLearningStepInput => ({
  status: "observed_independent", observations: rows, wantsFullExplanation: false, ...extra,
});
const cases = (["hinted", "revealed"] as const).flatMap(assistance => [0, 1, 2].flatMap(prior =>
  (["unobserved", "needs_check", "observed_independent"] as const).map(status => ({ assistance, prior, status }))));

describe("D5 assisted success systematic matrix", () => {
  it.each(cases)("fades $assistance with $prior older independent successes and $status", ({ assistance, prior, status }) => {
    const rows = [helped(assistance), ...Array.from({ length: prior }, (_, i) => helped(assistance, {
      id: `prior-${i}`, assistance: "independent", independentAttempt: "yes", attemptedAt: "2026-10-15T07:00:00Z",
    }))];
    const input = request(rows, { status });
    const before = structuredClone(input);
    const captured = captureNextLearningStep(input);
    expect(captured.decision).toEqual({ activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null });
    expect(nextLearningStep(input)).toEqual(captured.decision);
    expect(captured.candidates.at(-1)).toEqual({ action: "reduced_help_practice", eligible: true,
      reasonCodes: ["assisted_success"], evidenceRefs: ["observation:latest-helped"] });
    expect(captured.candidates.some(c => c.action === "transfer_check")).toBe(false);
    expect(input).toEqual(before);
  });

  const controls = [
    { label: "due retest", controls: { dueRetest: true }, reason: "due_retest" },
    { label: "new learning even when due", controls: { learningPhase: "new_learning", dueRetest: true }, reason: "requested_full" },
    { label: "explicit full", controls: { wantsFullExplanation: true }, reason: "requested_full" },
    { label: "consolidate", controls: { learningPhase: "consolidate" }, reason: "requested_consolidate" },
  ] satisfies Array<{ label: string; controls: Partial<NextLearningStepInput>; reason: string }>;
  it.each((["hinted", "revealed"] as const).flatMap(assistance => controls.map(c => ({ assistance, ...c }))))(
    "preserves $label before $assistance D5", ({ assistance, controls: extra, reason }) => {
      expect(nextLearningStep(request([helped(assistance)], extra)).reasonCode).toBe(reason);
    });

  it.each((["hinted", "revealed"] as const).flatMap(assistance => (["no", "unknown", undefined] as const)
    .map(usableForCurrentVersion => ({ assistance, usableForCurrentVersion }))))(
    "excludes $assistance when version qualification is $usableForCurrentVersion", ({ assistance, usableForCurrentVersion }) => {
      expect(nextLearningStep(request([helped(assistance, { usableForCurrentVersion })]))).toEqual({
        activityKind: "diagnose", reasonCode: "no_evidence", focusObservationId: null,
      });
    });
  it.each((["hinted", "revealed"] as const).flatMap(assistance => (["no", "unknown"] as const)
    .map(verifiedCorrect => ({ assistance, verifiedCorrect }))))(
    "does not treat $assistance/$verifiedCorrect as success", ({ assistance, verifiedCorrect }) => {
      expect(nextLearningStep(request([helped(assistance, { verifiedCorrect })])).reasonCode)
        .toBe(verifiedCorrect === "no" ? "verified_incorrect" : "unverified_only");
    });

  it.each(["hinted", "revealed"] as const)("does not treat an unknown latest %s verdict as success merely because older work is verified", assistance => {
    const latest = helped(assistance, { verifiedCorrect: "unknown" });
    const older = helped(assistance, { id: "older-independent", assistance: "independent", independentAttempt: "yes" });
    expect(nextLearningStep(request([latest, older]))).toEqual({
      activityKind: "transfer_check", reasonCode: "independent", focusObservationId: null,
    });
  });

  it.each(["hinted", "revealed"] as const)("does not revive older %s success ahead of an unknown latest answer", assistance => {
    const latest = helped(assistance, { id: "new-unknown", assistance: "independent", verifiedCorrect: "unknown" });
    expect(nextLearningStep(request([latest, helped(assistance)])).reasonCode).toBe("independent");
  });

  it.each(["hinted", "revealed"] as const)("keeps two trusted remediation cycles ahead of %s success, but not duplicate cycles", assistance => {
    const completedCycles = ["failure-a", "failure-b"].map(failureRootId => ({ failureRootId,
      evidenceRefs: [`observation:${failureRootId}`, `help_exposure:${failureRootId}`, `observation:followup-${failureRootId}`],
      repeatedVerifiedError: false, persistentDeliveredAssistance: true }));
    const rows = [helped(assistance)];
    expect(nextLearningStep(request(rows, { remediationCycles: { completedCycles } }))).toEqual({
      activityKind: "diagnose", reasonCode: "remediation_limit", focusObservationId: "latest-helped",
    });
    for (const cycles of [[completedCycles[0]!], [completedCycles[0]!, completedCycles[0]!],
      completedCycles.map(c => ({ ...c, evidenceRefs: [] }))]) {
      expect(nextLearningStep(request(rows, { remediationCycles: { completedCycles: cycles } })).reasonCode).toBe("assisted_success");
    }
  });

  it.each(["hinted", "revealed"] as const)("resolves delivered %s through the real projection without awarding independent mastery", level => {
    // The learner declaration deliberately still claims independence.
    const evidence = courseEvidence({ ...qualifiedInput, context: withHelp([{ ...exposure, level }]) });
    const projected = toSnapshotEvidence(evidence, new Date(learningObservation.occurredAt));
    expect(projected.observations[0]).toMatchObject({ assistance: level, verifiedCorrect: "yes", independentAttempt: "no" });
    expect(projected.summaries[0]?.status).toBe("needs_check");
    expect(nextLearningStep(buildDecisionInput({ observations: projected.observations, wantsFullExplanation: false })))
      .toEqual({ activityKind: "reduced_help_practice", reasonCode: "assisted_success", focusObservationId: null });
    expect(evidence.observations[0]?.evidenceVerdict).toBe("MASTERY_NOT_ESTABLISHED");
    expect(evidence.observations[0]?.assistance).toBe("independent");
  });
});

describe("delivery facts and uncertainty do not grant independence", () => {
  const facts = [
    { label: "pre-answer", patch: {}, independent: "no", resolved: true },
    { label: "duplicate pre-answer", patch: {}, independent: "no", resolved: true, duplicate: true },
    { label: "not delivered", patch: { delivered: false, deliveredAt: null }, independent: "yes", resolved: false },
    { label: "unknown delivery", patch: { delivered: null }, independent: "unknown", resolved: false },
    { label: "null time", patch: { deliveredAt: null }, independent: "unknown", resolved: false },
    { label: "at answer", patch: { deliveredAt: 300 }, independent: "unknown", resolved: false },
    { label: "after answer", patch: { deliveredAt: 301 }, independent: "yes", resolved: false },
    { label: "unknown attempt", patch: { attemptId: null }, independent: "unknown", resolved: false },
    { label: "unknown problem", patch: { problemId: null }, independent: "unknown", resolved: false },
    { label: "foreign problem and attempt", patch: { attemptId: "foreign-attempt", problemId: "foreign-problem" }, independent: "yes", resolved: false },
    { label: "conflicting problem", patch: { problemId: "foreign-problem" }, independent: "unknown", resolved: false },
    { label: "instruction not item help", patch: { kind: "instruction" as const }, independent: "yes", resolved: false },
  ];
  it.each((["hinted", "revealed"] as const).flatMap(level => facts.map(f => ({ level, ...f }))))(
    "$level: $label", ({ level, patch, independent, resolved, duplicate }) => {
      const fact = { ...exposure, ...patch, level };
      const ctx = withHelp(duplicate ? [fact, { ...fact }] : [fact]);
      const before = structuredClone(ctx);
      const result = evaluateEvidenceEligibility(observation, ctx);
      expect(result.independentAttempt).toBe(independent);
      expect(result.verifiedCorrect).toBe("yes");
      if (independent !== "yes") expect(result.usableForDelayedCheck).not.toBe("yes");
      expect(resolveEvidenceAssistance(observation, ctx)).toBe(resolved ? level : "independent");
      expect(ctx).toEqual(before);
    });
});
