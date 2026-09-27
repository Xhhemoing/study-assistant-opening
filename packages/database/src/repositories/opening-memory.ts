import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import {
  assertCourseInWorkspace,
  assertSourceTurnsOwned,
  lockOwnedWorkspace,
} from "./opening-memory-admission";
import { listMemoriesForContext } from "./opening-memory-context";
import { confirmOwnedMemory, rejectOwnedMemory } from "./opening-memory-decision";
import { deleteOwnedMemory } from "./opening-memory-delete";
import { decideOwnedMemoryCandidate, type MemoryCandidateDecisionInput } from "./opening-memory-candidate";
import {
  OpeningMemoryError,
  mapMemoryRow,
  type OpeningMemoryErrorCode,
  type ProposeMemoryInput,
} from "./opening-memory-types";

export { OpeningMemoryError, type OpeningMemoryErrorCode, type ProposeMemoryInput };

function sameSources(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}

export function createOpeningMemoryRepository(
  sql: Sql,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());
  return {
    async list(scope: OpeningScope, activeCourseId: string | null = null): Promise<MemoryItem[]> {
      await lockOwnedWorkspace(sql, scope);
      const rows = await sql`
        SELECT * FROM opening_memories
        WHERE workspace_id = ${scope.workspaceId} AND status <> 'deleted'
        ORDER BY created_at ASC`;
      return rows
        .map((row) => mapMemoryRow(row as Record<string, unknown>))
        .filter(
          (item) =>
            item.courseId == null
            || (activeCourseId != null && item.courseId === activeCourseId),
        );
    },

    async listForContext(
      scope: OpeningScope,
      activeCourseId: string | null = null,
    ): Promise<MemoryItem[]> {
      return listMemoriesForContext(sql, scope, activeCourseId);
    },

    async get(scope: OpeningScope, id: string): Promise<MemoryItem | null> {
      await lockOwnedWorkspace(sql, scope);
      const rows = await sql`
        SELECT * FROM opening_memories
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} LIMIT 1`;
      return rows.length ? mapMemoryRow(rows[0] as Record<string, unknown>) : null;
    },

    async proposeMemory(scope: OpeningScope, input: ProposeMemoryInput): Promise<MemoryItem> {
      const text = input.text.trim();
      if (!text) throw new OpeningMemoryError("VALIDATION", "memory text is required");
      if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
        throw new OpeningMemoryError("VALIDATION", "expiresAt must be an ISO datetime");
      }
      const kind = input.expiresAt ? "temporary" : "candidate";
      return sql.begin(async (tx) => {
        await lockOwnedWorkspace(tx, scope);
        await assertSourceTurnsOwned(tx, scope, input.sourceTurnIds);
        await assertCourseInWorkspace(tx, scope, input.courseId);
        const rejected = await tx`
          SELECT source_turn_ids, text FROM opening_memories
          WHERE workspace_id = ${scope.workspaceId} AND status = 'rejected'`;
        for (const row of rejected) {
          const src = (row.source_turn_ids as string[]) ?? [];
          if (row.text === text && sameSources(src, input.sourceTurnIds)) {
            throw new OpeningMemoryError("CONFLICT", "equivalent proposal was rejected");
          }
        }
        const rows = await tx`
          INSERT INTO opening_memories (
            id, workspace_id, course_id, kind, text, source_turn_ids, version, expires_at, status
          ) VALUES (
            ${randomUUID()}, ${scope.workspaceId}, ${input.courseId ?? null}, ${kind},
            ${text}, ${tx.json(input.sourceTurnIds as never)}, 0, ${input.expiresAt}, 'active'
          ) RETURNING *`;
        return mapMemoryRow(rows[0] as Record<string, unknown>);
      });
    },

    async confirm(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return confirmOwnedMemory(sql, scope, id, expectedVersion, clientKey);
    },

    async reject(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return rejectOwnedMemory(sql, scope, id, expectedVersion, clientKey);
    },

    async deleteMemory(
      scope: OpeningScope,
      input: {
        id: string;
        expectedVersion: number;
        deleteSourceText: boolean;
        clientKey: string;
      },
    ) {
      return deleteOwnedMemory(sql, scope, input);
    },

    /** @deprecated use deleteMemory — kept for call-site clarity during M02. */
    async delete(scope: OpeningScope, id: string): Promise<never> {
      throw new OpeningMemoryError(
        "VALIDATION",
        `use deleteMemory for ${id} in workspace ${scope.workspaceId}`,
      );
    },

    async decideMemoryCandidate(
      scope: OpeningScope,
      input: MemoryCandidateDecisionInput,
    ): Promise<MemoryItem> {
      return decideOwnedMemoryCandidate(sql, scope, input, now);
    },
  };
}

export type OpeningMemoryRepository = ReturnType<typeof createOpeningMemoryRepository>;
