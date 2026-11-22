import {
  BASE_PRIOR_ALPHA,
  BASE_PRIOR_BETA,
  MAX_BRIDGE_PRIOR_MEAN,
  MAX_BRIDGE_PSEUDO_OBSERVATIONS,
  MAX_BRIDGE_WEIGHT,
  MIN_BRIDGE_PRIOR_MEAN,
  MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE,
  canonicalizeIdentifier,
  isSafeIdentifier,
  type AcceptedConceptBridgeEdge,
  type ComputeCrossCourseWeakPriorInput,
  type CrossCourseConceptEdge,
  type CrossCourseDecoupleReason,
  type CrossCourseWeakPriorResult,
  type DecoupledConceptBridgeEdge,
  type IgnoredNonDirectBridgeEdge,
} from "./types";

interface AdmissibleBridgeEdge {
  readonly edge: CrossCourseConceptEdge;
  readonly edgeId: string;
  readonly canonicalSourceCourseId: string;
  readonly canonicalSourceConceptId: string;
  readonly directOnlyMastery: number;
  readonly evidenceSource: AcceptedConceptBridgeEdge["directEvidenceSource"];
}

const DIRECT_MASTERY_TOLERANCE = 1e-12;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

function compareBridgeCandidates(a: AdmissibleBridgeEdge, b: AdmissibleBridgeEdge): number {
  const weightOrder = b.edge.alignmentWeight - a.edge.alignmentWeight;
  const observationOrder = b.edge.sourceDirectObservationCount - a.edge.sourceDirectObservationCount;
  const evidenceOrder = Number(b.evidenceSource === "direct_counts") - Number(a.evidenceSource === "direct_counts");
  const idOrder = compareCodeUnits(a.edgeId, b.edgeId);
  // Equal IDs can carry distinct probabilities within the tolerance.
  return weightOrder || observationOrder || evidenceOrder || idOrder || a.directOnlyMastery - b.directOnlyMastery;
}

function compareConflictingBridgeCandidates(a: AdmissibleBridgeEdge, b: AdmissibleBridgeEdge): number {
  // Equal canonical IDs can have different spellings in the emitted diagnostics.
  return compareCodeUnits(a.edgeId, b.edgeId) ||
    a.directOnlyMastery - b.directOnlyMastery ||
    a.edge.alignmentWeight - b.edge.alignmentWeight ||
    a.edge.sourceDirectObservationCount - b.edge.sourceDirectObservationCount ||
    compareCodeUnits(a.edge.sourceCourseId, b.edge.sourceCourseId) ||
    compareCodeUnits(a.edge.sourceConceptId, b.edge.sourceConceptId) ||
    compareCodeUnits(a.edge.targetCourseId, b.edge.targetCourseId) ||
    compareCodeUnits(a.edge.targetConceptId, b.edge.targetConceptId);
}

function decoupledBridgeEdge(
  edge: CrossCourseConceptEdge,
  edgeId: string,
  reasons: readonly CrossCourseDecoupleReason[],
): DecoupledConceptBridgeEdge {
  const reason = reasons[0] ?? "bridged_prior_contamination";
  return {
    edgeId,
    sourceCourseId: edge.sourceCourseId,
    sourceConceptId: edge.sourceConceptId,
    targetCourseId: edge.targetCourseId,
    targetConceptId: edge.targetConceptId,
    reason,
    reasons: reasons.length > 0 ? reasons : [reason],
  };
}

