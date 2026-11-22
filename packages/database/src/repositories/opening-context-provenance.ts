import type { Sql, TransactionSql } from "postgres";
import type { Citation } from "@aistudy/contracts";
import { notePublicationMetadata } from "@aistudy/domain";

type Db = Sql | TransactionSql;
type Fragment = ReturnType<Db>;
export type FragmentFactory = () => Fragment;
type MemoryAlias = "" | "m";
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

/** Extract exact saved memory dependency UUIDs from persisted context_source_refs JSON. NULL on malformed lineage. */
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
export function noteContextSourceRefs(db: Db, refs: FragmentFactory): Fragment {
  return db`CASE WHEN jsonb_typeof(${refs()})='array' THEN (
    SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM jsonb_array_elements(${refs()}) ref
    WHERE NOT EXISTS (
      SELECT 1 FROM (VALUES ('answerKeyBlockIds'), ('publicationCardIds')) AS metadata(key)
      WHERE ref=jsonb_build_object(metadata.key, ref->metadata.key)
        AND jsonb_typeof(ref->metadata.key)='array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ref->metadata.key)='array'
          THEN ref->metadata.key ELSE '[]'::jsonb END) AS item(value)
          WHERE item.value IS NULL OR item.value !~* ${UUID.source})
    )
  ) ELSE ${refs()} END`;
}

