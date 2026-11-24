import type { LearnerStateFeature } from "../learner-state";
import { predictLearnerShadow } from "../learner-shadow-predictions";
import { buildDecisionInput } from "./decision-input";
import { nextLearningStep, NEXT_LEARNING_STEP_VERSION } from "./next-learning-step";
import type { NextLearningStep, NextLearningStepInput } from "./snapshot-sources";
import {
  adaptiveShadowTime, compareLearnerShadowV2, planAdaptiveBellmanShadow, predictLearnerShadowV2,
  type AdaptiveBellmanShadowInput, type AdaptiveEpistemicShadowInput,
} from "./metacognitive-epistemic-bridge";

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
  epistemic?: Omit<AdaptiveEpistemicShadowInput, "scope" | "cutoff" | "observations" | "features" | "excludedProblemIds">
    & Omit<AdaptiveEpistemicShadowInput["scope"], "courseId" | "requirementKey">
    & { bellman?: AdaptiveBellmanShadowInput };
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
  epistemicShadowComparison?: {
    prediction: ReturnType<typeof predictLearnerShadowV2>;
    holdout: ReturnType<typeof compareLearnerShadowV2>["receipt"];
    bellman?: ReturnType<typeof planAdaptiveBellmanShadow>;
  };
};

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
  const fallback = (reason: FallbackReason, sampleCount = 0,
    shadow: Pick<ExperimentalBktAdviceResult, "epistemicShadowComparison"> = {}): ExperimentalBktAdviceResult => ({
    ruleDecision, experimentalAdvice: null, calibrated: false,
    comparison: { ...comparison, status: "fallback", reason, sampleCount }, ...shadow,
  });
  if (experiment?.enabled !== true) return fallback("disabled");
  const { target, cutoff, features, excludedProblemIds } = experiment;
  const { courseId, requirementKey, problemId, itemVersionId } = target;
  if (![courseId, requirementKey, problemId, itemVersionId].every(value => typeof value === "string" && value.trim())) {
    return fallback("incomplete_target");
  }
  // Require an explicit timezone, not server-local date interpretation.
  const cutoffTime = adaptiveShadowTime(cutoff);
  if (!Number.isFinite(cutoffTime)) return fallback("invalid_cutoff");
  const isRecordedBeforeCutoff = (row: { attemptedAt: string; recordedAt: string | null }) => {
    const recorded = adaptiveShadowTime(row.recordedAt);
    return adaptiveShadowTime(row.attemptedAt) <= recorded && recorded < cutoffTime;
  };
  const visibleHeads = input.observations.filter(row => row.recordedAt === undefined || isRecordedBeforeCutoff({
    attemptedAt: row.attemptedAt, recordedAt: row.recordedAt,
  }));
  const historicalDecision = visibleHeads.length === input.observations.length ? ruleDecision
    : nextLearningStep(buildDecisionInput({ ...input, observations: visibleHeads }));
  if (input.dueRetest || input.learningPhase !== undefined || input.phaseSource === "explicit"
    || input.wantsFullExplanation || historicalDecision.metacognitiveRoute === "lucky_guess_verification_probe"
    || !["needs_check", "independent", "correct_needs_independent_check"].includes(historicalDecision.reasonCode)) {
    return fallback("priority_rule");
  }
  const epistemic = experiment.epistemic;
  const shadow: Pick<ExperimentalBktAdviceResult, "epistemicShadowComparison"> = {};
  if (epistemic?.targetFamilyKeys.some(key => key.trim())) {
    const { workspaceId, learnerId, confirmedSkillVersion, bellman, ...configuration } = epistemic;
    const shadowInput = { ...configuration, scope: { courseId: courseId!, requirementKey: requirementKey!, workspaceId, learnerId, confirmedSkillVersion },
      cutoff, observations: input.observations, features, excludedProblemIds: [...excludedProblemIds, problemId!] };
    shadow.epistemicShadowComparison = { prediction: predictLearnerShadowV2({ ...shadowInput, targetItemVersionId: itemVersionId! }),
      holdout: compareLearnerShadowV2(shadowInput).receipt, ...(bellman ? { bellman: planAdaptiveBellmanShadow(bellman) } : {}) };
  }

  // Features lack problemId. Join to trusted effective observation heads rather
  // than inventing a new predictor field or mistaking observation IDs for items.
  // Exclude every repeated head ID before joining: Map last-write-wins would
  // otherwise let a conflicting problem/skill qualify depending on row order.
  // Identical duplicates are also excluded conservatively, never extra samples.
  const headCounts = new Map<string, number>();
  for (const row of visibleHeads) headCounts.set(row.id, (headCounts.get(row.id) ?? 0) + 1);
  const heads = new Map(visibleHeads.filter(row => headCounts.get(row.id) === 1).map(row => [row.id, row]));
  // Ambiguous/repeated problems are excluded entirely, not counted as new samples.
  const problemCounts = new Map<string, number>();
  const observationCounts = new Map<string, number>();
  for (const row of visibleHeads) if (row.problemId) {
    problemCounts.set(row.problemId, (problemCounts.get(row.problemId) ?? 0) + 1);
  }
  const visibleFeatures = features.filter(isRecordedBeforeCutoff);
  for (const row of visibleFeatures) observationCounts.set(row.observationId, (observationCounts.get(row.observationId) ?? 0) + 1);
  const excluded = new Set(excludedProblemIds);
  const comparable = visibleFeatures.filter(row => {
    const head = heads.get(row.observationId);
    return head && head.problemId && head.itemVersionId && head.requirementKey === requirementKey
      && head.itemVersionId === row.itemVersionId && adaptiveShadowTime(head.attemptedAt) === adaptiveShadowTime(row.attemptedAt)
      && head.assistance === "independent" && head.independentAttempt === "yes"
      && head.usableForCurrentVersion === "yes" && head.verifiedCorrect === row.eligibility.verifiedCorrect
      && row.availability === "available" && !row.views.includes("help")
      && head.problemId !== problemId && problemCounts.get(head.problemId) === 1
      && observationCounts.get(row.observationId) === 1 && !excluded.has(head.problemId) && !excluded.has(row.observationId);
  });
  const prediction = predictLearnerShadow({ features: comparable, courseId: courseId!, requirementKey: requirementKey!, cutoff, excludedProblemIds: [] });
  const sampleCount = prediction.evidenceObservationIds.length;
  if (!sampleCount) return fallback("no_qualified_samples", 0, shadow);
  if (sampleCount < EXPERIMENTAL_BKT_ADVICE_POLICY.minimumDistinctProblems) return fallback("insufficient_samples", sampleCount, shadow);
  const bkt = prediction.predictions.find(row => row.modelId === "classical-bkt")!;
  const additionalSupport = bkt.probability < EXPERIMENTAL_BKT_ADVICE_POLICY.supportBelowProbability;
  const activityKind = additionalSupport ? "reduced_help_practice" : historicalDecision.activityKind;
  return {
    ruleDecision, calibrated: false,
    experimentalAdvice: { kind: additionalSupport ? "supported_practice" : "continue_rule", activityKind,
      modelId: "classical-bkt", modelVersion: bkt.modelVersion, probability: bkt.probability,
      evidenceObservationIds: prediction.evidenceObservationIds, success: prediction.success, failure: prediction.failure,
      cutoff, target: { courseId, requirementKey, problemId, itemVersionId } },
    comparison: { ...comparison, status: "compared", reason: additionalSupport ? "additional_support" : "retain_rule",
      sampleCount, differsFromRule: activityKind !== historicalDecision.activityKind },
    ...shadow,
  };
}
