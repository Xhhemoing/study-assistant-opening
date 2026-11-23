import { createSkillBelief, effectiveRetrievability, retrievability, type SkillBeliefV1 } from "../../epistemic/belief";
import { explorationWeight, planFiniteHorizon, type SchedulerAction } from "../../epistemic/bellman-scheduler";
import { propagateFireCredit, type FireTarget } from "../../epistemic/fire-credit";
import { updateBeliefWithEvidence, type SkillItemModel } from "../../epistemic/gauss-hermite";
import { evaluateShadowV2Holdout, type ShadowV2Input, type ShadowV2Row } from "../../epistemic/shadow-v2";
import { routeMetacognitiveConfidence } from "../../metacognition/confidence-router";
import { computeMurphyBrierReceipt } from "../../metacognition/murphy-brier";
import { isPreAnswerConfidence, type WheelSpinningGuardInput } from "../../metacognition/types";
import { wheelSpinningGuard } from "../../metacognition/wheel-spinning-guard";
import { isAiGradedEvidence } from "../ai-evaluation";
import type { EvidenceEligibility } from "../evidence-eligibility";
import { scoreLearnerShadowV2 } from "../learner-shadow-predictions";
import type { LearnerStateFeature } from "../learner-state";
import { normalizeSkillLabelKey } from "./skill-identity";
import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";

type SkillScope = Pick<SkillBeliefV1, "workspaceId" | "learnerId" | "courseId" | "confirmedSkillVersion"> & {
  requirementKey: string;
};

type ShadowObservation = SnapshotObservation & { recordedAt?: string | null };

export type SkillBeliefTrajectoryInput = {
  scope: SkillScope;
  cutoff: string;
  /** Trusted, identity-scoped effective heads and their independently qualified features. */
  observations: readonly ShadowObservation[];
  features: readonly LearnerStateFeature[];
  /** Immutable publisher item models and predeclared prior, available at the prediction cutoff. */
  itemModelsByVersion?: ReadonlyMap<string, SkillItemModel>;
  misconceptionPrior?: Pick<SkillBeliefV1, "misconceptionMass" | "otherMass">;
  /** Verified prerequisite edges from a distinct source skill to this skill, keyed by source observation. */
  fireEdgesByObservationId?: ReadonlyMap<string, Omit<FireTarget, "belief"> & { sourceSkillVersion: SkillBeliefV1["confirmedSkillVersion"] }>;
  excludedProblemIds?: readonly string[];
};

export type AdaptiveEpistemicShadowInput = SkillBeliefTrajectoryInput & Pick<ShadowV2Input,
  "targetFamilyKeys" | "propagatedFamilyKeys" | "advanceThreshold">;

export type AdaptiveWheelSpinningInput = Omit<WheelSpinningGuardInput, "nowMs" | "thresholds">;

export function evaluateWheelSpinningGuard({ taskId, skillId, events, additionalActiveDwellMs, scheduleBlocks }: AdaptiveWheelSpinningInput, now: Date) {
  return wheelSpinningGuard({ taskId, skillId, nowMs: now.getTime(), events, additionalActiveDwellMs, scheduleBlocks });
}

function firstSubmissions<T>(rows: readonly T[], problem: (row: T) => string | null, time: (row: T) => number) {
  const first = new Map<string, { at: number; row: T | null }>();
  for (const row of rows) {
    const key = problem(row), at = time(row);
    if (!key || !Number.isFinite(at)) continue;
    const existing = first.get(key);
    if (!existing || at < existing.at) first.set(key, { at, row });
    else if (at === existing.at) first.set(key, { at, row: null });
  }
  return new Set([...first.values()].map(entry => entry.row));
}

