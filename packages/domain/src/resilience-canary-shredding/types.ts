/**
 * @aistudy/domain/resilience-canary-shredding is 100% Closed-Core Proprietary.
 * Pure browser-safe deterministic TypeScript types with zero runtime host/DB/AI imports.
 */

export type DriftThresholdMetric =
  | "errorRate"
  | "p95TtftMs"
  | "verifierContradictionRate"
  | "canaryFailureRate";

export type CanaryProbeSource = "synthetic_canary" | "live_sse_guard";

export type SealedMarkerLeakCategory =
  | "answer_key"
  | "sealed_canary_marker"
  | "rubric_solution";

export type TaskRouteSpec = {
  providerFamily: string;
  modelId: string;
  taskKind: string;
};

export type CrossFamilyFallbackConfig = {
  primary: TaskRouteSpec;
  fallback: TaskRouteSpec;
};

export type DriftSentinelThresholds = {
  maxErrorRate: number;
  maxP95TtftMs: number;
  maxVerifierContradictionRate: number;
  maxCanaryFailureRate: number;
};

export type SanitizedCanaryProbeSignal = {
  probeId: string;
  probeSource: CanaryProbeSource;
  providerFamily: string;
  modelId: string;
  taskKind: string;
  observedAtMs: number;
  passed: boolean;
  sseAnswerMarkerLeak: boolean;
  leakCategory?: SealedMarkerLeakCategory;
};

export type SanitizedDriftWindowMetrics = {
  windowStartMs: number;
  windowEndMs: number;
  taskKind: string;
  providerFamily?: string;
  modelId?: string;
  decisionCount: number;
  errorRate: number;
  p95TtftMs: number;
  verifierContradictionRate: number;
  canaryFailureRate: number;
  sseAnswerMarkerLeak?: boolean;
};

export type DriftSentinelInput = {
  route: CrossFamilyFallbackConfig;
  thresholds: DriftSentinelThresholds;
  windows: readonly SanitizedDriftWindowMetrics[];
  probes?: readonly SanitizedCanaryProbeSignal[];
  evaluatedAtMs?: number;
};

export type DriftSentinelAction =
  | "keep_primary"
  | "immediate_circuit_break"
  | "switch_task_to_cross_family_fallback";

export type KeepPrimaryReason =
  | "within_thresholds"
  | "insufficient_qualified_windows"
  | "single_window_breach_not_confirmed"
  | "non_consecutive_breach_windows"
  | "disjoint_threshold_breaches";

export type DriftSentinelDecision =
  | {
      action: "immediate_circuit_break";
      triggerLatencyMs: 0;
      detectionElapsedMs: 0;
      withinDetectionSla: true;
      waitedForWindowCompletion: false;
      scopedTaskKind: string;
      isolatedRoute: TaskRouteSpec;
      fallbackRoute: TaskRouteSpec;
      isolatedRouteKey: string;
      leakSource: CanaryProbeSource;
      triggerProbeId: string | null;
      breachedMetrics: readonly DriftThresholdMetric[];
      reason: "sse_answer_marker_leak";
    }
  | {
      action: "switch_task_to_cross_family_fallback";
      triggerLatencyMs: number;
      detectionElapsedMs: number;
      withinDetectionSla: boolean;
      waitedForWindowCompletion: true;
      scopedTaskKind: string;
      isolatedRoute: TaskRouteSpec;
      fallbackRoute: TaskRouteSpec;
      isolatedRouteKey: string;
      breachedMetrics: readonly DriftThresholdMetric[];
      triggerWindowPair: readonly [
        SanitizedDriftWindowMetrics,
        SanitizedDriftWindowMetrics,
      ];
      reason: "consecutive_dual_window_threshold_breach";
    }
  | {
      action: "keep_primary";
      triggerLatencyMs: null;
      detectionElapsedMs: number;
      withinDetectionSla: true;
      waitedForWindowCompletion: false;
      scopedTaskKind: string;
      isolatedRoute: null;
      fallbackRoute: null;
      isolatedRouteKey: null;
      breachedMetrics: readonly DriftThresholdMetric[];
      qualifiedWindowCount: number;
      evaluatedWindowCount: number;
      reason: KeepPrimaryReason;
    };

export type ModelExecutionOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "sse_circuit_broken";

export type ModelAttemptBillingRecord = {
  providerFamily: string;
  modelId: string;
  outcome: ModelExecutionOutcome;
  providerCostMicroUnits: number;
  quotedLearnerDebitMicroUnits: number;
};

export type FailoverBillingSettlementInput = {
  requestId: string;
  taskKind: string;
  primaryAttempt: ModelAttemptBillingRecord;
  fallbackAttempt?: ModelAttemptBillingRecord | null;
};

