import { rm } from "node:fs/promises";
import type { Sql } from "postgres";
import type { OpeningBackupObject } from "@aistudy/domain";
import type { OpeningBackupObjectReader } from "../storage/opening-backup-stage";
import { stageOpeningBackupObjects } from "../storage/opening-backup-stage";
import { assertOpeningBackupSnapshotCurrent } from "./opening-backup-current";
import {
  readOpeningBackupSources,
  type OpeningBackupSourceSnapshot,
} from "./opening-backup-sources";
import type { OpeningScope } from "./opening-sources";
import { copyMemoryDeletions } from "./opening-backup-memory-deletions";

export type OpeningSourceStaging = {
  directory: string;
  snapshot: OpeningBackupSourceSnapshot;
  objects: OpeningBackupObject[];
  unavailableSources?: Array<{ sourceId: string; version: number }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function copyScope(scope: OpeningScope): OpeningScope {
  if (!scope || !UUID.test(scope.workspaceId) || !UUID.test(scope.ownerUserId)) {
    throw new Error("invalid backup scope");
  }
  return { workspaceId: scope.workspaceId.toLowerCase(), ownerUserId: scope.ownerUserId.toLowerCase() };
}

function copySnapshot(snapshot: OpeningBackupSourceSnapshot): OpeningBackupSourceSnapshot {
  return {
    workspaceId: snapshot.workspaceId,
    privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: snapshot.deletionJournal.map((mark) => ({ ...mark })),
    memoryDeletions: copyMemoryDeletions(snapshot.memoryDeletions, snapshot.workspaceId),
    sources: snapshot.sources.map((source) => ({ ...source })),
  };
}

async function removeOwned(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: false });
  } catch {
    throw new Error("staging cleanup failed");
  }
}

/**
 * Stages current and captured historical source versions. This is not a composed archive or restore.
 * A later deletion can still race after the recheck. The caller owns a successful directory
 * and must supply a private parent; Windows ACL enforcement is not verified here.
 * Confirmed missing versions are returned for composition; compose rejects a missing current version.
 */
export async function prepareOpeningSourceBackup(
  sql: Sql,
  scope: OpeningScope,
  parentDirectory: string,
  reader: OpeningBackupObjectReader,
): Promise<OpeningSourceStaging> {
  const stable = copyScope(scope);
  const snapshot = copySnapshot(await readOpeningBackupSources(sql, stable));
  const staged = await stageOpeningBackupObjects(snapshot.sources, parentDirectory, reader, { allowUnavailable: true });
  try {
    await assertOpeningBackupSnapshotCurrent(sql, stable, snapshot);
  } catch (error) {
    await removeOwned(staged.directory);
    throw error;
  }
  return { directory: staged.directory, snapshot, objects: staged.objects, unavailableSources: staged.unavailableSources };
}
