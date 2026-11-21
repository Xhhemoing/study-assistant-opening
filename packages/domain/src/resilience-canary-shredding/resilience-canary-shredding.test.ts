import { describe, expect, it } from "vitest";
import {
  CANARY_BUCKET_SPACE,
  CANARY_PROBE_INTERVAL_MS,
  CANARY_ROLLOUT_STAGES,
  CANDIDATE_PUBLISH_LEASE_TTL_MS,
  DRIFT_WINDOW_MS,
  EMERGENCY_ROLLBACK_SLA_MS,
  IMMUTABLE_LEDGER_TABLE_0014,
  MAX_SWITCHOVER_DETECTION_MS,
  MIN_DECISIONS_PER_WINDOW,
  PGVECTOR_EMBEDDINGS_TABLE_0084,
  acquireCandidatePublishLease,
  alignDriftWindowStart,
  computeCanaryHashBucket,
  createCanaryRolloutState,
  deriveCalibrationTier,
  evaluateDriftCanarySentinel,
  evaluateQuarantineRestoreBundle,
  planAndExecuteCryptoShred,
  promoteCanaryRolloutStage,
  reconcileFailoverBillingSettlement,
  revokeCandidatePublishLease,
  routeExpandContractBucket,
  triggerEmergencyRollback,
  validateCandidateCommitFence,
  type CrossFamilyFallbackConfig,
  type DriftSentinelThresholds,
  type SanitizedDriftWindowMetrics,
  type WorkspaceKeyTree,
} from "./index";

const baseRoute: CrossFamilyFallbackConfig = {
  primary: {
    providerFamily: "openai",
    modelId: "gpt-5.4-mini",
    taskKind: "tutor_turn",
  },
  fallback: {
    providerFamily: "anthropic",
    modelId: "claude-sonnet-4-6",
    taskKind: "tutor_turn",
  },
};

const baseThresholds: DriftSentinelThresholds = {
  maxErrorRate: 0.05,
  maxP95TtftMs: 2_500,
  maxVerifierContradictionRate: 0.04,
  maxCanaryFailureRate: 0.2,
};

function makeWindow(
  index: number,
  overrides: Partial<SanitizedDriftWindowMetrics> = {},
): SanitizedDriftWindowMetrics {
  const windowStartMs = index * DRIFT_WINDOW_MS;
  return {
    windowStartMs,
    windowEndMs: windowStartMs + DRIFT_WINDOW_MS,
    taskKind: "tutor_turn",
    providerFamily: "openai",
    modelId: "gpt-5.4-mini",
    decisionCount: 150,
    errorRate: 0.01,
    p95TtftMs: 800,
    verifierContradictionRate: 0.01,
    canaryFailureRate: 0,
    ...overrides,
  };
}

