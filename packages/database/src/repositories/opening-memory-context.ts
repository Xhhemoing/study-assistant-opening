import type { Sql, TransactionSql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { lockOwnedWorkspace } from "./opening-memory-admission";
import { createOpeningPrivacyRepository } from "./opening-privacy";
import { mapMemoryRow } from "./opening-memory-types";

type Db = Sql | TransactionSql;

/**
 * One scope query. A memory is excluded when any source turn is missing, foreign,
 * unowned, or references a missing, revoked, excluded, or version-drifted source.
 */
export async function listMemoriesForContext(
  db: Db,
  scope: OpeningScope,
  activeCourseId: string | null,
  excludedSourceIds?: readonly string[],
): Promise<MemoryItem[]> {
  await lockOwnedWorkspace(db, scope);
  const excluded = excludedSourceIds
    ?? await createOpeningPrivacyRepository(db).listExcludedSourceIds(scope);
  const rows = await db`
    SELECT m.* FROM opening_memories m
    WHERE m.workspace_id = ${scope.workspaceId}
      AND m.status = 'active'
      AND (m.course_id IS NULL OR m.course_id = ${activeCourseId})
      AND jsonb_array_length(m.source_turn_ids) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(m.source_turn_ids) AS ref(turn_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM opening_turns t
          INNER JOIN opening_conversations c ON c.id = t.conversation_id
          WHERE t.id::text = ref.turn_id
            AND t.workspace_id = ${scope.workspaceId}
            AND c.workspace_id = ${scope.workspaceId}
            AND c.owner_user_id = ${scope.ownerUserId}
        )
        OR EXISTS (
          SELECT 1 FROM opening_turns t
          WHERE t.id::text = ref.turn_id AND t.workspace_id = ${scope.workspaceId}
            AND (
              EXISTS (
                SELECT 1 FROM unnest(t.source_ids) AS sid(id)
                WHERE NOT EXISTS (
                  SELECT 1 FROM opening_sources s
                  WHERE s.id = sid.id AND s.workspace_id = ${scope.workspaceId}
                    AND s.upload_state = 'uploaded'
                )
                OR sid.id = ANY(${excluded}::uuid[])
              )
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(t.citations) = 'array' THEN t.citations ELSE '[]'::jsonb END
                ) AS citation
                WHERE NOT EXISTS (
                  SELECT 1 FROM opening_sources s
                  WHERE s.id::text = citation->>'sourceId'
                    AND s.workspace_id = ${scope.workspaceId}
                    AND s.upload_state = 'uploaded'
                    AND s.version::text = citation->>'sourceVersion'
                )
                OR citation->>'sourceId' = ANY(${excluded}::text[])
              )
            )
        )
      )
    ORDER BY m.created_at ASC`;
  return rows.map((row) => mapMemoryRow(row as Record<string, unknown>));
}
