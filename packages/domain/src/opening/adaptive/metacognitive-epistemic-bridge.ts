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
type LegacyProjection = ObservationProjection & { required: boolean; bit: bigint; copies: number; matchingTimes: ReadonlySet<number> };
type LegacyOccurrence = { projection: LegacyProjection; producerIndex: number };
type LegacyBucket = { occurrences: LegacyOccurrence[]; slots: Set<number>; required: bigint };
type LegacyProgress = { next: number; represented: bigint; skipped: bigint };
type LegacyRun = { slots: number[]; compatible: readonly boolean[] };
type LegacyAssignment = {
  progress: readonly LegacyProgress[];
  coverage: number;
  distinct: number;
  skipRun: boolean;
  edges: { previous: LegacyAssignment; projection?: LegacyProjection }[];
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

function compatibleSlotRuns(
  buckets: readonly LegacyBucket[], slots: readonly number[], visibleSlots: ReadonlySet<number>,
): LegacyRun[] {
  const runs: LegacyRun[] = [];
  const future = new Map<string, LegacyRun>();
  for (const slot of slots) {
    const compatible = buckets.map(bucket => bucket.slots.has(slot));
    const run = { slots: [slot], compatible };
    if (visibleSlots.has(slot)) {
      const previous = runs.at(-1);
      if (previous && compatible.every((accepts, index) => accepts === previous.compatible[index])) previous.slots.push(slot);
      else runs.push(run);
    } else {
      // Future slots only constrain the number of copies each bucket can place.
      const signature = compatible.join(",");
      const previous = future.get(signature);
      if (previous) previous.slots.push(slot);
      else future.set(signature, run);
    }
  }
  return [...runs, ...future.values()];
}

function compareAssignments(left: LegacyAssignment, right: LegacyAssignment) {
  // Prefer explaining another distinct projection over reusing an identical copy.
  return left.coverage - right.coverage || left.distinct - right.distinct;
}

function precedes(left: readonly LegacyOccurrence[], right: readonly LegacyOccurrence[]): boolean {
  const first = left.findIndex((placement, index) => placement.producerIndex !== right[index]!.producerIndex);
  return first >= 0 && left[first]!.producerIndex < right[first]!.producerIndex;
}

type EmitLegacyRevision = (
  row: LegacyProjection, slot: number, visibleCopies: number, canBeLatest: boolean, conflictFallback?: boolean,
) => void;

type BucketCopyCounts = {
  used: readonly number[];
  key: string | number;
  earliestPrefix: number;
  before: BucketCopyCounts[];
};

type BucketSlotState = {
  counts: BucketCopyCounts;
  reach: bigint;
  earliestLatest: number;
  maxVisible: number[];
  prefix?: number[];
  firstEdge: number;
  lastEdge: number;
};

function emitBucketLegacyPath(
  buckets: readonly LegacyBucket[], allocations: readonly (readonly LegacyOccurrence[])[],
  slots: readonly number[], recordings: readonly number[], visibleSlots: ReadonlySet<number>, emit: EmitLegacyRevision,
): number {
  const projections: LegacyProjection[] = [];
  const projectionIds = new Map<LegacyProjection, number>();
  const allocatedCopies: number[] = [];
  for (const allocation of allocations) {
    for (const { projection } of allocation) {
      let index = projectionIds.get(projection);
      if (index === undefined) {
        index = projections.length;
        projectionIds.set(projection, index);
        projections.push(projection);
        allocatedCopies.push(0);
      }
      allocatedCopies[index] = allocatedCopies[index]! + 1;
    }
  }
  const zeros = projections.map(() => 0);
  const rowShifts = buckets.map((_, index) => BigInt(index * buckets.length));
  const rowMask = (1n << BigInt(buckets.length)) - 1n;
  const edgeBits = rowShifts.map(shift => buckets.map((_, to) => 1n << (shift + BigInt(to))));
  const diagonal = buckets.reduce((bits, _, index) => bits | edgeBits[index]![index]!, 0n);
  // Pack mixed-radix copy counts and reach bits only when the integer stays exact.
  const reachWidth = 2 ** (buckets.length ** 2);
  const countStrides: number[] = [];
  let keySpace = reachWidth;
  for (let bucket = buckets.length - 1; bucket >= 0; bucket--) {
    countStrides[bucket] = keySpace;
    keySpace *= allocations[bucket]!.length + 1;
  }
  const packedKey = Number.isSafeInteger(keySpace);
  const key = (counts: string | number, reach: bigint) =>
    typeof counts === "number" ? counts + Number(reach) : `${counts}:${reach.toString(36)}`;
  let lastVisible = -1;
  let visibleCount = 0;
  for (const [position, slot] of slots.entries()) {
    if (!visibleSlots.has(slot)) continue;
    lastVisible = position;
    visibleCount++;
  }
  // Only mixed visibility with multiple visible slots needs per-projection path counts.
  const countVisibleCopies = visibleCount > 1 && visibleCount < slots.length;
  const totalCopies = allocations.map(rows => rows.length);
  type ReachExtension = { reach: bigint; predecessors: number[] };
  const slotTypes = new Map<string, { compatible: number[]; bucketSet: Set<number>; extensions: Map<bigint, ReachExtension[]> }>();
  const slotTypesByPosition = slots.map(slot => {
    const compatible = buckets.flatMap((bucket, index) => bucket.slots.has(slot) ? [index] : []);
    const signature = compatible.join(",");
    const existing = slotTypes.get(signature);
    if (existing) return existing;
    const type = { compatible, bucketSet: new Set(compatible), extensions: new Map<bigint, ReachExtension[]>() };
    slotTypes.set(signature, type);
    return type;
  });
  // Hall's condition for repeated copies uses the slot union of every bucket subset.
  // Large components use necessary total and individual capacities without enumerating subsets.
  const capacitySubsets = buckets.length <= 10
    ? Array.from({ length: (1 << buckets.length) - 1 }, (_, index) => buckets.flatMap((_, bucket) =>
      ((index + 1) & (1 << bucket)) !== 0 ? [bucket] : []))
    : [...buckets.map((_, bucket) => [bucket]), buckets.map((_, bucket) => bucket)];
  const prefixCapacities = [capacitySubsets.map(() => 0)];
  for (const { bucketSet } of slotTypesByPosition) {
    const previous = prefixCapacities.at(-1)!;
    prefixCapacities.push(capacitySubsets.map((subset, index) =>
      previous[index]! + Number(subset.some(bucket => bucketSet.has(bucket)))));
  }
  function fitsPrefix(used: readonly number[], capacities: readonly number[]) {
    for (let index = 0; index < capacitySubsets.length; index++) {
      let copies = 0;
      for (const bucket of capacitySubsets[index]!) copies += used[bucket]!;
      if (copies > capacities[index]!) return false;
    }
    return true;
  }

  if (!fitsPrefix(totalCopies, prefixCapacities[slots.length]!)) return Infinity;
  const countsByKey = new Map<string | number, BucketCopyCounts>();
  function saveCounts(used: readonly number[], key: string | number, upper: number): BucketCopyCounts {
    // Capacities can only increase as the prefix grows. All suffixes with
    // these counts can reuse the first prefix that passes the same pruning.
    let lower = used.reduce((sum, copies) => sum + copies, 0);
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (fitsPrefix(used, prefixCapacities[middle]!)) upper = middle;
      else lower = middle + 1;
    }
    const counts: BucketCopyCounts = { used, key, earliestPrefix: lower, before: [] };
    countsByKey.set(key, counts);
    return counts;
  }
  function removeCopy(counts: BucketCopyCounts, bucket: number): BucketCopyCounts {
    const known = counts.before[bucket];
    if (known) return known;
    const used = counts.used.slice();
    used[bucket] = used[bucket]! - 1;
    const key = typeof counts.key === "number" ? counts.key - countStrides[bucket]! : used.join(",");
    const before = countsByKey.get(key) ?? saveCounts(used, key, counts.earliestPrefix);
    counts.before[bucket] = before;
    return before;
  }
  const terminal: BucketSlotState = {
    counts: saveCounts(totalCopies, packedKey ? keySpace - reachWidth : totalCopies.join(","), slots.length),
    reach: diagonal, earliestLatest: -Infinity, maxVisible: zeros, firstEdge: -1, lastEdge: -1,
  };
  let suffixes = new Map([[key(terminal.counts.key, terminal.reach), terminal]]);
  // Share flat edge storage across a slot layer. Each state links its edges in insertion order.
  const edgesByPosition: { targets: BucketSlotState[]; projectionIndices: number[]; links: number[] }[] = [];

  for (let position = slots.length - 1; position >= 0; position--) {
    const slot = slots[position]!;
    const layer = new Map<string | number, BucketSlotState>();
    const { compatible: slotBuckets, bucketSet, extensions } = slotTypesByPosition[position]!;
    const visible = visibleSlots.has(slot);
    const hasVisibleSuffix = position <= lastVisible;
    const recording = recordings[slot]!;
    const targets: BucketSlotState[] = [];
    const projectionIndices: number[] = [];
    const links: number[] = [];
    if (hasVisibleSuffix) edgesByPosition[position] = { targets, projectionIndices, links };
    function add(next: BucketSlotState, counts: BucketCopyCounts, nextReach: bigint, index = -1) {
      const id = key(counts.key, nextReach);
      let state = layer.get(id);
      if (!state) {
        state = {
          counts, reach: nextReach,
          earliestLatest: hasVisibleSuffix ? Infinity : -Infinity,
          maxVisible: hasVisibleSuffix && countVisibleCopies ? [...zeros] : zeros,
          firstEdge: -1, lastEdge: -1,
        };
        layer.set(id, state);
      }
      // Trailing invisible slots constrain placement and reachability only.
      if (!hasVisibleSuffix) return;
      const latest = Math.max(next.earliestLatest, index < 0 ? -Infinity : recording);
      state.earliestLatest = Math.min(state.earliestLatest, latest);
      if (countVisibleCopies) {
        for (let i = 0; i < projections.length; i++) {
          state.maxVisible[i] = Math.max(state.maxVisible[i]!, next.maxVisible[i]! + Number(i === index));
        }
      }
      const edge = targets.length;
      if (state.lastEdge === -1) state.firstEdge = edge;
      else links[state.lastEdge] = edge;
      state.lastEdge = edge;
      targets.push(next);
      projectionIndices.push(index);
      links.push(-1);
    }

    for (const next of suffixes.values()) {
      const { counts, reach } = next;
      const { used } = counts;
      if (counts.earliestPrefix <= position) add(next, counts, reach);
      let extended = extensions.get(reach);
      for (const bucket of slotBuckets) {
        const occurrence = allocations[bucket]![used[bucket]! - 1];
        if (!occurrence) continue;
        const before = removeCopy(counts, bucket);
        if (before.earliestPrefix > position) continue;
        const projectionIndex = visible ? projectionIds.get(occurrence.projection)! : -1;
        if (slotBuckets.length === 1) {
          // A slot exclusive to one bucket adds no alternating path.
          add(next, before, reach, projectionIndex);
          continue;
        }
        if (!extended) {
          // Adding edges out of a bucket connects every predecessor to the
          // successors of all buckets compatible with this slot.
          let outRow = 0n;
          for (const other of slotBuckets) outRow |= (reach >> rowShifts[other]!) & rowMask;
          extended = [];
          for (const to of slotBuckets) {
            const predecessors: number[] = [];
            let nextReach = reach;
            for (const [from, shift] of rowShifts.entries()) {
              if ((reach & edgeBits[from]![to]!) === 0n) continue;
              nextReach |= outRow << shift;
              if (from !== to && bucketSet.has(from)) predecessors.push(from);
            }
            extended[to] = { reach: nextReach, predecessors };
          }
          extensions.set(reach, extended);
        }
        // An earlier producer can take this slot if its bucket can transfer a
        // suffix slot along an alternating path to cover the displaced bucket.
        const extension = extended[bucket]!;
        let canPrecede = false;
        for (const other of extension.predecessors) {
          const alternative = allocations[other]![used[other]!];
          if (alternative && alternative.producerIndex < occurrence.producerIndex) {
            canPrecede = true;
            break;
          }
        }
        if (!canPrecede) add(next, before, extension.reach, projectionIndex);
      }
    }
    suffixes = layer;
  }

  // The empty prefix can satisfy only the zero-copy state.
  let prefixes = [...suffixes.values()];
  const earliestLatest = prefixes.reduce((time, root) => Math.min(time, root.earliestLatest), Infinity);
  for (const root of prefixes) root.prefix = zeros;
  for (let position = 0; position <= lastVisible && prefixes.length; position++) {
    const slot = slots[position]!;
    const recording = recordings[slot]!;
    const { targets, projectionIndices, links } = edgesByPosition[position]!;
    const layer: BucketSlotState[] = [];
    const maxAssigned = [...zeros];
    const canBeLatest = projections.map(() => false);
    for (const state of prefixes) {
      const prefix = state.prefix!;
      for (let edge = state.firstEdge; edge !== -1; edge = links[edge]!) {
        const next = targets[edge]!;
        const index = projectionIndices[edge]!;
        if (index >= 0) {
          const assigned = countVisibleCopies ? prefix[index]! + 1 + next.maxVisible[index]! : 1;
          maxAssigned[index] = Math.max(maxAssigned[index]!, assigned);
          canBeLatest[index] ||= next.earliestLatest <= recording;
        }
        if (!next.prefix) {
          next.prefix = countVisibleCopies ? [...zeros] : zeros;
          layer.push(next);
        }
        if (countVisibleCopies) {
          for (let i = 0; i < projections.length; i++) {
            next.prefix[i] = Math.max(next.prefix[i]!, prefix[i]! + Number(i === index));
          }
        }
      }
    }
    for (const [index, projection] of projections.entries()) {
      if (maxAssigned[index] === 0) continue;
      // Each compatible slot at or after the cutoff can absorb one copy
      // from the untimestamped current snapshot for BKT sample uniqueness.
      const invisibleCopies = visibleCount === slots.length ? 0 : allocatedCopies[index]! - maxAssigned[index]!;
      emit(projection, slot, projection.copies - invisibleCopies, canBeLatest[index]!);
    }
    prefixes = layer;
  }
  return earliestLatest;
}

