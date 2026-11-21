import type { Sql, TransactionSql } from "postgres";
import type { Citation } from "@aistudy/contracts";
import { notePublicationMetadata } from "@aistudy/domain";

type Db = Sql | TransactionSql;
type Fragment = ReturnType<Db>;
export type ContextSourceRef = Pick<Citation, "sourceId" | "sourceVersion"> & {
  memoryOnly?: boolean;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMemoryDependencyMetadata(value: unknown): value is { memoryDependencyIds: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "memoryDependencyIds") return false;
  const ids = (value as { memoryDependencyIds?: unknown }).memoryDependencyIds;
  return Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === "string" && UUID.test(id));
}

/** Extract exact saved global-memory dependency UUIDs from persisted context_source_refs JSON. NULL on malformed lineage. */
export function parseContextMemoryDependencyIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const ref of value) {
    if (isMemoryDependencyMetadata(ref)) {
      for (const id of ref.memoryDependencyIds) ids.add(id.toLowerCase());
      continue;
    }
    if (!ref || typeof ref !== "object" || typeof ref.sourceId !== "string"
      || !UUID.test(ref.sourceId) || !Number.isSafeInteger(ref.sourceVersion) || ref.sourceVersion < 0
      || (ref.memoryOnly !== undefined && typeof ref.memoryOnly !== "boolean")) return null;
  }
  return [...ids].sort();
}

/** Persisted JSON is a trust boundary. NULL is unknown, never an empty lineage. */
export function parseContextSourceRefs(value: unknown): ContextSourceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: ContextSourceRef[] = [];
  for (const ref of value) {
    if (isMemoryDependencyMetadata(ref)) continue;
    if (!ref || typeof ref !== "object" || typeof ref.sourceId !== "string"
      || !UUID.test(ref.sourceId) || !Number.isSafeInteger(ref.sourceVersion) || ref.sourceVersion < 0
      || (ref.memoryOnly !== undefined && typeof ref.memoryOnly !== "boolean")) return null;
    refs.push({
      sourceId: ref.sourceId.toLowerCase(),
      sourceVersion: ref.sourceVersion,
      ...(ref.memoryOnly === true ? { memoryOnly: true } : {}),
    });
  }
  return mergeContextSourceRefs(refs);
}

export function mergeContextSourceRefs(...groups: readonly ContextSourceRef[][]): ContextSourceRef[] {
  const unique = new Map<string, { sourceId: string; sourceVersion: number }>();
  const nonMemorySourceIds = new Set<string>();
  const memoryOnlySourceIds = new Set<string>();
  for (const group of groups) for (const ref of group) {
    const sourceId = ref.sourceId.toLowerCase();
    if (ref.memoryOnly === true) memoryOnlySourceIds.add(sourceId);
    else nonMemorySourceIds.add(sourceId);
    const key = `${sourceId}:${ref.sourceVersion}`;
    if (!unique.has(key)) unique.set(key, { sourceId, sourceVersion: ref.sourceVersion });
  }
  return [...unique.values()].map(entry =>
    memoryOnlySourceIds.has(entry.sourceId) && !nonMemorySourceIds.has(entry.sourceId)
      ? { ...entry, memoryOnly: true }
      : entry,
  );
}

export function parseNoteContextSourceRefs(value: unknown): ContextSourceRef[] | null {
  return parseContextSourceRefs(Array.isArray(value) ? value.filter(ref => !notePublicationMetadata(ref)) : value);
}

/** Strip the exact note-only metadata shapes before applying source admission. */
export function noteContextSourceRefs(db: Db, refs: Fragment): Fragment {
  return db`CASE WHEN jsonb_typeof(${refs})='array' THEN (
    SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM jsonb_array_elements(${refs}) ref
    WHERE NOT EXISTS (
      SELECT 1 FROM (VALUES ('answerKeyBlockIds'), ('publicationCardIds')) AS metadata(key)
      WHERE ref=jsonb_build_object(metadata.key, ref->metadata.key)
        AND jsonb_typeof(ref->metadata.key)='array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ref->metadata.key)='array'
          THEN ref->metadata.key ELSE '[]'::jsonb END) AS item(value)
          WHERE item.value IS NULL OR item.value !~* ${UUID.source})
    )
  ) ELSE ${refs} END`;
}

