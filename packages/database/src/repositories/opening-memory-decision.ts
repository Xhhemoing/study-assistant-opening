import type { Sql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
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
    if (current.kind === "temporary" || current.sourceTurnIds.length > 0) {
      const admitted = await tx`
        SELECT m.id, (
          WITH RECURSIVE mem_deps(dep_id) AS (
            SELECT lower(dep.id)
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END
            ) AS st(turn_id)
            JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = m.workspace_id
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
            ) AS dep_elem
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
                AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
                THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
            ) AS dep(id)
            UNION
            SELECT lower(dep.id)
            FROM mem_deps prev
            JOIN opening_memories pm ON pm.id::text = prev.dep_id AND pm.workspace_id = m.workspace_id
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
            ) AS st(turn_id)
            JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = m.workspace_id
            CROSS JOIN LATERAL jsonb_array_elements(
              CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
            ) AS dep_elem
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
                AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
                THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
            ) AS dep(id)
          )
          SELECT min(dep_m.expires_at)
          FROM mem_deps d
          JOIN opening_memories dep_m ON dep_m.id::text = d.dep_id
            AND dep_m.workspace_id = m.workspace_id
            AND dep_m.status = 'active'
            AND dep_m.course_id IS NULL
            AND dep_m.kind = 'temporary'
            AND dep_m.expires_at IS NOT NULL
        ) AS ancestor_temporary_expires_at
        FROM opening_memories m
        WHERE m.id = ${id}
          AND m.workspace_id = ${scope.workspaceId}
          AND m.status = 'active'
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
            )
          )
          AND NOT EXISTS (
            WITH RECURSIVE mem_deps(dep_id) AS (
              SELECT lower(dep.id)
              FROM jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(m.source_turn_ids) = 'array' THEN m.source_turn_ids ELSE '[]'::jsonb END
              ) AS st(turn_id)
              JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = m.workspace_id
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
              ) AS dep_elem
              CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
                  AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
                  THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
              ) AS dep(id)
              UNION
              SELECT lower(dep.id)
              FROM mem_deps prev
              JOIN opening_memories pm ON pm.id::text = prev.dep_id AND pm.workspace_id = m.workspace_id
              CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
              ) AS st(turn_id)
              JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = m.workspace_id
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
              ) AS dep_elem
              CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
                  AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
                  THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
              ) AS dep(id)
            )
            SELECT 1
            FROM mem_deps d
            WHERE NOT EXISTS (
              SELECT 1
              FROM opening_memories dep_m
              WHERE dep_m.id::text = d.dep_id
                AND dep_m.workspace_id = m.workspace_id
                AND dep_m.status = 'active'
                AND dep_m.course_id IS NULL
                AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at IS NOT NULL AND dep_m.expires_at > clock_timestamp()))
            )
          )`;
      if (!admitted.length) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      const nowMs = now().getTime();
      if (current.kind === "temporary" && (current.expiresAt === null || Date.parse(current.expiresAt) <= nowMs)) {
        throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
      }
      const ancestorExp = (admitted[0] as Record<string, unknown>).ancestor_temporary_expires_at;
      if (ancestorExp != null) {
        const parsedMs = new Date(ancestorExp as string | Date).getTime();
        if (Number.isNaN(parsedMs) || parsedMs <= nowMs) {
          throw new OpeningMemoryError("VALIDATION", "memory source or dependency is no longer active");
        }
      }
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
