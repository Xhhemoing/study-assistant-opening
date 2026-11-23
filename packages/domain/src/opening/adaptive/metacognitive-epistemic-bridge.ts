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

export type SkillBeliefTrajectoryInput = {
  scope: SkillScope;
  cutoff: string;
  /** Trusted, identity-scoped effective heads and their independently qualified features. */
  observations: readonly SnapshotObservation[];
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

type EvidenceHead = {
  feature: LearnerStateFeature;
  observation: SnapshotObservation;
  attempted: number;
  claimedRequirementKeys: ReadonlySet<string>;
  exposureOnly?: false;
};

type JoinedHead = EvidenceHead | {
  feature: Pick<LearnerStateFeature, "observationId" | "requirementKey" | "attemptId">;
  observation: Pick<SnapshotObservation, "id" | "problemId" | "familyKey">;
  attempted: number;
  claimedRequirementKeys: ReadonlySet<string>;
  exposureOnly: true;
};

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function sameHead(left: SnapshotObservation, right: SnapshotObservation): boolean {
  if (left === right) return true;
  const { errors: leftErrors = [], ...leftFields } = left;
  const { errors: rightErrors = [], ...rightFields } = right;
  return sameFields(leftFields, rightFields) && leftErrors.length === rightErrors.length
    && leftErrors.every((error, index) => sameFields(error, rightErrors[index]!));
}

function groupByKey<T, K>(rows: readonly T[], keyOf: (row: T) => K) {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return groups;
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
  if (reasonCodes.includes("self_reported_copied_answer")) return assistance === "revealed";
  if (assistance === "unknown") return independentAttempt !== "yes" && reasonCodes.some(reason =>
    reason === "assistance_unknown" || reason === "exam_exposure_history_unknown" || reason === "exam_legacy_untracked_source");
  if (assistance !== "independent") return true;
  return !reasonCodes.some(reason => nonIndependentAssistanceReasons.has(reason))
    && (!reasonCodes.includes("help_before_submission") || reasonCodes.includes("attempt_timing_unknown"));
}

function matchesUntimestampedObservation(observation: SnapshotObservation, feature: LearnerStateFeature): boolean {
  const { eligibility } = feature;
  return (observation.requirementKey ?? null) === feature.requirementKey
    && normalizeSkillLabelKey(observation.skillLabel) === normalizeSkillLabelKey(feature.skillLabel)
    && (observation.itemVersionId ?? null) === feature.itemVersionId
    && (observation.verifiedCorrect === eligibility.verifiedCorrect
      || (eligibility.verifiedCorrect === "unknown" && feature.gaps.includes("cartridge_evidence_not_qualified")))
    && observation.independentAttempt === eligibility.independentAttempt
    && (observation.usableForCurrentVersion ?? "unknown") === eligibility.usableForCurrentVersion
    && matchesAssistance(observation.assistance, eligibility);
}

type FeatureRevision = { feature: LearnerStateFeature; attempted: number; recorded: number };
type ObservationRevision = { observation: SnapshotObservation; attempted: number };

function visibleObservationRevisions(
  observations: readonly SnapshotObservation[], features: readonly FeatureRevision[], cutoff: number,
): ObservationRevision[] {
  const visible: ObservationRevision[] = [];
  const claimedSlots = new Set<number>();
  const untimestamped: (ObservationRevision & { matchingSlots: number[] })[] = [];
  for (const observation of observations) {
    const attempted = adaptiveShadowTime(observation.attemptedAt);
    if (observation.recordedAt === undefined) {
      const matchingSlots = features.flatMap((row, slot) =>
        row.attempted === attempted && matchesUntimestampedObservation(observation, row.feature) ? [slot] : []);
      if (matchingSlots.length) untimestamped.push({ observation, attempted, matchingSlots });
      continue;
    }

    const recorded = adaptiveShadowTime(observation.recordedAt);
    if (!(attempted <= recorded)) continue;
    if (recorded < cutoff) visible.push({ observation, attempted });
    features.forEach((row, slot) => {
      if (row.recorded === recorded && row.attempted === attempted
        && matchesUntimestampedObservation(observation, row.feature)) claimedSlots.add(slot);
    });
  }

  // Each bucket shares the same matching feature slots, including the attempted time.
  for (const bucket of groupByKey(untimestamped, row => row.matchingSlots.join(",")).values()) {
    const { observation, matchingSlots } = bucket[0]!;
    const unclaimedSlots = matchingSlots.filter(slot => !claimedSlots.has(slot));
    const isVisible = (slot: number) => features[slot]!.recorded < cutoff;
    if (bucket.every(row => sameHead(row.observation, observation))) {
      const slots = unclaimedSlots.length ? unclaimedSlots : matchingSlots;
      if (slots.some(isVisible)) visible.push(...bucket);
    } else if (bucket.length === unclaimedSlots.length) {
      // Pair distinct legacy revisions with their feature slots in input order.
      visible.push(...bucket.filter((_row, index) => isVisible(unclaimedSlots[index]!)));
    } else if (matchingSlots.some(isVisible)) {
      // Ambiguous pairings still collide as soon as a matching feature is visible.
      visible.push(...bucket);
    }
  }
  return visible;
}

function prepareHeads(input: SkillBeliefTrajectoryInput, cutoff: number) {
  const courseFeatures = input.features.flatMap(feature => {
    if (feature.courseId !== input.scope.courseId) return [];
    const attempted = adaptiveShadowTime(feature.attemptedAt), recorded = adaptiveShadowTime(feature.recordedAt);
    return attempted <= recorded ? [{ feature, attempted, recorded }] : [];
  });
  const featuresById = groupByKey(courseFeatures, row => row.feature.observationId);
  const observationsById = groupByKey(input.observations, row => row.id);
  const disputedAttemptIds = new Set<string>();
  const heads = [...featuresById.entries()].flatMap(([observationId, allRows]): JoinedHead[] => {
    const rows = allRows.filter(row => row.recorded < cutoff);
    if (!rows.length) return [];
    const { feature, attempted } = rows[0]!;
    const { requirementKey, attemptId } = feature;
    const candidates = visibleObservationRevisions(observationsById.get(observationId) ?? [], allRows, cutoff);
    const sameSubmission = rows.every(row => row.feature.attemptId === attemptId && row.attempted === attempted)
      && candidates.every(row => row.attempted === attempted);
    if (!sameSubmission) {
      // Retain membership even when the collision loses its problem, family, or attempt identity.
      for (const row of rows) {
        if (row.feature.attemptId !== null) disputedAttemptIds.add(row.feature.attemptId);
      }
    }
    if (!candidates.length) return [];
    const { observation } = candidates[0]!;
    if (rows.length === 1 && requirementKey && sameSubmission && candidates.every(({ observation: head }) =>
      sameHead(head, observation) && (head.requirementKey ?? null) === requirementKey)) {
      return [{ feature, attempted, observation, claimedRequirementKeys: new Set([requirementKey]) }];
    }

    // A collision can establish prior exposure only for identities shared by every candidate.
    const unanimousRequirementKey = rows.every(row => (row.feature.requirementKey ?? null) === requirementKey)
      && candidates.every(({ observation: head }) => (head.requirementKey ?? null) === requirementKey) ? requirementKey : null;
    const problemId = candidates.every(({ observation: head }) => head.problemId === observation.problemId) ? observation.problemId : null;
    const familyKey = candidates.every(({ observation: head }) => head.familyKey === observation.familyKey) ? observation.familyKey : undefined;
    if (problemId === null && !familyKey?.trim()) return [];
    const claimedRequirementKeys = new Set([
      ...rows.map(row => row.feature.requirementKey), ...candidates.map(row => row.observation.requirementKey),
    ].filter(key => key != null));
    const latestFeatureAttempted = rows.reduce((latest, row) => Math.max(latest, row.attempted), attempted);
    const maxAttempted = candidates.reduce((latest, row) => Math.max(latest, row.attempted), latestFeatureAttempted);
    return [{
      exposureOnly: true, attempted: maxAttempted, claimedRequirementKeys,
      feature: { observationId, requirementKey: unanimousRequirementKey, attemptId: sameSubmission ? attemptId : null },
      observation: { id: observationId, problemId, familyKey },
    }];
  }).sort((a, b) => a.attempted - b.attempted || a.feature.observationId.localeCompare(b.feature.observationId));
  return { heads, disputedAttemptIds };
}

function isComparable(row: JoinedHead): row is EvidenceHead {
  if (row.exposureOnly === true) return false;
  const { feature, observation } = row;
  const { eligibility } = feature;
  return Boolean(feature.requirementKey) && Boolean(observation.itemVersionId) && observation.itemVersionId === feature.itemVersionId
    && observation.usableForCurrentVersion === "yes" && eligibility.usableForCurrentVersion === "yes"
    && observation.assistance === "independent" && observation.independentAttempt === "yes"
    && observation.isFirstSubmission !== false && observation.isMultiDraft !== true
    && eligibility.independentAttempt === "yes" && eligibility.verifiedCorrect !== "unknown"
    && observation.verifiedCorrect === eligibility.verifiedCorrect && !isAiGradedEvidence(eligibility)
    && feature.outcome === (eligibility.verifiedCorrect === "yes" ? "correct" : "incorrect")
    && feature.availability === "available" && !feature.views.includes("help");
}

function firstEpistemicSubmissions(rows: readonly JoinedHead[], disputedAttemptIds: ReadonlySet<string>) {
  const earliestByProblem = new Map<string, JoinedHead[]>();
  for (const row of rows) {
    const { problemId } = row.observation;
    if (!problemId) continue;
    const earliest = earliestByProblem.get(problemId);
    if (!earliest || row.attempted < earliest[0]!.attempted) earliestByProblem.set(problemId, [row]);
    else if (row.attempted === earliest[0]!.attempted) earliest.push(row);
  }
  const first = new Set<JoinedHead>();
  for (const earliest of earliestByProblem.values()) {
    const initial = earliest[0]!;
    const { attemptId } = initial.feature;
    if (attemptId !== null && disputedAttemptIds.has(attemptId)) continue;
    if (earliest.length === 1) {
      first.add(initial);
      continue;
    }
    if (attemptId === null || earliest.some(row => row.feature.attemptId !== attemptId)) continue;
    // A colliding head can claim multiple requirements without qualifying as evidence itself.
    const claimCounts = new Map<string, number>();
    for (const head of earliest) {
      for (const key of head.claimedRequirementKeys) claimCounts.set(key, (claimCounts.get(key) ?? 0) + 1);
    }
    for (const head of earliest) {
      const { requirementKey } = head.feature;
      if (requirementKey !== null && claimCounts.get(requirementKey) === 1) first.add(head);
    }
  }
  return first;
}

function freshFamilyHeads(known: readonly JoinedHead[], eligible: (row: JoinedHead) => boolean) {
  const seenFamilies = new Set<string>();
  const fresh = new Set<JoinedHead>();
  for (const simultaneous of groupByKey(known, row => row.attempted).values()) {
    const exposures: JoinedHead[][] = [];
    const submissions: JoinedHead[][] = [];
    for (const batch of groupByKey(simultaneous, row => row.feature.attemptId ?? row).values()) {
      (batch.some(eligible) ? submissions : exposures).push(batch);
    }
    // At a tie, standalone exposure counts first. Siblings share the history before their submission.
    for (const batch of [...exposures, ...submissions]) {
      const newFamilies = new Set<string>();
      for (const row of batch) {
        const { familyKey } = row.observation;
        if (familyKey?.trim() && !seenFamilies.has(familyKey)) {
          fresh.add(row);
          newFamilies.add(familyKey);
        }
      }
      for (const familyKey of newFamilies) seenFamilies.add(familyKey);
    }
  }
  return fresh;
}

function shadowItem(input: SkillBeliefTrajectoryInput, id: string): SkillItemModel {
  return input.itemModelsByVersion?.get(id) ?? { itemId: id, a: 1, b: 0, g: 0.25, l: 0.05 };
}

function withDirectEvidence(belief: SkillBeliefV1, row: EvidenceHead, item: SkillItemModel, freshFamily: boolean) {
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
  const { heads: known, disputedAttemptIds } = prepareHeads(input, cutoff);
  const first = firstEpistemicSubmissions(known, disputedAttemptIds), excludedIds = new Set(input.excludedProblemIds);
  const eligible = (row: JoinedHead): row is EvidenceHead => first.has(row) && isComparable(row)
    && !excludedIds.has(row.observation.id) && !excludedIds.has(row.observation.problemId!)
    && (!excludedFamilies || Boolean(row.observation.familyKey?.trim()) && !excludedFamilies.has(row.observation.familyKey!));
  const evidenceFeatures: LearnerStateFeature[] = [];
  const steps: { observationId: string; omega: 0 | 1; belief: SkillBeliefV1 }[] = [];
  const freshHeads = freshFamilyHeads(known, eligible);
  const propagatedAttempts = new Set<string>();
  const directlyObservedAttempts = new Set(known.filter(eligible).filter(row => row.feature.requirementKey === scope.requirementKey
    && row.feature.attemptId).map(row => row.feature.attemptId));
  for (const row of known) {
    const { observation } = row;
    if (!observation.problemId) continue;
    const isFreshFamily = freshHeads.has(row);
    const comparable = eligible(row);
    if (row.feature.requirementKey === scope.requirementKey) {
      if (comparable) {
        const item = shadowItem(input, row.feature.itemVersionId!);
        const next = withDirectEvidence(belief, row, item, isFreshFamily).belief;
        noDcmBelief = noDcmBelief === belief && !item.misconceptions?.length
          ? next : withDirectEvidence(noDcmBelief, row, { ...item, misconceptions: undefined }, isFreshFamily).belief;
        belief = next;
        evidenceFeatures.push(row.feature);
      }
      steps.push({ observationId: observation.id, omega: comparable ? 1 : 0, belief });
      continue;
    }
    if (!comparable) continue;
    const { feature } = row;
    const edge = input.fireEdgesByObservationId?.get(observation.id);
    const attemptId = feature.attemptId;
    if (!edge || row.observation.verifiedCorrect !== "yes" || !attemptId
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
  const { heads, disputedAttemptIds } = prepareHeads(input, cutoff);
  const first = firstEpistemicSubmissions(heads, disputedAttemptIds);
  const rows = heads.flatMap((row): ShadowV2Row[] => {
    if (!isComparable(row)) return [];
    const { observation, feature } = row;
    const familyKey = observation.familyKey;
    if (feature.requirementKey !== input.scope.requirementKey || !first.has(row)
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