/** SQL admission shared by live context and backup, with the latter retaining historical versions. */
export function contextSourceRefsIncluded(
  db: Db, workspaceId: string, refs: Fragment, allowHistoricalVersions = false, requireAvailability = !allowHistoricalVersions,
): Fragment {
  return db`
    COALESCE(jsonb_typeof(${refs}) = 'array', false)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${refs}) = 'array' THEN ${refs} ELSE '[]'::jsonb END
      ) provenance_ref
      WHERE NOT (
          provenance_ref = jsonb_build_object('memoryDependencyIds', provenance_ref->'memoryDependencyIds')
          AND jsonb_typeof(provenance_ref->'memoryDependencyIds') = 'array'
          AND jsonb_array_length(provenance_ref->'memoryDependencyIds') > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(provenance_ref->'memoryDependencyIds') = 'array'
                THEN provenance_ref->'memoryDependencyIds' ELSE '[]'::jsonb END
            ) AS dep(value)
            WHERE dep.value IS NULL OR dep.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
        )
        AND (
          jsonb_typeof(provenance_ref) IS DISTINCT FROM 'object'
          OR jsonb_typeof(provenance_ref->'sourceId') IS DISTINCT FROM 'string'
          OR (provenance_ref->>'sourceId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR jsonb_typeof(provenance_ref->'sourceVersion') IS DISTINCT FROM 'number'
          OR (provenance_ref->>'sourceVersion') !~ '^[0-9]+$'
          OR CASE WHEN jsonb_typeof(provenance_ref->'sourceVersion') = 'number'
            AND (provenance_ref->>'sourceVersion') ~ '^[0-9]+$'
            THEN (provenance_ref->>'sourceVersion')::numeric > 9007199254740991 ELSE false END
          OR NOT EXISTS (
            SELECT 1 FROM opening_sources provenance_source
            WHERE provenance_source.id::text = lower(provenance_ref->>'sourceId')
              AND provenance_source.workspace_id = ${workspaceId}
              AND provenance_source.upload_state = 'uploaded'
              AND (${!requireAvailability} OR NOT EXISTS (SELECT 1 FROM opening_source_versions provenance_version
                WHERE provenance_version.workspace_id=${workspaceId} AND provenance_version.source_id=provenance_source.id
                  AND provenance_version.version::text=provenance_ref->>'sourceVersion' AND provenance_version.availability='unavailable'))
              AND (${allowHistoricalVersions} OR provenance_source.version::text = provenance_ref->>'sourceVersion')
              AND NOT EXISTS (
                SELECT 1 FROM opening_privacy_exclusions provenance_exclusion
                WHERE provenance_exclusion.workspace_id = ${workspaceId}
                  AND provenance_exclusion.source_id = provenance_source.id
              )
          )
        )
    )`;
}

/** Version pins can exist independently of the turn's explicit source_ids. */
export function turnPinnedSourceRefs(db: Db, versions: Fragment, anchor: Fragment): Fragment {
  return db`
    SELECT source_id, source_version, true AS version_required
    FROM jsonb_each(CASE WHEN jsonb_typeof(${versions}) = 'object' THEN ${versions} ELSE '{}'::jsonb END)
      AS pin(source_id, source_version)
    UNION ALL
    SELECT ${anchor}->>'sourceId', NULLIF(${anchor}->'sourceVersion', 'null'::jsonb), false
    WHERE ${anchor}->>'sourceId' IS NOT NULL`;
}

