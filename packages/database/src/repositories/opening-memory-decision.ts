import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { lockOwnedWorkspace } from "./opening-memory-admission";
import { OpeningMemoryError, mapMemoryRow } from "./opening-memory-types";

export function confirmOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  id: string,
  expectedVersion: number,
  clientKey: string,
): Promise<MemoryItem> {
  return sql.begin(async (tx) => {
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
    const updated = await tx`
      UPDATE opening_memories
      SET kind = 'confirmed', expires_at = NULL, version = ${current.version + 1},
          last_decision_client_key = ${clientKey}, updated_at = now()
      WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
        AND version = ${expectedVersion} AND status = 'active'
      RETURNING *`;
    if (!updated.length) throw new OpeningMemoryError("CONFLICT", "confirm raced");
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
  return sql.begin(async (tx) => {
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
    return mapMemoryRow(updated[0] as Record<string, unknown>);
  });
}
