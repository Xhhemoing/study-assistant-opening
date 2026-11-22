import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { hasMemoryBearingRef, readTurnMemoryLineages, turnLineageCourse, turnPinnedSourcesIncluded } from "./opening-context-provenance";
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

/** Active document material from turn alias t, including citations and assistant context. */
export function turnSourceMaterialsActive(db: Db, workspaceId: string): ReturnType<Db> {
  return db`NOT (
    EXISTS (
      SELECT 1 FROM unnest(t.source_ids) AS sid(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.id = sid.id AND s.workspace_id = ${workspaceId} AND s.upload_state = 'uploaded'
      )
      OR EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = ${workspaceId} AND e.source_id = sid.id
      )
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END
      ) AS citation
      WHERE NOT EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.id::text = lower(citation->>'sourceId')
          AND s.workspace_id = ${workspaceId}
          AND s.upload_state = 'uploaded'
          AND s.version::text = citation->>'sourceVersion'
          AND NOT EXISTS (
            SELECT 1 FROM opening_source_versions sv
            WHERE sv.workspace_id = ${workspaceId}
              AND sv.source_id = s.id
              AND sv.version::text = citation->>'sourceVersion'
              AND sv.availability = 'unavailable'
          )
      )
      OR EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = ${workspaceId} AND e.source_id::text = lower(citation->>'sourceId')
      )
    )
    OR (
      t.role = 'assistant' AND t.context_source_refs IS NOT NULL AND (
        jsonb_typeof(t.context_source_refs) IS DISTINCT FROM 'array'
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(t.context_source_refs) = 'array' THEN t.context_source_refs ELSE '[]'::jsonb END
          ) AS ctx_ref
          WHERE NOT (
            ctx_ref = jsonb_build_object('memoryDependencyIds', ctx_ref->'memoryDependencyIds')
            AND jsonb_typeof(ctx_ref->'memoryDependencyIds') = 'array'
            AND CASE WHEN jsonb_typeof(ctx_ref->'memoryDependencyIds') = 'array'
              THEN jsonb_array_length(ctx_ref->'memoryDependencyIds') > 0 ELSE false END
          )
          AND NOT EXISTS (
            SELECT 1 FROM opening_sources s
            WHERE s.id::text = lower(ctx_ref->>'sourceId')
              AND s.workspace_id = ${workspaceId}
              AND s.upload_state = 'uploaded'
              AND s.version::text = ctx_ref->>'sourceVersion'
              AND NOT EXISTS (
                SELECT 1 FROM opening_source_versions sv
                WHERE sv.workspace_id = ${workspaceId}
                  AND sv.source_id = s.id
                  AND sv.version::text = ctx_ref->>'sourceVersion'
                  AND sv.availability = 'unavailable'
              )
              AND NOT EXISTS (
                SELECT 1 FROM opening_privacy_exclusions e
                WHERE e.workspace_id = ${workspaceId} AND e.source_id = s.id
              )
          )
        )
      )
    )
  ) AND ${turnPinnedSourcesIncluded(db, workspaceId, () => db`t.source_versions`, () => db`t.context_anchor`)}`;
}

/**
 * Require owned turns, currently allowed material, and usable memory ancestry.
 * Replacement excludes the memory that this transaction will supersede.
 */
export async function assertSourceTurnsOwned(
  db: Db,
  scope: OpeningScope,
  sourceTurnIds: readonly string[],
  excludeMemoryId: string | null = null,
  targetCourseId: string | null = null,
): Promise<string | undefined> {
  if (!sourceTurnIds.length) return undefined;
  const unique = [...new Set(sourceTurnIds.map(id => id.toLowerCase()))];
  const rows = await db<{ id: string; context_source_refs: unknown; effective_course_id: string | null }[]>`
    SELECT t.id, t.role, t.context_source_refs, t.context_anchor, c.course_id,
      CASE WHEN t.context_source_refs @? '$[*].memoryDependencyIds[*]'
        OR t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb
        THEN ${turnLineageCourse(db, "t")} END AS effective_course_id
    FROM opening_turns t
    JOIN opening_conversations c ON c.id = t.conversation_id AND c.workspace_id = t.workspace_id
    WHERE t.workspace_id = ${scope.workspaceId} AND c.owner_user_id = ${scope.ownerUserId}
      AND t.id = ANY(${unique}::uuid[])
      AND ${turnSourceMaterialsActive(db, scope.workspaceId)}`;
  const denied = () => new OpeningMemoryError("VALIDATION", "source turns must belong to an owned conversation");
  if (rows.length !== unique.length) throw denied();
  const lineageRows = rows.filter(row => hasMemoryBearingRef(row.context_source_refs));
  if (!lineageRows.length) return undefined;
  const lineages = await readTurnMemoryLineages(db, scope, lineageRows.map(row => ({
    refs: row.context_source_refs, courseId: row.effective_course_id, excludeMemoryId,
  })));
  let expiry: string | undefined;
  for (const lineage of lineages) {
    if (!lineage || (lineage.courseId !== null && lineage.courseId !== targetCourseId?.toLowerCase())) throw denied();
    if (lineage.temporaryExpiresAt && (!expiry || lineage.temporaryExpiresAt < expiry)) expiry = lineage.temporaryExpiresAt;
  }
  return expiry;
}


/** courses has workspace_id only; ownership is the already-locked workspace owner. */
export async function assertCourseInWorkspace(
  db: Db,
  scope: OpeningScope,
  courseId: string | null | undefined,
  requireActive = false,
): Promise<void> {
  if (courseId == null) return;
  const rows = await db`
    SELECT id FROM courses
    WHERE id = ${courseId} AND workspace_id = ${scope.workspaceId}
      AND (${!requireActive} OR archived_at IS NULL)
    LIMIT 1`;
  if (!rows.length) {
    throw new OpeningMemoryError("VALIDATION", "course is not in this workspace");
  }
}