export function turnPinnedSourcesIncluded(
  db: Db, workspaceId: string, versions: Fragment, anchor: Fragment, historical = false,
): Fragment {
  return db`
    COALESCE(jsonb_typeof(${versions}) = 'object', false)
    AND NOT EXISTS (
      SELECT 1 FROM (${turnPinnedSourceRefs(db, versions, anchor)}) pin
      WHERE ((pin.version_required OR pin.source_version IS NOT NULL)
          AND (jsonb_typeof(pin.source_version) IS DISTINCT FROM 'number'
            OR (pin.source_version #>> '{}') !~ '^[0-9]+$'))
        OR NOT EXISTS (
          SELECT 1 FROM opening_sources s
          WHERE s.id = ${lineageUuid(db, db`pin.source_id`)}
            AND s.workspace_id = ${workspaceId} AND s.upload_state = 'uploaded'
            AND (${historical} OR pin.source_version IS NULL OR s.version::text = pin.source_version #>> '{}')
            AND (${historical} OR NOT EXISTS (
              SELECT 1 FROM opening_source_versions sv
              WHERE sv.workspace_id = s.workspace_id AND sv.source_id = s.id
                AND sv.version::text = COALESCE(pin.source_version #>> '{}', s.version::text)
                AND sv.availability = 'unavailable'
            ))
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions e
              WHERE e.workspace_id = s.workspace_id AND e.source_id = s.id
            )
        )
    )`;
}

/** User turns are original leaves; assistant turns must carry their full consumed lineage. */
export function turnContextSourceRefs(db: Db, alias: "t" | "u" | "a" | "mt"): Fragment {
  const column = (name: string): Fragment => db`${db.unsafe(`${alias}.${name}`)}`;
  const versions = column("source_versions");
  const context = column("context_source_refs");
  const pins = turnPinnedSourceRefs(db, versions, column("context_anchor"));
  return db`CASE
    WHEN jsonb_typeof(${versions}) IS DISTINCT FROM 'object' THEN NULL
    WHEN ${column("role")} = 'assistant' AND jsonb_typeof(${context}) IS DISTINCT FROM 'array' THEN ${context}
    ELSE (CASE WHEN ${column("role")} = 'assistant' THEN ${context} ELSE (
      SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('sourceId', sid.id, 'sourceVersion', NULL) AS ref
        FROM unnest(${column("source_ids")}) sid(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM (${pins}) pin
          WHERE lower(pin.source_id) = sid.id::text AND pin.source_version IS NOT NULL
        )
        UNION ALL
        SELECT jsonb_build_object('sourceId', citation->'sourceId', 'sourceVersion', citation->'sourceVersion')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column("citations")})='array'
          THEN ${column("citations")} ELSE '[null]'::jsonb END) citation
      ) direct_refs
    ) END) || (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId', pin.source_id, 'sourceVersion', pin.source_version)), '[]'::jsonb)
      FROM (${pins}) pin
    )
  END`;
}

/** Cycle-safe recursive CTE walking a memory's source_turn_ids -> turn memoryDependencyIds -> ancestor memories. */
export function memoryTransitiveDepsCte(db: Db, alias: "" | "m" = "m"): Fragment {
  const sourceTurnIds = alias === "m" ? db`m.source_turn_ids` : db`opening_memories.source_turn_ids`;
  const workspaceId = alias === "m" ? db`m.workspace_id` : db`opening_memories.workspace_id`;
  return db`WITH RECURSIVE mem_deps(dep_id) AS (
    SELECT lower(dep.id)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(${sourceTurnIds}) = 'array' THEN ${sourceTurnIds} ELSE '[]'::jsonb END
    ) AS st(turn_id)
    JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = ${workspaceId}
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
    JOIN opening_memories pm ON pm.id::text = prev.dep_id AND pm.workspace_id = ${workspaceId}
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
    ) AS st(turn_id)
    JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = ${workspaceId}
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
    ) AS dep_elem
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
        AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
        THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
    ) AS dep(id)
  )`;
}

