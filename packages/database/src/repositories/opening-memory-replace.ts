import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { assertSourceTurnsOwned, lockOwnedWorkspace } from "./opening-memory-admission";
import { OpeningMemoryError, mapMemoryRow } from "./opening-memory-types";

export type ReplaceMemoryInput = {
  id: string;
  expectedVersion: number;
  text: string;
  sourceTurnIds: string[];
  clientKey: string;
};

/** Replace a confirmed fact while preserving the superseded revision. */
function sameSources(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

export function replaceOwnedMemory(
  sql: Sql,
  scope: OpeningScope,
  input: ReplaceMemoryInput,
): Promise<MemoryItem> {
  const text = input.text.trim();
  if (!text) throw new OpeningMemoryError("VALIDATION", "memory text is required");
  if (!input.sourceTurnIds.length) throw new OpeningMemoryError("VALIDATION", "corrected memory requires a source turn");
  if (input.clientKey.length < 8) throw new OpeningMemoryError("VALIDATION", "clientKey is too short");
  return sql.begin(async (tx) => {
    await lockOwnedWorkspace(tx, scope);
    const rows = await tx`
      SELECT * FROM opening_memories
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId}
      FOR UPDATE`;
    if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
    const current = rows[0] as Record<string, unknown>;
    const currentMemory = mapMemoryRow(current);
    const replay = await tx`
      SELECT * FROM opening_memories
      WHERE workspace_id = ${scope.workspaceId} AND last_decision_client_key = ${input.clientKey}
      ORDER BY created_at DESC LIMIT 10
      FOR UPDATE`;
    if (replay.length) {
      const prior = replay.find((item) => String((item as Record<string, unknown>).id) === input.id) as Record<string, unknown> | undefined;
      const replayedRow = replay.find((item) => {
        const candidate = item as Record<string, unknown>;
        return candidate.status === "active" && candidate.kind === "confirmed";
      }) as Record<string, unknown> | undefined;
      if (prior?.status !== "superseded" || !replayedRow) {
        throw new OpeningMemoryError("CONFLICT", "clientKey was already used for another memory operation");
      }
      const replayed = mapMemoryRow(replayedRow);
      if (replayed.text === text && sameSources(replayed.sourceTurnIds, input.sourceTurnIds)) return replayed;
      throw new OpeningMemoryError("CONFLICT", "clientKey was already used for another memory replacement");
    }
    if (currentMemory.version !== input.expectedVersion) {
      throw new OpeningMemoryError("CONFLICT", "stale memory version");
    }
    if (currentMemory.status !== "active" || currentMemory.kind !== "confirmed") {
      throw new OpeningMemoryError("CONFLICT", "only an active confirmed memory can be replaced");
    }
    await assertSourceTurnsOwned(tx, scope, input.sourceTurnIds);
    const superseded = await tx`
      UPDATE opening_memories
      SET status = 'superseded', version = ${currentMemory.version + 1},
          last_decision_client_key = ${input.clientKey}, updated_at = now()
      WHERE id = ${input.id} AND workspace_id = ${scope.workspaceId}
        AND version = ${input.expectedVersion} AND status = 'active' AND kind = 'confirmed'
      RETURNING id`;
    if (!superseded.length) throw new OpeningMemoryError("CONFLICT", "memory replacement raced");
    const inserted = await tx`
      INSERT INTO opening_memories (
        id, workspace_id, course_id, kind, text, source_turn_ids, version, expires_at, status,
        last_decision_client_key
      ) VALUES (
        gen_random_uuid(), ${scope.workspaceId}, ${currentMemory.courseId}, 'confirmed', ${text},
        ${tx.json(input.sourceTurnIds as never)}, ${currentMemory.version + 1}, NULL, 'active', ${input.clientKey}
      ) RETURNING *`;
    return mapMemoryRow(inserted[0] as Record<string, unknown>);
  });
}
