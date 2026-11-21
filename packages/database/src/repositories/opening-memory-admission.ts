import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { OpeningMemoryError } from "./opening-memory-types";

type Db = Sql | TransactionSql;

/** Workspace row lock first. Callers must not touch memory rows before this. */
export async function lockOwnedWorkspace(db: Db, scope: OpeningScope): Promise<void> {
  const owners = await db`
    SELECT id FROM workspaces
    WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
    FOR UPDATE`;
  if (!owners.length) throw new OpeningMemoryError("NOT_FOUND", "workspace not found");
}

/**
 * Non-empty sources must each be a turn in an owner-held conversation of this workspace.
 * Binds scope in SQL and does not select turn text.
 */
export async function assertSourceTurnsOwned(
  db: Db,
  scope: OpeningScope,
  sourceTurnIds: readonly string[],
): Promise<void> {
  if (!sourceTurnIds.length) return;
  const unique = [...new Set(sourceTurnIds.map(id => id.toLowerCase()))];
  const rows = await db`
    SELECT t.id FROM opening_turns t
    INNER JOIN opening_conversations c ON c.id = t.conversation_id
    WHERE t.workspace_id = ${scope.workspaceId}
      AND c.workspace_id = ${scope.workspaceId}
      AND c.owner_user_id = ${scope.ownerUserId}
      AND t.id = ANY(${unique}::uuid[])
      AND NOT EXISTS (
        WITH RECURSIVE mem_deps(dep_id) AS (
          SELECT lower(dep.id)
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(t.context_source_refs) = 'array' THEN t.context_source_refs ELSE '[]'::jsonb END
          ) AS dep_elem
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
              AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
              THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
          ) AS dep(id)
          UNION
          SELECT lower(dep.id)
          FROM mem_deps prev
          JOIN opening_memories pm ON pm.id::text = prev.dep_id AND pm.workspace_id = t.workspace_id
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
          ) AS st(turn_id)
          JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = t.workspace_id
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
            AND dep_m.workspace_id = t.workspace_id
            AND dep_m.status = 'active'
            AND dep_m.course_id IS NULL
            AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at IS NOT NULL AND dep_m.expires_at > clock_timestamp()))
        )
      )`;
  if (rows.length !== unique.length) {
    throw new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
  }
}

/** courses has workspace_id only; ownership is the already-locked workspace owner. */
export async function assertCourseInWorkspace(
  db: Db,
  scope: OpeningScope,
  courseId: string | null | undefined,
): Promise<void> {
  if (courseId == null) return;
  const rows = await db`
    SELECT id FROM courses
    WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId}
    LIMIT 1`;
  if (!rows.length) {
    throw new OpeningMemoryError("VALIDATION", "course is not in this workspace");
  }
}