function resolveEdgeId(edge: CrossCourseConceptEdge): string {
  return (
    edge.edgeId ??
    `${edge.sourceCourseId}:${edge.sourceConceptId}->${edge.targetCourseId}:${edge.targetConceptId}`
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveDirectOnlyMastery(
  edge: CrossCourseConceptEdge,
):
  | {
      readonly ok: true;
      readonly directOnlyMastery: number;
      readonly evidenceSource: "direct_counts" | "certified_direct_only_probability";
    }
  | {
      readonly ok: false;
      readonly reason:
        | "bridged_prior_contamination"
        | "insufficient_direct_evidence"
        | "invalid_edge_parameters";
    } {
  // Path 1: Raw direct in-course counts (`sourceDirectSuccessCount / sourceDirectObservationCount`).
  // Completely immune to any bridged prior that may have been mixed into `sourceMasteryProbability`.
  if (edge.sourceDirectSuccessCount !== undefined) {
    if (
      !Number.isSafeInteger(edge.sourceDirectSuccessCount) ||
      edge.sourceDirectSuccessCount < 0 ||
      !Number.isSafeInteger(edge.sourceDirectObservationCount) ||
      edge.sourceDirectObservationCount < MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE ||
      edge.sourceDirectSuccessCount > edge.sourceDirectObservationCount
    ) {
      return { ok: false, reason: "invalid_edge_parameters" };
    }
    return {
      ok: true,
      directOnlyMastery: edge.sourceDirectSuccessCount / edge.sourceDirectObservationCount,
      evidenceSource: "direct_counts",
    };
  }

  // Path 2: Certified direct-only probability (only when explicitly uncontaminated by bridged priors
  // AND backed by a safe integer `certifiedDirectObservationCount >= 3`).
  if (edge.includesBridgedPrior === true) {
    return { ok: false, reason: "bridged_prior_contamination" };
  }

  if (edge.sourceDirectOnlyMasteryProbability !== undefined) {
    if (
      edge.certifiedDirectObservationCount === undefined ||
      !Number.isSafeInteger(edge.certifiedDirectObservationCount) ||
      edge.certifiedDirectObservationCount < MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE ||
      edge.certifiedDirectObservationCount > edge.sourceDirectObservationCount
    ) {
      return { ok: false, reason: "insufficient_direct_evidence" };
    }
    if (
      !Number.isFinite(edge.sourceDirectOnlyMasteryProbability) ||
      edge.sourceDirectOnlyMasteryProbability < 0 ||
      edge.sourceDirectOnlyMasteryProbability > 1
    ) {
      return { ok: false, reason: "invalid_edge_parameters" };
    }
    return {
      ok: true,
      directOnlyMastery: edge.sourceDirectOnlyMasteryProbability,
      evidenceSource: "certified_direct_only_probability",
    };
  }

  // Path 3: Fail closed — never admit uncertified/mixed `sourceMasteryProbability`
  // which could relay an upstream course's bridged prior across 2 hops.
  return { ok: false, reason: "bridged_prior_contamination" };
}

/**
 * Computes a strictly 1-hop, read-time privacy-epoch checked, bounded weak Beta prior
 * `Beta(1 + deltaAlpha, 1 + deltaBeta)` with `deltaAlpha + deltaBeta <= 0.30`
 * (`posteriorMean` strictly in `[1 / 2.3, 1.3 / 2.3]`, shrunk within `[0.35, 0.65]`).
 *
 * Invariants:
 * 1. Zero multi-hop propagation: only direct edges targeting `(targetCourseId, targetConceptId)`
 *    from a different `sourceCourseId` with `>= 3` safe-integer direct in-course observations AND
 *    direct-only mastery (`sourceDirectSuccessCount / sourceDirectObservationCount` or
 *    uncontaminated `sourceDirectOnlyMasteryProbability` with `certifiedDirectObservationCount >= 3`)
 *    can contribute. Mixed posteriors incorporating imported bridged priors are rejected to prevent 2-hop relay.
 * 2. Instant lossless revocation: disabling source sharing, bumping source `privacy_epoch`,
 *    or revoking any supporting source ID immediately decouples the edge at read time,
 *    reverting to exact uniform `Beta(1, 1)` (`posteriorMean === 0.5`) when no edges remain,
 *    while leaving `targetInCourseState` untouched.
 */
export function computeCrossCourseWeakPrior<TTargetState = undefined>(
  input: ComputeCrossCourseWeakPriorInput<TTargetState>,
): CrossCourseWeakPriorResult<TTargetState> {
  const {
    targetCourseId,
    targetConceptId,
    edges,
    coursePrivacyEpochs,
    activeCourseSharingEnabled,
    revokedSourceIds,
    targetInCourseState,
  } = input;

  const targetIdsValid =
    isSafeIdentifier(targetCourseId) && isSafeIdentifier(targetConceptId);
  const canonicalTargetCourseId = targetIdsValid ? canonicalizeIdentifier(targetCourseId) : "";
  const canonicalTargetConceptId = targetIdsValid ? canonicalizeIdentifier(targetConceptId) : "";

  // Normalize UUID/identifier casing across revocation sets and course lookup tables
  // so mixed-case UUIDs can never bypass revocation, sharing, or privacy_epoch checks,
  // while ignoring reserved JS prototype-chain property keys.
  const canonicalRevokedSourceIds = new Set<string>();
  for (const revokedId of revokedSourceIds) {
    if (!isSafeIdentifier(revokedId)) continue;
    canonicalRevokedSourceIds.add(canonicalizeIdentifier(revokedId));
  }

  const canonicalSharingEnabled = new Map<string, boolean>();
  for (const [courseId, enabled] of Object.entries(activeCourseSharingEnabled)) {
    if (!isSafeIdentifier(courseId)) continue;
    const key = canonicalizeIdentifier(courseId);
    const existing = canonicalSharingEnabled.get(key);
    // Fail closed if conflicting mixed-case duplicate keys exist for the same course UUID.
    canonicalSharingEnabled.set(key, existing === undefined ? enabled === true : existing && enabled === true);
  }

  const canonicalPrivacyEpochs = new Map<string, number | null>();
  for (const [courseId, epoch] of Object.entries(coursePrivacyEpochs)) {
    if (!isSafeIdentifier(courseId)) continue;
    const key = canonicalizeIdentifier(courseId);
    const existing = canonicalPrivacyEpochs.get(key);
    if (existing === undefined) {
      canonicalPrivacyEpochs.set(key, epoch);
    } else if (existing !== epoch) {
      // Fail closed on conflicting mixed-case epoch keys for the same course UUID.
      canonicalPrivacyEpochs.set(key, null);
    }
  }

  const ignoredNonDirectEdges: IgnoredNonDirectBridgeEdge[] = [];
  const decoupledEdges: DecoupledConceptBridgeEdge[] = [];
  const admissibleBySourceKey = new Map<string, AdmissibleBridgeEdge[]>();

  for (const edge of edges) {
    const edgeId = resolveEdgeId(edge);
    const edgeTargetIdsValid =
      isSafeIdentifier(edge.targetCourseId) && isSafeIdentifier(edge.targetConceptId);
    const edgeSourceIdsValid =
      isSafeIdentifier(edge.sourceCourseId) && isSafeIdentifier(edge.sourceConceptId);
    const canonicalSourceCourseId = edgeSourceIdsValid
      ? canonicalizeIdentifier(edge.sourceCourseId)
      : "";
    const canonicalSourceConceptId = edgeSourceIdsValid
      ? canonicalizeIdentifier(edge.sourceConceptId)
      : "";
    const canonicalEdgeTargetCourseId = edgeTargetIdsValid
      ? canonicalizeIdentifier(edge.targetCourseId)
      : "";
    const canonicalEdgeTargetConceptId = edgeTargetIdsValid
      ? canonicalizeIdentifier(edge.targetConceptId)
      : "";

    if (
      !canonicalTargetCourseId ||
      !canonicalTargetConceptId ||
      !edgeTargetIdsValid ||
      canonicalEdgeTargetCourseId !== canonicalTargetCourseId ||
      canonicalEdgeTargetConceptId !== canonicalTargetConceptId
    ) {
      ignoredNonDirectEdges.push({
        edgeId,
        sourceCourseId: edge.sourceCourseId,
        sourceConceptId: edge.sourceConceptId,
        targetCourseId: edge.targetCourseId,
        targetConceptId: edge.targetConceptId,
        reason: "non_direct_target_mismatch",
      });
      continue;
    }

    if (edgeSourceIdsValid && canonicalSourceCourseId === canonicalTargetCourseId) {
      ignoredNonDirectEdges.push({
        edgeId,
        sourceCourseId: edge.sourceCourseId,
        sourceConceptId: edge.sourceConceptId,
        targetCourseId: edge.targetCourseId,
        targetConceptId: edge.targetConceptId,
        reason: "same_course_edge",
      });
      continue;
    }

    const decoupleReasons: CrossCourseDecoupleReason[] = [];

    if (
      !edgeSourceIdsValid ||
      edge.supportingSourceIds.some(sourceId => !isSafeIdentifier(sourceId))
    ) {
      decoupleReasons.push("invalid_edge_parameters");
    }

    if ((edge.hopCount !== undefined && edge.hopCount !== 1) || edge.derivedFromBridge === true) {
      decoupleReasons.push("multi_hop_rejected");
    }

    if (canonicalSharingEnabled.get(canonicalSourceCourseId) !== true) {
      decoupleReasons.push("course_sharing_disabled");
    }

    const liveEpoch = canonicalPrivacyEpochs.get(canonicalSourceCourseId);
    if (
      liveEpoch === undefined ||
      liveEpoch === null ||
      !Number.isFinite(liveEpoch) ||
      !Number.isFinite(edge.edgePrivacyEpoch) ||
      edge.edgePrivacyEpoch !== liveEpoch
    ) {
      decoupleReasons.push("privacy_epoch_mismatch");
    }

    if (
      edge.supportingSourceIds.some(sourceId =>
        canonicalRevokedSourceIds.has(canonicalizeIdentifier(sourceId)),
      )
    ) {
      decoupleReasons.push("supporting_source_revoked");
    }

    const hasAnyDirectObservation =
      Number.isFinite(edge.sourceDirectObservationCount) &&
      edge.sourceDirectObservationCount > 0;
    const hasSufficientDirectObservations =
      Number.isSafeInteger(edge.sourceDirectObservationCount) &&
      edge.sourceDirectObservationCount >= MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE;

    if (!hasAnyDirectObservation) {
      decoupleReasons.push("no_direct_source_observations");
    } else if (!hasSufficientDirectObservations) {
      decoupleReasons.push("insufficient_direct_evidence");
    }

    if (
      !Number.isFinite(edge.alignmentWeight) ||
      edge.alignmentWeight <= 0 ||
      edge.alignmentWeight > 1
    ) {
      decoupleReasons.push("invalid_edge_parameters");
    }

    const directResolution = hasSufficientDirectObservations
      ? resolveDirectOnlyMastery(edge)
      : null;
    if (directResolution && !directResolution.ok) {
      if (!decoupleReasons.includes(directResolution.reason)) {
        decoupleReasons.push(directResolution.reason);
      }
    }

    if (decoupleReasons.length > 0 || !directResolution || !directResolution.ok) {
      decoupledEdges.push(decoupledBridgeEdge(edge, edgeId, decoupleReasons));
      continue;
    }

    const sourceKey = JSON.stringify([canonicalSourceCourseId, canonicalSourceConceptId]);
    const candidate = {
      edge,
      edgeId,
      canonicalSourceCourseId,
      canonicalSourceConceptId,
      directOnlyMastery: directResolution.directOnlyMastery,
      evidenceSource: directResolution.evidenceSource,
    };
    const group = admissibleBySourceKey.get(sourceKey);
    if (group) {
      group.push(candidate);
    } else {
      admissibleBySourceKey.set(sourceKey, [candidate]);
    }
  }

  const surviving: AdmissibleBridgeEdge[] = [];
  // A stable source order also keeps the floating-point accumulation deterministic.
  for (const sourceKey of [...admissibleBySourceKey.keys()].sort()) {
    const group = admissibleBySourceKey.get(sourceKey)!;
    let preferred = group[0]!;
    let minimumMastery = preferred.directOnlyMastery;
    let maximumMastery = preferred.directOnlyMastery;
    for (const candidate of group) {
      minimumMastery = Math.min(minimumMastery, candidate.directOnlyMastery);
      maximumMastery = Math.max(maximumMastery, candidate.directOnlyMastery);
      if (compareBridgeCandidates(candidate, preferred) < 0) preferred = candidate;
    }

    if (maximumMastery - minimumMastery > DIRECT_MASTERY_TOLERANCE) {
      // Keep validation diagnostics in scan order, then report conflicts by source and candidate.
      for (const { edge, edgeId } of group.sort(compareConflictingBridgeCandidates)) {
        decoupledEdges.push(decoupledBridgeEdge(edge, edgeId, ["invalid_edge_parameters"]));
      }
    } else {
      surviving.push(preferred);
    }
  }

  if (surviving.length === 0) {
    return {
      targetCourseId,
      targetConceptId,
      alpha: BASE_PRIOR_ALPHA,
      beta: BASE_PRIOR_BETA,
      deltaAlpha: 0,
      deltaBeta: 0,
      equivalentObservations: 0,
      posteriorMean: BASE_PRIOR_ALPHA / (BASE_PRIOR_ALPHA + BASE_PRIOR_BETA),
      isWeakPriorOnly: true,
      requiresInCourseVerification: true,
      acceptedEdges: [],
      decoupledEdges,
      ignoredNonDirectEdges,
      targetInCourseState: targetInCourseState as TTargetState,
    };
  }

  const bridgeCap = Math.min(MAX_BRIDGE_WEIGHT, MAX_BRIDGE_PSEUDO_OBSERVATIONS);
  const totalRawWeight = surviving.reduce((sum, item) => sum + item.edge.alignmentWeight, 0);
  const scale = totalRawWeight > bridgeCap ? bridgeCap / totalRawWeight : 1;

  let rawDeltaAlpha = 0;
  let rawDeltaBeta = 0;
  const acceptedEdges: AcceptedConceptBridgeEdge[] = [];

  for (const {
    edge,
    edgeId,
    canonicalSourceCourseId,
    canonicalSourceConceptId,
    directOnlyMastery,
    evidenceSource,
  } of surviving) {
    const effectiveWeight = Math.min(bridgeCap, edge.alignmentWeight * scale);
    const edgeDeltaAlpha = effectiveWeight * directOnlyMastery;
    const edgeDeltaBeta = effectiveWeight * (1 - directOnlyMastery);
    rawDeltaAlpha += edgeDeltaAlpha;
    rawDeltaBeta += edgeDeltaBeta;
    acceptedEdges.push({
      edgeId,
      sourceCourseId: canonicalSourceCourseId,
      sourceConceptId: canonicalSourceConceptId,
      alignmentWeight: edge.alignmentWeight,
      sourceDirectOnlyMasteryProbability: directOnlyMastery,
      sourceMasteryProbability: directOnlyMastery,
      directEvidenceSource: evidenceSource,
      sourceDirectObservationCount: edge.sourceDirectObservationCount,
      edgePrivacyEpoch: edge.edgePrivacyEpoch,
      effectiveWeight,
      deltaAlpha: edgeDeltaAlpha,
      deltaBeta: edgeDeltaBeta,
    });
  }

  // Numerical safety guard against floating-point overshoot beyond `bridgeCap` (0.30).
  const totalDelta = rawDeltaAlpha + rawDeltaBeta;
  const norm = totalDelta > bridgeCap ? bridgeCap / totalDelta : 1;
  const deltaAlpha = Math.max(0, rawDeltaAlpha * norm);
  const deltaBeta = Math.max(0, rawDeltaBeta * norm);
  const equivalentObservations = Math.min(bridgeCap, deltaAlpha + deltaBeta);

  const alpha = BASE_PRIOR_ALPHA + deltaAlpha;
  const beta = BASE_PRIOR_BETA + deltaBeta;
  const posteriorMean = clamp(
    alpha / (alpha + beta),
    MIN_BRIDGE_PRIOR_MEAN,
    MAX_BRIDGE_PRIOR_MEAN,
  );

  return {
    targetCourseId,
    targetConceptId,
    alpha,
    beta,
    deltaAlpha,
    deltaBeta,
    equivalentObservations,
    posteriorMean,
    isWeakPriorOnly: true,
    requiresInCourseVerification: true,
    acceptedEdges,
    decoupledEdges,
    ignoredNonDirectEdges,
    targetInCourseState: targetInCourseState as TTargetState,
  };
}