export type FailoverBillingSettlementResult = {
  requestId: string;
  taskKind: string;
  primaryLearnerChargeMicroUnits: number;
  fallbackLearnerChargeMicroUnits: number;
  totalLearnerChargeMicroUnits: number;
  voidedFailedPrimary: boolean;
  voidedFailedFallback: boolean;
  duplicateChargePrevented: boolean;
  billedExecution: "primary" | "fallback" | null;
  internalProviderTelemetry: {
    primaryProviderCostMicroUnits: number;
    fallbackProviderCostMicroUnits: number;
    totalInternalProviderCostMicroUnits: number;
    primaryOutcome: ModelExecutionOutcome;
    fallbackOutcome: ModelExecutionOutcome | null;
  };
};

export type EnvelopeKeyStatus = "active" | "shredded" | "revoked";

export type WorkspaceMasterKey = {
  workspaceKeyId: string;
  keyVersion: number;
  status: "active" | "shredded";
  privacyEpoch: number;
  createdAtMs: number;
  shreddedAtMs: number | null;
};

export type SourceEnvelopeKey = {
  sourceId: string;
  sourceKeyId: string;
  wrappedByWorkspaceKeyId: string;
  status: EnvelopeKeyStatus;
  privacyEpoch: number;
  createdAtMs: number;
  shreddedAtMs: number | null;
};

export type WorkspaceKeyTree = {
  workspaceId: string;
  masterKey: WorkspaceMasterKey;
  sources: readonly SourceEnvelopeKey[];
};

export type CryptoShredTarget =
  | { kind: "source"; sourceId: string }
  | { kind: "workspace" };

export type AffectedCalibrationItemInput = {
  itemRevisionId: string;
  sourceId?: string;
  currentSampleCount: number;
  shreddedFirstIndependentSubmissionIds: readonly string[];
};

export type CalibrationTier =
  | "tier0_prior"
  | "tier1_difficulty_only"
  | "tier2_mmle";

export type CalibrationCountRollbackResult = {
  itemRevisionId: string;
  previousSampleCount: number;
  newlyShreddedCount: number;
  deduplicatedSkippedCount: number;
  nextSampleCount: number;
  postShredTier: CalibrationTier;
  appliedSubmissionIds: readonly string[];
};

export type MutableStoreArtifactInventory = {
  pgvectorChunks?: readonly {
    sourceId: string;
    chunkId: string;
    sourceVersion: number;
    modelKey: string;
  }[];
  redisKeys?: readonly {
    sourceId?: string;
    key: string;
  }[];
  s3Objects?: readonly {
    sourceId: string;
    bucket: string;
    objectKey: string;
    versionId: string;
  }[];
};

export type PgvectorPurgeDescriptor = {
  table: "opening_source_embeddings";
  workspaceId: string;
  sourceId: string;
  chunkIds: readonly string[];
  deleteFilter: {
    workspaceId: string;
    sourceId: string;
  };
};

export type S3ObjectVersionPurgeDescriptor = {
  bucket: string;
  objectKey: string;
  versionId: string;
  sourceId: string;
};

export type MutableStorePurgeDescriptors = {
  pgvectorEmbeddings0084: readonly PgvectorPurgeDescriptor[];
  redisHotKeys: readonly string[];
  s3ObjectVersionKeys: readonly S3ObjectVersionPurgeDescriptor[];
};

export type CryptoShredTombstoneReceipt = {
  receiptId: string;
  workspaceId: string;
  target: CryptoShredTarget;
  issuedAtMs: number;
  appendOnlyCompliant: true;
  immutableAppendOnlyDeletes: readonly [];
  preservedImmutableTables: readonly string[];
  shreddedWorkspaceKeyId: string | null;
  shreddedSourceKeyIds: readonly string[];
  shreddedSourceIds: readonly string[];
  preservedWorkspaceKeyId: string | null;
  preservedSourceKeyIds: readonly string[];
  appliedSubmissionKeys: readonly string[];
  newlyApplied: boolean;
};

export type CryptoShredExecutionInput = {
  keyTree: WorkspaceKeyTree;
  target: CryptoShredTarget;
  executedAtMs: number;
  affectedItemRevisions?: readonly AffectedCalibrationItemInput[];
  existingReceipts?: readonly CryptoShredTombstoneReceipt[];
  mutableInventory?: MutableStoreArtifactInventory;
};

export type CryptoShredExecutionResult = {
  nextKeyTree: WorkspaceKeyTree;
  receipt: CryptoShredTombstoneReceipt;
  appendOnlyCompliant: true;
  immutableAppendOnlyDeletes: readonly [];
  mutablePurges: MutableStorePurgeDescriptors;
  calibrationRollbacks: readonly CalibrationCountRollbackResult[];
};

export type QuarantineRestorePolicy = "strict_atomic" | "strip_shredded_lineage";

