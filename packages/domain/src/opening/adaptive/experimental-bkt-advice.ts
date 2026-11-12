import type { LearnerStateFeature } from "../learner-state";
import { predictLearnerShadow } from "../learner-shadow-predictions";
import { nextLearningStep, NEXT_LEARNING_STEP_VERSION } from "./next-learning-step";
import type { NextLearningStep, NextLearningStepInput } from "./snapshot-sources";

/** Predeclared experiment choices, not fitted sample sufficiency or calibrated truth. */
export const EXPERIMENTAL_BKT_ADVICE_POLICY = {
  version: "experimental-bkt-advice-1",
  minimumDistinctProblems: 5,
  supportBelowProbability: 0.6,
} as const;

export type ExperimentalBktAdviceInput = {
  enabled: boolean;
  /** Trusted effective-head features, not client/model-supplied grades. */
  features: readonly LearnerStateFeature[];
  target: { courseId?: string | null; requirementKey?: string | null; problemId?: string | null; itemVersionId?: string | null };
  cutoff: string;
  /** Accept problem IDs or observation IDs; translate to the predictor's observation-ID exclusions. */
  excludedProblemIds: readonly string[];
};
type FallbackReason = "disabled" | "incomplete_target" | "invalid_cutoff" | "priority_rule"
  | "no_qualified_samples" | "insufficient_samples";
export type ExperimentalBktAdviceResult = {
  ruleDecision: NextLearningStep;
  experimentalAdvice: null | {
    kind: "supported_practice" | "continue_rule";
    activityKind: NextLearningStep["activityKind"];
    probability: number;
    modelId: "classical-bkt";
    modelVersion: "1";
    evidenceObservationIds: string[];
    success: number;
    failure: number;
    cutoff: string;
    target: ExperimentalBktAdviceInput["target"];
  };
  comparison: {
    policyVersion: typeof EXPERIMENTAL_BKT_ADVICE_POLICY.version;
    ruleVersion: typeof NEXT_LEARNING_STEP_VERSION;
    status: "fallback" | "compared";
    reason: FallbackReason | "additional_support" | "retain_rule";
    sampleCount: number;
    differsFromRule: boolean;
  };
  calibrated: false;
};

/** Reject calendar rollovers and timezone-less timestamps at the experiment boundary. */
function experimentTime(value: string | null): number {
  if (value == null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const time = Date.parse(value);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 ? time : NaN;
}

/**
 * Explicit opt-in consumption, separate from rules and decision receipts. No status,
 * mastery, exam admission or phase is changed. Even high probability cannot bypass
 * instruction, due retests, learner requests, remediation or a verified error.
 */
export function nextLearningStepWithExperimentalBkt(
  input: NextLearningStepInput, experiment?: ExperimentalBktAdviceInput,
): ExperimentalBktAdviceResult {
  const ruleDecision = nextLearningStep(input);
  const comparison = { policyVersion: EXPERIMENTAL_BKT_ADVICE_POLICY.version,
    ruleVersion: NEXT_LEARNING_STEP_VERSION, sampleCount: 0, differsFromRule: false } as const;
  const fallback = (reason: FallbackReason, sampleCount = 0): ExperimentalBktAdviceResult => ({
    ruleDecision, experimentalAdvice: null, calibrated: false,
    comparison: { ...comparison, status: "fallback", reason, sampleCount },
  });
  if (experiment?.enabled !== true) return fallback("disabled");
  const { target, cutoff, features, excludedProblemIds } = experiment;
  const { courseId, requirementKey, problemId, itemVersionId } = target;
  if (![courseId, requirementKey, problemId, itemVersionId].every(value => typeof value === "string" && value.trim())) {
    return fallback("incomplete_target");
  }
  // Require an explicit timezone, not server-local date interpretation.
  const cutoffTime = experimentTime(cutoff);
  if (!Number.isFinite(cutoffTime)) return fallback("invalid_cutoff");
  if (input.dueRetest || input.learningPhase !== undefined || input.phaseSource === "explicit"
    || input.wantsFullExplanation || !["needs_check", "independent", "correct_needs_independent_check"].includes(ruleDecision.reasonCode)) {
    return fallback("priority_rule");
  }

  // Features lack problemId. Join to trusted effective observation heads rather
  // than inventing a new predictor field or mistaking observation IDs for items.
  // Exclude every repeated head ID before joining: Map last-write-wins would
  // otherwise let a conflicting problem/skill qualify depending on row order.
  // Identical duplicates are also excluded conservatively, never extra samples.
  const headCounts = new Map<string, number>();
  for (const row of input.observations) headCounts.set(row.id, (headCounts.get(row.id) ?? 0) + 1);
  const heads = new Map(input.observations.filter(row => headCounts.get(row.id) === 1).map(row => [row.id, row]));
  // Ambiguous/repeated problems are excluded entirely, not counted as new samples.
  const problemCounts = new Map<string, number>();
  const observationCounts = new Map<string, number>();
  for (const row of input.observations) if (row.problemId) {
    problemCounts.set(row.problemId, (problemCounts.get(row.problemId) ?? 0) + 1);
  }
  for (const row of features) observationCounts.set(row.observationId, (observationCounts.get(row.observationId) ?? 0) + 1);
  const excluded = new Set(excludedProblemIds);
  const comparable = features.filter(row => {
    const head = heads.get(row.observationId);
    const attempted = experimentTime(row.attemptedAt), recorded = experimentTime(row.recordedAt);
    return head && head.problemId && head.itemVersionId && head.requirementKey === requirementKey
      && head.itemVersionId === row.itemVersionId && experimentTime(head.attemptedAt) === attempted
      && head.assistance === "independent" && head.independentAttempt === "yes"
      && head.usableForCurrentVersion === "yes" && head.verifiedCorrect === row.eligibility.verifiedCorrect
      && row.availability === "available" && !row.views.includes("help")
      && Number.isFinite(attempted) && Number.isFinite(recorded) && attempted <= recorded && recorded < cutoffTime
      && head.problemId !== problemId && problemCounts.get(head.problemId) === 1
      && observationCounts.get(row.observationId) === 1 && !excluded.has(head.problemId) && !excluded.has(row.observationId);
  });
  const prediction = predictLearnerShadow({ features: comparable, courseId: courseId!, requirementKey: requirementKey!, cutoff, excludedProblemIds: [] });
  const sampleCount = prediction.evidenceObservationIds.length;
  if (!sampleCount) return fallback("no_qualified_samples");
  if (sampleCount < EXPERIMENTAL_BKT_ADVICE_POLICY.minimumDistinctProblems) return fallback("insufficient_samples", sampleCount);
  const bkt = prediction.predictions.find(row => row.modelId === "classical-bkt")!;
  const additionalSupport = bkt.probability < EXPERIMENTAL_BKT_ADVICE_POLICY.supportBelowProbability;
  const activityKind = additionalSupport ? "reduced_help_practice" : ruleDecision.activityKind;
  return {
    ruleDecision, calibrated: false,
    experimentalAdvice: { kind: additionalSupport ? "supported_practice" : "continue_rule", activityKind,
      modelId: "classical-bkt", modelVersion: bkt.modelVersion, probability: bkt.probability,
      evidenceObservationIds: prediction.evidenceObservationIds, success: prediction.success, failure: prediction.failure,
      cutoff, target: { courseId, requirementKey, problemId, itemVersionId } },
    comparison: { ...comparison, status: "compared", reason: additionalSupport ? "additional_support" : "retain_rule",
      sampleCount, differsFromRule: activityKind !== ruleDecision.activityKind },
  };
}
