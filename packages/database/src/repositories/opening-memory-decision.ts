import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { assertCourseInWorkspace, assertSourceTurnsOwned, lockOwnedWorkspace } from "./opening-memory-admission";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { OpeningMemoryError, mapMemoryRow } from "./opening-memory-types";
import { advanceOpeningWorkspacePrivacyEpoch, withOpeningTutorStreamFenceCommit } from "./opening-tutor-stream-fence";

export function confirmOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  id: string,
  expectedVersion: number,
  clientKey: string,
  now: () => Date = () => new Date(),
): Promise<MemoryItem> {
  return sql.begin(async (tx) => {
    const owners = await tx`SELECT id FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
    // Fence before business locks; retain the original locked ownership re-read.
    try {
      await lockWorkspaceLearningHistory(tx, scope);
    } catch (error) {
      if (error instanceof Error && "code" in error
        && error.code === "NOT_FOUND" && error.message === "workspace not found") {
        throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
      }
      throw error;
    }
    await lockOwnedWorkspace(tx, scope);
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const row = rows[0] as Record<string, unknown>;
    const current = mapMemoryRow(row);
    if (
      current.status === "active"
      && current.kind === "confirmed"
      && row.last_decision_client_key === clientKey
    ) {
      return current;
    }
    if (current.version !== expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (current.status !== "active" || current.kind === "confirmed") {
      throw new OpeningMemoryError("CONFLICT", "memory cannot be confirmed");
    }
    await assertCourseInWorkspace(tx, scope, current.courseId, true);
    const ancestorExpiry = await assertSourceTurnsOwned(tx, scope, current.sourceTurnIds, id, current.courseId);
    const expiry = Math.min(
      current.kind === "temporary" ? Date.parse(current.expiresAt ?? "") : Infinity,
      ancestorExpiry === undefined ? Infinity : Date.parse(ancestorExpiry),
    );
    if (Number.isNaN(expiry) || expiry <= now().getTime()) {
      throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
    }
    const expiryBeforeCommit = Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
    const updated = await tx`
      UPDATE opening_memories
      SET kind = 'confirmed', expires_at = NULL, version = ${current.version + 1},
          last_decision_client_key = ${clientKey}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND version = ${expectedVersion} AND status = 'active'
      RETURNING *`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "confirm raced");
    if (expiryBeforeCommit !== null) {
      const [expiry] = await tx`SELECT ${expiryBeforeCommit}::timestamptz > clock_timestamp() AS still_active`;
      if (!expiry?.still_active) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
    }
    return mapMemoryRow(updated[0] as Record<string, unknown>);
  });
}

export function rejectOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  id: string,
  expectedVersion: number,
  clientKey: string,
): Promise<MemoryItem> {
  return withOpeningTutorStreamFenceCommit(sql, async (tx) => {
    const owners = await tx`SELECT id FROM workspaces
      WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
    // Fence before business locks; retain the original locked ownership re-read.
    try {
      await lockWorkspaceLearningHistory(tx, scope);
    } catch (error) {
      if (error instanceof Error && "code" in error
        && error.code === "NOT_FOUND" && error.message === "workspace not found") {
        throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
      }
      throw error;
    }
    await lockOwnedWorkspace(tx, scope);
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const row = rows[0] as Record<string, unknown>;
    const current = mapMemoryRow(row);
    if (current.status === "rejected" && row.last_decision_client_key === clientKey) {
      return current;
    }
    if (current.version !== expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (current.status !== "active") {
      throw new OpeningMemoryError("CONFLICT", "memory cannot be rejected");
    }
    const updated = await tx`
      UPDATE opening_memories
      SET status = 'rejected', version = ${current.version + 1},
          last_decision_client_key = ${clientKey}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND version = ${expectedVersion}
      RETURNING *`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "reject raced");
    await advanceOpeningWorkspacePrivacyEpoch(tx, scope);
    return mapMemoryRow(updated[0] as Record<string, unknown>);
  });
}
