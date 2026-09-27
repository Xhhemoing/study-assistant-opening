import type { Sql } from "postgres";
import { rm } from "node:fs/promises";
import type { OpeningScope } from "./opening-sources";
import { composeOpeningBackupDraft, type OpeningBackupComposeResult } from "@aistudy/domain";
import { readOpeningBackupRecords } from "./opening-backup-records";
import {
  prepareOpeningSourceBackup,
  type OpeningSourceStaging,
} from "./opening-backup-prepare";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function copyScope(scope: OpeningScope): OpeningScope {
  if (!scope || !UUID.test(scope.workspaceId) || !UUID.test(scope.ownerUserId)) {
    throw new Error("invalid backup scope");
  }
  return { workspaceId: scope.workspaceId.toLowerCase(), ownerUserId: scope.ownerUserId.toLowerCase() };
}

async function removeOwned(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: false });
  } catch {
    throw new Error("staging cleanup failed");
  }
}

function compose(records: Awaited<ReturnType<typeof readOpeningBackupRecords>>, staging: OpeningSourceStaging): OpeningBackupComposeResult {
  return composeOpeningBackupDraft({
    records: {
      privacyEpoch: records.privacyEpoch,
      deletionJournal: records.deletionJournal,
      tables: records.tables,
    },
    staging: {
      snapshot: {
        workspaceId: staging.snapshot.workspaceId,
        privacyEpoch: staging.snapshot.privacyEpoch,
        deletionJournal: staging.snapshot.deletionJournal,
        sources: staging.snapshot.sources,
      },
      objects: staging.objects,
    },
  });
}

/**
 * Assembles a versioned draft from owner-scoped records and staged objects. This is
 * not a publish, archive write, restore apply, or a DB+S3 atomic snapshot: a later
 * deletion can still race, and a successful draft is not restore authorization.
 */
export async function assembleOpeningBackupDraft(
  sql: Sql,
  scope: OpeningScope,
  parentDirectory: string,
  reader: Parameters<typeof prepareOpeningSourceBackup>[3],
): Promise<OpeningBackupComposeResult> {
  const stable = copyScope(scope);
  const records = await readOpeningBackupRecords(sql, stable);
  let staging: OpeningSourceStaging | undefined;
  try {
    staging = await prepareOpeningSourceBackup(sql, stable, parentDirectory, reader);
    const result = compose(records, staging);
    if (!result.ok) {
      await removeOwned(staging.directory);
      return result;
    }
    return result;
  } catch (error) {
    if (staging) await removeOwned(staging.directory);
    throw error;
  }
}
