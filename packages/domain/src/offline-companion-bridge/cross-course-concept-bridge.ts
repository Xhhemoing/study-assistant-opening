import {
  BASE_PRIOR_ALPHA,
  BASE_PRIOR_BETA,
  MAX_BRIDGE_PRIOR_MEAN,
  MAX_BRIDGE_PSEUDO_OBSERVATIONS,
  MIN_BRIDGE_PRIOR_MEAN,
  type AcceptedConceptBridgeEdge,
  type ComputeCrossCourseWeakPriorInput,
  type CrossCourseConceptEdge,
  type CrossCourseDecoupleReason,
  type CrossCourseWeakPriorResult,
  type DecoupledConceptBridgeEdge,
  type IgnoredNonDirectBridgeEdge,
} from "./types";

function resolveEdgeId(edge: CrossCourseConceptEdge): string {
  return (
    edge.edgeId ??
    `${edge.sourceCourseId}:${edge.sourceConceptId}->${edge.targetCourseId}:${edge.targetConceptId}`
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Computes a strictly 1-hop, read-time privacy-epoch checked, bounded weak Beta prior
 * `Beta(1 + deltaAlpha, 1 + deltaBeta)` with `deltaAlpha + deltaBeta <= 1`
 * (`posteriorMean` strictly in `[1/3, 2/3]`).
 *
 * Invariants:
 * 1. Zero multi-hop propagation: only direct edges targeting `(targetCourseId, targetConceptId)`
 *    from a different `sourceCourseId` with positive in-course `sourceDirectObservationCount`
 *    can contribute. Upstream `A -> B` edges or bridge-derived priors are never propagated.
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

  const ignoredNonDirectEdges: IgnoredNonDirectBridgeEdge[] = [];
  const decoupledEdges: DecoupledConceptBridgeEdge[] = [];
  const survivingBySourceKey = new Map<string, { edge: CrossCourseConceptEdge; edgeId: string }>();

  for (const edge of edges) {
    const edgeId = resolveEdgeId(edge);

    if (edge.targetCourseId !== targetCourseId || edge.targetConceptId !== targetConceptId) {
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

    if (edge.sourceCourseId === targetCourseId) {
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

    if ((edge.hopCount !== undefined && edge.hopCount !== 1) || edge.derivedFromBridge === true) {
      decoupleReasons.push("multi_hop_rejected");
    }

    if (activeCourseSharingEnabled[edge.sourceCourseId] !== true) {
      decoupleReasons.push("course_sharing_disabled");
    }

    const liveEpoch = coursePrivacyEpochs[edge.sourceCourseId];
    if (
      liveEpoch === undefined ||
      !Number.isFinite(liveEpoch) ||
      !Number.isFinite(edge.edgePrivacyEpoch) ||
      edge.edgePrivacyEpoch !== liveEpoch
    ) {
      decoupleReasons.push("privacy_epoch_mismatch");
    }

    if (edge.supportingSourceIds.some(sourceId => revokedSourceIds.has(sourceId))) {
      decoupleReasons.push("supporting_source_revoked");
    }

    if (
      !Number.isFinite(edge.sourceDirectObservationCount) ||
      edge.sourceDirectObservationCount <= 0
    ) {
      decoupleReasons.push("no_direct_source_observations");
    }

    if (
      !Number.isFinite(edge.alignmentWeight) ||
      edge.alignmentWeight <= 0 ||
      edge.alignmentWeight > 1 ||
      !Number.isFinite(edge.sourceMasteryProbability) ||
      edge.sourceMasteryProbability < 0 ||
      edge.sourceMasteryProbability > 1
    ) {
      decoupleReasons.push("invalid_edge_parameters");
    }

    if (decoupleReasons.length > 0) {
      decoupledEdges.push({
        edgeId,
        sourceCourseId: edge.sourceCourseId,
        sourceConceptId: edge.sourceConceptId,
        targetCourseId: edge.targetCourseId,
        targetConceptId: edge.targetConceptId,
        reason: decoupleReasons[0]!,
        reasons: decoupleReasons,
      });
      continue;
    }

    // Deduplicate identical `(sourceCourseId, sourceConceptId)` edges deterministically
    // so repeating the same neighbor cannot inflate its alignment weight.
    const sourceKey = `${edge.sourceCourseId}::${edge.sourceConceptId}`;
    const existing = survivingBySourceKey.get(sourceKey);
    if (!existing || edge.alignmentWeight > existing.edge.alignmentWeight) {
      survivingBySourceKey.set(sourceKey, { edge, edgeId });
    }
  }

  const surviving = [...survivingBySourceKey.values()];

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

  const totalRawWeight = surviving.reduce((sum, item) => sum + item.edge.alignmentWeight, 0);
  const scale =
    totalRawWeight > MAX_BRIDGE_PSEUDO_OBSERVATIONS
      ? MAX_BRIDGE_PSEUDO_OBSERVATIONS / totalRawWeight
      : 1;

  let rawDeltaAlpha = 0;
  let rawDeltaBeta = 0;
  const acceptedEdges: AcceptedConceptBridgeEdge[] = [];

  for (const { edge, edgeId } of surviving) {
    const effectiveWeight = edge.alignmentWeight * scale;
    const edgeDeltaAlpha = effectiveWeight * edge.sourceMasteryProbability;
    const edgeDeltaBeta = effectiveWeight * (1 - edge.sourceMasteryProbability);
    rawDeltaAlpha += edgeDeltaAlpha;
    rawDeltaBeta += edgeDeltaBeta;
    acceptedEdges.push({
      edgeId,
      sourceCourseId: edge.sourceCourseId,
      sourceConceptId: edge.sourceConceptId,
      alignmentWeight: edge.alignmentWeight,
      sourceMasteryProbability: edge.sourceMasteryProbability,
      sourceDirectObservationCount: edge.sourceDirectObservationCount,
      edgePrivacyEpoch: edge.edgePrivacyEpoch,
      effectiveWeight,
      deltaAlpha: edgeDeltaAlpha,
      deltaBeta: edgeDeltaBeta,
    });
  }

  // Numerical safety guard against floating-point overshoot beyond 1 equivalent observation.
  const totalDelta = rawDeltaAlpha + rawDeltaBeta;
  const norm =
    totalDelta > MAX_BRIDGE_PSEUDO_OBSERVATIONS
      ? MAX_BRIDGE_PSEUDO_OBSERVATIONS / totalDelta
      : 1;
  const deltaAlpha = Math.max(0, rawDeltaAlpha * norm);
  const deltaBeta = Math.max(0, rawDeltaBeta * norm);
  const equivalentObservations = Math.min(MAX_BRIDGE_PSEUDO_OBSERVATIONS, deltaAlpha + deltaBeta);

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
