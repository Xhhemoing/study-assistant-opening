import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import {
  lineageUuid, memoryCourseAllows, memoryDependencyRows, memoryTransitiveDependenciesActive,
  turnMemoryOnlySourcesBacked, turnTransitiveDependenciesActive, type FragmentFactory,
} from "./opening-context-provenance";
import { lockOwnedWorkspace, turnSourceMaterialsActive } from "./opening-memory-admission";
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
    let expiryBeforeCommit: string | null = null;
    if (current.courseId !== null || current.kind === "temporary" || current.sourceTurnIds.length > 0) {
      const memoryCourse: FragmentFactory = () => tx`m.course_id`;
      const workspace: FragmentFactory = () => tx`m.workspace_id`;
      const admitted = await tx`
        SELECT m.id, (
          WITH RECURSIVE mem_deps(dep_id) AS (
            SELECT lower(dep.id)
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END
            ) st(turn_id)
            JOIN opening_turns dt ON dt.id = ${lineageUuid(tx, () => tx`st.turn_id`)} AND dt.workspace_id = m.workspace_id
            CROSS JOIN LATERAL ${memoryDependencyRows(tx, () => tx`dt.context_source_refs`)} dep
            UNION
            SELECT lower(dep.id)
            FROM mem_deps prev
            JOIN opening_memories pm ON pm.id = ${lineageUuid(tx, () => tx`prev.dep_id`)} AND pm.workspace_id = m.workspace_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
            ) st(turn_id)
            JOIN opening_turns dt ON dt.id = ${lineageUuid(tx, () => tx`st.turn_id`)} AND dt.workspace_id = m.workspace_id
            CROSS JOIN LATERAL ${memoryDependencyRows(tx, () => tx`dt.context_source_refs`)} dep
          )
          SELECT min(dep_m.expires_at)
          FROM mem_deps d
          JOIN opening_memories dep_m ON dep_m.id::text = d.dep_id
            AND dep_m.workspace_id = m.workspace_id
            AND dep_m.status = 'active'
            AND ${memoryCourseAllows(tx, () => tx`dep_m.course_id`, memoryCourse, workspace)}
            AND dep_m.kind = 'temporary'
            AND dep_m.expires_at > clock_timestamp()
        ) AS ancestor_temporary_expires_at
        FROM opening_memories m
        WHERE m.id = ${id}
          AND m.workspace_id = ${scope.workspaceId}
          AND m.status = 'active'
          AND ${memoryCourseAllows(tx, memoryCourse, memoryCourse, workspace)}
          AND (m.kind <> 'temporary' OR (m.expires_at IS NOT NULL AND m.expires_at > clock_timestamp()))
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END
            ) AS ref(turn_id)
            WHERE NOT EXISTS (
              SELECT 1 FROM opening_turns t
              INNER JOIN opening_conversations c ON c.id = t.conversation_id
              WHERE t.id::text = lower(ref.turn_id)
                AND t.workspace_id = ${scope.workspaceId}
                AND c.workspace_id = ${scope.workspaceId}
                AND c.owner_user_id = ${scope.ownerUserId}
                AND ${turnSourceMaterialsActive(tx, scope.workspaceId)}
                AND ${turnTransitiveDependenciesActive(tx, "t", memoryCourse)}
                AND ${turnMemoryOnlySourcesBacked(tx, "t", scope.workspaceId, scope.ownerUserId, memoryCourse,
                  undefined, () => tx`m.id`)}
            )
          )
          AND ${memoryTransitiveDependenciesActive(tx)}`;
      if (!admitted.length) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      const ancestorExpiry = admitted[0]?.ancestor_temporary_expires_at;
      const expiry = Math.min(
        current.kind === "temporary" ? Date.parse(current.expiresAt ?? "") : Infinity,
        ancestorExpiry == null ? Infinity : new Date(ancestorExpiry as string | Date).getTime(),
      );
      if (Number.isNaN(expiry) || expiry <= now().getTime()) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      if (Number.isFinite(expiry)) expiryBeforeCommit = new Date(expiry).toISOString();
    }
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
