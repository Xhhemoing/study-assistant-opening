import { OPENING_RESTORE_APPLY_ORDER } from "@aistudy/domain";
import { isForbiddenBackupTable } from "../../../contracts/src/opening/backup-inventory";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningBackupSourceError } from "./opening-backup-sources";
import { readOpeningBackupTableRows } from "./opening-backup-record-table-queries";
import { readOpeningMemoryDeletions, type OpeningMemoryDeletions } from "./opening-backup-memory-deletions";

// The restore dependency order also names the complete export inventory.
export const OPENING_BACKUP_TABLES = OPENING_RESTORE_APPLY_ORDER;
export type OpeningBackupTable = (typeof OPENING_BACKUP_TABLES)[number];
export type OpeningBackupRecordSnapshot = {
  privacyEpoch: number;
  deletionJournal: Array<{ sourceId: string; deletedAt: string; assetDeletedAt?: string | null }>;
  memoryDeletions: OpeningMemoryDeletions;
  tables: Record<OpeningBackupTable, Record<string, unknown>[]>;
};

/** Durable Opening records only. This is an inventory, not a restore package. */
export async function readOpeningBackupRecords(
  sql: Sql,
  scope: OpeningScope,
): Promise<OpeningBackupRecordSnapshot> {
  const forbidden = OPENING_BACKUP_TABLES.find(isForbiddenBackupTable);
  if (forbidden) throw new Error(`Forbidden backup table: ${forbidden}`);
  const id = scope.workspaceId;
  const userId = scope.ownerUserId;
  return sql.begin("isolation level repeatable read, read only", async (tx) => {
    const owner = await tx`SELECT id, privacy_epoch FROM workspaces WHERE id = ${id} AND owner_user_id = ${userId} LIMIT 1`;
    if (!owner.length) throw new OpeningBackupSourceError();
    const privacyEpoch = Number((owner[0] as { privacy_epoch: number }).privacy_epoch);
    const memoryDeletions = await readOpeningMemoryDeletions(tx, id);
    const tables = await readOpeningBackupTableRows(tx, id, userId);
    const unexpected = Object.keys(tables).find(isForbiddenBackupTable);
    if (unexpected) throw new Error(`Forbidden backup table: ${unexpected}`);
    const deletionJournal = tables.opening_privacy_exclusions
      .filter((row) => typeof row.source_id === "string"
        && (typeof row.deleted_at === "string" || row.deleted_at instanceof Date))
      .map((row) => ({
        sourceId: row.source_id as string,
        deletedAt: new Date(row.deleted_at as string | Date).toISOString(),
        ...(row.asset_deleted_at ? { assetDeletedAt: new Date(row.asset_deleted_at as string | Date).toISOString() } : {}),
      }));
    return { privacyEpoch, deletionJournal, memoryDeletions, tables };
  });
}
