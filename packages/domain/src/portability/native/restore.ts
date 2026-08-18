import type {
  BackupConflictPolicy,
  BackupIdentityCounts,
  LossEntry,
  NativeBackupPackage,
} from "@aistudy/contracts";
import { NativeBackupError } from "./errors";
import { assertFileHashes } from "./files";
import { emptyBackupCounts } from "./package";
import {
  RESTORE_TOPOLOGY,
  type ExistingBackupIds,
  type NativeBackupRecord,
  type RestoreCollection,
} from "./types";

export type RestoreStep = {
  collection: RestoreCollection;
  records: NativeBackupRecord[];
};

export type NativeRestorePlan = {
  conflictPolicy: BackupConflictPolicy;
  steps: RestoreStep[];
  applied: BackupIdentityCounts;
  skipped: BackupIdentityCounts;
  warnings: LossEntry[];
  records: NativeBackupPackage["records"] & { workspaceId: string };
};

export function planNativeRestore(input: {
  packed: NativeBackupPackage;
  targetWorkspaceId: string;
  targetOwnerUserId: string;
  existingIds: ExistingBackupIds;
  conflictPolicy: BackupConflictPolicy;
  compatibleMigrationIds: string[];
}): NativeRestorePlan {
  assertCompatible(input.packed, input.compatibleMigrationIds);
  assertFileHashes(input.packed.files);

  const applied = emptyBackupCounts();
  const skipped = emptyBackupCounts();
  const warnings: LossEntry[] = [];
  const kept: Record<RestoreCollection, NativeBackupRecord[]> = {
    courses: [],
    documents: [],
    blocks: [],
    revisions: [],
    relations: [],
    memberships: [],
    goals: [],
    windows: [],
    explorations: [],
    promotions: [],
    cards: [],
    events: [],
  };

  for (const collection of RESTORE_TOPOLOGY) {
    const existing = new Set(input.existingIds[collection] ?? []);
    for (const record of asRecords(input.packed.records[collection])) {
      if (!existing.has(record.id)) {
        kept[collection].push(remap(record, input.targetWorkspaceId, input.targetOwnerUserId));
        continue;
      }
      if (input.conflictPolicy === "reject") {
        throw new NativeBackupError(
          "ID_CONFLICT",
          `Existing ${collection} id ${record.id} would be overwritten`,
        );
      }
      skipped[countKey(collection)] += 1;
      warnings.push({
        code: "id-conflict",
        feature: collection,
        message: `Existing ${collection} id was skipped.`,
        ...warningSubject(collection, record.id),
      });
    }
  }

  applied.workspaces = 1;
  applied.files = input.packed.files.length;
  for (const collection of RESTORE_TOPOLOGY) {
    applied[countKey(collection)] = kept[collection].length;
  }

  return {
    conflictPolicy: input.conflictPolicy,
    steps: RESTORE_TOPOLOGY.map((collection) => ({ collection, records: kept[collection] })),
    applied,
    skipped,
    warnings,
    records: {
      workspace: { ...input.packed.records.workspace, id: input.targetWorkspaceId },
      workspaceId: input.targetWorkspaceId,
      courses: kept.courses,
      memberships: kept.memberships,
      goals: kept.goals,
      windows: kept.windows,
      documents: kept.documents,
      blocks: kept.blocks,
      relations: kept.relations,
      revisions: kept.revisions,
      explorations: kept.explorations,
      promotions: kept.promotions,
      cards: kept.cards,
      events: kept.events,
    },
  };
}

function assertCompatible(packed: NativeBackupPackage, compatibleMigrationIds: string[]): void {
  if (!compatibleMigrationIds.includes(packed.schemaManifest.latestMigrationId)) {
    throw new NativeBackupError(
      "INCOMPATIBLE_SCHEMA",
      `Backup migration ${packed.schemaManifest.latestMigrationId} is not compatible`,
    );
  }
}

function asRecords(value: unknown): NativeBackupRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is NativeBackupRecord => {
    return Boolean(item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");
  });
}

function remap(
  record: NativeBackupRecord,
  workspaceId: string,
  ownerUserId: string,
): NativeBackupRecord {
  return {
    ...record,
    workspaceId,
    ...(typeof record.ownerUserId === "string" ? { ownerUserId } : {}),
  };
}

function countKey(collection: RestoreCollection): keyof BackupIdentityCounts {
  return collection;
}

function warningSubject(collection: RestoreCollection, id: string): Partial<LossEntry> {
  if (collection === "documents" || collection === "blocks" || collection === "revisions") {
    return { documentId: id };
  }
  if (collection === "cards") return { cardId: id };
  return {};
}
