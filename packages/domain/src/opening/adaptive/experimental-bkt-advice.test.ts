import { describe, expect, it } from "vitest";
import type { LearnerStateFeature } from "../learner-state";
import { predictLearnerShadow } from "../learner-shadow-predictions";
import { captureNextLearningStep, nextLearningStep } from "./next-learning-step";
import { EXPERIMENTAL_BKT_ADVICE_POLICY, nextLearningStepWithExperimentalBkt, type ExperimentalBktAdviceInput } from "./experimental-bkt-advice";
import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";

const cutoff = "2026-11-10T00:00:00Z";
function fixture(outcomes: boolean[] = [true, true, true, true, true, true]) {
  const features: LearnerStateFeature[] = outcomes.map((correct, index) => ({
    observationId: `observation-${index}`, attemptId: `attempt-${index}`, courseId: "course", requirementKey: "skill",
    itemVersionId: `version-${index}`, skillLabel: "矩阵", attemptedAt: `2026-11-0${index + 1}T00:00:00Z`,
    recordedAt: `2026-11-0${index + 1}T00:01:00Z`, sourceIds: ["source"], sourceVersions: { source: 1 },
    eligibility: { independentAttempt: "yes", verifiedCorrect: correct ? "yes" : "no", usableForCurrentVersion: "yes",
      usableForDelayedCheck: "unknown", reasonCodes: [correct ? "deterministic_correct" : "deterministic_incorrect"], policyVersion: "opening-evidence-v4" },
    availability: "available", views: ["independent"], transfer: { usable: "unknown", knowledgeComponents: [], reasonCodes: [] },
    retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null },
    gaps: [], outcome: correct ? "correct" : "incorrect", ordinal: index,
  }));
  const observations: SnapshotObservation[] = features.map<SnapshotObservation>((row, index) => ({
    id: row.observationId, skillLabel: row.skillLabel, requirementKey: row.requirementKey, itemVersionId: row.itemVersionId,
    attemptedAt: row.attemptedAt, assistance: "independent", independentAttempt: "yes", usableForCurrentVersion: "yes",
    verifiedCorrect: row.eligibility.verifiedCorrect, problemId: `problem-${index}`,
  })).reverse();
  const input: NextLearningStepInput = { status: "needs_check", observations, wantsFullExplanation: false };
  const experiment: ExperimentalBktAdviceInput = { enabled: true, features, cutoff,
    target: { courseId: "course", requirementKey: "skill", problemId: "new-problem", itemVersionId: "new-version" }, excludedProblemIds: [] };
  return { input, experiment };
}

function expectRuleUnchanged(input: NextLearningStepInput, experiment?: ExperimentalBktAdviceInput) {
  const before = structuredClone({ input, experiment });
  const receipt = captureNextLearningStep(input);
  const result = nextLearningStepWithExperimentalBkt(input, experiment);
  expect(result.ruleDecision).toEqual(nextLearningStep(input));
  expect(captureNextLearningStep(input)).toEqual(receipt);
  expect({ input, experiment }).toEqual(before);
  expect(result.calibrated).toBe(false);
  expect(Object.keys(result.ruleDecision).sort()).toEqual(["activityKind", "focusObservationId", "reasonCode"]);
  return result;
}