describe("A. 15-Minute Drift Canary Sentinel & Zero-Double-Billing", () => {
  it("exposes exact sentinel cadence and window invariants", () => {
    expect(CANARY_PROBE_INTERVAL_MS).toBe(60_000);
    expect(DRIFT_WINDOW_MS).toBe(300_000);
    expect(MIN_DECISIONS_PER_WINDOW).toBe(100);
    expect(MAX_SWITCHOVER_DETECTION_MS).toBe(900_000);
    expect(alignDriftWindowStart(300_000 + 45_123)).toBe(300_000);
  });

  it("triggers 0ms circuit break immediately on synthetic or live SSE answer-marker leak", () => {
    const decision = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [makeWindow(0, { decisionCount: 12 })],
      probes: [
        {
          probeId: "probe-ok",
          probeSource: "synthetic_canary",
          providerFamily: "openai",
          modelId: "gpt-5.4-mini",
          taskKind: "tutor_turn",
          observedAtMs: 60_000,
          passed: true,
          sseAnswerMarkerLeak: false,
        },
        {
          probeId: "probe-leak",
          probeSource: "live_sse_guard",
          providerFamily: "openai",
          modelId: "gpt-5.4-mini",
          taskKind: "tutor_turn",
          observedAtMs: 75_000,
          passed: false,
          sseAnswerMarkerLeak: true,
          leakCategory: "answer_key",
        },
      ],
    });

    expect(decision).toMatchObject({
      action: "immediate_circuit_break",
      triggerLatencyMs: 0,
      detectionElapsedMs: 0,
      withinDetectionSla: true,
      waitedForWindowCompletion: false,
      scopedTaskKind: "tutor_turn",
      isolatedRouteKey: "openai:gpt-5.4-mini:tutor_turn",
      leakSource: "live_sse_guard",
      triggerProbeId: "probe-leak",
      reason: "sse_answer_marker_leak",
    });
  });

  it("triggers 0ms circuit break on live SSE leak flag inside a partial/in-progress window without waiting", () => {
    const partialDecision = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        {
          windowStartMs: 0,
          windowEndMs: 60_000, // 1m partial in-progress window
          taskKind: "tutor_turn",
          providerFamily: "openai",
          modelId: "gpt-5.4-mini",
          decisionCount: 5,
          errorRate: 0,
          p95TtftMs: 400,
          verifierContradictionRate: 0,
          canaryFailureRate: 0,
          sseAnswerMarkerLeak: true,
        },
      ],
    });

    expect(partialDecision.action).toBe("immediate_circuit_break");
    expect(partialDecision.triggerLatencyMs).toBe(0);
    expect(partialDecision.waitedForWindowCompletion).toBe(false);

    // Without sseAnswerMarkerLeak, statistical rate evaluation still requires full 5m windows
    expect(() =>
      evaluateDriftCanarySentinel({
        route: baseRoute,
        thresholds: baseThresholds,
        windows: [
          {
            windowStartMs: 0,
            windowEndMs: 60_000,
            taskKind: "tutor_turn",
            decisionCount: 150,
            errorRate: 0.9,
            p95TtftMs: 400,
            verifierContradictionRate: 0,
            canaryFailureRate: 0,
          },
        ],
      }),
    ).toThrow(RangeError);
  });

  it("ignores sparse windows (< 100 decisions), single-window spikes, non-consecutive windows, quiet-separated breaches, and disjoint metric breaches", () => {
    const sparse = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 99, errorRate: 0.9 }),
        makeWindow(1, { decisionCount: 99, errorRate: 0.9 }),
      ],
    });
    expect(sparse.action).toBe("keep_primary");
    if (sparse.action === "keep_primary") {
      expect(sparse.reason).toBe("insufficient_qualified_windows");
    }

    const singleSpike = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 140, errorRate: 0.2 }),
        makeWindow(1, { decisionCount: 140, errorRate: 0.01 }),
      ],
    });
    expect(singleSpike.action).toBe("keep_primary");
    if (singleSpike.action === "keep_primary") {
      expect(singleSpike.reason).toBe("single_window_breach_not_confirmed");
    }

    const bridgedBySparse = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 120, errorRate: 0.25 }),
        makeWindow(1, { decisionCount: 40, errorRate: 0.25 }),
        makeWindow(2, { decisionCount: 120, errorRate: 0.25 }),
      ],
    });
    expect(bridgedBySparse.action).toBe("keep_primary");
    if (bridgedBySparse.action === "keep_primary") {
      expect(bridgedBySparse.reason).toBe("non_consecutive_breach_windows");
    }

    const separatedByHealthy = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 150, errorRate: 0.25 }),
        makeWindow(1, { decisionCount: 150, errorRate: 0.01 }),
        makeWindow(2, { decisionCount: 150, errorRate: 0.25 }),
      ],
    });
    expect(separatedByHealthy.action).toBe("keep_primary");
    if (separatedByHealthy.action === "keep_primary") {
      expect(separatedByHealthy.reason).toBe("non_consecutive_breach_windows");
    }

    const separatedByMissingInterval = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 150, errorRate: 0.25 }),
        makeWindow(2, { decisionCount: 150, errorRate: 0.25 }),
      ],
    });
    expect(separatedByMissingInterval.action).toBe("keep_primary");
    if (separatedByMissingInterval.action === "keep_primary") {
      expect(separatedByMissingInterval.reason).toBe("non_consecutive_breach_windows");
    }

    const disjoint = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 120, errorRate: 0.25 }),
        makeWindow(1, { decisionCount: 120, p95TtftMs: 4_500 }),
      ],
    });
    expect(disjoint.action).toBe("keep_primary");
    if (disjoint.action === "keep_primary") {
      expect(disjoint.reason).toBe("disjoint_threshold_breaches");
    }
  });

  it("switches ONLY the breached taskKind to cross-family fallback within <= 15m on dual consecutive >= 100 windows", () => {
    const windows: SanitizedDriftWindowMetrics[] = [
      makeWindow(0, { taskKind: "grade_attempt", errorRate: 0.35 }),
      makeWindow(1, { taskKind: "grade_attempt", errorRate: 0.35 }),
      makeWindow(0, { taskKind: "tutor_turn", decisionCount: 100, verifierContradictionRate: 0.08 }),
      makeWindow(1, { taskKind: "tutor_turn", decisionCount: 100, verifierContradictionRate: 0.09 }),
    ];

    const tutorDecision = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows,
    });
    expect(tutorDecision.action).toBe("switch_task_to_cross_family_fallback");
    if (tutorDecision.action === "switch_task_to_cross_family_fallback") {
      expect(tutorDecision.scopedTaskKind).toBe("tutor_turn");
      expect(tutorDecision.breachedMetrics).toEqual(["verifierContradictionRate"]);
      expect(tutorDecision.triggerLatencyMs).toBe(600_000);
      expect(tutorDecision.withinDetectionSla).toBe(true);
      expect(tutorDecision.fallbackRoute.providerFamily).toBe("anthropic");
    }

    const cleanParseDecision = evaluateDriftCanarySentinel({
      route: {
        primary: { providerFamily: "openai", modelId: "gpt-5.4-mini", taskKind: "parse_source" },
        fallback: { providerFamily: "anthropic", modelId: "claude-sonnet-4-6", taskKind: "parse_source" },
      },
      thresholds: baseThresholds,
      windows,
    });
    expect(cleanParseDecision.action).toBe("keep_primary");
    expect(cleanParseDecision.scopedTaskKind).toBe("parse_source");

    const ttftAndCanaryDecision = evaluateDriftCanarySentinel({
      route: baseRoute,
      thresholds: baseThresholds,
      windows: [
        makeWindow(0, { decisionCount: 110, p95TtftMs: 3_100, canaryFailureRate: 0.4 }),
        makeWindow(1, { decisionCount: 110, p95TtftMs: 3_200, canaryFailureRate: 0.4 }),
      ],
      evaluatedAtMs: 14 * 60_000,
    });
    expect(ttftAndCanaryDecision.action).toBe("switch_task_to_cross_family_fallback");
    if (ttftAndCanaryDecision.action === "switch_task_to_cross_family_fallback") {
      expect(ttftAndCanaryDecision.breachedMetrics).toEqual(["p95TtftMs", "canaryFailureRate"]);
      expect(ttftAndCanaryDecision.withinDetectionSla).toBe(true);
    }
  });

  it("rejects same-family fallback configuration", () => {
    expect(() =>
      evaluateDriftCanarySentinel({
        route: {
          primary: baseRoute.primary,
          fallback: { ...baseRoute.primary, modelId: "gpt-5.4" },
        },
        thresholds: baseThresholds,
        windows: [],
      }),
    ).toThrow(RangeError);
  });

  it("enforces zero double-billing settlement across failed primary, double failure, and race dual-success", () => {
    const primaryFailFallbackWin = reconcileFailoverBillingSettlement({
      requestId: "req-1",
      taskKind: "tutor_turn",
      primaryAttempt: {
        providerFamily: "openai",
        modelId: "gpt-5.4-mini",
        outcome: "sse_circuit_broken",
        providerCostMicroUnits: 320,
        quotedLearnerDebitMicroUnits: 500,
      },
      fallbackAttempt: {
        providerFamily: "anthropic",
        modelId: "claude-sonnet-4-6",
        outcome: "succeeded",
        providerCostMicroUnits: 410,
        quotedLearnerDebitMicroUnits: 600,
      },
    });
    expect(primaryFailFallbackWin).toMatchObject({
      primaryLearnerChargeMicroUnits: 0,
      fallbackLearnerChargeMicroUnits: 600,
      totalLearnerChargeMicroUnits: 600,
      voidedFailedPrimary: true,
      voidedFailedFallback: false,
      duplicateChargePrevented: false,
      billedExecution: "fallback",
      internalProviderTelemetry: {
        primaryProviderCostMicroUnits: 320,
        fallbackProviderCostMicroUnits: 410,
        totalInternalProviderCostMicroUnits: 730,
      },
    });

    const bothFailed = reconcileFailoverBillingSettlement({
      requestId: "req-2",
      taskKind: "tutor_turn",
      primaryAttempt: {
        providerFamily: "openai",
        modelId: "gpt-5.4-mini",
        outcome: "timed_out",
        providerCostMicroUnits: 200,
        quotedLearnerDebitMicroUnits: 500,
      },
      fallbackAttempt: {
        providerFamily: "anthropic",
        modelId: "claude-sonnet-4-6",
        outcome: "failed",
        providerCostMicroUnits: 150,
        quotedLearnerDebitMicroUnits: 600,
      },
    });
    expect(bothFailed.totalLearnerChargeMicroUnits).toBe(0);
    expect(bothFailed.voidedFailedPrimary).toBe(true);
    expect(bothFailed.voidedFailedFallback).toBe(true);
    expect(bothFailed.billedExecution).toBeNull();

    const raceDualSuccess = reconcileFailoverBillingSettlement({
      requestId: "req-3",
      taskKind: "tutor_turn",
      primaryAttempt: {
        providerFamily: "openai",
        modelId: "gpt-5.4-mini",
        outcome: "succeeded",
        providerCostMicroUnits: 300,
        quotedLearnerDebitMicroUnits: 500,
      },
      fallbackAttempt: {
        providerFamily: "anthropic",
        modelId: "claude-sonnet-4-6",
        outcome: "succeeded",
        providerCostMicroUnits: 400,
        quotedLearnerDebitMicroUnits: 600,
      },
    });
    expect(raceDualSuccess.totalLearnerChargeMicroUnits).toBe(500);
    expect(raceDualSuccess.fallbackLearnerChargeMicroUnits).toBe(0);
    expect(raceDualSuccess.duplicateChargePrevented).toBe(true);
    expect(raceDualSuccess.billedExecution).toBe("primary");
  });
});

