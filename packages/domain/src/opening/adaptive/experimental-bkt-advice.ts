import type { LearnerStateFeature } from "../learner-state";
import { predictLearnerShadow } from "../learner-shadow-predictions";
import { buildDecisionInput } from "./decision-input";
import { nextLearningStep, NEXT_LEARNING_STEP_VERSION } from "./next-learning-step";
import type { NextLearningStep, NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";
import {
  adaptiveShadowTime, compareLearnerShadowV2, courseFeatureRevisions, matchesUntimestampedObservation,
  planAdaptiveBellmanShadow, predictLearnerShadowV2, sameObservationProjection, visibleObservationRevisions,
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

function groupById<T>(rows: readonly T[], idOf: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = idOf(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

function historicalBktEvidence(
  observations: readonly SnapshotObservation[], features: readonly LearnerStateFeature[], courseId: string, cutoff: number,
) {
  const valid = courseFeatureRevisions(features, courseId);
  const courseFeaturesById = groupById(features.filter(row => row.courseId === courseId), row => row.observationId);
  const featuresById = groupById(valid, row => row.feature.observationId);
  const latestRecordings = new Map<string, number>();
  const disputedSamples = new Set<string>();
  const heads = [...groupById(observations, row => row.id).entries()].flatMap(([id, rows]) => {
    const slots = featuresById.get(id) ?? [];
    const visible = visibleObservationRevisions(rows, slots, cutoff);
    const hasInvalidFeatures = (courseFeaturesById.get(id)?.length ?? 0) > slots.length;
    const unplaced = rows.filter(row => {
      if (row.recordedAt !== undefined) return false;
      const attempted = adaptiveShadowTime(row.attemptedAt);
      return attempted < cutoff && !slots.some(slot =>
        slot.attempted === attempted && matchesUntimestampedObservation(row, slot.feature));
    });
    const ruleOnly = hasInvalidFeatures ? [] : unplaced.filter(row => !rows.some(explicit =>
      explicit.recordedAt !== undefined && sameObservationProjection(row, explicit)));
    if (ruleOnly.length) disputedSamples.add(id);
    if (!visible.length) return ruleOnly;

    const latest = visible.reduce((time, row) => Math.max(time, row.recorded), -Infinity);
    const current = visible.filter(row => row.recorded === latest);
    // An older legacy projection cannot compete with a strictly newer head
    // unless its possible recordings also include the latest recording.
    const uncertainRecording = current.some(row => row.legacyCopies !== undefined && visible.some(older =>
      older.recorded < latest && older.observation === row.observation));
    if (ruleOnly.length || uncertainRecording) return [...visible.map(row => row.observation), ...ruleOnly];
    if (current.length < visible.length) latestRecordings.set(id, latest);

    // Classical BKT requires a unique sample, even if replay can infer
    // exposure from multiple copies of a legacy projection.
    if (unplaced.length || current.some(({ observation, legacyCopies }) => (legacyCopies ?? 1) > 1
      || visible.some(older => older.recorded < latest && older.legacyCopies !== undefined
        && sameObservationProjection(older.observation, observation)))) disputedSamples.add(id);
    return current.map(row => row.observation);
  });
  return {
    heads, disputedSamples,
    features: valid.filter(({ feature, recorded }) => recorded < cutoff
      && recorded === (latestRecordings.get(feature.observationId) ?? recorded)).map(row => row.feature),
  };
}

function verifiedStepLabels(head: SnapshotObservation): string {
  return JSON.stringify([...new Set((head.errors ?? []).filter(error => error.source === "verified_steps")
    .map(error => error.label))].sort());
}

function historicalRuleInput(input: NextLearningStepInput, heads: readonly SnapshotObservation[]) {
  const groups = groupById(heads, row => row.id);
  // Equal or unresolved recording times remain duplicate samples. For the rule
  // gate, prefer an agreement on the facts that can affect priority.
  const ambiguousPriority = [...groups.values()].some(([first, ...rest]) => rest.some(head =>
    head.attemptedAt !== first!.attemptedAt || head.verifiedCorrect !== first!.verifiedCorrect
    || head.assistance !== first!.assistance || head.independentAttempt !== first!.independentAttempt
    || head.usableForCurrentVersion !== first!.usableForCurrentVersion
    || head.preAnswerConfidence !== first!.preAnswerConfidence || head.isMultiDraft !== first!.isMultiDraft
    || head.hasValidIntermediateSteps !== first!.hasValidIntermediateSteps
    || verifiedStepLabels(head) !== verifiedStepLabels(first!)
    || ((input.drilldownSnapshot !== undefined || head.verifiedCorrect === "no") && head.problemId !== first!.problemId)));
  const effective = [...groups.values()].map(rows => rows[0]!);
  const unchanged = effective.length === input.observations.length && effective.every((row, index) => row === input.observations[index]);
  return { ambiguousPriority, ruleInput: unchanged ? input : buildDecisionInput({ ...input, observations: effective }) };
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
  const { heads: visibleHeads, features: visibleFeatures, disputedSamples } =
    historicalBktEvidence(input.observations, features, courseId!, cutoffTime);
  const { ambiguousPriority, ruleInput } = historicalRuleInput(input, visibleHeads);
  const historicalDecision = ruleInput === input ? ruleDecision : nextLearningStep(ruleInput);
  if (input.dueRetest || input.learningPhase !== undefined || input.phaseSource === "explicit"
    || input.wantsFullExplanation || ambiguousPriority || historicalDecision.metacognitiveRoute === "lucky_guess_verification_probe"
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
  for (const row of visibleFeatures) observationCounts.set(row.observationId, (observationCounts.get(row.observationId) ?? 0) + 1);
  const excluded = new Set(excludedProblemIds);
  const comparable = visibleFeatures.filter(row => {
    const head = heads.get(row.observationId);
    return head && !disputedSamples.has(row.observationId) && head.problemId && head.itemVersionId && head.requirementKey === requirementKey
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