function emitOptimalLegacyPaths(
  buckets: readonly LegacyBucket[], optimal: ReadonlySet<LegacyAssignment>, slots: readonly number[],
  recordings: readonly number[], visibleSlots: ReadonlySet<number>, emit: EmitLegacyRevision,
): number {
  const projections = [...new Set(buckets.flatMap(bucket => bucket.occurrences.map(row => row.projection)))];
  const projectionIds = new Map(projections.map((projection, index) => [projection, index]));
  const empty = projections.map(() => 0);
  const pending = new Map([...optimal].map(assignment => [assignment, new Map([[empty.join(","), empty]])]));
  const complete = new Map<string, number[]>();
  // At a shared state, every suffix with the same copy counts can use any common prefix.
  for (const [assignment, profiles] of pending) {
    if (!assignment.edges.length) {
      for (const [key, copies] of profiles) complete.set(key, copies);
    }
    for (const { previous, projection } of assignment.edges) {
      const next = pending.get(previous) ?? new Map<string, number[]>();
      for (const [key, copies] of profiles) {
        if (projection === undefined) {
          next.set(key, copies);
          continue;
        }
        const projectionId = projectionIds.get(projection)!;
        const extended = [...copies];
        extended[projectionId] = extended[projectionId]! + 1;
        next.set(extended.join(","), extended);
      }
      pending.set(previous, next);
    }
    pending.delete(assignment);
  }

  // Prefer earlier occurrences only when the distinct count and the
  // identities of projections using extra copies agree.
  const preferredByBucket = buckets.map(() => new Map<string, LegacyOccurrence[]>());
  const profiles = [...complete.values()].map(copies => {
    const remaining = [...copies];
    return buckets.map((bucket, index) => {
      // The first copies of each projection preserve the selected bucket's producer order.
      const rows = bucket.occurrences.filter(({ projection }) => {
        const id = projectionIds.get(projection)!;
        if (remaining[id] === 0) return false;
        remaining[id] = remaining[id]! - 1;
        return true;
      });
      const counts = groupByKey(rows, row => row.projection);
      const extraCopies = [...counts].flatMap(([projection, copies]) =>
        copies.length > 1 ? [`${projection.bit}=${copies.length - 1}`] : []).sort().join(",");
      const key = `${rows.length}:${counts.size}:${extraCopies}`;
      const preferred = preferredByBucket[index]!;
      const previous = preferred.get(key);
      if (!previous || precedes(rows, previous)) preferred.set(key, rows);
      return { key, rows };
    });
  });

  let earliestLatest = Infinity;
  for (const profile of profiles) {
    if (profile.some(({ key, rows }, index) => precedes(preferredByBucket[index]!.get(key)!, rows))) continue;
    const earliest = emitBucketLegacyPath(buckets, profile.map(({ rows }) => rows), slots, recordings, visibleSlots, emit);
    earliestLatest = Math.min(earliestLatest, earliest);
  }
  return earliestLatest;
}

