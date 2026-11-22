import type { Sql, TransactionSql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import { isMemoryEligible } from "@aistudy/domain";
import {
  contextSourceRefsIncluded, memoryCourseAllows,
  mergeContextSourceRefs, parseContextSourceRefs, readTurnMemoryLineages, turnContextSourceRefs, turnLineageCourse, type ContextSourceRef,
} from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";
import { lockOwnedWorkspace } from "./opening-memory-admission";
import { createOpeningPrivacyRepository } from "./opening-privacy";
import { mapMemoryRow } from "./opening-memory-types";

type Db = Sql | TransactionSql;

export type LoadedMemoryContext = {
  memories: MemoryItem[];
  sourceRefs: ContextSourceRef[];
  temporaryMemoryExpiresAt?: string;
  dependencyMemoryIds?: string[];
};

/**
 * One scope query. A memory is excluded when any source turn is missing, foreign,
 * unowned, references a missing, revoked, excluded, or version-drifted source,
 * or transitively depends on a memory that is no longer usable in its course.
 */
async function readMemoryContext(
  db: Db,
  scope: OpeningScope,
  activeCourseId: string | null,
  excludedSourceIds?: readonly string[],
): Promise<Array<{
  memory: MemoryItem;
  sourceRefs: ContextSourceRef[];
  ancestorTemporaryExpiresAt?: string;
  ancestorMemoryIds: string[];
}>> {
  await lockOwnedWorkspace(db, scope);
  const excluded = excludedSourceIds
    ?? await createOpeningPrivacyRepository(db).listExcludedSourceIds(scope);
  const rows = await db`
    SELECT m.*, (
      SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM opening_turns t
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(${turnContextSourceRefs(db, "t")}, '[]'::jsonb)) ref
      WHERE t.id::text IN (SELECT lower(elem) FROM jsonb_array_elements_text(m.source_turn_ids) AS elem)
        AND t.workspace_id = ${scope.workspaceId}
    ) AS material_source_refs,
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'refs', t.context_source_refs, 'courseId', ${turnLineageCourse(db, "t")}
      )), '[]'::jsonb)
      FROM opening_turns t
      WHERE t.workspace_id = m.workspace_id
        AND t.id::text IN (SELECT lower(elem) FROM jsonb_array_elements_text(m.source_turn_ids) elem)
        AND (t.context_source_refs @? '$[*].memoryDependencyIds[*]'
          OR t.context_source_refs @> '[{"memoryOnly":true}]'::jsonb)
    ) AS lineage_turns
    FROM opening_memories m
    WHERE m.workspace_id = ${scope.workspaceId}
      AND m.status = 'active'
      AND ${memoryCourseAllows(db, () => db`m.course_id`, () => db`${activeCourseId}::uuid`, () => db`m.workspace_id`)}
      AND jsonb_array_length(m.source_turn_ids) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(m.source_turn_ids) AS ref(turn_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM opening_turns t
          INNER JOIN opening_conversations c ON c.id = t.conversation_id
          WHERE t.id::text = lower(ref.turn_id)
            AND t.workspace_id = ${scope.workspaceId}
            AND c.workspace_id = ${scope.workspaceId}
            AND c.owner_user_id = ${scope.ownerUserId}
        )
        OR EXISTS (
          SELECT 1 FROM opening_turns t
          WHERE t.id::text = lower(ref.turn_id) AND t.workspace_id = ${scope.workspaceId}
            AND (
              NOT (${contextSourceRefsIncluded(db, scope.workspaceId, () => turnContextSourceRefs(db, "t"))}) OR
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
  const requests = rows.flatMap(row => ((row.lineage_turns ?? []) as Array<{ refs: unknown; courseId: string | null }>).map(
    turn => ({ ...turn, excludeMemoryId: String(row.id) }),
  ));
  const lineages = await readTurnMemoryLineages(db, scope, requests);
  let offset = 0;
  return rows.flatMap(row => {
    const count = Array.isArray(row.lineage_turns) ? row.lineage_turns.length : 0;
    const ancestors = lineages.slice(offset, offset + count);
    offset += count;
    const memory = mapMemoryRow(row as Record<string, unknown>);
    const ancestorMemoryIds = new Set<string>();
    let ancestorTemporaryExpiresAt: string | undefined;
    for (const ancestor of ancestors) {
      if (!ancestor || (ancestor.courseId !== null && ancestor.courseId !== memory.courseId)) return [];
      for (const id of ancestor.memoryIds) ancestorMemoryIds.add(id);
      if (ancestor.temporaryExpiresAt && (!ancestorTemporaryExpiresAt || ancestor.temporaryExpiresAt < ancestorTemporaryExpiresAt)) {
        ancestorTemporaryExpiresAt = ancestor.temporaryExpiresAt;
      }
    }
    return [{ memory, sourceRefs: parseContextSourceRefs(row.material_source_refs) ?? [],
      ancestorTemporaryExpiresAt, ancestorMemoryIds: [...ancestorMemoryIds].sort() }];
  });
}

export async function listMemoriesForContext(
  db: Db, scope: OpeningScope, activeCourseId: string | null, excludedSourceIds?: readonly string[], now?: string,
): Promise<MemoryItem[]> {
  const rows = await readMemoryContext(db, scope, activeCourseId, excludedSourceIds);
  if (now === undefined) return rows.map((row) => row.memory);
  const nowMs = Date.parse(now);
  return rows
    .filter((row) => row.ancestorTemporaryExpiresAt === undefined
      || (!Number.isNaN(nowMs) && Date.parse(row.ancestorTemporaryExpiresAt) > nowMs))
    .map((row) => row.memory);
}

/** The same instant selects both the injected text and its material lineage. */
export async function loadMemoryContext(
  db: Db, scope: OpeningScope, activeCourseId: string | null, now: string,
): Promise<LoadedMemoryContext> {
  const nowMs = Date.parse(now);
  const eligible = (await readMemoryContext(db, scope, activeCourseId))
    .filter((row) => isMemoryEligible(row.memory, now)
      && (row.ancestorTemporaryExpiresAt === undefined
        || (!Number.isNaN(nowMs) && Date.parse(row.ancestorTemporaryExpiresAt) > nowMs)));
  let earliestTempExpiresAtMs: number | undefined;
  let earliestTempExpiresAtIso: string | undefined;
  const dependencyIds = new Set<string>();
  for (const row of eligible) {
    const candidates = [
      ...(row.memory.kind === "temporary" && row.memory.expiresAt ? [row.memory.expiresAt] : []),
      ...(row.ancestorTemporaryExpiresAt ? [row.ancestorTemporaryExpiresAt] : []),
    ];
    for (const candidate of candidates) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed) && (earliestTempExpiresAtMs === undefined || parsed < earliestTempExpiresAtMs)) {
        earliestTempExpiresAtMs = parsed;
        earliestTempExpiresAtIso = new Date(parsed).toISOString();
      }
    }
    for (const id of row.ancestorMemoryIds) dependencyIds.add(id);
  }
  const dependencyMemoryIds = [...dependencyIds].sort();
  return {
    memories: eligible.map((row) => row.memory),
    sourceRefs: mergeContextSourceRefs(...eligible.map((row) => row.sourceRefs)),
    ...(earliestTempExpiresAtIso ? { temporaryMemoryExpiresAt: earliestTempExpiresAtIso } : {}),
    ...(dependencyMemoryIds.length ? { dependencyMemoryIds } : {}),
  };
}
