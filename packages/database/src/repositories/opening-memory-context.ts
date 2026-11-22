import type { Sql, TransactionSql } from "postgres";
import type { MemoryItem } from "@aistudy/contracts";
import { isMemoryEligible } from "@aistudy/domain";
import {
  memoryCourseAllows, memoryDependencySummary, memoryTransitiveDepsCte,
  mergeContextSourceRefs, parseContextMemoryDependencyIds, parseContextSourceRefs, turnContextSourceRefs,
  type ContextSourceRef, type FragmentFactory,
} from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";
import { lockOwnedWorkspace, readMemoryOrigins } from "./opening-memory-admission";
import { mapMemoryRow } from "./opening-memory-types";

type Db = Sql | TransactionSql;

export type LoadedMemoryContext = {
  memories: MemoryItem[];
  sourceRefs: ContextSourceRef[];
  temporaryMemoryExpiresAt?: string;
  dependencyMemoryIds?: string[];
};

/**
 * Read eligible rows before validating their backing turns. Exclude missing, foreign,
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
  const workspace: FragmentFactory = () => db`m.workspace_id`;
  const course: FragmentFactory = () => db`m.course_id`;
  const eligibleForScope: FragmentFactory = () => db`m.workspace_id = ${scope.workspaceId} AND m.status = 'active'
    AND jsonb_array_length(m.source_turn_ids) > 0
    AND ${memoryCourseAllows(db, course, () => db`${activeCourseId}::uuid`, workspace)}`;
  // Avoid reaching the dependency planner at all when there is no sourced memory.
  const [hasEvidence] = await db`SELECT m.id FROM opening_memories m WHERE ${eligibleForScope()} LIMIT 1`;
  if (!hasEvidence) return [];
  const rows = await db`
    WITH eligible AS MATERIALIZED (
      SELECT m.*, (
        SELECT jsonb_build_object(
          'turn_ids', COALESCE(jsonb_agg(t.id), '[]'::jsonb),
          'refs', jsonb_path_query_array(COALESCE(jsonb_agg(${turnContextSourceRefs(db, "t")}), '[]'::jsonb), '$[*][*]')
        )
        FROM jsonb_array_elements_text(m.source_turn_ids) ref(turn_id)
        JOIN opening_turns t ON t.id::text = lower(ref.turn_id) AND t.workspace_id = m.workspace_id
      ) AS source_evidence, (
        SELECT to_jsonb(chain) FROM (
          ${memoryDependencySummary(db, memoryTransitiveDepsCte(db), workspace, course, () => db`m.id`)}
        ) chain
      ) AS ancestry
      FROM opening_memories m
      WHERE ${eligibleForScope()}
    )
    SELECT eligible.*, source_evidence->'refs' AS material_source_refs,
      source_evidence->'turn_ids' AS evidence_turn_ids,
      ancestry->>'temporary_expires_at' AS ancestor_temporary_expires_at, ancestry->'memory_ids' AS ancestor_memory_ids
    FROM eligible WHERE (ancestry->>'all_active')::boolean
      AND jsonb_array_length(source_evidence->'turn_ids') = jsonb_array_length(source_turn_ids)
    ORDER BY created_at ASC`;
  const origins = await readMemoryOrigins(db, scope, rows.flatMap(row => Array.isArray(row.evidence_turn_ids) ? [{
    id: String(row.id), excludedId: String(row.id), course_id: row.course_id as string | null, turn_ids: row.evidence_turn_ids as string[],
  }] : []), { excluded: excludedSourceIds });
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