describe("B. Multi-Source Nested Envelope Crypto-Shredding & Quarantine Restore", () => {
  const initialTree: WorkspaceKeyTree = {
    workspaceId: "ws-1",
    masterKey: {
      workspaceKeyId: "kw-1",
      keyVersion: 1,
      status: "active",
      privacyEpoch: 1,
      createdAtMs: 1_000,
      shreddedAtMs: null,
    },
    sources: [
      {
        sourceId: "src-a",
        sourceKeyId: "ks-a",
        wrappedByWorkspaceKeyId: "kw-1",
        status: "active",
        privacyEpoch: 1,
        createdAtMs: 1_100,
        shreddedAtMs: null,
      },
      {
        sourceId: "src-b",
        sourceKeyId: "ks-b",
        wrappedByWorkspaceKeyId: "kw-1",
        status: "active",
        privacyEpoch: 1,
        createdAtMs: 1_200,
        shreddedAtMs: null,
      },
    ],
  };

  it("shreds a single source K_s without disturbing sibling K_s' or K_w, obeys 0014 append-only rules, and runs idempotent N_i' rollback", () => {
    const firstRun = planAndExecuteCryptoShred({
      keyTree: initialTree,
      target: { kind: "source", sourceId: "src-a" },
      executedAtMs: 10_000,
      mutableInventory: {
        pgvectorChunks: [
          { sourceId: "src-a", chunkId: "chk-2", sourceVersion: 1, modelKey: "embed-1" },
          { sourceId: "src-a", chunkId: "chk-1", sourceVersion: 1, modelKey: "embed-1" },
          { sourceId: "src-b", chunkId: "chk-b1", sourceVersion: 1, modelKey: "embed-1" },
        ],
        redisKeys: [
          { sourceId: "src-a", key: "hot:src-a:1" },
          { sourceId: "src-b", key: "hot:src-b:1" },
        ],
        s3Objects: [
          { sourceId: "src-a", bucket: "assets", objectKey: "ws-1/src-a.pdf", versionId: "v1" },
          { sourceId: "src-b", bucket: "assets", objectKey: "ws-1/src-b.pdf", versionId: "v1" },
        ],
      },
      affectedItemRevisions: [
        {
          itemRevisionId: "rev-mmle-to-t1",
          sourceId: "src-a",
          currentSampleCount: 52,
          shreddedFirstIndependentSubmissionIds: ["sub-1", "sub-2", "sub-3", "sub-2"],
        },
        {
          itemRevisionId: "rev-to-t0",
          sourceId: "src-a",
          currentSampleCount: 2,
          shreddedFirstIndependentSubmissionIds: ["sub-a", "sub-b", "sub-c"],
        },
        {
          itemRevisionId: "rev-sibling-src-b",
          sourceId: "src-b",
          currentSampleCount: 60,
          shreddedFirstIndependentSubmissionIds: ["sub-x"],
        },
      ],
    });

    expect(firstRun.appendOnlyCompliant).toBe(true);
    expect(firstRun.immutableAppendOnlyDeletes).toEqual([]);
    expect(firstRun.receipt.preservedImmutableTables).toEqual([IMMUTABLE_LEDGER_TABLE_0014]);
    expect(firstRun.nextKeyTree.masterKey.status).toBe("active");
    expect(firstRun.receipt.preservedWorkspaceKeyId).toBe("kw-1");
    expect(firstRun.receipt.shreddedSourceKeyIds).toEqual(["ks-a"]);
    expect(firstRun.receipt.preservedSourceKeyIds).toEqual(["ks-b"]);
    expect(firstRun.nextKeyTree.sources.find((s) => s.sourceId === "src-a")?.status).toBe("shredded");
    expect(firstRun.nextKeyTree.sources.find((s) => s.sourceId === "src-b")?.status).toBe("active");

    expect(firstRun.mutablePurges.pgvectorEmbeddings0084).toEqual([
      {
        table: PGVECTOR_EMBEDDINGS_TABLE_0084,
        workspaceId: "ws-1",
        sourceId: "src-a",
        chunkIds: ["chk-1", "chk-2"],
        deleteFilter: { workspaceId: "ws-1", sourceId: "src-a" },
      },
    ]);
    expect(firstRun.mutablePurges.redisHotKeys).toEqual(["hot:src-a:1"]);
    expect(firstRun.mutablePurges.s3ObjectVersionKeys).toEqual([
      { bucket: "assets", objectKey: "ws-1/src-a.pdf", versionId: "v1", sourceId: "src-a" },
    ]);

    expect(firstRun.calibrationRollbacks).toEqual([
      {
        itemRevisionId: "rev-mmle-to-t1",
        previousSampleCount: 52,
        newlyShreddedCount: 3,
        deduplicatedSkippedCount: 1,
        nextSampleCount: 49,
        postShredTier: "tier1_difficulty_only",
        appliedSubmissionIds: ["sub-1", "sub-2", "sub-3"],
      },
      {
        itemRevisionId: "rev-to-t0",
        previousSampleCount: 2,
        newlyShreddedCount: 3,
        deduplicatedSkippedCount: 0,
        nextSampleCount: 0,
        postShredTier: "tier0_prior",
        appliedSubmissionIds: ["sub-a", "sub-b", "sub-c"],
      },
      {
        itemRevisionId: "rev-sibling-src-b",
        previousSampleCount: 60,
        newlyShreddedCount: 0,
        deduplicatedSkippedCount: 0,
        nextSampleCount: 60,
        postShredTier: "tier2_mmle",
        appliedSubmissionIds: [],
      },
    ]);

    // Re-running the shred is 100% idempotent and never double-decrements N_i'
    const replay = planAndExecuteCryptoShred({
      keyTree: firstRun.nextKeyTree,
      target: { kind: "source", sourceId: "src-a" },
      executedAtMs: 12_000,
      existingReceipts: [firstRun.receipt],
      affectedItemRevisions: [
        {
          itemRevisionId: "rev-mmle-to-t1",
          sourceId: "src-a",
          currentSampleCount: 49,
          shreddedFirstIndependentSubmissionIds: ["sub-1", "sub-2", "sub-3"],
        },
      ],
    });
    expect(replay.receipt.newlyApplied).toBe(false);
    expect(replay.calibrationRollbacks[0]).toMatchObject({
      previousSampleCount: 49,
      newlyShreddedCount: 0,
      deduplicatedSkippedCount: 3,
      nextSampleCount: 49,
      postShredTier: "tier1_difficulty_only",
    });
  });

  it("supports full workspace shred destroying K_w and all K_s while keeping 0014 append-only and aggregating multi-row itemRevisionId rollbacks", () => {
    const wsShred = planAndExecuteCryptoShred({
      keyTree: initialTree,
      target: { kind: "workspace" },
      executedAtMs: 20_000,
      affectedItemRevisions: [
        {
          itemRevisionId: "rev-multi-source",
          sourceId: "src-a",
          currentSampleCount: 52,
          shreddedFirstIndependentSubmissionIds: ["sub-1"],
        },
        {
          itemRevisionId: "rev-multi-source",
          sourceId: "src-b",
          currentSampleCount: 52,
          shreddedFirstIndependentSubmissionIds: ["sub-2", "sub-3", "sub-1"],
        },
      ],
    });

    expect(wsShred.appendOnlyCompliant).toBe(true);
    expect(wsShred.immutableAppendOnlyDeletes).toEqual([]);
    expect(wsShred.nextKeyTree.masterKey.status).toBe("shredded");
    expect(wsShred.receipt.shreddedWorkspaceKeyId).toBe("kw-1");
    expect(wsShred.receipt.shreddedSourceIds).toEqual(["src-a", "src-b"]);
    expect(wsShred.receipt.shreddedSourceKeyIds).toEqual(["ks-a", "ks-b"]);
    expect(wsShred.nextKeyTree.sources.every((s) => s.status === "shredded")).toBe(true);
    expect(deriveCalibrationTier(50)).toBe("tier2_mmle");
    expect(wsShred.calibrationRollbacks).toEqual([
      {
        itemRevisionId: "rev-multi-source",
        previousSampleCount: 52,
        newlyShreddedCount: 3,
        deduplicatedSkippedCount: 1,
        nextSampleCount: 49,
        postShredTier: "tier1_difficulty_only",
        appliedSubmissionIds: ["sub-1", "sub-2", "sub-3"],
      },
    ]);

    // After tree compaction/rebuild (new active K_w and empty sources), receipt still blocks sourceKeyId-only restore
    const rebuiltKeyTree: WorkspaceKeyTree = {
      workspaceId: "ws-1",
      masterKey: {
        workspaceKeyId: "kw-2",
        keyVersion: 2,
        status: "active",
        privacyEpoch: 2,
        createdAtMs: 25_000,
        shreddedAtMs: null,
      },
      sources: [],
    };
    const postCompactionRestore = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-post-compaction",
      policy: "strict_atomic",
      liveKeyTree: rebuiltKeyTree,
      existingReceipts: [wsShred.receipt],
      records: [
        {
          recordId: "rec-compacted-source-key-only",
          recordType: "source_chunk",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-2",
          sourceId: null,
          sourceKeyId: "ks-b",
          privacyEpoch: 2,
        },
      ],
    });
    expect(postCompactionRestore.status).toBe("rejected_shredded_lineage");
    expect(postCompactionRestore.rejectedRecords.map((r) => [r.recordId, r.reason])).toEqual([
      ["rec-compacted-source-key-only", "shredded_source_key"],
    ]);
  });

  it("fails closed on source-scoped records missing both sourceId and sourceKeyId while permitting explicit workspace metadata", () => {
    const result = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-missing-source-lineage",
      policy: "strip_shredded_lineage",
      liveKeyTree: initialTree,
      records: [
        {
          recordId: "rec-chunk-no-lineage",
          recordType: "source_chunk",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: null,
          privacyEpoch: 1,
        },
        {
          recordId: "rec-embedding-no-lineage",
          recordType: "source_embedding",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-1",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-explicit-required",
          recordType: "workspace_metadata",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-1",
          requiresSourceLineage: true,
          privacyEpoch: 1,
        },
        {
          recordId: "rec-workspace-meta",
          recordType: "workspace_metadata",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: null,
          privacyEpoch: 1,
        },
        {
          recordId: "rec-explicit-exempt",
          recordType: "custom_note",
          workspaceId: "ws-1",
          workspaceKeyId: "kw-1",
          requiresSourceLineage: false,
          privacyEpoch: 1,
        },
      ],
    });

    expect(result.status).toBe("approved_after_filtering");
    expect(result.approvedRecords.map((r) => r.recordId)).toEqual([
      "rec-workspace-meta",
      "rec-explicit-exempt",
    ]);
    expect(result.rejectedRecords.map((r) => [r.recordId, r.reason])).toEqual([
      ["rec-chunk-no-lineage", "missing_source_lineage"],
      ["rec-embedding-no-lineage", "missing_source_lineage"],
      ["rec-explicit-required", "missing_source_lineage"],
    ]);
  });

  it("quarantines and blocks/strips shredded keys, revoked sources, and stale privacyEpochs before live apply", () => {
    const afterSingleShred = planAndExecuteCryptoShred({
      keyTree: initialTree,
      target: { kind: "source", sourceId: "src-a" },
      executedAtMs: 10_000,
    });

    const records = [
      {
        recordId: "rec-clean-sibling",
        recordType: "source_chunk",
        workspaceId: "ws-1",
        workspaceKeyId: "kw-1",
        sourceId: "src-b",
        sourceKeyId: "ks-b",
        privacyEpoch: 1,
      },
      {
        recordId: "rec-shredded-source-key",
        recordType: "learning_event",
        workspaceId: "ws-1",
        workspaceKeyId: "kw-1",
        sourceId: "src-a",
        sourceKeyId: "ks-a",
        privacyEpoch: 1,
      },
      {
        recordId: "rec-stale-epoch",
        recordType: "source_chunk",
        workspaceId: "ws-1",
        workspaceKeyId: "kw-1",
        sourceId: "src-b",
        sourceKeyId: "ks-b",
        privacyEpoch: 0,
      },
    ];

    const strict = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-1",
      policy: "strict_atomic",
      liveKeyTree: afterSingleShred.nextKeyTree,
      existingReceipts: [afterSingleShred.receipt],
      records,
    });
    expect(strict.stagingZone).toBe("quarantine");
    expect(strict.status).toBe("rejected_shredded_lineage");
    expect(strict.liveApplyAllowed).toBe(false);
    expect(strict.approvedRecords).toEqual([]);
    expect(strict.rejectedRecords.map((r) => [r.recordId, r.reason])).toEqual([
      ["rec-shredded-source-key", "shredded_source_key"],
      ["rec-stale-epoch", "stale_privacy_epoch"],
    ]);

    const filtered = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-2",
      policy: "strip_shredded_lineage",
      liveKeyTree: afterSingleShred.nextKeyTree,
      existingReceipts: [afterSingleShred.receipt],
      records,
    });
    expect(filtered.status).toBe("approved_after_filtering");
    expect(filtered.liveApplyAllowed).toBe(true);
    expect(filtered.approvedRecords.map((r) => r.recordId)).toEqual([
      "rec-clean-sibling",
    ]);

    const cleanOnly = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-3",
      policy: "strict_atomic",
      liveKeyTree: afterSingleShred.nextKeyTree,
      records: [records[0]!],
    });
    expect(cleanOnly.status).toBe("approved_clean");
    expect(cleanOnly.liveApplyAllowed).toBe(true);
  });

  it("fails closed for sourceKeyId-only restore records (deleted without receipt, revoked, stale source epoch, rotated sourceKeyId)", () => {
    const keyTree: WorkspaceKeyTree = {
      workspaceId: "ws-key-only",
      masterKey: {
        workspaceKeyId: "kw-1",
        keyVersion: 1,
        status: "active",
        privacyEpoch: 1,
        createdAtMs: 1_000,
        shreddedAtMs: null,
      },
      sources: [
        {
          sourceId: "src-revoked",
          sourceKeyId: "ks-revoked",
          wrappedByWorkspaceKeyId: "kw-1",
          status: "revoked",
          privacyEpoch: 1,
          createdAtMs: 1_100,
          shreddedAtMs: null,
        },
        {
          sourceId: "src-epoch-bumped",
          sourceKeyId: "ks-epoch-2",
          wrappedByWorkspaceKeyId: "kw-1",
          status: "active",
          privacyEpoch: 2,
          createdAtMs: 1_200,
          shreddedAtMs: null,
        },
        {
          sourceId: "src-rotated",
          sourceKeyId: "ks-rotated-v2",
          wrappedByWorkspaceKeyId: "kw-1",
          status: "active",
          privacyEpoch: 1,
          createdAtMs: 1_300,
          shreddedAtMs: null,
        },
      ],
    };

    const result = evaluateQuarantineRestoreBundle({
      bundleId: "bundle-source-key-only",
      policy: "strip_shredded_lineage",
      liveKeyTree: keyTree,
      records: [
        {
          recordId: "rec-deleted-no-receipt",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: "ks-pruned-deleted",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-revoked-source",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: "ks-revoked",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-stale-source-epoch",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: "ks-epoch-2",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-rotated-key-only",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: "ks-rotated-v1",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-rotated-mismatched-with-source-id",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: "src-rotated",
          sourceKeyId: "ks-rotated-v1",
          privacyEpoch: 1,
        },
        {
          recordId: "rec-valid-epoch-2",
          recordType: "learning_event",
          workspaceId: "ws-key-only",
          workspaceKeyId: "kw-1",
          sourceId: null,
          sourceKeyId: "ks-epoch-2",
          privacyEpoch: 2,
        },
      ],
    });

    expect(result.status).toBe("approved_after_filtering");
    expect(result.approvedRecords.map((r) => r.recordId)).toEqual([
      "rec-valid-epoch-2",
    ]);
    expect(result.rejectedRecords.map((r) => [r.recordId, r.reason])).toEqual([
      ["rec-deleted-no-receipt", "stale_source_key"],
      ["rec-revoked-source", "revoked_or_deleted_source"],
      ["rec-stale-source-epoch", "stale_privacy_epoch"],
      ["rec-rotated-key-only", "stale_source_key"],
      ["rec-rotated-mismatched-with-source-id", "stale_source_key"],
    ]);

    expect(() =>
      evaluateQuarantineRestoreBundle({
        bundleId: "bundle-dup-key",
        policy: "strict_atomic",
        liveKeyTree: {
          ...keyTree,
          sources: [
            keyTree.sources[0]!,
            { ...keyTree.sources[1]!, sourceKeyId: "ks-revoked" },
          ],
        },
        records: [],
      }),
    ).toThrow(RangeError);
  });
});

