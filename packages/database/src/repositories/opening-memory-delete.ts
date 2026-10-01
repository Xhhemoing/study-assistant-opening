import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { parseContextSourceRefs } from "./opening-context-provenance";
import { OpeningMemoryError } from "./opening-memory-types";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { invalidateOpeningLearningEligibility } from "./opening-learning-eligibility";

export type MemoryDeletionReceipt = {
  memoryId: string;
  workspaceId: string;
  privacyEpoch: number;
  excludedSourceIds: string[];
  deletedAt: string;
};

/** Tombstone, privacy epoch, and content-free exclusions share one transaction. */
export function deleteOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  input: { id: string; expectedVersion: number; deleteSourceText: boolean; clientKey: string },
): Promise<MemoryDeletionReceipt> {
  return sql.begin(async (tx) => {
    await lockWorkspaceLearningHistory(tx, scope);
    const owners = await tx`
      SELECT id, privacy_epoch FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      FOR UPDATE`;
    if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId}
      FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const row = rows[0] as Record<string, unknown>;
    const deletedAt = new Date();
    if (row.status === "deleted" && row.last_decision_client_key === input.clientKey) {
      const excl = await tx`
        SELECT source_id FROM opening_privacy_exclusions
        WHERE workspace_id = ${scope.workspaceId} AND memory_id = ${input.id}`;
      return {
        memoryId: input.id,
        workspaceId: scope.workspaceId,
        privacyEpoch: Number((owners[0] as { privacy_epoch: number }).privacy_epoch),
        excludedSourceIds: excl.map((e) => (e as { source_id: string }).source_id),
        deletedAt: deletedAt.toISOString(),
      };
    }
    if (Number(row.version) !== input.expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (row.status === "deleted") throw new OpeningMemoryError("CONFLICT", "memory already deleted");
    const turnIds = (row.source_turn_ids as string[]) ?? [];
    const sourceIds: string[] = [];
    for (const turnId of turnIds) {
      const turns = await tx`
        SELECT source_ids, context_source_refs FROM opening_turns
        WHERE workspace_id = ${scope.workspaceId} AND id = ${turnId}
        LIMIT 1`;
      if (turns.length) {
        sourceIds.push(...((turns[0] as { source_ids: string[] | null }).source_ids ?? []));
        sourceIds.push(...(parseContextSourceRefs(turns[0]!.context_source_refs) ?? []).map((ref) => ref.sourceId));
      }
    }
    await tx`
      UPDATE opening_memories
      SET status = 'deleted', version = ${Number(row.version) + 1},
          last_decision_client_key = ${input.clientKey}, updated_at = now()
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId}
        AND version = ${input.expectedVersion}`;
    const epochRows = await tx`
      UPDATE workspaces SET privacy_epoch = privacy_epoch + 1, updated_at = now()
      WHERE id = ${scope.workspaceId}
      RETURNING privacy_epoch`;
    const uniqueSourceIds = [...new Set(sourceIds)];
    const existingExclusions = uniqueSourceIds.length ? await tx`SELECT source_id FROM opening_privacy_exclusions
      WHERE workspace_id=${scope.workspaceId} AND source_id IN ${tx(uniqueSourceIds)}` : [];
    const previouslyExcluded = new Set(existingExclusions.map((exclusion) => String(exclusion.source_id)));
    const newlyExcluded = uniqueSourceIds.filter((sourceId) => !previouslyExcluded.has(sourceId));
    const excludedSourceIds: string[] = [];
    for (const sourceId of uniqueSourceIds) {
      await tx`
        INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
        VALUES (${randomUUID()}, ${scope.workspaceId}, ${sourceId}, ${input.id}, ${deletedAt})
        ON CONFLICT (workspace_id, source_id) DO UPDATE
          SET memory_id = EXCLUDED.memory_id, deleted_at = EXCLUDED.deleted_at`;
      excludedSourceIds.push(sourceId);
    }
    if (newlyExcluded.length) {
      await nextWorkspaceLearningHistoryRevision(tx, scope);
      await invalidateOpeningLearningEligibility(tx, scope, { sourceIds: newlyExcluded });
    }
    if (input.deleteSourceText) {
      for (const turnId of turnIds) {
        await tx`UPDATE opening_turns SET text = '' WHERE workspace_id = ${scope.workspaceId} AND id = ${turnId}`;
      }
    }
    return {
      memoryId: input.id,
      workspaceId: scope.workspaceId,
      privacyEpoch: Number((epochRows[0] as { privacy_epoch: number }).privacy_epoch),
      excludedSourceIds,
      deletedAt: deletedAt.toISOString(),
    };
  });
}
