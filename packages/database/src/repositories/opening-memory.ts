import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";

export type OpeningMemoryErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningMemoryError extends Error {
  readonly code: OpeningMemoryErrorCode;
  constructor(code: OpeningMemoryErrorCode, message: string) {
    super(message);
    this.name = "OpeningMemoryError";
    this.code = code;
  }
}

export type ProposeMemoryInput = {
  text: string;
  sourceTurnIds: string[];
  expiresAt: string | null;
  courseId?: string | null;
};

function mapRow(row: Record<string, unknown>): MemoryItem {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    courseId: (row.course_id as string | null) ?? null,
    kind: row.kind as MemoryItem["kind"],
    text: row.text as string,
    sourceTurnIds: (row.source_turn_ids as string[]) ?? [],
    version: Number(row.version),
    expiresAt: row.expires_at
      ? new Date(row.expires_at as string | Date).toISOString()
      : null,
    status: row.status as MemoryItem["status"],
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function sameSources(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}

export function createOpeningMemoryRepository(sql: Sql) {
  return {
    async list(scope: OpeningScope, activeCourseId: string | null = null): Promise<MemoryItem[]> {
      const rows = await sql`
        SELECT * FROM opening_memories
        WHERE workspace_id = ${scope.workspaceId} AND status <> 'deleted'
        ORDER BY created_at ASC`;
      return rows
        .map((row) => mapRow(row as Record<string, unknown>))
        .filter(
          (item) =>
            item.courseId == null
            || (activeCourseId != null && item.courseId === activeCourseId),
        );
    },

    async get(scope: OpeningScope, id: string): Promise<MemoryItem | null> {
      const rows = await sql`
        SELECT * FROM opening_memories
        WHERE id = ${id} AND workspace_id = ${scope.workspaceId} LIMIT 1`;
      return rows.length ? mapRow(rows[0] as Record<string, unknown>) : null;
    },

    async proposeMemory(scope: OpeningScope, input: ProposeMemoryInput): Promise<MemoryItem> {
      const text = input.text.trim();
      if (!text) throw new OpeningMemoryError("VALIDATION", "memory text is required");
      if (input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
        throw new OpeningMemoryError("VALIDATION", "expiresAt must be an ISO datetime");
      }
      const kind = input.expiresAt ? "temporary" : "candidate";
      const rejected = await sql`
        SELECT source_turn_ids, text FROM opening_memories
        WHERE workspace_id = ${scope.workspaceId} AND status = 'rejected'`;
      for (const row of rejected) {
        const src = (row.source_turn_ids as string[]) ?? [];
        if (row.text === text && sameSources(src, input.sourceTurnIds)) {
          throw new OpeningMemoryError("CONFLICT", "equivalent proposal was rejected");
        }
      }
      const rows = await sql`
        INSERT INTO opening_memories (
          id, workspace_id, course_id, kind, text, source_turn_ids, version, expires_at, status
        ) VALUES (
          ${randomUUID()}, ${scope.workspaceId}, ${input.courseId ?? null}, ${kind},
          ${text}, ${sql.json(input.sourceTurnIds as never)}, 0, ${input.expiresAt}, 'active'
        ) RETURNING *`;
      return mapRow(rows[0] as Record<string, unknown>);
    },

    async confirm(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return sql.begin(async (tx) => {
        const owners = await tx`
          SELECT id FROM workspaces
          WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
        const rows = await tx`
          SELECT * FROM opening_memories
          WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
        if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
        const row = rows[0] as Record<string, unknown>;
        const current = mapRow(row);
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
        return mapRow(updated[0] as Record<string, unknown>);
      });
    },

    async reject(
      scope: OpeningScope,
      id: string,
      expectedVersion: number,
      clientKey: string,
    ): Promise<MemoryItem> {
      return sql.begin(async (tx) => {
        const rows = await tx`
          SELECT * FROM opening_memories
          WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
        if (!rows.length) throw new OpeningMemoryError("NOT_FOUND", "memory not found");
        const row = rows[0] as Record<string, unknown>;
        const current = mapRow(row);
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
        return mapRow(updated[0] as Record<string, unknown>);
      });
    },

    /**
     * M02: tombstone + privacy_epoch++ + content-free exclusions in one transaction.
     * Receipt never includes deleted memory text.
     */
    async deleteMemory(
      scope: OpeningScope,
      input: {
        id: string;
        expectedVersion: number;
        deleteSourceText: boolean;
        clientKey: string;
      },
    ): Promise<{
      memoryId: string;
      workspaceId: string;
      privacyEpoch: number;
      excludedSourceIds: string[];
      deletedAt: string;
    }> {
      return sql.begin(async (tx) => {
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
        if (row.status === "deleted") {
          throw new OpeningMemoryError("CONFLICT", "memory already deleted");
        }

        const turnIds = (row.source_turn_ids as string[]) ?? [];
        const sourceIds: string[] = [];
        for (const turnId of turnIds) {
          const turns = await tx`
            SELECT source_ids FROM opening_turns
            WHERE workspace_id = ${scope.workspaceId} AND id = ${turnId}
            LIMIT 1`;
          if (turns.length) {
            const ids = (turns[0] as { source_ids: string[] | null }).source_ids ?? [];
            sourceIds.push(...ids);
          }
        }
        const uniqueSourceIds = [...new Set(sourceIds)];

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
        const privacyEpoch = Number((epochRows[0] as { privacy_epoch: number }).privacy_epoch);

        const excludedSourceIds: string[] = [];
        for (const sourceId of uniqueSourceIds) {
          await tx`
            INSERT INTO opening_privacy_exclusions (id, workspace_id, source_id, memory_id, deleted_at)
            VALUES (${randomUUID()}, ${scope.workspaceId}, ${sourceId}, ${input.id}, ${deletedAt})
            ON CONFLICT (workspace_id, source_id) DO UPDATE
              SET memory_id = EXCLUDED.memory_id, deleted_at = EXCLUDED.deleted_at`;
          excludedSourceIds.push(sourceId);
        }

        if (input.deleteSourceText) {
          for (const turnId of turnIds) {
            await tx`
              UPDATE opening_turns SET text = ''
              WHERE workspace_id = ${scope.workspaceId} AND id = ${turnId}`;
          }
        }

        return {
          memoryId: input.id,
          workspaceId: scope.workspaceId,
          privacyEpoch,
          excludedSourceIds,
          deletedAt: deletedAt.toISOString(),
        };
      });
    },

    /** @deprecated use deleteMemory — kept for call-site clarity during M02. */
    async delete(scope: OpeningScope, id: string): Promise<never> {
      throw new OpeningMemoryError(
        "VALIDATION",
        `use deleteMemory for ${id} in workspace ${scope.workspaceId}`,
      );
    },
  };
}

export type OpeningMemoryRepository = ReturnType<typeof createOpeningMemoryRepository>;