function resolveSingleLegacyProjection(
  row: LegacyProjection, slots: readonly number[], recordings: readonly number[],
  visibleSlots: ReadonlySet<number>, emit: EmitLegacyRevision,
): number {
  const count = Math.min(row.copies, slots.length);
  const visible = slots.filter(slot => visibleSlots.has(slot));
  const minVisible = Math.max(0, count - (slots.length - visible.length));
  const maxVisible = Math.min(count, visible.length);
  const earliestLatest = minVisible ? recordings[visible[minVisible - 1]!]! : -Infinity;
  const visibleCopies = row.copies - (count - maxVisible);
  for (const slot of visible) emit(row, slot, visibleCopies, recordings[slot]! >= earliestLatest);
  return earliestLatest;
}

function resolveLegacyComponent(
  buckets: readonly LegacyBucket[], slots: readonly number[], recordings: readonly number[],
  visibleSlots: ReadonlySet<number>, emit: EmitLegacyRevision,
): number | null {
  const only = buckets[0]!.occurrences[0]!.projection;
  if (buckets.length === 1 && buckets[0]!.occurrences.every(row => row.projection === only)) {
    return resolveSingleLegacyProjection(only, slots, recordings, visibleSlots, emit);
  }

  const allCopies = buckets.map(bucket => bucket.occurrences);
  const copyCount = allCopies.reduce((sum, rows) => sum + rows.length, 0);
  if (copyCount <= slots.length) {
    // A feasible full allocation is the only profile that assigns every copy.
    const earliest = emitBucketLegacyPath(buckets, allCopies, slots, recordings, visibleSlots, emit);
    if (earliest !== Infinity) return earliest;
  }

  const first: LegacyAssignment = {
    progress: buckets.map(() => ({ next: 0, represented: 0n, skipped: 0n })),
    coverage: 0, distinct: 0, skipRun: false, edges: [],
  };
  const runs = compatibleSlotRuns(buckets, slots, visibleSlots);
  let assignments = [first];
  for (const { compatible, startsRun } of runs.flatMap(run => run.slots.map((_, index) => ({
    compatible: run.compatible, startsRun: index === 0,
  })))) {
    const next = new Map<string, LegacyAssignment>();
    function offer(candidate: LegacyAssignment) {
      const progress = candidate.progress.map(row => `${row.next}:${row.represented}:${row.skipped}`).join(",");
      const key = `${Number(candidate.skipRun)}:${progress}`;
      const previous = next.get(key);
      const comparison = previous ? compareAssignments(candidate, previous) : 1;
      if (comparison > 0) next.set(key, candidate);
      else if (comparison === 0) previous!.edges.push(...candidate.edges);
    }
    for (const assignment of assignments) {
      offer({ ...assignment, skipRun: true, edges: [{ previous: assignment }] });
      // Compatible slots in this run are interchangeable, so occupy a prefix.
      if (!startsRun && assignment.skipRun) continue;
      buckets.forEach(({ occurrences }, bucketIndex) => {
        if (!compatible[bucketIndex]) return;
        const { next: start, represented } = assignment.progress[bucketIndex]!;
        let { skipped } = assignment.progress[bucketIndex]!;
        const offered = new Set<LegacyProjection>();
        for (let index = start; index < occurrences.length; index++) {
          const occurrence = occurrences[index]!;
          const row = occurrence.projection;
          const missing = (represented & row.bit) === 0n;
          if ((skipped & row.bit) === 0n && !offered.has(row)) {
            offered.add(row);
            const progress = [...assignment.progress];
            progress[bucketIndex] = { next: index + 1, represented: represented | row.bit, skipped };
            offer({ progress, coverage: assignment.coverage + 1, distinct: assignment.distinct + Number(missing), skipRun: false,
              edges: [{ previous: assignment, projection: row }] });
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
      for (const projection of new Set(bucket.occurrences.map(row => row.projection))) {
        for (const slot of bucket.slots) emit(projection, slot, projection.copies, true, true);
      }
    }
    return null;
  }

  // Future-only components still need a feasibility check for rule-only evidence.
  return slots.some(slot => visibleSlots.has(slot))
    ? emitOptimalLegacyPaths(buckets, optimal, slots, recordings, visibleSlots, emit)
    : -Infinity;
}

function explicitObservationRecording(observation: SnapshotObservation, attempted = adaptiveShadowTime(observation.attemptedAt)): number {
  const recorded = adaptiveShadowTime(observation.recordedAt ?? null);
  return attempted <= recorded ? recorded : NaN;
}

/** Resolve heads for a single observation ID against its course-scoped recording slots. */
export function visibleObservationRevisions(
  observations: readonly SnapshotObservation[], features: readonly FeatureRevision[], cutoff: number,
): {
  revisions: ObservationRevision[];
  latest: ObservationRevision[];
  unplaced: SnapshotObservation[];
  canBeAbsent: boolean;
  revisionsCanBeAbsent: boolean;
} {
  const explicit: ObservationRevision[] = [];
  const claimedSlots = new Set<number>();
  let explicitSlotLatest = -Infinity;
  const legacy: (ObservationProjection & { matchingSlots: number[]; producerIndex: number })[] = [];
  for (const [producerIndex, observation] of observations.entries()) {
    const attempted = adaptiveShadowTime(observation.attemptedAt);
    const matchingSlots = features.flatMap((row, slot) =>
      row.attempted === attempted && matchesUntimestampedObservation(observation, row.feature) ? [slot] : []);
    if (observation.recordedAt == null) {
      if (Number.isFinite(attempted)) legacy.push({ observation, attempted, matchingSlots, producerIndex });
      continue;
    }

    const recorded = explicitObservationRecording(observation, attempted);
    if (!Number.isFinite(recorded)) continue;
    explicit.push({ observation, attempted, recorded });
    let matchedSlot = false;
    for (const slot of matchingSlots) {
      if (features[slot]!.recorded === recorded) {
        claimedSlots.add(slot);
        matchedSlot = true;
      }
    }
    if (matchedSlot && recorded < cutoff) explicitSlotLatest = Math.max(explicitSlotLatest, recorded);
  }

  // The historical window ends strictly before the cutoff for both rows and slots.
  const revisions = explicit.filter(row => row.recorded < cutoff);
  const recordings = features.map(feature => feature.recorded);
  const visibleSlots = new Set(recordings.flatMap((recorded, slot) => recorded < cutoff ? [slot] : []));
  const possibleLatest = [...revisions];
  let earliestLatest = revisions.reduce((time, row) => Math.max(time, row.recorded), -Infinity);
  let earliestSlotLatest = explicitSlotLatest;
  let hasVisibleConflictFallback = false;
  const emitted = new Map<LegacyProjection, Map<number, { copies: number; canBeLatest: boolean }>>();
  function emit(row: LegacyProjection, slot: number, visibleCopies: number, canBeLatest: boolean, conflictFallback = false) {
    if (!visibleSlots.has(slot)) return;
    if (conflictFallback) hasVisibleConflictFallback = true;
    const slots = emitted.get(row) ?? new Map();
    const existing = slots.get(slot);
    slots.set(slot, { copies: Math.max(existing?.copies ?? 0, visibleCopies), canBeLatest: canBeLatest || existing?.canBeLatest === true });
    emitted.set(row, slots);
  }

  const eligible = legacy.map(row => {
    const matchingTimes = new Set(row.matchingSlots.map(slot => features[slot]!.recorded));
    const required = !explicit.some(head => matchingTimes.has(head.recorded) && sameObservationProjection(row.observation, head.observation));
    const slots = row.matchingSlots.filter(slot => !claimedSlots.has(slot));
    return { ...row, slots, required, matchingTimes };
  });
  const buckets: LegacyBucket[] = [];
  const unresolved = new Set<LegacyProjection>();
  // Producer order applies to projections competing for the same eligible slots.
  for (const rows of groupByKey(eligible, row => row.slots.join(",")).values()) {
    const bucket: LegacyBucket = { occurrences: [], slots: new Set(rows[0]!.slots), required: 0n };
    const distinct: LegacyProjection[] = [];
    for (const { observation, attempted, required, matchingSlots, matchingTimes, producerIndex } of rows) {
      const identical = distinct.find(projection => sameObservationProjection(observation, projection.observation));
      const projection = identical ?? { observation, attempted, required, bit: 1n << BigInt(distinct.length), copies: 0, matchingTimes };
      if (!identical) distinct.push(projection);
      projection.copies++;
      if (!bucket.slots.size) {
        // A different legacy head on an explicitly claimed slot remains conflicting.
        unresolved.add(projection);
        if (required) {
          for (const slot of matchingSlots) emit(projection, slot, projection.copies, true, true);
        }
        continue;
      }
      if (required) bucket.required |= projection.bit;
      // Each occurrence adds capacity for the same content while retaining producer order.
      bucket.occurrences.push({ projection, producerIndex });
    }
    if (bucket.occurrences.length) buckets.push(bucket);
  }

  for (const component of legacyComponents(buckets)) {
    const earliest = resolveLegacyComponent(component.buckets, component.slots, recordings, visibleSlots, emit);
    if (earliest === null) {
      for (const bucket of component.buckets) {
        for (const { projection } of bucket.occurrences) unresolved.add(projection);
      }
    } else {
      earliestLatest = Math.max(earliestLatest, earliest);
      earliestSlotLatest = Math.max(earliestSlotLatest, earliest);
    }
  }
  // Components share no slots. A possible latest revision also has to be at
  // least as new as the earliest latest recording of every other component.
  for (const [{ observation, attempted }, slots] of emitted) {
    for (const [slot, { copies, canBeLatest }] of slots) {
      const revision = { observation, attempted, recorded: recordings[slot]!, legacyCopies: copies };
      revisions.push(revision);
      if (canBeLatest) possibleLatest.push(revision);
    }
  }
  // A legacy projection without a feasible slot can inform the ordinary rule,
  // provided it is old enough, has no visible slot conflict, and is no explicit echo.
  const unplaced = [...unresolved].filter(row => row.attempted < cutoff && !emitted.has(row)
    && !explicit.some(head => (head.recorded < cutoff || row.matchingTimes.has(head.recorded))
      && sameObservationProjection(head.observation, row.observation))).map(row => row.observation);
  // A visible fallback conflict still indicates rule-level presence, while direct replay
  // requires a feasible slot-matched placement before the cutoff without conflict fallback.
  const revisionsCanBeAbsent = earliestSlotLatest === -Infinity || hasVisibleConflictFallback;
  const canBeAbsent = earliestLatest === -Infinity && !unplaced.length && !hasVisibleConflictFallback;
  return { revisions, latest: possibleLatest.filter(row => row.recorded >= earliestLatest), unplaced, canBeAbsent, revisionsCanBeAbsent };
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
  const sameCourseObservationIds = new Set(input.features
    .filter(row => row.courseId === input.scope.courseId)
    .map(row => row.observationId));
  const foreignObservationIds = new Set(input.features
    .filter(row => row.courseId !== input.scope.courseId && !sameCourseObservationIds.has(row.observationId))
    .map(row => row.observationId));
  const observationsById = groupByKey(input.observations, row => row.id);
  const disputedAttemptIds = new Set<string>();
  const claimsByAttemptId = new Map<string, Map<string, number>>();
  const observationIds = new Set([...featuresById.keys(), ...observationsById.keys()]);
  const heads = [...observationIds].flatMap((observationId): JoinedHead[] => {
    if (foreignObservationIds.has(observationId)) return [];
    const allRows = featuresById.get(observationId) ?? [];
    const rows = allRows.filter(row => row.recorded < cutoff);
    const { revisions: candidates, unplaced, revisionsCanBeAbsent } = visibleObservationRevisions(
      observationsById.get(observationId) ?? [], allRows, cutoff);
    const exposureCandidates = candidates.length ? candidates : unplaced.flatMap(observation => {
      const attempted = adaptiveShadowTime(observation.attemptedAt);
      return Number.isFinite(attempted) ? [{ observation, attempted }] : [];
    });
    if (!rows.length) {
      if (!exposureCandidates.length) return [];
      const { observation } = exposureCandidates[0]!;
      const claimedRequirementKeys = new Set(exposureCandidates
        .map(row => row.observation.requirementKey)
        .filter(key => key != null));
      const requirementKey = observation.requirementKey ?? null;
      const unanimousRequirementKey = exposureCandidates.every(({ observation: head }) =>
        (head.requirementKey ?? null) === requirementKey) ? requirementKey : null;
      const problemId = exposureCandidates.every(({ observation: head }) => head.problemId === observation.problemId)
        ? observation.problemId : null;
      const familyKey = exposureCandidates.every(({ observation: head }) => head.familyKey === observation.familyKey)
        ? observation.familyKey : undefined;
      if (problemId === null && !familyKey?.trim()) return [];
      const maxAttempted = exposureCandidates.reduce((latest, row) => Math.max(latest, row.attempted), -Infinity);
      return [{
        exposureOnly: true, attempted: maxAttempted, claimedRequirementKeys,
        feature: { observationId, requirementKey: unanimousRequirementKey, attemptId: null },
        observation: { id: observationId, problemId, familyKey },
      }];
    }
    const { feature, attempted, recorded } = rows[0]!;
    const { requirementKey, attemptId } = feature;
    const sameSubmission = rows.every(row => row.feature.attemptId === attemptId && row.attempted === attempted)
      && exposureCandidates.every(row => row.attempted === attempted);
    const claimedRequirementKeys = new Set([
      ...rows.map(row => row.feature.requirementKey), ...exposureCandidates.map(row => row.observation.requirementKey),
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
    if (!exposureCandidates.length) return [];
    const { observation } = exposureCandidates[0]!;
    if (candidates.length && !revisionsCanBeAbsent && rows.length === 1 && requirementKey && sameSubmission
      && candidates.every(({ observation: head, recorded: at }) =>
        at === recorded && sameObservationProjection(head, observation) && matchesUntimestampedObservation(head, feature))) {
      return [{ feature, attempted, observation, claimedRequirementKeys }];
    }

    // A collision can establish prior exposure only for identities shared by every candidate.
    const unanimousRequirementKey = rows.every(row => (row.feature.requirementKey ?? null) === requirementKey)
      && exposureCandidates.every(({ observation: head }) => (head.requirementKey ?? null) === requirementKey) ? requirementKey : null;
    const problemId = exposureCandidates.every(({ observation: head }) => head.problemId === observation.problemId)
      ? observation.problemId : null;
    const familyKey = exposureCandidates.every(({ observation: head }) => head.familyKey === observation.familyKey)
      ? observation.familyKey : undefined;
    if (problemId === null && !familyKey?.trim()) return [];
    const latestFeatureAttempted = rows.reduce((latest, row) => Math.max(latest, row.attempted), attempted);
    const maxAttempted = exposureCandidates.reduce((latest, row) => Math.max(latest, row.attempted), latestFeatureAttempted);
    return [{
      exposureOnly: true, attempted: maxAttempted, claimedRequirementKeys,
      feature: { observationId, requirementKey: unanimousRequirementKey, attemptId: candidates.length && sameSubmission ? attemptId : null },
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
