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

const observationProjectionFields = [
  "id", "skillLabel", "requirementKey", "itemVersionId", "attemptedAt", "assistance", "verifiedCorrect",
  "independentAttempt", "usableForCurrentVersion", "problemId", "familyKey", "preAnswerConfidence",
  "hasValidIntermediateSteps", "isFirstSubmission", "isMultiDraft",
] as const satisfies readonly (keyof SnapshotObservation)[];

export function sameObservationProjection(left: SnapshotObservation, right: SnapshotObservation): boolean {
  if (left === right) return true;
  const leftErrors = left.errors ?? [], rightErrors = right.errors ?? [];
  return observationProjectionFields.every(key => left[key] === right[key]) && leftErrors.length === rightErrors.length
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

export function matchesUntimestampedObservation(observation: SnapshotObservation, feature: LearnerStateFeature): boolean {
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
type ObservationProjection = { observation: SnapshotObservation; attempted: number };
type ObservationRevision = ObservationProjection & { recorded: number; legacyCopies?: number };
type LegacyProjection = ObservationProjection & { slots: ReadonlySet<number>; required: boolean; bit: bigint; copies: number };
type LegacyBucket = { occurrences: LegacyProjection[]; slots: Set<number>; required: bigint };
type LegacyProgress = { next: number; represented: bigint; skipped: bigint };
type LegacyPlacement = { bucketIndex: number; occurrence: number; slot: number };
type LegacyAssignment = {
  progress: readonly LegacyProgress[];
  coverage: number;
  distinct: number;
  edges: { previous: LegacyAssignment; placement?: LegacyPlacement }[];
};

function legacyComponents(buckets: readonly LegacyBucket[]) {
  const bySlot = groupByKey(buckets.flatMap(bucket => [...bucket.slots].map(slot => ({ slot, bucket }))), entry => entry.slot);
  const remaining = new Set(buckets);
  const components: { buckets: LegacyBucket[]; slots: number[] }[] = [];
  for (const first of remaining) {
    remaining.delete(first);
    const connected = [first];
    const slots = new Set<number>();
    for (const bucket of connected) {
      for (const slot of bucket.slots) {
        if (slots.has(slot)) continue;
        slots.add(slot);
        for (const entry of bySlot.get(slot)!) if (remaining.delete(entry.bucket)) connected.push(entry.bucket);
      }
    }
    components.push({ buckets: connected, slots: [...slots].sort((left, right) => left - right) });
  }
  return components;
}

function compareAssignments(left: LegacyAssignment, right: LegacyAssignment) {
  // Prefer explaining another distinct projection over reusing an identical copy.
  return left.coverage - right.coverage || left.distinct - right.distinct;
}

type ProducerPath = { slots: bigint; distinct: number; placements: readonly LegacyPlacement[] };

function offerProducerPath(paths: Map<string, ProducerPath>, path: ProducerPath) {
  const key = `${path.slots}:${path.distinct}`;
  const previous = paths.get(key);
  if (previous) {
    // Identical slot sets have equal length, so the first differing occurrence decides.
    const difference = path.placements.findIndex((entry, index) => entry.occurrence !== previous.placements[index]!.occurrence);
    if (difference < 0 || path.placements[difference]!.occurrence > previous.placements[difference]!.occurrence) return;
  }
  paths.set(key, path);
}

function emitOptimalLegacyPaths(
  buckets: readonly LegacyBucket[], optimal: ReadonlySet<LegacyAssignment>,
  emit: (row: LegacyProjection, slot: number) => void,
) {
  // Project the optimal assignment graph onto one bucket at a time. A producer
  // preference can replace another path only for the same slots and distinct count.
  // The assignment of every other bucket remains feasible for that replacement.
  buckets.forEach(({ occurrences }, bucketIndex) => {
    const pending = new Map<LegacyAssignment, Map<string, ProducerPath>>();
    for (const assignment of optimal) {
      const { represented } = assignment.progress[bucketIndex]!;
      const distinct = new Set(occurrences.filter(row => (row.bit & represented) !== 0n)).size;
      const paths = new Map<string, ProducerPath>();
      offerProducerPath(paths, { slots: 0n, distinct, placements: [] });
      pending.set(assignment, paths);
    }
    // All terminal nodes are at the same depth. Visiting in insertion order
    // accumulates paths from every successor before visiting its predecessor.
    for (const [assignment, paths] of pending) {
      if (!assignment.edges.length) {
        for (const { placements } of paths.values()) {
          for (const { slot, occurrence } of placements) emit(occurrences[occurrence]!, slot);
        }
      }
      for (const { previous, placement } of assignment.edges) {
        const next = pending.get(previous) ?? new Map<string, ProducerPath>();
        for (const path of paths.values()) {
          offerProducerPath(next, placement?.bucketIndex === bucketIndex
            ? { ...path, slots: path.slots | (1n << BigInt(placement.slot)), placements: [placement, ...path.placements] }
            : path);
        }
        pending.set(previous, next);
      }
      pending.delete(assignment);
    }
  });
}

function resolveLegacyComponent(
  buckets: readonly LegacyBucket[], slots: readonly number[], visibleSlots: ReadonlySet<number>,
  emit: (row: LegacyProjection, slot: number) => void,
) {
  if (!slots.some(slot => visibleSlots.has(slot))) return;
  const only = buckets[0]!.occurrences[0]!;
  if (buckets.length === 1 && buckets[0]!.occurrences.every(row => row === only)) {
    // No other content can explain these slots; extra copies do not change exposure.
    for (const slot of slots) emit(only, slot);
    return;
  }

  const first: LegacyAssignment = {
    progress: buckets.map(() => ({ next: 0, represented: 0n, skipped: 0n })), coverage: 0, distinct: 0, edges: [],
  };
  let assignments = [first];
  for (const slot of slots) {
    const next = new Map<string, LegacyAssignment>();
    function offer(candidate: LegacyAssignment) {
      const key = candidate.progress.map(row => `${row.next}:${row.represented}:${row.skipped}`).join(",");
      const previous = next.get(key);
      const comparison = previous ? compareAssignments(candidate, previous) : 1;
      if (comparison > 0) next.set(key, candidate);
      else if (comparison === 0) previous!.edges.push(...candidate.edges);
    }
    for (const assignment of assignments) {
      offer({ ...assignment, edges: [{ previous: assignment }] });
      buckets.forEach(({ occurrences, slots: compatible }, bucketIndex) => {
        if (!compatible.has(slot)) return;
        const { next: start, represented } = assignment.progress[bucketIndex]!;
        let { skipped } = assignment.progress[bucketIndex]!;
        const offered = new Set<LegacyProjection>();
        for (let index = start; index < occurrences.length; index++) {
          const row = occurrences[index]!;
          const missing = (represented & row.bit) === 0n;
          if ((skipped & row.bit) === 0n && row.slots.has(slot) && !offered.has(row)) {
            offered.add(row);
            const progress = [...assignment.progress];
            progress[bucketIndex] = { next: index + 1, represented: represented | row.bit, skipped };
            offer({ progress, coverage: assignment.coverage + 1, distinct: assignment.distinct + Number(missing),
              edges: [{ previous: assignment, placement: { bucketIndex, occurrence: index, slot } }] });
          }
          // A first occurrence fixes the order of that content. An optional
          // projection skipped here cannot re-enter through a later copy.
          if (missing && row.required) break;
          if (missing) skipped |= row.bit;
        }
      });
    }
    assignments = [...next.values()];
  }

  let best: LegacyAssignment | undefined;
  const optimal = new Set<LegacyAssignment>();
  for (const assignment of assignments) {
    if (assignment.progress.some(({ represented }, index) => (represented & buckets[index]!.required) !== buckets[index]!.required)) continue;
    const comparison = best ? compareAssignments(assignment, best) : 1;
    if (comparison > 0) {
      best = assignment;
      optimal.clear();
    }
    if (comparison >= 0) optimal.add(assignment);
  }
  if (!best) {
    // Contradictory recordings cannot all be represented. Retain the distinct
    // possible contents at visible slots so qualification fails closed.
    for (const bucket of buckets) {
      for (const row of new Set(bucket.occurrences)) for (const slot of row.slots) emit(row, slot);
    }
    return;
  }

  emitOptimalLegacyPaths(buckets, optimal, emit);
}

/** Resolve heads for a single observation ID against its course-scoped recording slots. */
export function visibleObservationRevisions(
  observations: readonly SnapshotObservation[], features: readonly FeatureRevision[], cutoff: number,
): ObservationRevision[] {
  const explicit: ObservationRevision[] = [];
  const claimedSlots = new Set<number>();
  const legacy: (ObservationProjection & { matchingSlots: number[] })[] = [];
  for (const observation of observations) {
    const attempted = adaptiveShadowTime(observation.attemptedAt);
    const matchingSlots = features.flatMap((row, slot) =>
      row.attempted === attempted && matchesUntimestampedObservation(observation, row.feature) ? [slot] : []);
    if (observation.recordedAt === undefined) {
      if (matchingSlots.length) legacy.push({ observation, attempted, matchingSlots });
      continue;
    }

    const recorded = adaptiveShadowTime(observation.recordedAt);
    if (!(attempted <= recorded)) continue;
    explicit.push({ observation, attempted, recorded });
    for (const slot of matchingSlots) if (features[slot]!.recorded === recorded) claimedSlots.add(slot);
  }

  const visible = explicit.filter(row => row.recorded < cutoff);
  const visibleSlots = new Set(features.flatMap((row, slot) => row.recorded < cutoff ? [slot] : []));
  const emitted = new Map<LegacyProjection, Set<number>>();
  function emit(row: LegacyProjection, slot: number) {
    if (!visibleSlots.has(slot)) return;
    const slots = emitted.get(row) ?? new Set<number>();
    if (slots.has(slot)) return;
    slots.add(slot);
    emitted.set(row, slots);
    visible.push({ observation: row.observation, attempted: row.attempted, recorded: features[slot]!.recorded, legacyCopies: row.copies });
  }

  const unclaimed = legacy.map(row => ({ ...row, unclaimedSlots: row.matchingSlots.filter(slot => !claimedSlots.has(slot)) }));
  const buckets: LegacyBucket[] = [];
  // A matching feature already claimed by an explicit revision cannot change
  // which legacy projections share producer ordering for the remaining slots.
  for (const rows of groupByKey(unclaimed, row => row.unclaimedSlots.join(",")).values()) {
    const bucket: LegacyBucket = { occurrences: [], slots: new Set(), required: 0n };
    const distinct: LegacyProjection[] = [];
    for (const row of rows) {
      const identical = distinct.find(projection => sameObservationProjection(row.observation, projection.observation));
      if (identical) {
        identical.copies++;
        if (identical.slots.size) bucket.occurrences.push(identical);
        continue;
      }
      const matchingTimes = new Set(row.matchingSlots.map(slot => features[slot]!.recorded));
      const anchor = explicit.reduce((earliest, head) => matchingTimes.has(head.recorded) && sameObservationProjection(row.observation, head.observation)
        ? Math.min(earliest, head.recorded) : earliest, Infinity);
      const slots = new Set(row.unclaimedSlots.filter(slot => features[slot]!.recorded < anchor));
      const required = anchor === Infinity;
      const projection = { observation: row.observation, attempted: row.attempted, required, slots, bit: 1n << BigInt(distinct.length), copies: 1 };
      distinct.push(projection);
      if (!slots.size) {
        // A different legacy head on an explicitly claimed slot remains conflicting.
        if (required) for (const slot of row.matchingSlots) emit(projection, slot);
        continue;
      }
      if (required) bucket.required |= projection.bit;
      for (const slot of slots) bucket.slots.add(slot);
      // Each occurrence adds capacity for the same content while retaining producer order.
      bucket.occurrences.push(projection);
    }
    if (bucket.occurrences.length) buckets.push(bucket);
  }

  for (const component of legacyComponents(buckets)) resolveLegacyComponent(component.buckets, component.slots, visibleSlots, emit);
  return visible;
}

function featureSlotKey(feature: LearnerStateFeature): string {
  const { eligibility } = feature;
  return JSON.stringify([feature.observationId, feature.attemptId, feature.itemVersionId, feature.requirementKey,
    feature.skillLabel, feature.availability, feature.outcome, eligibility.verifiedCorrect, eligibility.independentAttempt,
    eligibility.usableForCurrentVersion, [...eligibility.reasonCodes].sort(), [...feature.views].sort(), [...feature.gaps].sort()]);
}

export function courseFeatureRevisions(features: readonly LearnerStateFeature[], courseId: string): FeatureRevision[] {
  return features.flatMap(feature => {
    if (feature.courseId !== courseId) return [];
    const attempted = adaptiveShadowTime(feature.attemptedAt), recorded = adaptiveShadowTime(feature.recordedAt);
    return attempted <= recorded ? [{ feature, attempted, recorded }] : [];
  }).sort((left, right) => {
    const chronology = left.recorded - right.recorded || left.attempted - right.attempted;
    if (chronology) return chronology;
    const leftKey = featureSlotKey(left.feature), rightKey = featureSlotKey(right.feature);
    return leftKey < rightKey ? -1 : Number(leftKey > rightKey);
  });
}

function prepareHeads(input: SkillBeliefTrajectoryInput, cutoff: number) {
  const courseFeatures = courseFeatureRevisions(input.features, input.scope.courseId);
  const featuresById = groupByKey(courseFeatures, row => row.feature.observationId);
  const observationsById = groupByKey(input.observations, row => row.id);
  const disputedAttemptIds = new Set<string>();
  const claimsByAttemptId = new Map<string, Map<string, number>>();
  const heads = [...featuresById.entries()].flatMap(([observationId, allRows]): JoinedHead[] => {
    const rows = allRows.filter(row => row.recorded < cutoff);
    if (!rows.length) return [];
    const { feature, attempted, recorded } = rows[0]!;
    const { requirementKey, attemptId } = feature;
    const candidates = visibleObservationRevisions(observationsById.get(observationId) ?? [], allRows, cutoff);
    const sameSubmission = rows.every(row => row.feature.attemptId === attemptId && row.attempted === attempted)
      && candidates.every(row => row.attempted === attempted);
    const claimedRequirementKeys = new Set([
      ...rows.map(row => row.feature.requirementKey), ...candidates.map(row => row.observation.requirementKey),
    ].filter(key => key != null));
    if (!sameSubmission) {
      // Retain membership even when the collision loses its problem, family, or attempt identity.
      for (const row of rows) {
        if (row.feature.attemptId !== null) disputedAttemptIds.add(row.feature.attemptId);
      }
    } else if (attemptId !== null) {
      // Count each observation's claims even when it cannot establish problem or family exposure.
      const counts = claimsByAttemptId.get(attemptId) ?? new Map<string, number>();
      for (const key of claimedRequirementKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
      claimsByAttemptId.set(attemptId, counts);
    }
    if (!candidates.length) return [];
    const { observation } = candidates[0]!;
    if (rows.length === 1 && requirementKey && sameSubmission && candidates.every(({ observation: head, recorded: at }) =>
      at === recorded && sameObservationProjection(head, observation) && (head.requirementKey ?? null) === requirementKey)) {
      return [{ feature, attempted, observation, claimedRequirementKeys }];
    }

    // A collision can establish prior exposure only for identities shared by every candidate.
    const unanimousRequirementKey = rows.every(row => (row.feature.requirementKey ?? null) === requirementKey)
      && candidates.every(({ observation: head }) => (head.requirementKey ?? null) === requirementKey) ? requirementKey : null;
    const problemId = candidates.every(({ observation: head }) => head.problemId === observation.problemId) ? observation.problemId : null;
    const familyKey = candidates.every(({ observation: head }) => head.familyKey === observation.familyKey) ? observation.familyKey : undefined;
    if (problemId === null && !familyKey?.trim()) return [];
    const latestFeatureAttempted = rows.reduce((latest, row) => Math.max(latest, row.attempted), attempted);
    const maxAttempted = candidates.reduce((latest, row) => Math.max(latest, row.attempted), latestFeatureAttempted);
    return [{
      exposureOnly: true, attempted: maxAttempted, claimedRequirementKeys,
      feature: { observationId, requirementKey: unanimousRequirementKey, attemptId: sameSubmission ? attemptId : null },
      observation: { id: observationId, problemId, familyKey },
    }];
  }).sort((a, b) => a.attempted - b.attempted || a.feature.observationId.localeCompare(b.feature.observationId));
  return { heads, disputedAttemptIds, claimsByAttemptId };
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

function firstEpistemicSubmissions({ heads, disputedAttemptIds, claimsByAttemptId }: ReturnType<typeof prepareHeads>) {
  const earliestByProblem = new Map<string, JoinedHead[]>();
  for (const row of heads) {
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
    const attemptClaims = attemptId === null ? undefined : claimsByAttemptId.get(attemptId);
    if (earliest.length === 1) {
      const { requirementKey } = initial.feature;
      if (attemptId === null || (requirementKey !== null && attemptClaims?.get(requirementKey) === 1)) first.add(initial);
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
      if (requirementKey !== null && attemptClaims?.get(requirementKey) === 1 && claimCounts.get(requirementKey) === 1) first.add(head);
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
  const prepared = prepareHeads(input, cutoff);
  const { heads: known } = prepared;
  const first = firstEpistemicSubmissions(prepared), excludedIds = new Set(input.excludedProblemIds);
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
  const prepared = prepareHeads(input, cutoff);
  const first = firstEpistemicSubmissions(prepared);
  const rows = prepared.heads.flatMap((row): ShadowV2Row[] => {
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