describe("C. Expand-Contract Canary Router & < 5s Candidate Publish Lease Rollback", () => {
  it("maps subjects deterministically with strict monotonic subset inclusion across 0% -> 1% -> 10% -> 100%", () => {
    expect(CANARY_ROLLOUT_STAGES).toEqual([
      "0_percent",
      "1_percent",
      "10_percent",
      "100_percent",
    ]);
    expect(CANDIDATE_PUBLISH_LEASE_TTL_MS).toBe(2_000);
    expect(EMERGENCY_ROLLBACK_SLA_MS).toBe(5_000);

    let count1 = 0;
    let count10 = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const subjectKey = `learner-${i}`;
      const bucket = computeCanaryHashBucket("rollout-r5", subjectKey);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(CANARY_BUCKET_SPACE);

      const r0 = routeExpandContractBucket({
        rolloutId: "rollout-r5",
        subjectKey,
        stage: "0_percent",
        schemaContractBackwardCompatible: true,
      });
      const r1 = routeExpandContractBucket({
        rolloutId: "rollout-r5",
        subjectKey,
        stage: "1_percent",
        schemaContractBackwardCompatible: true,
      });
      const r10 = routeExpandContractBucket({
        rolloutId: "rollout-r5",
        subjectKey,
        stage: "10_percent",
        schemaContractBackwardCompatible: true,
      });
      const r100 = routeExpandContractBucket({
        rolloutId: "rollout-r5",
        subjectKey,
        stage: "100_percent",
        schemaContractBackwardCompatible: true,
      });

      expect(r0.inCanary).toBe(false);
      expect(r100.inCanary).toBe(true);
      if (r1.inCanary) {
        count1 += 1;
        expect(r10.inCanary).toBe(true);
      }
      if (r10.inCanary) {
        count10 += 1;
        expect(r100.inCanary).toBe(true);
      }
    }

    expect(count1).toBeGreaterThan(15);
    expect(count1).toBeLessThan(80);
    expect(count10).toBeGreaterThan(320);
    expect(count10).toBeLessThan(480);
  });

  it("refuses promotion above 0_percent when Expand-Contract compatibility is false", () => {
    const state = createCanaryRolloutState({
      rolloutId: "rollout-compat",
      schemaContractBackwardCompatible: false,
    });
    const promotion = promoteCanaryRolloutStage(state, "1_percent");
    expect(promotion.promoted).toBe(false);
    expect(promotion.reason).toBe("expand_contract_backward_incompatible");
    expect(promotion.state.stage).toBe("0_percent");

    const routed = routeExpandContractBucket({
      rolloutId: "rollout-compat",
      subjectKey: "learner-42",
      stage: "100_percent",
      schemaContractBackwardCompatible: false,
    });
    expect(routed.inCanary).toBe(false);
    expect(routed.engine).toBe("baseline");
    expect(routed.reason).toBe("expand_contract_incompatible");
  });

  it("enforces 2s lease TTL, blocks stale partitioned renewals, clamps drain >= 0, and guarantees zero dirty writes within < 5s rollback SLA", () => {
    const initial = createCanaryRolloutState({
      rolloutId: "rollout-lease",
      schemaContractBackwardCompatible: true,
      stage: "10_percent",
      epoch: 3,
      synchronizedAtMs: 10_000,
    });

    // Missing authoritative snapshot or stale sync fails closed
    expect(
      acquireCandidatePublishLease(
        { ...initial, synchronizedAtMs: null },
        "worker-no-sync",
        10_000,
      ),
    ).toEqual({
      granted: false,
      lease: null,
      reason: "stale_authoritative_snapshot",
    });

    const acquired = acquireCandidatePublishLease(initial, "worker-1", 10_000);
    expect(acquired.granted).toBe(true);
    if (!acquired.granted) return;

    expect(acquired.lease.rolloutEpoch).toBe(3);
    expect(acquired.lease.expiresAtMs).toBe(12_000);

    // Valid commit within 2s TTL
    expect(validateCandidateCommitFence(initial, acquired.lease, 12_000)).toMatchObject({
      allowed: true,
      dirtyWritePrevented: false,
      reason: "lease_valid",
    });

    // Expired commit (> 2,000 ms) fails closed
    expect(validateCandidateCommitFence(initial, acquired.lease, 12_001)).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_expired",
    });

    // Revoked lease fails closed immediately
    const revoked = revokeCandidatePublishLease(acquired.lease);
    expect(validateCandidateCommitFence(initial, revoked, 10_500)).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_revoked",
    });

    // Emergency rollback atomically drops stage to 0_percent, bumps epoch, and bounds drain <= 2s (< 5s SLA)
    const rollback = triggerEmergencyRollback(
      initial,
      "canary_drift_breach",
      11_000,
    );
    expect(rollback.nextState.stage).toBe("0_percent");
    expect(rollback.nextState.emergencyRollbackActive).toBe(true);
    expect(rollback.nextState.epoch).toBe(4);
    expect(rollback.rollbackDeadlineAtMs).toBe(13_000);
    expect(rollback.maxDrainWindowMs).toBe(2_000);
    expect(rollback.withinRollbackSla).toBe(true);
    expect(rollback.rollbackDeadlineAtMs - rollback.rollbackTriggeredAtMs).toBeLessThan(
      EMERGENCY_ROLLBACK_SLA_MS,
    );

    // Already-expired activeLeases never produce a negative maxDrainWindowMs
    const expiredDrainRollback = triggerEmergencyRollback(
      initial,
      "already_expired_leases",
      15_000,
      [acquired.lease],
    );
    expect(expiredDrainRollback.maxDrainWindowMs).toBe(0);
    expect(expiredDrainRollback.rollbackDeadlineAtMs).toBe(15_000);
    expect(expiredDrainRollback.withinRollbackSla).toBe(true);

    // Authoritative coordinator state immediately rejects any in-flight lease
    expect(
      validateCandidateCommitFence(rollback.nextState, acquired.lease, 11_100),
    ).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "emergency_rollback_active",
    });

    // Partitioned worker passing its STALE local state alongside authoritativeStoreState is rejected immediately
    expect(
      validateCandidateCommitFence(
        initial,
        acquired.lease,
        11_100,
        rollback.nextState,
      ),
    ).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "emergency_rollback_active",
      stateEpoch: 4,
      leaseEpoch: 3,
    });

    // Partitioned worker trying to renew against stale local state AFTER sync TTL (> 2_000 ms) is rejected
    expect(
      acquireCandidatePublishLease(initial, "worker-1", 12_500),
    ).toEqual({
      granted: false,
      lease: null,
      reason: "stale_authoritative_snapshot",
    });

    // Even if renewed slightly before sync TTL expiry (11_500, syncAt 10_000), lease expiry is bounded <= syncAt + 2_000 <= rollbackAt + 2_000
    const earlyRenew = acquireCandidatePublishLease(initial, "worker-1", 11_500);
    expect(earlyRenew.granted).toBe(true);
    if (earlyRenew.granted) {
      expect(earlyRenew.lease.expiresAtMs).toBeLessThanOrEqual(rollback.rollbackDeadlineAtMs);
      expect(
        validateCandidateCommitFence(
          initial,
          earlyRenew.lease,
          rollback.rollbackDeadlineAtMs + 1,
        ),
      ).toMatchObject({
        allowed: false,
        dirtyWritePrevented: true,
        reason: "lease_expired",
      });
    }

    // Even a network-partitioned worker evaluating against its STALE pre-rollback state
    // cannot commit past its 2s TTL (well before the 5s SLA deadline)
    expect(
      validateCandidateCommitFence(initial, acquired.lease, rollback.rollbackDeadlineAtMs + 1),
    ).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_expired",
    });

    // Rollback refuses new lease acquisition
    expect(acquireCandidatePublishLease(rollback.nextState, "worker-2", 11_500)).toEqual({
      granted: false,
      lease: null,
      reason: "emergency_rollback_active",
    });

    // Even if emergencyRollbackActive were cleared later at a new epoch, old-epoch lease stays fenced out
    const reenabledEpochState = {
      ...rollback.nextState,
      stage: "1_percent" as const,
      emergencyRollbackActive: false,
    };
    expect(
      validateCandidateCommitFence(reenabledEpochState, acquired.lease, 11_200),
    ).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "stale_rollout_epoch",
      stateEpoch: 4,
      leaseEpoch: 3,
    });

    // Non-finite lease timestamps fail closed rather than slipping past comparisons
    expect(
      validateCandidateCommitFence(
        initial,
        { ...acquired.lease, issuedAtMs: Number.NaN, expiresAtMs: Number.NaN },
        10_500,
      ),
    ).toMatchObject({
      allowed: false,
      dirtyWritePrevented: true,
      reason: "lease_expired",
    });

    // Validation guards for evaluatedAtMs and trimmed same-family billing
    expect(() =>
      evaluateDriftCanarySentinel({
        route: baseRoute,
        thresholds: baseThresholds,
        windows: [],
        evaluatedAtMs: -1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      reconcileFailoverBillingSettlement({
        requestId: "req-same-family-trim",
        taskKind: "tutor_turn",
        primaryAttempt: {
          providerFamily: "openai",
          modelId: "gpt-5.4-mini",
          outcome: "failed",
          providerCostMicroUnits: 100,
          quotedLearnerDebitMicroUnits: 200,
        },
        fallbackAttempt: {
          providerFamily: " openai ",
          modelId: "gpt-5.4",
          outcome: "succeeded",
          providerCostMicroUnits: 120,
          quotedLearnerDebitMicroUnits: 200,
        },
      }),
    ).toThrow(RangeError);
  });
});