export function metacognitiveStepMetadata({ observations, metacognitiveConfidence }: NextLearningStepInput) {
  if (!metacognitiveConfidence && !observations.some(row => row.preAnswerConfidence !== undefined)) return undefined;
  const all = observations.map(row => ({
    ...metacognitiveConfidence?.byObservationId.get(row.id), ...row,
  }));
  const submissions = firstSubmissions(all, row => row.problemId, row => Date.parse(row.attemptedAt));
  const firstClaimCounts = new Map<string, number>();
  for (const { problemId, isFirstSubmission } of all) {
    if (problemId !== null && isFirstSubmission === true) {
      firstClaimCounts.set(problemId, (firstClaimCounts.get(problemId) ?? 0) + 1);
    }
  }
  const current = all.filter(row => row.usableForCurrentVersion === "yes");
  const isAssisted = (row: SnapshotObservation) => row.assistance !== "independent"
    || row.independentAttempt !== "yes" || row.isMultiDraft === true;
  const calibration = current.flatMap(row => isPreAnswerConfidence(row.preAnswerConfidence) ? [{
    itemId: row.problemId ?? undefined,
    preAnswerConfidence: row.preAnswerConfidence,
    isCorrect: row.verifiedCorrect === "unknown" ? null : row.verifiedCorrect === "yes",
    isFirstSubmission: row.problemId !== null && (firstClaimCounts.get(row.problemId) ?? 0) <= 1
      && row.isFirstSubmission !== false && submissions.has(row),
    assisted: isAssisted(row),
  }] : []);
  if (calibration.length === 0) return undefined;
  const murphyBrier = computeMurphyBrierReceipt(calibration);
  const latest = current[0];
  if (!latest || latest.verifiedCorrect === "unknown" || !isPreAnswerConfidence(latest.preAnswerConfidence)) return { murphyBrier };
  let priorConsecutiveErrors = 0;
  for (const row of current.slice(1)) {
    if (row.verifiedCorrect !== "no" || row.hasValidIntermediateSteps === true) break;
    priorConsecutiveErrors++;
  }
  const route = routeMetacognitiveConfidence({ preAnswerConfidence: latest.preAnswerConfidence,
    isCorrect: latest.verifiedCorrect === "yes", hasValidIntermediateSteps: latest.hasValidIntermediateSteps === true,
    priorConsecutiveErrors, assisted: isAssisted(latest) && !(latest.preAnswerConfidence === "guessing"
      && latest.assistance === "independent" && latest.independentAttempt === "unknown" && latest.isMultiDraft !== true) });
  return { murphyBrier, metacognitiveRoute: route.route, allowMasteryAdvance: route.allowMasteryAdvance,
    productiveFailureRecognized: route.productiveFailureRecognized, effectiveFrustrationStreak: route.effectiveFrustrationStreak,
    pedagogicalDirective: route.directive };
}