/** SQL admission shared by live context and backup, with the latter retaining historical versions. */
export function contextSourceRefsIncluded(
  db: Db, workspaceId: string, refs: FragmentFactory, allowHistoricalVersions = false, requireAvailability = !allowHistoricalVersions,
  bareSourceIds?: FragmentFactory,
): Fragment {
  const versionless: FragmentFactory = () => bareSourceIds ? db`input.unversioned` : db`false`;
  const safeRefs: FragmentFactory = () => db`CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END`;
  return db`
    COALESCE(jsonb_typeof(${refs()}) = 'array', false)
    AND NOT EXISTS (
      SELECT 1 FROM ${bareSourceIds ? db`(
        SELECT elem, false AS unversioned FROM jsonb_array_elements(${safeRefs()}) elem
        UNION ALL
        SELECT jsonb_build_object('sourceId', sid.id), true FROM unnest(${bareSourceIds()}) sid(id)
      ) AS input(provenance_ref, unversioned)` : db`jsonb_array_elements(${safeRefs()}) provenance_ref`}
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
          OR (NOT ${versionless()} AND (jsonb_typeof(provenance_ref->'sourceVersion') IS DISTINCT FROM 'number'
            OR (provenance_ref->>'sourceVersion') !~ '^[0-9]+$'))
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
                  AND provenance_version.version::text=COALESCE(provenance_ref->>'sourceVersion', provenance_source.version::text)
                  AND provenance_version.availability='unavailable'))
              AND (${allowHistoricalVersions} OR ${versionless()} OR provenance_source.version::text = provenance_ref->>'sourceVersion')
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
export function turnPinnedSourceRefs(db: Db, versions: FragmentFactory, anchor: FragmentFactory): Fragment {
  return db`
    SELECT source_id, source_version, true AS version_required
    FROM jsonb_each(CASE WHEN jsonb_typeof(${versions()}) = 'object' THEN ${versions()} ELSE '{}'::jsonb END)
      AS pin(source_id, source_version)
    UNION ALL
    SELECT ${anchor()}->>'sourceId', NULLIF(${anchor()}->'sourceVersion', 'null'::jsonb), false
    WHERE ${anchor()}->>'sourceId' IS NOT NULL`;
}

export function turnPinnedSourcesIncluded(
  db: Db, workspaceId: string, versions: FragmentFactory, anchor: FragmentFactory, historical = false,
): Fragment {
  return db`
    COALESCE(jsonb_typeof(${versions()}) = 'object', false)
    AND NOT EXISTS (
      SELECT 1 FROM (${turnPinnedSourceRefs(db, versions, anchor)}) pin
      WHERE ((pin.version_required OR pin.source_version IS NOT NULL)
          AND (jsonb_typeof(pin.source_version) IS DISTINCT FROM 'number'
            OR (pin.source_version #>> '{}') !~ '^[0-9]+$'))
        OR NOT EXISTS (
          SELECT 1 FROM opening_sources s
          WHERE s.id = ${lineageUuid(db, () => db`pin.source_id`)}
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
  const versions = () => column("source_versions");
  const context = () => column("context_source_refs");
  const pins = () => turnPinnedSourceRefs(db, versions, () => column("context_anchor"));
  return db`CASE
    WHEN jsonb_typeof(${versions()}) IS DISTINCT FROM 'object' THEN NULL
    WHEN ${column("role")} = 'assistant' AND jsonb_typeof(${context()}) IS DISTINCT FROM 'array' THEN ${context()}
    ELSE (CASE WHEN ${column("role")} = 'assistant' THEN ${context()} ELSE (
      SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('sourceId', sid.id, 'sourceVersion', NULL) AS ref
        FROM unnest(${column("source_ids")}) sid(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM (${pins()}) pin
          WHERE lower(pin.source_id) = sid.id::text AND pin.source_version IS NOT NULL
        )
        UNION ALL
        SELECT jsonb_build_object('sourceId', citation->'sourceId', 'sourceVersion', citation->'sourceVersion')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column("citations")})='array'
          THEN ${column("citations")} ELSE '[null]'::jsonb END) citation
      ) direct_refs
    ) END) || (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId', pin.source_id, 'sourceVersion', pin.source_version)), '[]'::jsonb)
      FROM (${pins()}) pin
    )
  END`;
}

/** Expose metadata filters to the planner before expanding their dependency arrays. */
export function memoryDependencyRows(db: Db, refs: FragmentFactory): Fragment {
  return db`(
    SELECT dep.id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END
    ) AS dep_elem
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
        THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END
    ) AS dep(id)
    WHERE dep_elem = jsonb_build_object('memoryDependencyIds', dep_elem->'memoryDependencyIds')
      AND jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
  )`;
}

/** Cycle-safe recursive CTE walking a memory's source_turn_ids -> turn memoryDependencyIds -> ancestor memories. */
export function memoryTransitiveDepsCte(db: Db, alias: MemoryAlias = "m"): Fragment {
  return db`WITH RECURSIVE mem_deps(dep_id) AS (${memoryDependencyWalk(db, alias)})`;
}

export function memoryDependencyWalk(db: Db, alias: MemoryAlias = "m"): Fragment {
  const sourceTurnIds = () => alias === "m" ? db`m.source_turn_ids` : db`opening_memories.source_turn_ids`;
  const workspaceId: FragmentFactory = () => alias === "m" ? db`m.workspace_id` : db`opening_memories.workspace_id`;
  return db`
    SELECT lower(dep.id)
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(${sourceTurnIds()}) = 'array' THEN ${sourceTurnIds()} ELSE '[]'::jsonb END
    ) AS ref(turn_id)
    JOIN opening_turns dt ON dt.id::text = lower(ref.turn_id) AND dt.workspace_id = ${workspaceId()}
    CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`dt.context_source_refs`)} AS dep
    UNION ${memoryDependencyStep(db, workspaceId)}`;
}

/** A scoped memory is usable only in its own active course. */
export function memoryCourseAllows(
  db: Db, memoryCourseId: FragmentFactory, targetCourseId: FragmentFactory, workspaceId: FragmentFactory,
): Fragment {
  return db`(${memoryCourseId()} IS NULL OR (${memoryCourseId()} = ${targetCourseId()} AND EXISTS (
    SELECT 1 FROM courses cr WHERE cr.id = ${memoryCourseId()}
      AND cr.workspace_id = ${workspaceId()} AND cr.archived_at IS NULL
  )))`;
}

/** TRUE iff every transitive memory referenced by a memory's source turns is usable in its course. */
export function memoryTransitiveDependenciesActive(db: Db, alias: MemoryAlias = "m"): Fragment {
  const workspaceId: FragmentFactory = () => alias === "m" ? db`m.workspace_id` : db`opening_memories.workspace_id`;
  const courseId: FragmentFactory = () => alias === "m" ? db`m.course_id` : db`opening_memories.course_id`;
  return db`NOT EXISTS (
    ${memoryTransitiveDepsCte(db, alias)}
    SELECT 1
    FROM mem_deps d
    WHERE NOT EXISTS (
      SELECT 1
      FROM opening_memories dep_m
      WHERE dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)}
        AND dep_m.workspace_id = ${workspaceId()}
        AND dep_m.status = 'active'
        AND ${memoryCourseAllows(db, () => db`dep_m.course_id`, courseId, workspaceId)}
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at IS NOT NULL AND dep_m.expires_at > clock_timestamp()))
    )
  )`;
}

export function lineageUuid(db: Db, value: FragmentFactory): Fragment {
  return db`CASE WHEN (${value()}) ~* ${UUID.source} THEN (${value()})::uuid END`;
}

export function turnLineageCourse(db: Db, alias: "a" | "t", conversationCourse?: FragmentFactory): Fragment {
  const turn: FragmentFactory = () => alias === "a" ? db`a` : db`t`;
  const course = conversationCourse ?? (() => db`(SELECT tc.course_id FROM opening_conversations tc
    WHERE tc.id = ${turn()}.conversation_id AND tc.workspace_id = ${turn()}.workspace_id)`);
  return db`(
    COALESCE(${course()}, ${lineageUuid(db, () => db`${turn()}.context_anchor->>'courseId'`)},
      CASE WHEN ${turn()}.role = 'assistant' THEN (
        SELECT ${lineageUuid(db, () => db`tu.context_anchor->>'courseId'`)} FROM opening_turns tu
        WHERE tu.workspace_id = ${turn()}.workspace_id AND tu.conversation_id = ${turn()}.conversation_id AND tu.role = 'user'
          AND tu.id = (SELECT tj.user_turn_id FROM opening_tutor_jobs tj
            WHERE tj.assistant_turn_id = ${turn()}.id AND tj.workspace_id = ${turn()}.workspace_id
              AND tj.conversation_id = ${turn()}.conversation_id)
      ) END)
  )`;
}

/** Cycle-safe recursive CTE walking a turn's context_source_refs memoryDependencyIds -> ancestor memories. */
export function turnTransitiveDepsCte(db: Db, alias: "a" | "t"): Fragment {
  return db`WITH RECURSIVE mem_deps(dep_id) AS (${turnDependencyWalk(db, alias)})`;
}

export function turnDependencyWalk(db: Db, alias: "a" | "t"): Fragment {
  const contextRefs: FragmentFactory = () => alias === "a" ? db`a.context_source_refs` : db`t.context_source_refs`;
  const workspaceId: FragmentFactory = () => alias === "a" ? db`a.workspace_id` : db`t.workspace_id`;
  return db`
    SELECT lower(dep.id) FROM ${memoryDependencyRows(db, contextRefs)} AS dep
    UNION ${memoryDependencyStep(db, workspaceId)}`;
}

function memoryDependencyStep(db: Db, workspaceId: FragmentFactory): Fragment {
  return db`
    SELECT CASE WHEN child.course_id IS NOT NULL AND child.course_id IS DISTINCT FROM pm.course_id
      THEN NULL ELSE lower(dep.id) END
    FROM mem_deps prev
    JOIN opening_memories pm ON pm.id = ${lineageUuid(db, () => db`prev.dep_id`)} AND pm.workspace_id = ${workspaceId()}
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
    ) AS st(turn_id)
    JOIN opening_turns dt ON dt.id = ${lineageUuid(db, () => db`st.turn_id`)} AND dt.workspace_id = ${workspaceId()}
    CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`dt.context_source_refs`)} AS dep
    LEFT JOIN opening_memories child ON child.workspace_id = pm.workspace_id
      AND child.id = ${lineageUuid(db, () => db`dep.id`)}`;
}

/** A turn may carry only memory usable both there and in the new consumer's course. */
export function turnTransitiveDependenciesActive(
  db: Db, alias: "a" | "t", targetCourseId?: FragmentFactory,
  ownCourseId: FragmentFactory = () => turnLineageCourse(db, alias),
): Fragment {
  const workspaceId: FragmentFactory = () => alias === "a" ? db`a.workspace_id` : db`t.workspace_id`;
  const memoryCourseId: FragmentFactory = () => db`dep_m.course_id`;
  return db`NOT EXISTS (
    ${turnTransitiveDepsCte(db, alias)}
    SELECT 1
    FROM mem_deps d
    WHERE NOT EXISTS (
      SELECT 1
      FROM opening_memories dep_m
      WHERE dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)}
        AND dep_m.workspace_id = ${workspaceId()}
        AND dep_m.status = 'active'
        AND ${memoryCourseAllows(db, memoryCourseId, ownCourseId, workspaceId)}
        ${targetCourseId ? db`AND ${memoryCourseAllows(db, memoryCourseId, targetCourseId, workspaceId)}` : db``}
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at IS NOT NULL AND dep_m.expires_at > clock_timestamp()))
    )
  )`;
}

/** The source must be present in an owned source turn of the exact backing memory. */
export function memoryBacksSource(
  db: Db, sourceTurnIds: FragmentFactory, sourceId: FragmentFactory, workspaceId: string, ownerUserId: string,
  allowInheritedRefs: FragmentFactory,
): Fragment {
  return db`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(${sourceTurnIds()}) = 'array' THEN ${sourceTurnIds()} ELSE '[]'::jsonb END
    ) AS mref(turn_id)
    JOIN opening_turns mt ON mt.id::text = lower(mref.turn_id) AND mt.workspace_id = ${workspaceId}
    JOIN opening_conversations mc ON mc.id = mt.conversation_id
      AND mc.workspace_id = ${workspaceId} AND mc.owner_user_id = ${ownerUserId}
    CROSS JOIN LATERAL (SELECT CASE WHEN mt.role = 'assistant' THEN mt.context_source_refs ELSE mt.citations END AS refs) origin
    WHERE ${sourceId()} = ANY(mt.source_ids) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(origin.refs) = 'array' THEN origin.refs ELSE '[]'::jsonb END
      ) AS turn_ref
      WHERE lower(turn_ref->>'sourceId') = ${sourceId()}::text
        AND ((turn_ref->>'memoryOnly') IS DISTINCT FROM 'true' OR ${allowInheritedRefs()})
    ) OR EXISTS (
      SELECT 1 FROM (${turnPinnedSourceRefs(db, () => db`mt.source_versions`, () => db`mt.context_anchor`)}) pin
      WHERE lower(pin.source_id) = ${sourceId()}::text
    )
  )`;
}

export function hasMemoryBearingRef(refs: unknown): boolean {
  return Array.isArray(refs) && refs.some(ref => ref && typeof ref === "object"
    && (ref.memoryOnly === true || Object.hasOwn(ref, "memoryDependencyIds")));
}

/** Candidate roots for a saved memory-only reference, grouped by reference. */
export function turnMemoryOnlyBackingIds(
  db: Db, refs: FragmentFactory, ownCourse: FragmentFactory, scope: { workspaceId: string; ownerUserId: string },
): Fragment {
  const attributed: FragmentFactory = () => db`${refs()} @? '$[*].memoryDependencyIds[*]'`;
  return db`(
    SELECT COALESCE(jsonb_agg(to_jsonb(ARRAY(
      SELECT m.id FROM opening_memories m
      WHERE m.workspace_id = ${scope.workspaceId} AND m.status = 'active'
        AND (m.kind = 'confirmed' OR (m.kind = 'temporary' AND m.expires_at > clock_timestamp()))
        AND (m.course_id IS NULL OR m.course_id = ${ownCourse()})
        AND (${attributed()} AND m.id::text IN (SELECT lower(d.id) FROM ${memoryDependencyRows(db, refs)} d)
          OR NOT (${attributed()}) AND ${ownCourse()} IS NULL AND m.course_id IS NULL)
        AND ${memoryBacksSource(db, () => db`m.source_turn_ids`,
          () => lineageUuid(db, () => db`mem_ref->>'sourceId'`), scope.workspaceId, scope.ownerUserId, attributed)}
      ORDER BY m.id
    ))), '[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END) mem_ref
    WHERE (mem_ref->>'memoryOnly') = 'true'
  )`;
}

/** Aggregate validity, course and expiry from one closure. */
export function memoryDependencySummary(
  db: Db, closure: Fragment, workspaceId: FragmentFactory, courseId: FragmentFactory,
  excludeMemoryId: FragmentFactory = () => db`NULL::uuid`,
): Fragment {
  return db`${closure}
    SELECT COALESCE(bool_and(COALESCE(
        dep_m.id IS NOT NULL AND dep_m.id IS DISTINCT FROM ${excludeMemoryId()}
        AND dep_m.status = 'active'
        AND (dep_m.kind = 'confirmed' OR (dep_m.kind = 'temporary' AND dep_m.expires_at > clock_timestamp()))
        AND ${memoryCourseAllows(db, () => db`dep_m.course_id`, courseId, workspaceId)}, false
      )), true) AS all_active,
      min(dep_m.expires_at) FILTER (WHERE dep_m.kind = 'temporary') AS temporary_expires_at,
      COALESCE(jsonb_agg(d.dep_id ORDER BY d.dep_id), '[]'::jsonb) AS memory_ids
    FROM mem_deps d
    LEFT JOIN opening_memories dep_m ON dep_m.id = ${lineageUuid(db, () => db`d.dep_id`)}
      AND dep_m.workspace_id = ${workspaceId()}`;
}

/** Set-based closure shared by batched readers and the single-statement metadata gate. */
export function memoryDependencyGraphCtes(db: Db, workspaceId: string, seeds: FragmentFactory): Fragment {
  return db`
    mem_deps(root_id, parent_id, dep_id) AS (
      SELECT id, NULL::uuid, id::text FROM (${seeds()}) roots
      UNION
      SELECT prev.root_id, parent.id, lower(dep.id)
      FROM mem_deps prev
      JOIN opening_memories parent ON parent.id = ${lineageUuid(db, () => db`prev.dep_id`)}
        AND parent.workspace_id = ${workspaceId}
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(parent.source_turn_ids) = 'array' THEN parent.source_turn_ids ELSE '[]'::jsonb END
      ) origin(turn_id)
      JOIN opening_turns t ON t.id = ${lineageUuid(db, () => db`origin.turn_id`)} AND t.workspace_id = parent.workspace_id
      CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`t.context_source_refs`)} dep
    ), dependency_status AS (
    SELECT d.root_id, d.dep_id, m.course_id, m.source_turn_ids,
      m.status = 'active'
        AND (m.kind = 'confirmed' OR (m.kind = 'temporary' AND m.expires_at > clock_timestamp()))
        AND (m.course_id IS NULL OR (c.id IS NOT NULL AND (d.parent_id IS NULL OR parent.course_id = m.course_id))) AS usable,
      CASE WHEN m.kind = 'temporary' THEN m.expires_at END AS expires_at
    FROM mem_deps d
    LEFT JOIN opening_memories m ON m.id = ${lineageUuid(db, () => db`d.dep_id`)} AND m.workspace_id = ${workspaceId}
    LEFT JOIN opening_memories parent ON parent.id = d.parent_id AND parent.workspace_id = m.workspace_id
    LEFT JOIN courses c ON c.id = m.course_id AND c.workspace_id = m.workspace_id AND c.archived_at IS NULL
    )`;
}

export type MemoryDependencyStatus = {
  root_id: string; dep_id: string; course_id: string | null; expires_at: Date | null; usable: boolean;
};

export async function readMemoryDependencyStatus(db: Db, workspaceId: string, rootIds: string[]) {
  const byRoot = new Map<string, MemoryDependencyStatus[]>();
  if (!rootIds.length) return byRoot;
  const rows = await db<MemoryDependencyStatus[]>`
    WITH RECURSIVE ${memoryDependencyGraphCtes(db, workspaceId,
      () => db`SELECT id FROM unnest(${rootIds}::uuid[]) roots(id)`)}
    SELECT root_id, dep_id, course_id, expires_at, usable FROM dependency_status`;
  for (const row of rows) {
    const group = byRoot.get(row.root_id);
    if (group) group.push(row);
    else byRoot.set(row.root_id, [row]);
  }
  return byRoot;
}

/** Resolve exact consumed IDs and choose an active authority for each unattributed reference. */
export function resolveMemoryDependencyStatus(
  graph: ReadonlyMap<string, MemoryDependencyStatus[]>, ids: string[], backings: string[][],
  courseId: string | null, excludedId?: string,
): MemoryDependencyStatus[] | null {
  const usable = (id: string) => {
    const nodes = graph.get(id);
    return nodes?.length && nodes.every(node => node.usable && node.dep_id !== excludedId
      && (node.course_id === null || node.course_id === courseId)) ? nodes : null;
  };
  const groups = [...ids.map(usable),
    ...backings.map(candidates => candidates.map(usable).find(nodes => nodes !== null) ?? null)];
  return groups.some(group => group === null) ? null : groups.flatMap(group => group ?? []);
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