/** TRUE iff every transitive global memory referenced by a memory's source turns is active and unexpired. */
export function memoryTransitiveDependenciesActive(db: Db, alias: "" | "m" = "m"): Fragment {
  const sourceTurnIds = alias === "m" ? db`m.source_turn_ids` : db`opening_memories.source_turn_ids`;
  const workspaceId = alias === "m" ? db`m.workspace_id` : db`opening_memories.workspace_id`;
  return db`NOT EXISTS (
    WITH RECURSIVE mem_deps(dep_id) AS (
      SELECT lower(dep.id)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(${sourceTurnIds}) = 'array' THEN ${sourceTurnIds} ELSE '[]'::jsonb END
      ) AS st(turn_id)
      JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = ${workspaceId}
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
      JOIN opening_memories pm ON pm.id::text = prev.dep_id AND pm.workspace_id = ${workspaceId}
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
      ) AS st(turn_id)
      JOIN opening_turns dt ON dt.id::text = lower(st.turn_id) AND dt.workspace_id = ${workspaceId}
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
        AND dep_m.workspace_id = ${workspaceId}
        AND dep_m.status = 'active'
        AND dep_m.course_id IS NULL
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at IS NOT NULL AND dep_m.expires_at > clock_timestamp()))
    )
  )`;
}

function lineageUuid(db: Db, value: Fragment): Fragment {
  return db`CASE WHEN ${value} ~* ${UUID.source} THEN ${value}::uuid END`;
}

/** Cycle-safe recursive CTE walking a turn's context_source_refs memoryDependencyIds -> ancestor memories. */
export function turnTransitiveDepsCte(db: Db, alias: "a" | "t"): Fragment {
  const contextRefs = alias === "a" ? db`a.context_source_refs` : db`t.context_source_refs`;
  const workspaceId = alias === "a" ? db`a.workspace_id` : db`t.workspace_id`;
  return db`WITH RECURSIVE mem_deps(dep_id) AS (
    SELECT lower(dep.id)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${contextRefs}) = 'array' THEN ${contextRefs} ELSE '[]'::jsonb END
    ) AS dep_elem
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
        AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
        THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
    ) AS dep(id)
    UNION
    SELECT lower(dep.id)
    FROM mem_deps prev
    JOIN opening_memories pm ON pm.id = ${lineageUuid(db, db`prev.dep_id`)} AND pm.workspace_id = ${workspaceId}
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
    ) AS st(turn_id)
    JOIN opening_turns dt ON dt.id = ${lineageUuid(db, db`st.turn_id`)} AND dt.workspace_id = ${workspaceId}
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(dt.context_source_refs) = 'array' THEN dt.context_source_refs ELSE '[]'::jsonb END
    ) AS dep_elem
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
        AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
        THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
    ) AS dep(id)
  )`;
}

/** TRUE iff every transitive global memory referenced by a turn's memoryDependencyIds is active and unexpired. */
export function turnTransitiveDependenciesActive(db: Db, alias: "a" | "t"): Fragment {
  const workspaceId = alias === "a" ? db`a.workspace_id` : db`t.workspace_id`;
  return db`NOT EXISTS (
    ${turnTransitiveDepsCte(db, alias)}
    SELECT 1
    FROM mem_deps d
    WHERE NOT EXISTS (
      SELECT 1
      FROM opening_memories m
      WHERE m.id = ${lineageUuid(db, db`d.dep_id`)}
        AND m.workspace_id = ${workspaceId}
        AND m.status = 'active'
        AND m.course_id IS NULL
        AND (m.kind = 'confirmed' OR (m.kind = 'temporary' AND m.expires_at IS NOT NULL AND m.expires_at > clock_timestamp()))
    )
  )`;
}

export function turnHasMemoryDependencies(db: Db): Fragment {
  return db`t.context_source_refs @? '$[*].memoryDependencyIds[*]'`;
}

/** Call only for turns with dependencies, so ordinary reads never plan a recursive query. */
export async function readTurnsWithActiveMemoryDependencies(
  db: Db, workspaceId: string, turnIds: string[],
): Promise<Set<string>> {
  if (!turnIds.length) return new Set();
  const rows = await db<{ id: string }[]>`
    SELECT t.id FROM opening_turns t
    WHERE t.workspace_id = ${workspaceId} AND t.id = ANY(${turnIds}::uuid[])
      AND ${turnTransitiveDependenciesActive(db, "t")}`;
  return new Set(rows.map(row => row.id));
}
