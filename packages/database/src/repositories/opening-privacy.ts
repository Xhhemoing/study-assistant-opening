import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";

export type PrivacyExclusion = {
  workspaceId: string;
  sourceId: string;
  memoryId: string | null;
  deletedAt: string;
};

export type DeletionReceipt = {
  memoryId: string;
  workspaceId: string;
  privacyEpoch: number;
  excludedSourceIds: string[];
  deletedAt: string;
};

export function createOpeningPrivacyRepository(sql: Sql | TransactionSql) {
  return {
    async getWorkspaceEpoch(scope: OpeningScope): Promise<number> {
      const rows = await sql`
        SELECT privacy_epoch FROM workspaces
        WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        LIMIT 1`;
      if (!rows.length) return 0;
      return Number((rows[0] as { privacy_epoch: number }).privacy_epoch);
    },

    async isSourceExcluded(scope: OpeningScope, sourceId: string): Promise<boolean> {
      const rows = await sql`
        SELECT 1 FROM opening_privacy_exclusions
        WHERE workspace_id = ${scope.workspaceId} AND source_id = ${sourceId}
        LIMIT 1`;
      return rows.length > 0;
    },

    async listExcludedSourceIds(scope: OpeningScope): Promise<string[]> {
      const rows = await sql`
        SELECT source_id FROM opening_privacy_exclusions
        WHERE workspace_id = ${scope.workspaceId}`;
      return rows.map((row) => (row as { source_id: string }).source_id);
    },

    /** Asset deletion is separate from AI exclusion, and survives backup restore. */
    async isSourceAssetDeleted(scope: OpeningScope, sourceId: string): Promise<boolean> {
      const rows = await sql`SELECT 1 FROM opening_privacy_exclusions e JOIN workspaces w ON w.id=e.workspace_id
        WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=${sourceId}
          AND w.owner_user_id=${scope.ownerUserId} AND e.asset_deleted_at IS NOT NULL LIMIT 1`;
      return rows.length > 0;
    },

    async listAssetDeletedSourceIds(scope: OpeningScope): Promise<string[]> {
      const rows = await sql`SELECT e.source_id FROM opening_privacy_exclusions e JOIN workspaces w ON w.id=e.workspace_id
        WHERE e.workspace_id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND e.asset_deleted_at IS NOT NULL`;
      return rows.map(row => String(row.source_id));
    },

    /** Owns the transaction so callers cannot acquire the workspace lock before its semantic counter. */
    async recordExclusions(
      db: Sql,
      scope: OpeningScope,
      input: { sourceIds: string[]; memoryId: string; deletedAt: Date },
    ): Promise<string[]> {
      const sourceIds = [...new Set(input.sourceIds)];
      if (!sourceIds.length) return [];
      return db.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const recorded: string[] = [];
        for (const sourceId of sourceIds) {
          const inserted = await tx`
            INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
            VALUES (${randomUUID()}, ${scope.workspaceId}, ${sourceId}, ${input.memoryId}, ${input.deletedAt})
            ON CONFLICT (workspace_id, source_id) DO NOTHING
            RETURNING source_id`;
          if (inserted.length) recorded.push(sourceId);
        }
        if (recorded.length) {
          await tx`UPDATE workspaces SET privacy_epoch=privacy_epoch+1, updated_at=now() WHERE id=${scope.workspaceId}`;
          await nextWorkspaceLearningHistoryRevision(tx, scope);
          await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: recorded });
        }
        return sourceIds;
      });
    },
  };
}

export type OpeningPrivacyRepository = ReturnType<typeof createOpeningPrivacyRepository>;
