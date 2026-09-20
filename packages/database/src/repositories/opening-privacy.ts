import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";

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

export function createOpeningPrivacyRepository(sql: Sql) {
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

    async recordExclusions(
      tx: Sql,
      scope: OpeningScope,
      input: { sourceIds: string[]; memoryId: string; deletedAt: Date },
    ): Promise<string[]> {
      const recorded: string[] = [];
      for (const sourceId of [...new Set(input.sourceIds)]) {
        const rows = await tx`
          INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
          VALUES (${randomUUID()}, ${scope.workspaceId}, ${sourceId}, ${input.memoryId}, ${input.deletedAt})
          ON CONFLICT (workspace_id, source_id) DO UPDATE
            SET memory_id = EXCLUDED.memory_id, deleted_at = EXCLUDED.deleted_at
          RETURNING source_id`;
        if (rows.length) recorded.push(sourceId);
      }
      return recorded;
    },
  };
}

export type OpeningPrivacyRepository = ReturnType<typeof createOpeningPrivacyRepository>;
