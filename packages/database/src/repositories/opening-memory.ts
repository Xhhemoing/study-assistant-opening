import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import {
  assertCourseInWorkspace,
  assertSourceTurnsOwned,
  lockActiveMemoryCourses,
  lockOwnedWorkspace,
  readBareUserOrigins,
} from "./opening-memory-admission";
import { sourceTurnsAllowMisconceptionMemory } from "./v3-bitemporal-misconception-memory";
import { listMemoriesForContext, loadMemoryContext } from "./opening-memory-context";
import { confirmOwnedMemory, rejectOwnedMemory } from "./opening-memory-decision";
import { deleteOwnedMemory } from "./opening-memory-delete";
import { memoryUsesDeletedSource } from "./opening-source-actions-privacy";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { decideOwnedMemoryCandidate, type MemoryCandidateDecisionInput } from "./opening-memory-candidate";
import { replaceOwnedMemory, type ReplaceMemoryInput } from "./opening-memory-replace";
import {
  OpeningMemoryError,
  mapMemoryRow,
  type OpeningMemoryErrorCode,
  type ProposeMemoryInput,
} from "./opening-memory-types";

export { OpeningMemoryError, type OpeningMemoryErrorCode, type ProposeMemoryInput, type ReplaceMemoryInput };

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
        SELECT m.* FROM opening_memories m
        WHERE workspace_id = ${scope.workspaceId} AND status <> 'deleted'
          AND NOT (${memoryUsesDeletedSource(sql)})
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
      materialUse: "citation" | "practice" = "citation",
    ): Promise<MemoryItem[]> {
      return listMemoriesForContext(sql, scope, activeCourseId, undefined, undefined, materialUse);
    },

    async listContext(scope: OpeningScope, now: string, activeCourseId: string | null = null, materialUse: "citation" | "practice" = "citation") {
      return loadMemoryContext(sql, scope, activeCourseId, now, materialUse);
    },

    async get(scope: OpeningScope, id: string): Promise<MemoryItem | null> {
      await lockOwnedWorkspace(sql, scope);
      const rows = await sql`
        SELECT m.* FROM opening_memories m
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} AND NOT (${memoryUsesDeletedSource(sql)}) LIMIT 1`;
      return rows.length ? mapMemoryRow(rows[0] as Record<string, unknown>) : null;
    },

    async proposeMemory(scope: OpeningScope, input: ProposeMemoryInput): Promise<MemoryItem> {
      const text = input.text.trim();
      if (!text) throw new OpeningMemoryError("VALIDATION", "memory text is required");
      if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
        throw new OpeningMemoryError("VALIDATION", "expiresAt must be an ISO datetime");
      }
      const kind = input.expiresAt ? "temporary" : "candidate";
      const courseId = input.courseId ?? null;
      return sql.begin(async (tx) => {
        const owners = await tx`SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
        if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
        // Fence before business locks; re-read ownership under the original lock below.
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
        if (input.sourceTurnIds.length && courseId && !await lockActiveMemoryCourses(tx, scope, [courseId])) {
          const ids = [...new Set(input.sourceTurnIds.map(id => id.toLowerCase()))];
          const owned = await tx`SELECT t.id FROM opening_turns t
            JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
            WHERE t.id=ANY(${ids}::uuid[]) AND t.workspace_id=${scope.workspaceId}
              AND c.owner_user_id=${scope.ownerUserId} AND t.status='complete'`;
          if (owned.length !== ids.length) {
            throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
          }
          throw new OpeningMemoryError("VALIDATION", "course is not in this workspace");
        }
        const assertOrigins = async () => {
          const bareOrigins = courseId === null ? await readBareUserOrigins(tx, scope, input.sourceTurnIds) : new Set<string>();
          const nonBareOrigins = input.sourceTurnIds.filter(id => !bareOrigins.has(id.toLowerCase()));
          if (!await sourceTurnsAllowMisconceptionMemory(tx, scope, nonBareOrigins, courseId)) {
            throw new OpeningMemoryError("VALIDATION", "memory source or dependency misconception is unavailable");
          }
          await assertSourceTurnsOwned(tx, scope, nonBareOrigins, null, courseId);
        };
        await assertOrigins();
        await assertCourseInWorkspace(tx, scope, courseId, true);
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
            ${randomUUID()}, ${scope.workspaceId}, ${courseId}, ${kind},
            ${text}, ${tx.json(input.sourceTurnIds as never)}, 0, ${input.expiresAt}, 'active'
          ) RETURNING *`;
        await assertOrigins();
        return mapMemoryRow(rows[0] as Record<string, unknown>);
      });
    },

    async confirm(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return confirmOwnedMemory(sql, scope, id, expectedVersion, clientKey, now);
    },

    async reject(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return rejectOwnedMemory(sql, scope, id, expectedVersion, clientKey);
    },

    async replaceMemory(scope: OpeningScope, input: ReplaceMemoryInput): Promise<MemoryItem> {
      return replaceOwnedMemory(sql, scope, input);
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
