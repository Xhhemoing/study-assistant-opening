import type {
  AffectedCalibrationItemInput,
  CalibrationCountRollbackResult,
  CalibrationTier,
  CryptoShredExecutionInput,
  CryptoShredExecutionResult,
  CryptoShredTombstoneReceipt,
  MutableStorePurgeDescriptors,
  PgvectorPurgeDescriptor,
  QuarantinedRecordRejection,
  QuarantineRejectReason,
  QuarantineRestoreInput,
  QuarantineRestoreRecord,
  QuarantineRestoreResult,
  S3ObjectVersionPurgeDescriptor,
  SourceEnvelopeKey,
  WorkspaceKeyTree,
} from "./types";

export const IMMUTABLE_LEDGER_TABLE_0014 = "learning_events" as const;
export const PGVECTOR_EMBEDDINGS_TABLE_0084 =
  "opening_source_embeddings" as const;
export const TIER2_MMLE_MIN_SAMPLES = 50 as const;

function assertNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function assertNonNegativeInt(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function submissionCompoundKey(
  itemRevisionId: string,
  submissionId: string,
): string {
  return `${itemRevisionId}\u0000${submissionId}`;
}

export function deriveCalibrationTier(sampleCount: number): CalibrationTier {
  const count = assertNonNegativeInt(sampleCount, "sampleCount");
  if (count === 0) return "tier0_prior";
  if (count < TIER2_MMLE_MIN_SAMPLES) return "tier1_difficulty_only";
  return "tier2_mmle";
}

function validateKeyTree(keyTree: WorkspaceKeyTree): void {
  assertNonEmpty(keyTree.workspaceId, "keyTree.workspaceId");
  assertNonEmpty(
    keyTree.masterKey.workspaceKeyId,
    "keyTree.masterKey.workspaceKeyId",
  );
  assertNonNegativeInt(
    keyTree.masterKey.keyVersion,
    "keyTree.masterKey.keyVersion",
  );
  assertNonNegativeInt(
    keyTree.masterKey.privacyEpoch,
    "keyTree.masterKey.privacyEpoch",
  );

  const seenSourceIds = new Set<string>();
  for (const source of keyTree.sources) {
    assertNonEmpty(source.sourceId, "source.sourceId");
    assertNonEmpty(source.sourceKeyId, "source.sourceKeyId");
    assertNonNegativeInt(source.privacyEpoch, "source.privacyEpoch");
    if (seenSourceIds.has(source.sourceId)) {
      throw new RangeError(
        `Duplicate sourceId in keyTree.sources: ${source.sourceId}`,
      );
    }
    seenSourceIds.add(source.sourceId);
    if (source.wrappedByWorkspaceKeyId !== keyTree.masterKey.workspaceKeyId) {
      throw new RangeError(
        `Source key ${source.sourceKeyId} is not wrapped by workspace master key ${keyTree.masterKey.workspaceKeyId}`,
      );
    }
  }
}

function buildMutablePurgeDescriptors(
  workspaceId: string,
  targetSourceIds: readonly string[],
  inventory: CryptoShredExecutionInput["mutableInventory"],
): MutableStorePurgeDescriptors {
  const sortedSourceIds = [...new Set(targetSourceIds)].sort();
  const targetSourceSet = new Set(sortedSourceIds);

  const pgvectorChunks = inventory?.pgvectorChunks;
  const pgvectorEmbeddings0084: PgvectorPurgeDescriptor[] = sortedSourceIds.map(
    (sourceId) => {
      const chunkIds = (pgvectorChunks ?? [])
        .filter((chunk) => chunk.sourceId === sourceId)
        .map((chunk) => chunk.chunkId)
        .sort();
      return {
        table: PGVECTOR_EMBEDDINGS_TABLE_0084,
        workspaceId,
        sourceId,
        chunkIds,
        deleteFilter: { workspaceId, sourceId },
      };
    },
  );

  const redisHotKeySet = new Set<string>();
  if (inventory?.redisKeys && inventory.redisKeys.length > 0) {
    for (const entry of inventory.redisKeys) {
      if (entry.sourceId === undefined || targetSourceSet.has(entry.sourceId)) {
        redisHotKeySet.add(entry.key);
      }
    }
  } else {
    for (const sourceId of sortedSourceIds) {
      redisHotKeySet.add(`aistudy:ws:${workspaceId}:src:${sourceId}:hot`);
      redisHotKeySet.add(`aistudy:ws:${workspaceId}:src:${sourceId}:chunks`);
    }
  }

  const s3ObjectVersionKeys: S3ObjectVersionPurgeDescriptor[] = (
    inventory?.s3Objects ?? []
  )
    .filter((obj) => targetSourceSet.has(obj.sourceId))
    .map((obj) => ({
      bucket: obj.bucket,
      objectKey: obj.objectKey,
      versionId: obj.versionId,
      sourceId: obj.sourceId,
    }))
    .sort((a, b) =>
      `${a.bucket}/${a.objectKey}#${a.versionId}`.localeCompare(
        `${b.bucket}/${b.objectKey}#${b.versionId}`,
      ),
    );

  return {
    pgvectorEmbeddings0084,
    redisHotKeys: [...redisHotKeySet].sort(),
    s3ObjectVersionKeys,
  };
}

function computeCalibrationRollbacks(
  revisions: readonly AffectedCalibrationItemInput[],
  target: CryptoShredExecutionInput["target"],
  priorShreddedKeys: ReadonlySet<string>,
): {
  rollbacks: CalibrationCountRollbackResult[];
  newlyAppliedKeys: string[];
} {
  const seenKeys = new Set(priorShreddedKeys);
  const newlyAppliedKeys: string[] = [];
  const rollbacks: CalibrationCountRollbackResult[] = [];

  for (const item of revisions) {
    const itemRevisionId = assertNonEmpty(
      item.itemRevisionId,
      "item.itemRevisionId",
    );
    const previousSampleCount = assertNonNegativeInt(
      item.currentSampleCount,
      "item.currentSampleCount",
    );

    if (
      target.kind === "source" &&
      item.sourceId !== undefined &&
      item.sourceId !== target.sourceId
    ) {
      rollbacks.push({
        itemRevisionId,
        previousSampleCount,
        newlyShreddedCount: 0,
        deduplicatedSkippedCount: 0,
        nextSampleCount: previousSampleCount,
        postShredTier: deriveCalibrationTier(previousSampleCount),
        appliedSubmissionIds: [],
      });
      continue;
    }

    const appliedSubmissionIds: string[] = [];
    for (const rawSubmissionId of item.shreddedFirstIndependentSubmissionIds) {
      const submissionId = assertNonEmpty(rawSubmissionId, "submissionId");
      const key = submissionCompoundKey(itemRevisionId, submissionId);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      newlyAppliedKeys.push(key);
      appliedSubmissionIds.push(submissionId);
    }

    const newlyShreddedCount = appliedSubmissionIds.length;
    const deduplicatedSkippedCount =
      item.shreddedFirstIndependentSubmissionIds.length - newlyShreddedCount;
    const nextSampleCount = Math.max(0, previousSampleCount - newlyShreddedCount);

    rollbacks.push({
      itemRevisionId,
      previousSampleCount,
      newlyShreddedCount,
      deduplicatedSkippedCount,
      nextSampleCount,
      postShredTier: deriveCalibrationTier(nextSampleCount),
      appliedSubmissionIds,
    });
  }

  return { rollbacks, newlyAppliedKeys };
}

export function planAndExecuteCryptoShred(
  input: CryptoShredExecutionInput,
): CryptoShredExecutionResult {
  validateKeyTree(input.keyTree);
  assertNonNegativeInt(input.executedAtMs, "executedAtMs");

  const existingReceipts = input.existingReceipts ?? [];
  const priorShreddedKeys = new Set<string>();
  for (const receipt of existingReceipts) {
    for (const key of receipt.appliedSubmissionKeys) {
      priorShreddedKeys.add(key);
    }
  }

  const workspaceId = input.keyTree.workspaceId;
  let nextMasterKey = { ...input.keyTree.masterKey };
  let nextSources: SourceEnvelopeKey[];
  let shreddedWorkspaceKeyId: string | null = null;
  let preservedWorkspaceKeyId: string | null = null;
  let shreddedSourceIds: string[] = [];
  let shreddedSourceKeyIds: string[] = [];
  let preservedSourceKeyIds: string[] = [];
  let newlyApplied = false;

  if (input.target.kind === "source") {
    const targetSourceId = assertNonEmpty(
      input.target.sourceId,
      "target.sourceId",
    );
    const matchingSource = input.keyTree.sources.find(
      (source) => source.sourceId === targetSourceId,
    );
    if (!matchingSource) {
      throw new RangeError(
        `Source ${targetSourceId} not found in workspace ${workspaceId} key tree`,
      );
    }

    preservedWorkspaceKeyId =
      nextMasterKey.status === "active" ? nextMasterKey.workspaceKeyId : null;

    nextSources = input.keyTree.sources.map((source) => {
      if (source.sourceId !== targetSourceId) {
        return { ...source };
      }
      if (source.status !== "shredded") {
        newlyApplied = true;
      }
      return {
        ...source,
        status: "shredded",
        privacyEpoch:
          source.status === "shredded"
            ? source.privacyEpoch
            : source.privacyEpoch + 1,
        shreddedAtMs: source.shreddedAtMs ?? input.executedAtMs,
      };
    });

    const updatedTarget = nextSources.find(
      (source) => source.sourceId === targetSourceId,
    )!;
    shreddedSourceIds = [updatedTarget.sourceId];
    shreddedSourceKeyIds = [updatedTarget.sourceKeyId];
    preservedSourceKeyIds = nextSources
      .filter((source) => source.sourceId !== targetSourceId && source.status === "active")
      .map((source) => source.sourceKeyId)
      .sort();
  } else {
    if (nextMasterKey.status !== "shredded") {
      newlyApplied = true;
      nextMasterKey = {
        ...nextMasterKey,
        status: "shredded",
        privacyEpoch: nextMasterKey.privacyEpoch + 1,
        shreddedAtMs: nextMasterKey.shreddedAtMs ?? input.executedAtMs,
      };
    }

    nextSources = input.keyTree.sources.map((source) => {
      if (source.status !== "shredded") {
        newlyApplied = true;
      }
      return {
        ...source,
        status: "shredded",
        privacyEpoch:
          source.status === "shredded"
            ? source.privacyEpoch
            : source.privacyEpoch + 1,
        shreddedAtMs: source.shreddedAtMs ?? input.executedAtMs,
      };
    });

    shreddedWorkspaceKeyId = nextMasterKey.workspaceKeyId;
    shreddedSourceIds = nextSources.map((source) => source.sourceId).sort();
    shreddedSourceKeyIds = nextSources
      .map((source) => source.sourceKeyId)
      .sort();
  }

  const { rollbacks, newlyAppliedKeys } = computeCalibrationRollbacks(
    input.affectedItemRevisions ?? [],
    input.target,
    priorShreddedKeys,
  );
  if (newlyAppliedKeys.length > 0) {
    newlyApplied = true;
  }

  const mutablePurges = buildMutablePurgeDescriptors(
    workspaceId,
    shreddedSourceIds,
    input.mutableInventory,
  );

  const targetDiscriminator =
    input.target.kind === "workspace"
      ? "workspace"
      : `source:${input.target.sourceId}`;
  const receipt: CryptoShredTombstoneReceipt = {
    receiptId: `tombstone:${workspaceId}:${targetDiscriminator}:${input.executedAtMs}`,
    workspaceId,
    target: input.target,
    issuedAtMs: input.executedAtMs,
    appendOnlyCompliant: true,
    immutableAppendOnlyDeletes: [],
    preservedImmutableTables: [IMMUTABLE_LEDGER_TABLE_0014],
    shreddedWorkspaceKeyId,
    shreddedSourceKeyIds,
    shreddedSourceIds,
    preservedWorkspaceKeyId,
    preservedSourceKeyIds,
    appliedSubmissionKeys: newlyAppliedKeys,
    newlyApplied,
  };

  return {
    nextKeyTree: {
      workspaceId,
      masterKey: nextMasterKey,
      sources: nextSources,
    },
    receipt,
    appendOnlyCompliant: true,
    immutableAppendOnlyDeletes: [],
    mutablePurges,
    calibrationRollbacks: rollbacks,
  };
}

function classifyQuarantineRecord(
  record: QuarantineRestoreRecord,
  liveKeyTree: WorkspaceKeyTree,
  shreddedWorkspaceKeyIds: ReadonlySet<string>,
  shreddedSourceKeyIds: ReadonlySet<string>,
  revokedSourceIds: ReadonlySet<string>,
  sourceById: ReadonlyMap<string, SourceEnvelopeKey>,
): QuarantineRejectReason | null {
  if (record.workspaceId !== liveKeyTree.workspaceId) {
    return "workspace_mismatch";
  }

  if (
    liveKeyTree.masterKey.status === "shredded" ||
    shreddedWorkspaceKeyIds.has(record.workspaceKeyId)
  ) {
    return "shredded_workspace_key";
  }

  if (record.sourceKeyId && shreddedSourceKeyIds.has(record.sourceKeyId)) {
    return "shredded_source_key";
  }

  const liveSource = record.sourceId
    ? sourceById.get(record.sourceId)
    : undefined;

  if (record.sourceId) {
    if (
      revokedSourceIds.has(record.sourceId) ||
      liveSource?.status === "shredded" ||
      liveSource?.status === "revoked"
    ) {
      return "revoked_or_deleted_source";
    }
  }

  if (record.privacyEpoch < liveKeyTree.masterKey.privacyEpoch) {
    return "stale_privacy_epoch";
  }

  if (liveSource && record.privacyEpoch < liveSource.privacyEpoch) {
    return "stale_privacy_epoch";
  }

  if (record.workspaceKeyId !== liveKeyTree.masterKey.workspaceKeyId) {
    return "unrecognized_workspace_key";
  }

  if (
    liveSource &&
    record.sourceKeyId &&
    record.sourceKeyId !== liveSource.sourceKeyId
  ) {
    return "stale_source_key";
  }

  if (record.sourceId && !liveSource) {
    return "revoked_or_deleted_source";
  }

  return null;
}

export function evaluateQuarantineRestoreBundle(
  input: QuarantineRestoreInput,
): QuarantineRestoreResult {
  const bundleId = assertNonEmpty(input.bundleId, "bundleId");
  validateKeyTree(input.liveKeyTree);

  const shreddedWorkspaceKeyIds = new Set<string>(input.shreddedKeyIds ?? []);
  const shreddedSourceKeyIds = new Set<string>(input.shreddedKeyIds ?? []);
  const revokedSourceIds = new Set<string>(input.revokedSourceIds ?? []);

  if (input.liveKeyTree.masterKey.status === "shredded") {
    shreddedWorkspaceKeyIds.add(input.liveKeyTree.masterKey.workspaceKeyId);
  }

  const sourceById = new Map<string, SourceEnvelopeKey>();
  for (const source of input.liveKeyTree.sources) {
    sourceById.set(source.sourceId, source);
    if (source.status === "shredded") {
      shreddedSourceKeyIds.add(source.sourceKeyId);
      revokedSourceIds.add(source.sourceId);
    } else if (source.status === "revoked") {
      revokedSourceIds.add(source.sourceId);
    }
  }

  for (const receipt of input.existingReceipts ?? []) {
    if (receipt.workspaceId !== input.liveKeyTree.workspaceId) continue;
    if (receipt.shreddedWorkspaceKeyId) {
      shreddedWorkspaceKeyIds.add(receipt.shreddedWorkspaceKeyId);
    }
    for (const keyId of receipt.shreddedSourceKeyIds) {
      shreddedSourceKeyIds.add(keyId);
    }
    for (const sourceId of receipt.shreddedSourceIds) {
      revokedSourceIds.add(sourceId);
    }
  }

  const cleanRecords: QuarantineRestoreRecord[] = [];
  const rejectedRecords: QuarantinedRecordRejection[] = [];

  for (const record of input.records) {
    assertNonEmpty(record.recordId, "record.recordId");
    assertNonEmpty(record.recordType, "record.recordType");
    assertNonEmpty(record.workspaceId, "record.workspaceId");
    assertNonEmpty(record.workspaceKeyId, "record.workspaceKeyId");
    assertNonNegativeInt(record.privacyEpoch, "record.privacyEpoch");

    const rejectionReason = classifyQuarantineRecord(
      record,
      input.liveKeyTree,
      shreddedWorkspaceKeyIds,
      shreddedSourceKeyIds,
      revokedSourceIds,
      sourceById,
    );

    if (rejectionReason) {
      rejectedRecords.push({
        recordId: record.recordId,
        recordType: record.recordType,
        sourceId: record.sourceId ?? null,
        sourceKeyId: record.sourceKeyId ?? null,
        workspaceKeyId: record.workspaceKeyId,
        privacyEpoch: record.privacyEpoch,
        reason: rejectionReason,
      });
    } else {
      cleanRecords.push(record);
    }
  }

  if (rejectedRecords.length === 0) {
    return {
      bundleId,
      stagingZone: "quarantine",
      policy: input.policy,
      status: "approved_clean",
      liveApplyAllowed: true,
      approvedRecords: cleanRecords,
      rejectedRecords: [],
    };
  }

  if (input.policy === "strict_atomic") {
    return {
      bundleId,
      stagingZone: "quarantine",
      policy: input.policy,
      status: "rejected_shredded_lineage",
      liveApplyAllowed: false,
      approvedRecords: [],
      rejectedRecords,
    };
  }

  return {
    bundleId,
    stagingZone: "quarantine",
    policy: input.policy,
    status: "approved_after_filtering",
    liveApplyAllowed: true,
    approvedRecords: cleanRecords,
    rejectedRecords,
  };
}