/** Reject time without a timezone and calendar rollovers before constructing a bitemporal prefix. */
export function adaptiveShadowTime(value: string | null): number {
  if (value == null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const time = Date.parse(value);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 ? time : NaN;
}

type JoinedHead = {
  feature: LearnerStateFeature;
  observation: SnapshotObservation;
  attempted: number;
};

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function sameHead(left: ShadowObservation, right: ShadowObservation): boolean {
  if (left === right) return true;
  const { errors: leftErrors = [], ...leftFields } = left;
  const { errors: rightErrors = [], ...rightFields } = right;
  return sameFields(leftFields, rightFields) && leftErrors.length === rightErrors.length
    && leftErrors.every((error, index) => sameFields(error, rightErrors[index]!));
}

function uniqueById<T extends object>(rows: readonly T[], idOf: (row: T) => string, same?: (left: T, right: T) => boolean) {
  const byId = new Map<string, T | null>();
  for (const row of rows) {
    const id = idOf(row);
    const existing = byId.get(id);
    if (existing === undefined) byId.set(id, row);
    else if (existing !== null && !same?.(existing, row)) byId.set(id, null);
  }
  return byId;
}

const nonIndependentAssistanceReasons = new Set<EvidenceEligibility["reasonCodes"][number]>([
  "declared_help", "prior_evaluation_feedback", "exam_lesson_assistance", "exam_partial_example_exposure",
  "assistance_unknown", "exam_exposure_history_unknown", "exam_legacy_untracked_source",
]);

function matchesAssistance(assistance: SnapshotObservation["assistance"], eligibility: EvidenceEligibility): boolean {
  const { independentAttempt, reasonCodes } = eligibility;
  // Eligibility exits before evaluating assistance when the observation identity is incomplete.
  if (reasonCodes.includes("observation_identity_incomplete")) return true;
  if ((assistance === "hinted" || assistance === "revealed") && independentAttempt !== "no") return false;
  if (assistance === "unknown" && independentAttempt === "yes") return false;
  if (reasonCodes.includes("self_reported_copied_answer")) return assistance === "revealed";
  if (assistance !== "independent") return true;
  return !reasonCodes.some(reason => nonIndependentAssistanceReasons.has(reason))
    && (!reasonCodes.includes("help_before_submission") || reasonCodes.includes("attempt_timing_unknown"));
}

function prepareHeads(input: SkillBeliefTrajectoryInput, cutoff: number): JoinedHead[] {
  const visibleFeatures = input.features.flatMap(feature => {
    if (feature.courseId !== input.scope.courseId) return [];
    const attempted = adaptiveShadowTime(feature.attemptedAt), recorded = adaptiveShadowTime(feature.recordedAt);
    return attempted <= recorded && recorded < cutoff ? [{ feature, attempted }] : [];
  });
  const features = uniqueById(visibleFeatures, row => row.feature.observationId);
  const heads = uniqueById(input.observations.filter(observation => {
    const row = features.get(observation.id);
    const attempted = adaptiveShadowTime(observation.attemptedAt);
    if (!row || row.attempted !== attempted) return false;
    if (observation.recordedAt === undefined) {
      // Bind untimestamped heads to the visible feature before resolving duplicates.
      const { feature } = row;
      const { eligibility } = feature;
      return (observation.requirementKey ?? null) === feature.requirementKey
        && normalizeSkillLabelKey(observation.skillLabel) === normalizeSkillLabelKey(feature.skillLabel)
        && (observation.itemVersionId ?? null) === feature.itemVersionId
        && observation.verifiedCorrect === eligibility.verifiedCorrect
        && observation.independentAttempt === eligibility.independentAttempt
        && (observation.usableForCurrentVersion ?? "unknown") === eligibility.usableForCurrentVersion
        && matchesAssistance(observation.assistance, eligibility);
    }
    const recorded = adaptiveShadowTime(observation.recordedAt);
    return attempted <= recorded && recorded < cutoff;
  }), row => row.id, sameHead);
  return [...features.values()].flatMap(row => {
    if (!row) return [];
    const { feature } = row;
    const observation = heads.get(feature.observationId);
    if (!observation || !feature.requirementKey || observation.requirementKey !== feature.requirementKey) return [];
    return [{ ...row, observation }];
  }).sort((a, b) => a.attempted - b.attempted || a.feature.observationId.localeCompare(b.feature.observationId));
}

function isComparable({ feature, observation }: JoinedHead) {
  const { eligibility } = feature;
  return Boolean(observation.itemVersionId) && observation.itemVersionId === feature.itemVersionId
    && observation.usableForCurrentVersion === "yes" && eligibility.usableForCurrentVersion === "yes"
    && observation.assistance === "independent" && observation.independentAttempt === "yes"
    && observation.isFirstSubmission !== false && observation.isMultiDraft !== true
    && eligibility.independentAttempt === "yes" && eligibility.verifiedCorrect !== "unknown"
    && observation.verifiedCorrect === eligibility.verifiedCorrect && !isAiGradedEvidence(eligibility)
    && feature.outcome === (eligibility.verifiedCorrect === "yes" ? "correct" : "incorrect")
    && feature.availability === "available" && !feature.views.includes("help");
}

function firstEpistemicSubmissions(rows: readonly JoinedHead[]) {
  return firstSubmissions(rows, row => row.observation.problemId
    ? JSON.stringify([row.feature.requirementKey, row.observation.problemId]) : null, row => row.attempted);
}

function shadowItem(input: SkillBeliefTrajectoryInput, id: string): SkillItemModel {
  return input.itemModelsByVersion?.get(id) ?? { itemId: id, a: 1, b: 0, g: 0.25, l: 0.05 };
}

function withDirectEvidence(belief: SkillBeliefV1, row: JoinedHead, item: SkillItemModel, freshFamily: boolean) {
  const outcome = row.observation.verifiedCorrect === "yes";
  const misconceptionId = !outcome ? row.observation.errors?.find(error => error.source === "verified_steps"
    && item.misconceptions?.some(misconception => misconception.id === error.misconceptionId))?.misconceptionId : undefined;
  return updateBeliefWithEvidence({ belief, item, atMs: row.attempted, observation: { outcome, isFreshFamily: freshFamily,
    channel: misconceptionId ? "step-failure" : "unassisted", misconceptionId } });
}

function replay(input: SkillBeliefTrajectoryInput, cutoff: number, excludedFamilies?: ReadonlySet<string>) {
  const { scope, misconceptionPrior: prior } = input;
  const identity = { workspaceId: scope.workspaceId, learnerId: scope.learnerId, courseId: scope.courseId,
    confirmedSkillVersion: scope.confirmedSkillVersion };
  let belief = createSkillBelief({ ...identity, misconceptionMass: prior?.misconceptionMass, otherMass: prior?.otherMass });
  let noDcmBelief = prior ? createSkillBelief(identity) : belief;
  const known = prepareHeads(input, cutoff);
  const first = firstEpistemicSubmissions(known), excludedIds = new Set(input.excludedProblemIds);
  const eligible = (row: JoinedHead) => first.has(row) && isComparable(row)
    && !excludedIds.has(row.observation.id) && !excludedIds.has(row.observation.problemId!)
    && (!excludedFamilies || Boolean(row.observation.familyKey?.trim()) && !excludedFamilies.has(row.observation.familyKey!));
  const evidenceFeatures: LearnerStateFeature[] = [];
  const steps: { observationId: string; omega: 0 | 1; belief: SkillBeliefV1 }[] = [];
  const seenFamilies = new Set<string>();
  const propagatedAttempts = new Set<string>();
  const directlyObservedAttempts = new Set(known.filter(row => row.feature.requirementKey === scope.requirementKey
    && row.feature.attemptId && eligible(row)).map(row => row.feature.attemptId));
  for (const row of known) {
    const { observation, feature } = row;
    const familyKey = observation.familyKey?.trim() ? observation.familyKey : null;
    const isFreshFamily = Boolean(familyKey && !seenFamilies.has(familyKey));
    if (familyKey) seenFamilies.add(familyKey);
    if (!observation.problemId) continue;
    const comparable = eligible(row);
    if (feature.requirementKey === scope.requirementKey) {
      if (comparable) {
        const item = shadowItem(input, feature.itemVersionId!);
        const next = withDirectEvidence(belief, row, item, isFreshFamily).belief;
        noDcmBelief = noDcmBelief === belief && !item.misconceptions?.length
          ? next : withDirectEvidence(noDcmBelief, row, { ...item, misconceptions: undefined }, isFreshFamily).belief;
        belief = next;
        evidenceFeatures.push(feature);
      }
      steps.push({ observationId: observation.id, omega: comparable ? 1 : 0, belief });
      continue;
    }
    const edge = input.fireEdgesByObservationId?.get(observation.id);
    const attemptId = feature.attemptId;
    if (!edge || !comparable || observation.verifiedCorrect !== "yes" || !attemptId
      || directlyObservedAttempts.has(attemptId) || propagatedAttempts.has(attemptId)) continue;
    const source = createSkillBelief({ ...identity, confirmedSkillVersion: edge.sourceSkillVersion });
    const sourceUpdate = withDirectEvidence(source, row, shadowItem(input, feature.itemVersionId!), isFreshFamily);
    const propagate = (target: SkillBeliefV1) => propagateFireCredit({ sourceSkillId: feature.requirementKey!, attemptId,
      atMs: row.attempted, source: sourceUpdate.belief, rhoPlus: sourceUpdate.retrievedProbability,
      targets: { target: { ...edge, belief: target } } });
    const propagated = propagate(belief);
    noDcmBelief = noDcmBelief === belief ? propagated.targets.target!.belief : propagate(noDcmBelief).targets.target!.belief;
    belief = propagated.targets.target!.belief;
    if (propagated.propagatedSkillIds.length) propagatedAttempts.add(attemptId);
  }
  return { belief, noDcmBelief, evidenceFeatures, steps, directRetrievability: retrievability(belief, cutoff),
    effectiveRetrievability: effectiveRetrievability(belief, cutoff) };
}

function cutoffMs(cutoff: string) {
  const time = adaptiveShadowTime(cutoff);
  if (!Number.isFinite(time)) throw new RangeError("Invalid adaptive shadow cutoff");
  return time;
}

export function buildSkillBeliefTrajectory(input: SkillBeliefTrajectoryInput) {
  const cutoff = cutoffMs(input.cutoff);
  const { belief, steps, directRetrievability, effectiveRetrievability } = replay(input, cutoff);
  return { belief, steps, directRetrievability, effectiveRetrievability };
}

function predictAt(input: AdaptiveEpistemicShadowInput, cutoff: number,
  excludedFamilies: ReadonlySet<string>, itemVersionId?: string) {
  const { belief, noDcmBelief, directRetrievability, effectiveRetrievability, evidenceFeatures } = replay(input, cutoff, excludedFamilies);
  const predictions = scoreLearnerShadowV2({ ...input.scope, features: evidenceFeatures,
    cutoff: new Date(cutoff).toISOString(), belief, noDcmBelief, item: shadowItem(input, itemVersionId ?? input.scope.requirementKey) });
  return { belief, predictions, directRetrievability, effectiveRetrievability,
    evidenceObservationIds: evidenceFeatures.map(row => row.observationId) };
}

export function predictLearnerShadowV2(input: AdaptiveEpistemicShadowInput & { targetItemVersionId?: string }) {
  const cutoff = cutoffMs(input.cutoff);
  return predictAt(input, cutoff, new Set([...input.targetFamilyKeys, ...input.propagatedFamilyKeys]), input.targetItemVersionId);
}

/** Each answered row gets a forecast from its own pre-attempt prefix, leaving its entire family out. */
export function compareLearnerShadowV2(input: AdaptiveEpistemicShadowInput) {
  const cutoff = cutoffMs(input.cutoff);
  const excluded = new Set([...input.targetFamilyKeys, ...input.propagatedFamilyKeys]);
  const excludedIds = new Set(input.excludedProblemIds);
  const heads = prepareHeads(input, cutoff);
  const first = firstEpistemicSubmissions(heads);
  const rows = heads.flatMap((row): ShadowV2Row[] => {
    const { observation, feature } = row;
    const familyKey = observation.familyKey;
    if (feature.requirementKey !== input.scope.requirementKey || !first.has(row) || !isComparable(row)
      || !familyKey?.trim() || excluded.has(familyKey) || excludedIds.has(observation.id) || excludedIds.has(observation.problemId!)) return [];
    const { predictions } = predictAt(input, row.attempted, new Set([...excluded, familyKey]), feature.itemVersionId!);
    return [{ observationId: observation.id, familyKey, attemptedAt: observation.attemptedAt,
      correct: observation.verifiedCorrect === "yes", predictions }];
  });
  return { rows, receipt: evaluateShadowV2Holdout({ ...input, rows }) };
}

export type AdaptiveBellmanShadowInput = {
  candidates: readonly SchedulerAction[];
  horizonMinutes?: number;
  slotMinutes?: number;
  deadlineHours?: number;
};

const ADAPTIVE_SHADOW_DEADLINE_HOURS = 72;

export function planAdaptiveBellmanShadow({ candidates, horizonMinutes = ADAPTIVE_SHADOW_DEADLINE_HOURS * 60,
  slotMinutes = 15, deadlineHours = ADAPTIVE_SHADOW_DEADLINE_HOURS }: AdaptiveBellmanShadowInput) {
  if (!Number.isFinite(deadlineHours) || deadlineHours < 0 || !Number.isFinite(horizonMinutes) || horizonMinutes < 0
    || !Number.isInteger(slotMinutes) || slotMinutes < 1) throw new RangeError("Invalid adaptive shadow planning bounds");
  const boundedMinutes = Math.min(horizonMinutes, ADAPTIVE_SHADOW_DEADLINE_HOURS * 60, deadlineHours * 60);
  const actions = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  return { ...planFiniteHorizon({ actions, slotMinutes, horizonMinutes: boundedMinutes, deadlineHours }),
    horizonMinutes: boundedMinutes, slotMinutes, deadlineHours, explorationWeight: explorationWeight(deadlineHours, { min: 0 }) };
}