describe("explicit experimental BKT advice consumption", () => {
  it("keeps the default and disabled paths byte-for-byte rule-only", () => {
    const { input, experiment } = fixture();
    for (const option of [undefined, { ...experiment, enabled: false }]) {
      expect(expectRuleUnchanged(input, option)).toMatchObject({ experimentalAdvice: null,
        comparison: { status: "fallback", reason: "disabled", sampleCount: 0, differsFromRule: false } });
    }
  });

  it("consumes existing BKT output only on opt-in, with predeclared non-calibrated policy and versioned rule comparison", () => {
    const { input, experiment } = fixture([false, false, false, false, false, true]);
    const expected = predictLearnerShadow({ ...experiment, courseId: "course", requirementKey: "skill" });
    const result = expectRuleUnchanged(input, experiment);
    expect(result).toMatchObject({ ruleDecision: { activityKind: "diagnose", reasonCode: "needs_check" },
      experimentalAdvice: { kind: "supported_practice", activityKind: "reduced_help_practice", modelId: "classical-bkt", modelVersion: "1",
        success: expected.success, failure: expected.failure, evidenceObservationIds: expected.evidenceObservationIds, cutoff, target: experiment.target },
      comparison: { policyVersion: "experimental-bkt-advice-1", ruleVersion: "next-learning-step-6", status: "compared",
        reason: "additional_support", sampleCount: 6, differsFromRule: true } });
    expect(result.experimentalAdvice?.probability).toBe(expected.predictions[0]!.probability);
    expect(EXPERIMENTAL_BKT_ADVICE_POLICY).toMatchObject({ minimumDistinctProblems: 5, supportBelowProbability: 0.6 });
  });

  it.each(["needs_check", "needs_review", "unobserved", "observed_independent"] as const)("never promotes %s or skips instruction/exam checks at high probability", status => {
    const { input, experiment } = fixture();
    input.status = status;
    const result = expectRuleUnchanged(input, experiment);
    expect(result.experimentalAdvice).toMatchObject({ kind: "continue_rule", activityKind: result.ruleDecision.activityKind });
    expect(result.experimentalAdvice!.probability).toBeGreaterThan(0.8);
    expect(result.comparison).toMatchObject({ differsFromRule: false, reason: "retain_rule" });
    expect(input.status).toBe(status);
    expect(result).not.toHaveProperty("mastery");
  });

  it.each([0, 1, 4, 5])("uses predeclared distinct-problem minimum with %i observations", count => {
    const { input, experiment } = fixture(Array.from({ length: count }, () => true));
    // A rule-only head keeps the rule out of the higher-priority no-evidence branch.
    if (!count) input.observations = fixture().input.observations.slice(0, 1);
    const result = expectRuleUnchanged(input, experiment);
    expect(result.comparison.status).toBe(count >= 5 ? "compared" : "fallback");
    if (count < 5) expect(result).toMatchObject({ experimentalAdvice: null, comparison: {
      reason: count ? "insufficient_samples" : "no_qualified_samples", sampleCount: count } });
  });

  it.each(["courseId", "requirementKey", "problemId", "itemVersionId"] as const)("requires complete target identity (%s)", field => {
    for (const value of [undefined, null, "", " "]) {
      const { input, experiment } = fixture();
      experiment.target[field] = value;
      expect(expectRuleUnchanged(input, experiment).comparison.reason).toBe("incomplete_target");
    }
  });

  it.each(["invalid", "", "2026-11-10", "2026-11-10T00:00:00", "2026-02-30T00:00:00Z"])("falls back on invalid or ambiguous cutoff %s", invalid => {
    const { input, experiment } = fixture();
    expect(expectRuleUnchanged(input, { ...experiment, cutoff: invalid }).comparison.reason).toBe("invalid_cutoff");
  });

  it("excludes AI, help, stale/unknown versions, wrong scope, missing identity and future/late/invalid data", () => {
    const changes: Array<(row: LearnerStateFeature, head: SnapshotObservation) => void> = [
      row => { row.eligibility.reasonCodes.push("ai_graded_correct"); },
      row => { row.eligibility.reasonCodes.push("ai_graded_incorrect"); },
      row => { row.eligibility.independentAttempt = "no"; },
      row => { row.eligibility.verifiedCorrect = "unknown"; },
      row => { row.eligibility.usableForCurrentVersion = "unknown"; },
      row => { row.availability = "stale"; },
      row => { row.availability = "unavailable"; },
      row => { row.views.push("help"); },
      row => { row.requirementKey = "other"; },
      row => { row.courseId = "other"; },
      row => { row.itemVersionId = "old-version"; },
      (_row, head) => { head.assistance = "hinted"; },
      (_row, head) => { head.problemId = null; },
      (_row, head) => { head.itemVersionId = null; },
      (_row, head) => { head.requirementKey = null; },
      (_row, head) => { head.usableForCurrentVersion = "unknown"; },
      (row, head) => { row.attemptedAt = head.attemptedAt = cutoff; row.recordedAt = cutoff; },
      (row, head) => { row.attemptedAt = head.attemptedAt = "2026-11-11T00:00:00Z"; },
      row => { row.recordedAt = cutoff; },
      row => { row.recordedAt = null; },
      row => { row.recordedAt = "bad"; },
      row => { row.recordedAt = "2026-10-01T00:00:00Z"; },
      (row, head) => { row.attemptedAt = head.attemptedAt = "bad"; },
    ];
    for (const change of changes) {
      const { input, experiment } = fixture([true, true, true, true, true]);
      const feature = experiment.features[0]!;
      change(feature, input.observations.find(row => row.id === feature.observationId)!);
      expect(expectRuleUnchanged(input, experiment)).toMatchObject({ experimentalAdvice: null,
        comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    }
  });

  it("excludes target items, explicitly held-out IDs, repeated problems and duplicate feature heads", () => {
    for (const mode of ["target", "problem-id", "observation-id", "repeat", "duplicate-feature", "missing-head"] as const) {
      const { input, experiment } = fixture([true, true, true, true, true]);
      const head = input.observations.at(-1)!;
      if (mode === "target") experiment.target.problemId = head.problemId;
      if (mode === "problem-id") experiment.excludedProblemIds = [head.problemId!];
      if (mode === "observation-id") experiment.excludedProblemIds = [head.id];
      if (mode === "repeat") input.observations = [...input.observations, { ...head, id: "repeated-attempt" }];
      if (mode === "duplicate-feature") experiment.features = [...experiment.features, { ...experiment.features[0]! }];
      if (mode === "missing-head") input.observations = input.observations.filter(row => row.id !== head.id);
      expect(expectRuleUnchanged(input, experiment)).toMatchObject({ experimentalAdvice: null,
        comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    }
  });

  it.each(["problem", "skill", "problem-and-skill", "identical"] as const)("excludes duplicate head IDs through %s collision in both orders", collision => {
    for (const reverse of [false, true]) {
      const { input, experiment } = fixture([true, true, true, true, true]);
      const head = input.observations.at(-1)!;
      const duplicate = { ...head,
        ...(collision === "problem" || collision === "problem-and-skill" ? { problemId: "conflicting-problem" } : {}),
        ...(collision === "skill" || collision === "problem-and-skill" ? { requirementKey: "conflicting-skill" } : {}),
      };
      input.observations = reverse ? [...input.observations, duplicate] : [duplicate, ...input.observations];
      expect(expectRuleUnchanged(input, experiment)).toMatchObject({ experimentalAdvice: null,
        comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    }
  });

  it("keeps a qualified fifth-sample control and excludes duplicate IDs without reading private bodies", () => {
    const { input, experiment } = fixture([true, true, true, true, true]);
    const control = nextLearningStepWithExperimentalBkt(input, experiment);
    expect(control.comparison).toMatchObject({ status: "compared", sampleCount: 5 });
    const head = input.observations.at(-1)!;
    const duplicate = { ...head, problemId: "conflicting-problem", requirementKey: "conflicting-skill" };
    for (const row of [head, duplicate, experiment.features[0]!, experiment.target]) {
      Object.defineProperty(row, "privateBody", { get() { throw new Error("private body must not be read"); } });
    }
    for (const observations of [[duplicate, ...input.observations], [...input.observations, duplicate]]) {
      const result = nextLearningStepWithExperimentalBkt({ ...input, observations }, experiment);
      expect(result.ruleDecision).toEqual(nextLearningStep({ ...input, observations }));
      expect(result).toMatchObject({ experimentalAdvice: null, comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    }
  });

  it("does not read an enumerable private target getter on the successful five-sample path", () => {
    const { input, experiment } = fixture([true, true, true, true, true]);
    Object.defineProperty(experiment.target, "privateBody", { enumerable: true,
      get() { throw new Error("successful advice must not read private target body"); } });
    const result = nextLearningStepWithExperimentalBkt(input, experiment);
    expect(result.comparison).toMatchObject({ status: "compared", sampleCount: 5 });
    expect(result.ruleDecision).toEqual(nextLearningStep(input));
    expect(result.experimentalAdvice?.target).toEqual({ courseId: "course", requirementKey: "skill",
      problemId: "new-problem", itemVersionId: "new-version" });
  });

  it("does not copy an enumerable private target sentinel on the successful five-sample path", () => {
    const { input, experiment } = fixture([true, true, true, true, true]);
    Object.defineProperty(experiment.target, "privateBody", { enumerable: true, value: "synthetic-private-sentinel" });
    const result = nextLearningStepWithExperimentalBkt(input, experiment);
    expect(result.comparison).toMatchObject({ status: "compared", sampleCount: 5 });
    expect(result.ruleDecision).toEqual(nextLearningStep(input));
    expect(result.experimentalAdvice?.target).toEqual({ courseId: "course", requirementKey: "skill",
      problemId: "new-problem", itemVersionId: "new-version" });
    expect(Object.keys(result.experimentalAdvice!.target).sort()).toEqual(["courseId", "itemVersionId", "problemId", "requirementKey"]);
    expect(result.experimentalAdvice?.target).not.toHaveProperty("privateBody");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-sentinel");
  });

  it.each(["courseId", "requirementKey", "problemId", "itemVersionId"] as const)("does not promote null %s identity or read a private body", field => {
    const { input, experiment } = fixture([true, true, true, true, true]);
    experiment.target[field] = null;
    Object.defineProperty(experiment.target, "privateBody", { get() { throw new Error("private body must not be read"); } });
    expect(nextLearningStepWithExperimentalBkt(input, experiment)).toMatchObject({ ruleDecision: nextLearningStep(input),
      experimentalAdvice: null, comparison: { reason: "incomplete_target", sampleCount: 0 } });
  });

  it("does not count a composite answer again under another skill or infer canonical families from sources", () => {
    const { input, experiment } = fixture([true, true, true, true, true]);
    const head = input.observations.at(-1)!;
    input.observations = [...input.observations, { ...head, id: "same-composite-other-skill", requirementKey: "other-skill" }];
    expect(expectRuleUnchanged(input, experiment)).toMatchObject({ experimentalAdvice: null,
      comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    // Shared source IDs do not establish a family; this experiment claims only
    // distinct problems, not cross-family transfer or real-package readiness.
    const clean = fixture();
    expect(new Set(clean.experiment.features.flatMap(row => row.sourceIds)).size).toBe(1);
    expect(expectRuleUnchanged(clean.input, clean.experiment).experimentalAdvice).not.toHaveProperty("familyId");
  });

  it("does not admit visually unverified or non-diagnostic answers as qualified experiment samples", () => {
    for (const id of ["visual-unverified-1", "visual-unverified-2", "visual-unverified-3", "visual-unverified-4",
      "visual-unverified-5", "visual-unverified-6", "T5Q9-non-diagnostic"]) {
      const { input, experiment } = fixture([true, true, true, true, true]);
      const row = experiment.features[0]!;
      const head = input.observations.find(value => value.id === row.observationId)!;
      row.observationId = head.id = id;
      row.eligibility.verifiedCorrect = head.verifiedCorrect = "unknown";
      row.eligibility.usableForCurrentVersion = head.usableForCurrentVersion = "unknown";
      expect(expectRuleUnchanged(input, experiment)).toMatchObject({ experimentalAdvice: null,
        comparison: { reason: "insufficient_samples", sampleCount: 4 } });
    }
  });

  it("preserves due retest, explicit controls, remediation and error/help priority", () => {
    const cycles = { completedCycles: ["1", "2"].map(id => ({ failureRootId: id,
      evidenceRefs: [`observation:${id}`, `help_exposure:${id}`, `observation:followup-${id}`],
      repeatedVerifiedError: false, persistentDeliveredAssistance: true })) };
    const controls: Partial<NextLearningStepInput>[] = [
      { dueRetest: true }, { learningPhase: "new_learning", dueRetest: true }, { learningPhase: "consolidate" },
      { learningPhase: "explore" }, { learningPhase: "maintain" }, { wantsFullExplanation: true },
      { remediationCycles: cycles }, { phaseSource: "explicit" },
    ];
    for (const control of controls) {
      const { input, experiment } = fixture();
      const request = { ...input, ...control };
      const result = nextLearningStepWithExperimentalBkt(request, experiment);
      expect(result.ruleDecision).toEqual(nextLearningStep(request));
      expect(result).toMatchObject({ experimentalAdvice: null, comparison: { reason: "priority_rule" } });
    }
    for (const override of [{ assistance: "hinted" as const }, { verifiedCorrect: "no" as const }]) {
      const { input, experiment } = fixture();
      input.observations = [{ ...input.observations[0]!, ...override }, ...input.observations.slice(1)];
      expect(expectRuleUnchanged(input, experiment).comparison.reason).toBe("priority_rule");
    }
  });
});
