import { readOpeningBackupVersionRows } from "./opening-backup-versions";
import { readOpeningMemoryDeletions, type OpeningMemoryDeletions } from "./opening-backup-memory-deletions";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

export type OpeningBackupSource = {
  sourceId: string;
  version: number;
  bytes: number;
  sha256: string;
};

export type OpeningDeletionMark = { sourceId: string; deletedAt: string; assetDeletedAt?: string | null };

export type OpeningBackupSourceSnapshot = {
  workspaceId: string;
  privacyEpoch: number;
  deletionJournal: OpeningDeletionMark[];
  memoryDeletions: OpeningMemoryDeletions;
  sources: OpeningBackupSource[];
};

export class OpeningBackupSourceError extends Error {
  readonly code = "NOT_FOUND" as const;
  constructor() {
    super("workspace not found");
    this.name = "OpeningBackupSourceError";
  }
}

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

/** Source inventory only. Not an OpeningBackup and not an archive. */
export function readOpeningBackupSources(
  sql: Sql,
  scope: OpeningScope,
): Promise<OpeningBackupSourceSnapshot> {
  return sql.begin("isolation level repeatable read, read only", async (tx) => {
    const owners = await tx`
      SELECT privacy_epoch FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      LIMIT 1`;
    if (!owners.length) throw new OpeningBackupSourceError();
    const memoryDeletions = await readOpeningMemoryDeletions(tx, scope.workspaceId);
    const marks = await tx`
      SELECT source_id, deleted_at, asset_deleted_at FROM opening_privacy_exclusions
      WHERE workspace_id = ${scope.workspaceId}
      ORDER BY source_id ASC`;
    const versions = await readOpeningBackupVersionRows(tx, scope);
    const rows = versions.filter(row => row.availability === "available");
    return {
      workspaceId: scope.workspaceId,
      privacyEpoch: Number((owners[0] as { privacy_epoch: number }).privacy_epoch),
      memoryDeletions,
      deletionJournal: marks.map((row) => {
        const mark = row as { source_id: string; deleted_at: string | Date; asset_deleted_at?: string | Date | null };
        return { sourceId: mark.source_id, deletedAt: iso(mark.deleted_at), ...(mark.asset_deleted_at ? { assetDeletedAt: iso(mark.asset_deleted_at) } : {}) };
      }),
      sources: rows.map((row) => {
        const source = row as { source_id: string; version: unknown; bytes: unknown; sha256: string };
        return {
          sourceId: source.source_id,
          version: Number(source.version),
          bytes: Number(source.bytes),
          sha256: source.sha256,
        };
      }),
    };
  });
}
