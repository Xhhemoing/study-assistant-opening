import type { Sql, TransactionSql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import { isMemoryEligible } from "@aistudy/domain";
import {
  dependencyOriginCourseAllows, lineageUuid, memoryCourseAllows, memoryDependencyRows, turnLineageCourse,
  mergeContextSourceRefs, parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs,
  type ContextSourceRef, type FragmentFactory,
} from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";
import { lockActiveMemoryCourse, lockMemoryMaterialSources, lockOwnedWorkspace, readMemoryOrigins } from "./opening-memory-admission";
import { mapMemoryRow } from "./opening-memory-types";

type Db = Sql | TransactionSql;

export type LoadedMemoryContext = {
  memories: MemoryItem[];
  sourceRefs: ContextSourceRef[];
  temporaryMemoryExpiresAt?: string;
  dependencyMemoryIds?: string[];
};

/**
 * Read eligible memories as a batch before resolving their full backing lineage.
 */
async function readMemoryContextInTx(
  db: Db,
  scope: OpeningScope,
  activeCourseId: string | null,
  materialUse: "citation" | "practice",
  excludedSourceIds?: readonly string[],
): Promise<Array<{
  memory: MemoryItem;
  sourceRefs: ContextSourceRef[];
  ancestorTemporaryExpiresAt?: string;
  ancestorMemoryIds: string[];
}>> {
  await lockOwnedWorkspace(db, scope);
  const eligibleCourseId = activeCourseId !== null && await lockActiveMemoryCourse(db, scope, activeCourseId)
    ? activeCourseId : null;
  const workspace: FragmentFactory = () => db`m.workspace_id`;
  const course: FragmentFactory = () => db`m.course_id`;
  const eligibleForScope: FragmentFactory = () => db`m.workspace_id = ${scope.workspaceId} AND m.status = 'active'
    AND jsonb_array_length(m.source_turn_ids) > 0
    AND ${memoryCourseAllows(db, course, () => db`${eligibleCourseId}::uuid`, workspace)}`;
  // Avoid reaching the dependency planner at all when there is no sourced memory.
  const [hasEvidence] = await db`SELECT m.id FROM opening_memories m WHERE ${eligibleForScope()} LIMIT 1`;
  if (!hasEvidence) return [];
  // Bound the explicit ancestry query to all selected roots in one walk.
  // The origin check also resolves unattributed backing and validates stored material.
  const rows = await db`
    /* Batch the original WITH RECURSIVE mem_deps(dep_id) traversal by root memory. */
    WITH RECURSIVE eligible AS MATERIALIZED (
      SELECT m.*, (
        SELECT jsonb_build_object(
          'turn_ids', COALESCE(jsonb_agg(t.id), '[]'::jsonb),
          'refs', jsonb_path_query_array(COALESCE(jsonb_agg(${turnContextSourceRefs(db, "t")}), '[]'::jsonb), '$[*][*]')
        )
        FROM jsonb_array_elements_text(m.source_turn_ids) ref(turn_id)
        JOIN opening_turns t ON t.id::text = lower(ref.turn_id) AND t.workspace_id = m.workspace_id AND t.status = 'complete'
      ) AS source_evidence
      FROM opening_memories m
      WHERE ${eligibleForScope()}
    ), mem_deps(dep_id, root_id) AS (
      SELECT lower(dep.id), m.id AS root_id
      FROM eligible m CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`m.source_evidence->'refs'`)} dep
      UNION
      SELECT CASE WHEN ${dependencyOriginCourseAllows(db, () => db`parent.course_id`, () => db`child.course_id`, () => db`course.id`)}
        THEN lower(dep.id) END, prev.root_id
      FROM mem_deps prev
      JOIN opening_memories parent ON parent.id = ${lineageUuid(db, () => db`prev.dep_id`)} AND parent.workspace_id = ${scope.workspaceId}
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(parent.source_turn_ids) = 'array' THEN parent.source_turn_ids ELSE '[]'::jsonb END
      ) origin(turn_id)
      JOIN opening_turns t ON t.id = ${lineageUuid(db, () => db`origin.turn_id`)} AND t.workspace_id = parent.workspace_id AND t.status = 'complete'
      CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`t.context_source_refs`)} dep
      CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "t")} AS id) course
      LEFT JOIN opening_memories child ON child.id = ${lineageUuid(db, () => db`dep.id`)} AND child.workspace_id = parent.workspace_id
    ), ancestry AS (
      SELECT d.root_id, jsonb_agg(DISTINCT d.dep_id) AS memory_ids,
        min(dep_m.expires_at) FILTER (WHERE dep_m.kind = 'temporary') AS temporary_expires_at,
        bool_and(COALESCE(dep_m.id <> d.root_id AND dep_m.status = 'active'
          AND (dep_m.course_id IS NULL OR dep_course.id IS NOT NULL)
          AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp())), false)) AS all_active
      FROM mem_deps d
      LEFT JOIN opening_memories dep_m ON dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)} AND dep_m.workspace_id = ${scope.workspaceId}
      LEFT JOIN courses dep_course ON dep_course.id=dep_m.course_id AND dep_course.workspace_id=dep_m.workspace_id
        AND dep_course.archived_at IS NULL
      GROUP BY d.root_id
    )
    SELECT eligible.*, source_evidence->'refs' AS material_source_refs,
      source_evidence->'turn_ids' AS evidence_turn_ids,
      ancestry.temporary_expires_at AS ancestor_temporary_expires_at, ancestry.memory_ids AS ancestor_memory_ids
    FROM eligible LEFT JOIN ancestry ON ancestry.root_id = eligible.id
    WHERE COALESCE(ancestry.all_active, true)
      AND jsonb_array_length(source_evidence->'turn_ids') = jsonb_array_length(source_turn_ids)
    ORDER BY created_at ASC`;
  const originRows = rows.flatMap(row => Array.isArray(row.evidence_turn_ids) ? [{
    id: String(row.id), excludedId: String(row.id), course_id: row.course_id as string | null, turn_ids: row.evidence_turn_ids as string[],
  }] : []);
  const collectSourceIds = new Set<string>();
  let origins = await readMemoryOrigins(db, scope, originRows, { excluded: excludedSourceIds, materialUse, collectSourceIds });
  if (collectSourceIds.size) {
    const lockedSourceIds = await lockMemoryMaterialSources(db, scope, collectSourceIds);
    origins = await readMemoryOrigins(db, scope, originRows, { excluded: excludedSourceIds, materialUse, lockedSourceIds });
  }
  return rows.flatMap(row => {
    const origin = origins.get(String(row.id));
    const sourceRefs = parseContextSourceRefs(row.material_source_refs);
    if (origin === null || sourceRefs === null) return [];
    const expiry = Math.min(row.ancestor_temporary_expires_at == null
      ? Infinity : new Date(row.ancestor_temporary_expires_at as string | Date).getTime(), origin?.expiresAt ?? Infinity);
    if (Number.isNaN(expiry)) return [];
    const ancestorTemporaryExpiresAt = Number.isFinite(expiry) ? new Date(expiry).toISOString() : undefined;
    const ancestorMemoryIds = [...new Set([
      ...(parseContextMemoryDependencyIds([{ memoryDependencyIds: row.ancestor_memory_ids }]) ?? []),
      ...(origin?.ids ?? []),
    ])].sort();
    return [{ memory: mapMemoryRow(row as Record<string, unknown>), sourceRefs, ancestorTemporaryExpiresAt, ancestorMemoryIds }];
  });
}

function readMemoryContext(
  db: Db, scope: OpeningScope, activeCourseId: string | null, materialUse: "citation" | "practice", excludedSourceIds?: readonly string[],
) {
  const read = (tx: Db) => readMemoryContextInTx(tx, scope, activeCourseId, materialUse, excludedSourceIds);
  return "begin" in db && typeof db.begin === "function" ? db.begin(read) : read(db);
}

export async function listMemoriesForContext(
  db: Db, scope: OpeningScope, activeCourseId: string | null, excludedSourceIds?: readonly string[], now?: string,
  materialUse: "citation" | "practice" = "citation",
): Promise<MemoryItem[]> {
  const rows = await readMemoryContext(db, scope, activeCourseId, materialUse, excludedSourceIds);
  if (now === undefined) return rows.map((row) => row.memory);
  const nowMs = Date.parse(now);
  return rows
    .filter((row) => row.ancestorTemporaryExpiresAt === undefined
      || (!Number.isNaN(nowMs) && Date.parse(row.ancestorTemporaryExpiresAt) > nowMs))
    .map((row) => row.memory);
}

/** The same instant selects both the injected text and its material lineage. */
export async function loadMemoryContext(
  db: Db, scope: OpeningScope, activeCourseId: string | null, now: string, materialUse: "citation" | "practice" = "citation",
): Promise<LoadedMemoryContext> {
  const nowMs = Date.parse(now);
  const eligible = (await readMemoryContext(db, scope, activeCourseId, materialUse))
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
