import type {
  AcquireLeaseResult,
  CanaryRolloutStage,
  CanaryRolloutState,
  CandidatePublishLease,
  CommitFenceResult,
  EmergencyRollbackResult,
  ExpandContractRouteInput,
  ExpandContractRouteResult,
  StagePromotionResult,
} from "./types";

export const CANDIDATE_PUBLISH_LEASE_TTL_MS = 2_000 as const;
export const EMERGENCY_ROLLBACK_SLA_MS = 5_000 as const;
export const CANARY_BUCKET_SPACE = 10_000 as const;

export const CANARY_ROLLOUT_STAGES = [
  "0_percent",
  "1_percent",
  "10_percent",
  "100_percent",
] as const;

const STAGE_BUCKET_THRESHOLD: Record<CanaryRolloutStage, number> = {
  "0_percent": 0,
  "1_percent": 100,
  "10_percent": 1_000,
  "100_percent": CANARY_BUCKET_SPACE,
};

function assertNonEmptyString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function assertNonNegativeFinite(value: number, fieldName: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative finite number`);
  }
  return value;
}

/**
 * Deterministic 32-bit FNV-1a + Murmur3 avalanche mixer mapping (rolloutId, subjectKey)
 * onto [0, 9999] with uniform distribution and zero stage-dependent churn.
 */
export function computeCanaryHashBucket(
  rolloutId: string,
  subjectKey: string,
): number {
  const normalizedRollout = assertNonEmptyString(rolloutId, "rolloutId");
  const normalizedSubject = assertNonEmptyString(subjectKey, "subjectKey");
  const bytes = new TextEncoder().encode(
    `${normalizedRollout}\u0000${normalizedSubject}`,
  );

  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  return (hash >>> 0) % CANARY_BUCKET_SPACE;
}

export function createCanaryRolloutState(input: {
  rolloutId: string;
  schemaContractBackwardCompatible: boolean;
  stage?: CanaryRolloutStage;
  epoch?: number;
}): CanaryRolloutState {
  const rolloutId = assertNonEmptyString(input.rolloutId, "rolloutId");
  const stage = input.stage ?? "0_percent";
  const epoch = input.epoch ?? 1;
  if (!Number.isInteger(epoch) || epoch < 1) {
    throw new RangeError("epoch must be a positive integer");
  }
  if (stage !== "0_percent" && !input.schemaContractBackwardCompatible) {
    throw new RangeError(
      "Cannot initialize canary stage above 0_percent without backward-compatible Expand-Contract schema",
    );
  }

  return {
    rolloutId,
    stage,
    epoch,
    schemaContractBackwardCompatible: input.schemaContractBackwardCompatible,
    emergencyRollbackActive: false,
    rollbackReason: null,
    rollbackTriggeredAtMs: null,
    rollbackDeadlineAtMs: null,
  };
}

export function promoteCanaryRolloutStage(
  state: CanaryRolloutState,
  targetStage: CanaryRolloutStage,
): StagePromotionResult {
  assertNonEmptyString(state.rolloutId, "state.rolloutId");

  if (state.emergencyRollbackActive && targetStage !== "0_percent") {
    return {
      promoted: false,
      previousStage: state.stage,
      state,
      reason: "emergency_rollback_active",
    };
  }

  if (targetStage !== "0_percent" && !state.schemaContractBackwardCompatible) {
    return {
      promoted: false,
      previousStage: state.stage,
      state,
      reason: "expand_contract_backward_incompatible",
    };
  }

  return {
    promoted: true,
    previousStage: state.stage,
    state: {
      ...state,
      stage: targetStage,
    },
    reason: "stage_promoted",
  };
}

export function routeExpandContractBucket(
  input: ExpandContractRouteInput,
): ExpandContractRouteResult {
  const rolloutId = assertNonEmptyString(input.rolloutId, "rolloutId");
  const subjectKey = assertNonEmptyString(input.subjectKey, "subjectKey");
  const bucket = computeCanaryHashBucket(rolloutId, subjectKey);

  if (input.emergencyRollbackActive === true) {
    return {
      rolloutId,
      subjectKey,
      bucket,
      stage: input.stage,
      engine: "baseline",
      inCanary: false,
      reason: "emergency_rollback_active",
    };
  }

  if (!input.schemaContractBackwardCompatible) {
    return {
      rolloutId,
      subjectKey,
      bucket,
      stage: input.stage,
      engine: "baseline",
      inCanary: false,
      reason: "expand_contract_incompatible",
    };
  }

  if (input.stage === "0_percent") {
    return {
      rolloutId,
      subjectKey,
      bucket,
      stage: input.stage,
      engine: "baseline",
      inCanary: false,
      reason: "stage_zero_percent",
    };
  }

  const threshold = STAGE_BUCKET_THRESHOLD[input.stage];
  const inCanary = bucket < threshold;
  return {
    rolloutId,
    subjectKey,
    bucket,
    stage: input.stage,
    engine: inCanary ? "candidate" : "baseline",
    inCanary,
    reason: inCanary ? "matched_canary_bucket" : "outside_canary_bucket",
  };
}

export function acquireCandidatePublishLease(
  state: CanaryRolloutState,
  workerId: string,
  nowMs: number,
): AcquireLeaseResult {
  const normalizedWorkerId = assertNonEmptyString(workerId, "workerId");
  const issuedAtMs = assertNonNegativeFinite(nowMs, "nowMs");

  if (state.emergencyRollbackActive) {
    return {
      granted: false,
      lease: null,
      reason: "emergency_rollback_active",
    };
  }

  if (state.stage === "0_percent") {
    return {
      granted: false,
      lease: null,
      reason: "stage_zero_percent",
    };
  }

  if (!state.schemaContractBackwardCompatible) {
    return {
      granted: false,
      lease: null,
      reason: "expand_contract_incompatible",
    };
  }

  const lease: CandidatePublishLease = {
    leaseId: `${state.rolloutId}:epoch-${state.epoch}:${normalizedWorkerId}:${issuedAtMs}`,
    rolloutId: state.rolloutId,
    workerId: normalizedWorkerId,
    rolloutEpoch: state.epoch,
    issuedAtMs,
    expiresAtMs: issuedAtMs + CANDIDATE_PUBLISH_LEASE_TTL_MS,
    ttlMs: CANDIDATE_PUBLISH_LEASE_TTL_MS,
    revoked: false,
  };

  return {
    granted: true,
    lease,
    reason: "lease_granted",
  };
}

export function revokeCandidatePublishLease(
  lease: CandidatePublishLease,
): CandidatePublishLease {
  return {
    ...lease,
    revoked: true,
  };
}

export function validateCandidateCommitFence(
  state: CanaryRolloutState,
  lease: CandidatePublishLease | null | undefined,
  commitNowMs: number,
): CommitFenceResult {
  assertNonNegativeFinite(commitNowMs, "commitNowMs");

  if (!lease) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "missing_lease",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: null,
    };
  }

  if (state.emergencyRollbackActive) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "emergency_rollback_active",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (state.stage === "0_percent") {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "rollout_at_zero_percent",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (!state.schemaContractBackwardCompatible) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "expand_contract_incompatible",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (
    lease.rolloutEpoch !== state.epoch ||
    lease.rolloutId !== state.rolloutId
  ) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "stale_rollout_epoch",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (lease.revoked) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_revoked",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (
    !Number.isFinite(lease.issuedAtMs) ||
    !Number.isFinite(lease.expiresAtMs) ||
    lease.issuedAtMs < 0 ||
    lease.expiresAtMs < lease.issuedAtMs
  ) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_expired",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (commitNowMs < lease.issuedAtMs) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "commit_before_lease_issued",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  if (
    commitNowMs > lease.expiresAtMs ||
    commitNowMs - lease.issuedAtMs > CANDIDATE_PUBLISH_LEASE_TTL_MS
  ) {
    return {
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_expired",
      commitNowMs,
      stateEpoch: state.epoch,
      leaseEpoch: lease.rolloutEpoch,
    };
  }

  return {
    allowed: true,
    dirtyWritePrevented: false,
    reason: "lease_valid",
    commitNowMs,
    stateEpoch: state.epoch,
    leaseEpoch: lease.rolloutEpoch,
  };
}

export function triggerEmergencyRollback(
  state: CanaryRolloutState,
  reason: string,
  rollbackAtMs: number,
): EmergencyRollbackResult {
  const normalizedReason = assertNonEmptyString(reason, "reason");
  const triggeredAtMs = assertNonNegativeFinite(rollbackAtMs, "rollbackAtMs");
  const rollbackDeadlineAtMs = triggeredAtMs + CANDIDATE_PUBLISH_LEASE_TTL_MS;
  const slaDeadlineAtMs = triggeredAtMs + EMERGENCY_ROLLBACK_SLA_MS;

  const nextState: CanaryRolloutState = {
    rolloutId: state.rolloutId,
    stage: "0_percent",
    epoch: state.epoch + 1,
    schemaContractBackwardCompatible: state.schemaContractBackwardCompatible,
    emergencyRollbackActive: true,
    rollbackReason: normalizedReason,
    rollbackTriggeredAtMs: triggeredAtMs,
    rollbackDeadlineAtMs,
  };

  return {
    previousStage: state.stage,
    previousEpoch: state.epoch,
    nextState,
    rollbackTriggeredAtMs: triggeredAtMs,
    rollbackDeadlineAtMs,
    slaDeadlineAtMs,
    maxDrainWindowMs: CANDIDATE_PUBLISH_LEASE_TTL_MS,
    withinRollbackSla: CANDIDATE_PUBLISH_LEASE_TTL_MS <= EMERGENCY_ROLLBACK_SLA_MS,
    reason: normalizedReason,
  };
}