export type QuarantineRestoreRecord = {
  recordId: string;
  recordType: string;
  workspaceId: string;
  workspaceKeyId: string;
  sourceId?: string | null;
  sourceKeyId?: string | null;
  privacyEpoch: number;
};

export type QuarantineRejectReason =
  | "workspace_mismatch"
  | "shredded_workspace_key"
  | "unrecognized_workspace_key"
  | "shredded_source_key"
  | "revoked_or_deleted_source"
  | "stale_source_key"
  | "stale_privacy_epoch";

export type QuarantinedRecordRejection = {
  recordId: string;
  recordType: string;
  sourceId: string | null;
  sourceKeyId: string | null;
  workspaceKeyId: string;
  privacyEpoch: number;
  reason: QuarantineRejectReason;
};

export type QuarantineRestoreInput = {
  bundleId: string;
  policy: QuarantineRestorePolicy;
  liveKeyTree: WorkspaceKeyTree;
  records: readonly QuarantineRestoreRecord[];
  existingReceipts?: readonly CryptoShredTombstoneReceipt[];
  revokedSourceIds?: readonly string[];
  shreddedKeyIds?: readonly string[];
};

export type QuarantineRestoreStatus =
  | "approved_clean"
  | "approved_after_filtering"
  | "rejected_shredded_lineage";

export type QuarantineRestoreResult = {
  bundleId: string;
  stagingZone: "quarantine";
  policy: QuarantineRestorePolicy;
  status: QuarantineRestoreStatus;
  liveApplyAllowed: boolean;
  approvedRecords: readonly QuarantineRestoreRecord[];
  rejectedRecords: readonly QuarantinedRecordRejection[];
};

export type CanaryRolloutStage =
  | "0_percent"
  | "1_percent"
  | "10_percent"
  | "100_percent";

export type CanaryRolloutState = {
  rolloutId: string;
  stage: CanaryRolloutStage;
  epoch: number;
  schemaContractBackwardCompatible: boolean;
  emergencyRollbackActive: boolean;
  rollbackReason: string | null;
  rollbackTriggeredAtMs: number | null;
  rollbackDeadlineAtMs: number | null;
};

export type ExpandContractRouteInput = {
  rolloutId: string;
  subjectKey: string;
  stage: CanaryRolloutStage;
  schemaContractBackwardCompatible: boolean;
  emergencyRollbackActive?: boolean;
};

export type ExpandContractRouteReason =
  | "matched_canary_bucket"
  | "outside_canary_bucket"
  | "stage_zero_percent"
  | "expand_contract_incompatible"
  | "emergency_rollback_active";

export type ExpandContractRouteResult = {
  rolloutId: string;
  subjectKey: string;
  bucket: number;
  stage: CanaryRolloutStage;
  engine: "baseline" | "candidate";
  inCanary: boolean;
  reason: ExpandContractRouteReason;
};

export type StagePromotionResult =
  | {
      promoted: true;
      previousStage: CanaryRolloutStage;
      state: CanaryRolloutState;
      reason: "stage_promoted";
    }
  | {
      promoted: false;
      previousStage: CanaryRolloutStage;
      state: CanaryRolloutState;
      reason:
        | "expand_contract_backward_incompatible"
        | "emergency_rollback_active";
    };

export type CandidatePublishLease = {
  leaseId: string;
  rolloutId: string;
  workerId: string;
  rolloutEpoch: number;
  issuedAtMs: number;
  expiresAtMs: number;
  ttlMs: 2000;
  revoked: boolean;
};

export type AcquireLeaseResult =
  | {
      granted: true;
      lease: CandidatePublishLease;
      reason: "lease_granted";
    }
  | {
      granted: false;
      lease: null;
      reason:
        | "emergency_rollback_active"
        | "stage_zero_percent"
        | "expand_contract_incompatible";
    };

export type CommitFenceReason =
  | "lease_valid"
  | "missing_lease"
  | "emergency_rollback_active"
  | "rollout_at_zero_percent"
  | "expand_contract_incompatible"
  | "stale_rollout_epoch"
  | "lease_revoked"
  | "lease_expired"
  | "commit_before_lease_issued";

export type CommitFenceResult = {
  allowed: boolean;
  dirtyWritePrevented: boolean;
  reason: CommitFenceReason;
  commitNowMs: number;
  stateEpoch: number;
  leaseEpoch: number | null;
};

export type EmergencyRollbackResult = {
  previousStage: CanaryRolloutStage;
  previousEpoch: number;
  nextState: CanaryRolloutState;
  rollbackTriggeredAtMs: number;
  rollbackDeadlineAtMs: number;
  slaDeadlineAtMs: number;
  maxDrainWindowMs: 2000;
  withinRollbackSla: boolean;
  reason: string;
};
