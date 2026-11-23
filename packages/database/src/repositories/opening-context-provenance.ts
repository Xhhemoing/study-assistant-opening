import type { Sql, TransactionSql } from "postgres";
import type { Citation } from "@aistudy/contracts";
import { notePublicationMetadata } from "@aistudy/domain";
import { readMemoryDependencyStatus } from "./opening-memory-admission";
import type { OpeningScope } from "./opening-sources";

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
  bareSourceIds?: FragmentFactory, citations?: FragmentFactory,
): Fragment {
  const separateInputs = bareSourceIds !== undefined || citations !== undefined;
  const safeArray = (value: FragmentFactory): Fragment => db`CASE WHEN jsonb_typeof(${value()}) = 'array' THEN ${value()} ELSE '[]'::jsonb END`;
  return db`
    COALESCE(jsonb_typeof(${refs()}) = 'array', false)
    ${citations ? db`AND COALESCE(jsonb_typeof(${citations()}) = 'array', false)` : db``}
    AND NOT EXISTS (
      SELECT 1 FROM ${separateInputs ? db`(
        SELECT elem, false, true FROM jsonb_array_elements(${safeArray(refs)}) elem
        ${bareSourceIds ? db`UNION ALL
          SELECT jsonb_build_object('sourceId', sid.id), true, false FROM unnest(${bareSourceIds()}) sid(id)` : db``}
        ${citations ? db`UNION ALL SELECT elem, false, false FROM jsonb_array_elements(${safeArray(citations)}) elem` : db``}
      ) AS input(provenance_ref, unversioned, allow_dependency_metadata)` : db`jsonb_array_elements(${safeArray(refs)}) provenance_ref`}
      WHERE NOT (
          ${separateInputs ? db`input.allow_dependency_metadata AND` : db``}
          provenance_ref = jsonb_build_object('memoryDependencyIds', provenance_ref->'memoryDependencyIds')
          AND jsonb_typeof(provenance_ref->'memoryDependencyIds') = 'array'
          AND provenance_ref->'memoryDependencyIds' <> '[]'::jsonb
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
          OR (provenance_ref ? 'memoryOnly' AND jsonb_typeof(provenance_ref->'memoryOnly') IS DISTINCT FROM 'boolean')
          OR (${bareSourceIds ? db`NOT input.unversioned AND` : db``} (jsonb_typeof(provenance_ref->'sourceVersion') IS DISTINCT FROM 'number'
            OR (provenance_ref->>'sourceVersion') !~ '^[0-9]+$'))
          OR CASE WHEN jsonb_typeof(provenance_ref->'sourceVersion') = 'number'
            AND (provenance_ref->>'sourceVersion') ~ '^[0-9]+$'
            THEN (provenance_ref->>'sourceVersion')::numeric > 9007199254740991 ELSE false END
          OR NOT EXISTS (
            SELECT 1 FROM opening_sources provenance_source
            WHERE provenance_source.id = ${lineageUuid(db, () => db`provenance_ref->>'sourceId'`)}
              AND provenance_source.workspace_id = ${workspaceId}
              AND provenance_source.upload_state = 'uploaded'
              AND (${!requireAvailability} OR NOT EXISTS (SELECT 1 FROM opening_source_versions provenance_version
                WHERE provenance_version.workspace_id=${workspaceId} AND provenance_version.source_id=provenance_source.id
                  AND provenance_version.version::text=COALESCE(provenance_ref->>'sourceVersion', provenance_source.version::text)
                  AND provenance_version.availability='unavailable'))
              AND (${allowHistoricalVersions} OR ${bareSourceIds ? db`input.unversioned OR` : db``}
                provenance_source.version::text = provenance_ref->>'sourceVersion')
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

/** A missing saved chunk yields an invalid pin for the caller's source admission. */
export function turnChunkSourceRef(db: Db, turn: FragmentFactory): Fragment {
  return db`SELECT k.source_id::text AS source_id, to_jsonb(k.source_version) AS source_version, true AS version_required
    FROM (SELECT ${turn()}.chunk_id AS id WHERE ${turn()}.chunk_id IS NOT NULL) saved
    LEFT JOIN opening_source_chunks k ON k.id = saved.id`;
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
export function turnContextSourceRefs(db: Db, alias: "t" | "u" | "a" | "mt", includeChunk = false): Fragment {
  const turn: FragmentFactory = () => {
    switch (alias) {
      case "t": return db`t`;
      case "u": return db`u`;
      case "a": return db`a`;
      case "mt": return db`mt`;
    }
  };
  const versions: FragmentFactory = () => db`${turn()}.source_versions`;
  const context: FragmentFactory = () => db`${turn()}.context_source_refs`;
  const pins = () => turnPinnedSourceRefs(db, versions, () => db`${turn()}.context_anchor`);
  return db`CASE
    WHEN jsonb_typeof(${versions()}) IS DISTINCT FROM 'object' THEN NULL
    WHEN ${turn()}.role = 'assistant' AND jsonb_typeof(${context()}) IS DISTINCT FROM 'array' THEN ${context()}
    ELSE (CASE WHEN ${turn()}.role = 'assistant' THEN ${context()} ELSE (
      SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('sourceId', sid.id, 'sourceVersion', NULL) AS ref
        FROM unnest(${turn()}.source_ids) sid(id)
        WHERE NOT EXISTS (
          SELECT 1 FROM (${pins()}) pin
          WHERE lower(pin.source_id) = sid.id::text AND pin.source_version IS NOT NULL
        )
        UNION ALL
        SELECT jsonb_build_object('sourceId', citation->'sourceId', 'sourceVersion', citation->'sourceVersion')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${turn()}.citations)='array'
          THEN ${turn()}.citations ELSE '[null]'::jsonb END) citation
      ) direct_refs
    ) END) || (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('sourceId', pin.source_id, 'sourceVersion', pin.source_version)), '[]'::jsonb)
      FROM (${pins()} ${includeChunk ? db`UNION ALL ${turnChunkSourceRef(db, turn)}` : db``}) pin
    )
  END`;
}

/** A direct source needs one consistent version, with evidence outside inherited memory. */
export function turnDirectSourcesVersioned(
  db: Db, ids: FragmentFactory, refs: FragmentFactory, citations: FragmentFactory,
): Fragment {
  const array = (items: FragmentFactory) => db`CASE WHEN jsonb_typeof(${items()}) = 'array' THEN ${items()} ELSE '[]'::jsonb END`;
  return db`NOT EXISTS (
    SELECT 1 FROM unnest(${ids()}) direct(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT ref, COALESCE(ref->'memoryOnly' = 'true'::jsonb, false) AS memory_only
        FROM jsonb_array_elements(${array(refs)}) ref
        UNION ALL
        SELECT citation, false FROM jsonb_array_elements(${array(citations)}) citation
      ) evidence
      WHERE lower(ref->>'sourceId') = direct.id::text
      HAVING count(*) FILTER (WHERE NOT memory_only) > 0 AND count(DISTINCT ref->'sourceVersion') = 1
        AND bool_and((NOT ref ? 'memoryOnly' OR jsonb_typeof(ref->'memoryOnly') = 'boolean')
          AND CASE WHEN jsonb_typeof(ref->'sourceVersion') = 'number'
            THEN (ref->>'sourceVersion') ~ '^[0-9]+$' AND (ref->'sourceVersion')::numeric <= 9007199254740991
            ELSE false END)
    )
  )`;
}

/** Saved assistant material needs its own pin, citation, or direct context ref. */
export function assistantDirectSourcesVersioned(db: Db, alias: "t" | "a"): Fragment {
  const turn = () => alias === "t" ? db`t` : db`a`;
  return db`(${turn()}.role <> 'assistant' OR cardinality(${turn()}.source_ids) = 0 OR (
    jsonb_typeof(${turn()}.citations) = 'array'
    AND ${turnDirectSourcesVersioned(db, () => db`${turn()}.source_ids`,
      () => turnContextSourceRefs(db, alias), () => db`${turn()}.citations`)}
  ))`;
}

/** Expose metadata filters to the planner before expanding their dependency arrays. */
export function memoryDependencyRows(db: Db, refs: FragmentFactory): Fragment {
  return db`(
    SELECT dep.id
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END
    ) AS dep_elem
    -- Avoid the JSON function's default row estimate multiplying through recursive joins.
    CROSS JOIN LATERAL unnest(ARRAY(
      SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(dep_elem->'memoryDependencyIds') = 'array'
        THEN dep_elem->'memoryDependencyIds' ELSE '[]'::jsonb END)
    )) AS dep(id)
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
    JOIN opening_turns dt ON dt.id = ${lineageUuid(db, () => db`ref.turn_id`)} AND dt.workspace_id = ${workspaceId()}
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

export function isLineageUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function pairedUserTurnId(db: Db, turn: FragmentFactory): Fragment {
  return db`SELECT tj.user_turn_id FROM opening_tutor_jobs tj
    WHERE tj.assistant_turn_id = ${turn()}.id AND tj.workspace_id = ${turn()}.workspace_id
      AND tj.conversation_id = ${turn()}.conversation_id`;
}

/** Older imported assistant turns without a tutor job have no conversational prefix. */
export function historicalUserTurnId(db: Db, turn: FragmentFactory = () => db`t`): Fragment {
  return db`CASE WHEN ${turn()}.role='assistant' AND NOT ${turn()}.query_system AND ${turn()}.system_query IS NULL THEN (
    SELECT u.id FROM opening_turns u
    WHERE u.id=(${pairedUserTurnId(db, turn)}) AND u.workspace_id=${turn()}.workspace_id
      AND u.conversation_id=${turn()}.conversation_id AND u.role='user' AND u.status='complete' AND NOT u.query_system
  ) END`;
}

export function turnMaterialUse(db: Db, alias: "t" | "u" | "a"): Fragment {
  const turn: FragmentFactory = () => alias === "t" ? db`t` : alias === "a" ? db`a` : db`u`;
  return db`CASE WHEN ${turn()}.attempt_id IS NOT NULL OR ${turn()}.context_anchor->>'itemVersionId' IS NOT NULL
    ${alias !== "u" ? db`OR (${turn()}.role = 'assistant' AND EXISTS (
      SELECT 1 FROM opening_turns tu
      WHERE tu.id = (${pairedUserTurnId(db, turn)}) AND tu.workspace_id = ${turn()}.workspace_id
        AND tu.conversation_id = ${turn()}.conversation_id AND tu.role = 'user'
        AND (tu.attempt_id IS NOT NULL OR tu.context_anchor->>'itemVersionId' IS NOT NULL)
    ))` : db``}
    THEN 'practice' ELSE 'citation' END`;
}

function ownedTurnLearningSession(db: Db, turn: FragmentFactory, owner: FragmentFactory): Fragment {
  return db`FROM opening_learning_sessions ls
    WHERE ls.id = ${turn()}.learning_session_id AND ls.workspace_id = ${turn()}.workspace_id
      AND ls.owner_user_id = ${owner()}`;
}

export function turnLearningSessionCourse(db: Db, turn: FragmentFactory, owner: FragmentFactory): Fragment {
  return db`(SELECT ls.course_id ${ownedTurnLearningSession(db, turn, owner)})`;
}

export function turnHasOwnedSession(db: Db, turn: FragmentFactory, owner: FragmentFactory): Fragment {
  return db`(${turn()}.learning_session_id IS NULL OR EXISTS (SELECT 1 ${ownedTurnLearningSession(db, turn, owner)}))`;
}

/** A NULL element marks a saved session or activity that could not be resolved. */
export function turnSessionMaterialIds(db: Db, turn: FragmentFactory, owner: FragmentFactory): Fragment {
  return db`CASE WHEN ${turn()}.learning_session_id IS NULL AND ${turn()}.context_anchor->>'activityId' IS NULL
    THEN '{}'::uuid[] ELSE (
    SELECT CASE
      WHEN (saved.session_id IS NOT NULL AND session.id IS NULL)
        OR (session.activity_id IS NOT NULL AND activity.id IS NULL)
        OR (saved.anchor_activity_id IS NOT NULL AND anchor_activity.id IS NULL)
      THEN ARRAY[NULL]::uuid[]
      ELSE COALESCE(session.source_ids, '{}'::uuid[])
        || COALESCE(activity.source_ids, '{}'::uuid[])
        || COALESCE(anchor_activity.source_ids, '{}'::uuid[])
      END
    FROM (SELECT ${turn()}.learning_session_id AS session_id,
      ${turn()}.context_anchor->>'activityId' AS anchor_activity_id,
      ${turn()}.workspace_id AS workspace_id, ${owner()} AS owner_user_id) saved
    LEFT JOIN opening_learning_sessions session ON session.id=saved.session_id
      AND session.workspace_id=saved.workspace_id AND session.owner_user_id=saved.owner_user_id
    LEFT JOIN opening_teaching_activities activity ON activity.id=session.activity_id
      AND activity.workspace_id=saved.workspace_id AND activity.owner_user_id=saved.owner_user_id
    LEFT JOIN opening_teaching_activities anchor_activity ON anchor_activity.id=${lineageUuid(db, () => db`saved.anchor_activity_id`)}
      AND anchor_activity.workspace_id=saved.workspace_id AND anchor_activity.owner_user_id=saved.owner_user_id
  ) END`;
}

/** Material evidence shared by turn admission, memory projection, and backing checks. */
export function turnMaterialRows(db: Db, owner: FragmentFactory, turn: FragmentFactory = () => db`t`): Fragment {
  return db`
    SELECT sid.id::text AS source_id, NULL::text AS version, false AS version_required, false AS memory_only
    FROM unnest(${turn()}.source_ids || ${turnSessionMaterialIds(db, turn, owner)}) sid(id)
    UNION ALL
    SELECT citation->>'sourceId', CASE WHEN jsonb_typeof(citation->'sourceVersion') = 'number' THEN citation->>'sourceVersion' END, true, false
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${turn()}.citations) = 'array' THEN ${turn()}.citations ELSE '[]'::jsonb END) citation
    UNION ALL
    SELECT ref->>'sourceId', CASE WHEN jsonb_typeof(ref->'sourceVersion') = 'number' THEN ref->>'sourceVersion' END,
      true, COALESCE(ref->'memoryOnly' = 'true'::jsonb, false)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${turn()}.context_source_refs) = 'array'
      THEN ${turn()}.context_source_refs ELSE '[]'::jsonb END) ref
    WHERE NOT (ref = jsonb_build_object('memoryDependencyIds', ref->'memoryDependencyIds')
      AND jsonb_typeof(ref->'memoryDependencyIds') = 'array'
      AND ref->'memoryDependencyIds' <> '[]'::jsonb)
    UNION ALL
    SELECT pin.source_id, CASE WHEN pin.source_version IS NULL THEN NULL
      WHEN jsonb_typeof(pin.source_version) = 'number' THEN pin.source_version #>> '{}' ELSE '' END, pin.version_required, false
    FROM (${turnPinnedSourceRefs(db, () => db`${turn()}.source_versions`, () => db`${turn()}.context_anchor`)}) pin
    UNION ALL
    SELECT chunk.source_id, chunk.source_version #>> '{}', chunk.version_required, false
    FROM (${turnChunkSourceRef(db, turn)}) chunk`;
}

/** A missing or foreign session cannot establish that a saved turn was standalone. */
export function turnHasStandaloneSession(db: Db, turn: FragmentFactory, owner: FragmentFactory): Fragment {
  return db`(${turn()}.learning_session_id IS NULL OR EXISTS (
    SELECT 1 ${ownedTurnLearningSession(db, turn, owner)} AND ls.course_id IS NULL
  ))`;
}

export function turnHasStandaloneSessions(db: Db, owner: FragmentFactory, turn: FragmentFactory = () => db`t`): Fragment {
  return db`${turnHasStandaloneSession(db, turn, owner)} AND (${turn()}.role <> 'assistant' OR NOT EXISTS (
    SELECT 1 FROM opening_turns tu
    WHERE tu.id = (${pairedUserTurnId(db, turn)})
      AND tu.workspace_id = ${turn()}.workspace_id AND tu.conversation_id = ${turn()}.conversation_id AND tu.role = 'user'
      AND NOT ${turnHasStandaloneSession(db, () => db`tu`, owner)}
  ))`;
}

export function turnLineageCourse(
  db: Db, alias: "a" | "t" | "dt" | "u" | "current", conversationCourse?: FragmentFactory, ownerUserId?: FragmentFactory,
): Fragment {
  const turn: FragmentFactory = () => {
    switch (alias) {
      case "a": return db`a`;
      case "t": return db`t`;
      case "dt": return db`dt`;
      case "u": return db`u`;
      case "current": return db`current`;
    }
  };
  const course = conversationCourse ?? (() => db`(SELECT tc.course_id FROM opening_conversations tc
    WHERE tc.id = ${turn()}.conversation_id AND tc.workspace_id = ${turn()}.workspace_id)`);
  const owner = ownerUserId ?? (() => db`(SELECT tc.owner_user_id FROM opening_conversations tc
    WHERE tc.id = ${turn()}.conversation_id AND tc.workspace_id = ${turn()}.workspace_id)`);
  return db`(
    COALESCE(${course()}, ${lineageUuid(db, () => db`${turn()}.context_anchor->>'courseId'`)},
      ${turnLearningSessionCourse(db, turn, owner)}
      ${alias === "u" || alias === "current" ? db`` : db`, CASE WHEN ${turn()}.role = 'assistant' THEN (
        SELECT COALESCE(${lineageUuid(db, () => db`tu.context_anchor->>'courseId'`)},
          ${turnLearningSessionCourse(db, () => db`tu`, owner)}) FROM opening_turns tu
        WHERE tu.workspace_id = ${turn()}.workspace_id AND tu.conversation_id = ${turn()}.conversation_id AND tu.role = 'user'
          AND tu.id = (${pairedUserTurnId(db, turn)})
      ) END`})
  )`;
}

/** Cycle-safe recursive CTE walking a turn's context_source_refs memoryDependencyIds -> ancestor memories. */
export function turnTransitiveDepsCte(db: Db, alias: "a" | "t"): Fragment {
  return db`WITH RECURSIVE mem_deps(dep_id) AS (${turnDependencyWalk(db, alias)})`;
}

export function turnDependencyWalk(db: Db, alias: "a" | "t", deferLegacy = false): Fragment {
  const contextRefs: FragmentFactory = () => alias === "a" ? db`a.context_source_refs` : db`t.context_source_refs`;
  const workspaceId: FragmentFactory = () => alias === "a" ? db`a.workspace_id` : db`t.workspace_id`;
  return db`
    SELECT lower(dep.id) FROM ${memoryDependencyRows(db, contextRefs)} AS dep
    UNION ${memoryDependencyStep(db, workspaceId, deferLegacy, false)}`;
}

function memoryDependencyStep(db: Db, workspaceId: FragmentFactory, deferLegacy = false, checkOriginCourse = true): Fragment {
  return db`
    SELECT CASE WHEN (child.course_id IS NOT NULL AND child.course_id IS DISTINCT FROM pm.course_id)
      ${checkOriginCourse ? db`OR NOT ${dependencyOriginCourseAllows(db, () => db`pm.course_id`, () => db`child.course_id`, () => db`origin_course.id`)}` : db``}
      OR dt.status <> 'complete'
      ${deferLegacy ? db`OR dt.id IS NULL OR (dep.id IS NULL AND dt.context_source_refs @> '[{"memoryOnly":true}]'::jsonb)` : db``}
      THEN NULL ELSE lower(dep.id) END
    FROM mem_deps prev
    JOIN opening_memories pm ON pm.id = ${lineageUuid(db, () => db`prev.dep_id`)} AND pm.workspace_id = ${workspaceId()}
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(pm.source_turn_ids) = 'array' THEN pm.source_turn_ids ELSE '[]'::jsonb END
    ) AS st(turn_id)
    ${deferLegacy ? db`LEFT JOIN LATERAL` : db`JOIN LATERAL`} (
      SELECT saved.* FROM opening_turns saved
      WHERE saved.id = ${lineageUuid(db, () => db`st.turn_id`)} AND saved.workspace_id = ${workspaceId()}
      OFFSET 0
    ) dt ON true
    ${deferLegacy ? db`LEFT JOIN LATERAL ${memoryDependencyRows(db, () => db`dt.context_source_refs`)} AS dep ON true`
      : db`CROSS JOIN LATERAL ${memoryDependencyRows(db, () => db`dt.context_source_refs`)} AS dep`}
    LEFT JOIN opening_memories child ON child.workspace_id = pm.workspace_id
      AND child.id = ${lineageUuid(db, () => db`dep.id`)}
    ${checkOriginCourse ? db`CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "dt")} AS id) origin_course` : db``}
    ${deferLegacy ? db`WHERE dep.id IS NOT NULL OR dt.id IS NULL OR dt.status <> 'complete'
      OR dt.context_source_refs @> '[{"memoryOnly":true}]'::jsonb` : db``}`;
}

/** Scoped ancestors and their descendants must agree with the originating turn. */
export function dependencyOriginCourseAllows(
  db: Db, parentCourse: FragmentFactory, childCourse: FragmentFactory, originCourse: FragmentFactory,
): Fragment {
  return db`((${parentCourse()} IS NULL OR ${parentCourse()} IS NOT DISTINCT FROM ${originCourse()})
    AND (${childCourse()} IS NULL OR (${childCourse()} = ${parentCourse()} AND ${childCourse()} IS NOT DISTINCT FROM ${originCourse()})))`;
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

/** Before exact memory attribution existed, a backing needed its own owned material. */
export function memoryBacksSource(
  db: Db, sourceTurnIds: FragmentFactory, sourceId: FragmentFactory, workspaceId: string, ownerUserId: string | FragmentFactory,
): Fragment {
  const turn: FragmentFactory = () => db`mt`;
  const hasMaterial = (origin: FragmentFactory) => db`EXISTS (
    SELECT 1 FROM (${turnMaterialRows(db, () => db`mc.owner_user_id`, origin)}) material
    WHERE lower(material.source_id) = ${sourceId()}::text AND NOT material.memory_only
  )`;
  return db`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(${sourceTurnIds()}) = 'array' THEN ${sourceTurnIds()} ELSE '[]'::jsonb END
    ) AS mref(turn_id)
    JOIN opening_turns mt ON mt.id::text = lower(mref.turn_id)
      AND mt.id = ${lineageUuid(db, () => db`mref.turn_id`)}
      AND mt.workspace_id = ${workspaceId} AND mt.status = 'complete'
    JOIN opening_conversations mc ON mc.id = mt.conversation_id
      AND mc.workspace_id = ${workspaceId} AND mc.owner_user_id = ${typeof ownerUserId === "string" ? ownerUserId : ownerUserId()}
    WHERE ${hasMaterial(turn)} OR (mt.role='assistant' AND EXISTS (
      SELECT 1 FROM opening_turns mu
      WHERE mu.id=(${pairedUserTurnId(db, turn)}) AND mu.workspace_id=mt.workspace_id
        AND mu.conversation_id=mt.conversation_id AND mu.role='user' AND mu.status='complete'
        AND ${hasMaterial(() => db`mu`)}
    ))
  )`;
}

export function hasMemoryBearingRef(refs: unknown): boolean {
  return Array.isArray(refs) && refs.some(ref => ref && typeof ref === "object"
    && (ref.memoryOnly === true || Object.hasOwn(ref, "memoryDependencyIds")));
}

/** Candidate roots for a saved memory-only reference, grouped by reference. */
export function turnMemoryOnlyBackingIds(
  db: Db, refs: FragmentFactory, ownCourse: FragmentFactory, standaloneSessions: FragmentFactory,
  scope: { workspaceId: string; ownerUserId: string | FragmentFactory },
): Fragment {
  const attributed: FragmentFactory = () => db`${refs()} @? '$[*].memoryDependencyIds[*]'`;
  return db`(
    SELECT COALESCE(jsonb_agg(to_jsonb(ARRAY(
      SELECT m.id FROM opening_memories m
      WHERE m.workspace_id = ${scope.workspaceId} AND m.status = 'active'
        AND (m.kind = 'confirmed' OR (m.kind = 'temporary' AND m.expires_at > clock_timestamp()))
        AND (m.course_id IS NULL OR m.course_id = ${ownCourse()})
        AND (${attributed()} AND m.id::text IN (SELECT lower(d.id) FROM ${memoryDependencyRows(db, refs)} d)
          OR NOT (${attributed()}) AND ${ownCourse()} IS NULL AND (${standaloneSessions()}) AND m.course_id IS NULL)
        AND (${attributed()} OR ${memoryBacksSource(db, () => db`m.source_turn_ids`,
          () => lineageUuid(db, () => db`mem_ref.backing_ref->>'sourceId'`), scope.workspaceId, scope.ownerUserId)})
      ORDER BY m.id
    )) ORDER BY mem_ref.ordinality), '[]'::jsonb)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${refs()}) = 'array' THEN ${refs()} ELSE '[]'::jsonb END)
      WITH ORDINALITY AS mem_ref(backing_ref, ordinality)
    WHERE (mem_ref.backing_ref->>'memoryOnly') = 'true'
  )`;
}

export type MemoryDependencyStatus = {
  dep_id: string; course_id: string | null; expires_at: Date | null; usable: boolean;
  sourceIds?: string[];
};

/** Match the order used by turnMemoryOnlyBackingIds after parsing the saved lineage. */
export function memoryOnlyRefSourceIds(refs: unknown): string[] {
  return Array.isArray(refs)
    ? refs.filter(ref => ref?.memoryOnly === true).map(ref => String(ref.sourceId).toLowerCase())
    : [];
}

/** Resolve exact consumed IDs and choose an active authority for each unattributed reference. */
export function resolveMemoryDependencyStatus(
  graph: ReadonlyMap<string, MemoryDependencyStatus[]>, ids: string[], backings: string[][],
  courseId: string | null, excludedId?: string, backingSourceIds?: string[],
): MemoryDependencyStatus[] | null {
  const usable = (id: string) => {
    const nodes = graph.get(id);
    return nodes?.length && nodes.every(node => node.usable && node.dep_id !== excludedId
      && (node.course_id === null || node.course_id === courseId)) ? nodes : null;
  };
  if (backingSourceIds && backings.length !== backingSourceIds.length) return null;
  const groups = [...ids.map(usable), ...backings.map((candidates, index) => {
    const sourceId = backingSourceIds?.[index];
    return candidates.map(usable).find(nodes => nodes !== null
      && (!sourceId || nodes.some(node => node.sourceIds?.includes(sourceId)))) ?? null;
  })];
  return groups.some(group => group === null) ? null : groups.flatMap(group => group ?? []);
}

export function turnHasMemoryDependencies(db: Db, refs: FragmentFactory = () => db`t.context_source_refs`): Fragment {
  return db`(${refs()} @? '$[*].memoryDependencyIds[*]' OR ${refs()} @> '[{"memoryOnly":true}]'::jsonb)`;
}

type TurnMemorySide = {
  turnId: string;
  courseId: string | null;
  materialUse: "citation" | "practice";
  refs: unknown;
  standaloneSessions: boolean;
};

type TurnMemoryEvidence = TurnMemorySide & {
  ownerUserId: string;
  checkedAt: string;
  paired?: TurnMemorySide | null;
  historicalUserTurnId?: string;
};

/** Resolve each saved side under its own policy and keep its deadline across later reads. */
export async function readTurnMemoryDependencyDeadlines(
  db: Db, workspaceId: string, turnIds: string[], sourceLocks?: {
    sourceIds: Set<string>; courseIds?: Set<string>; acquire: () => Promise<readonly string[]>;
  },
  verifyHistory?: (scope: OpeningScope, userTurnId: string) => Promise<{ valid: boolean; earliestExpiresAtMs: number }>,
  verifyOrigins?: FragmentFactory,
): Promise<Map<string, number>> {
  if (!turnIds.length) return new Map();
  const course: FragmentFactory = () => db`course.id`;
  const refs: FragmentFactory = () => db`a.context_source_refs`;
  const owner: FragmentFactory = () => db`c.owner_user_id`;
  const historical: FragmentFactory | undefined = verifyHistory ? () => historicalUserTurnId(db, () => db`a`) : undefined;
  const rows = await db<{ id: string | TurnMemoryEvidence }[]>`
    SELECT t.id FROM opening_turns a
    JOIN opening_conversations c ON c.id=a.conversation_id AND c.workspace_id=a.workspace_id
    LEFT JOIN opening_turns u ON a.role='assistant' AND u.id=(${pairedUserTurnId(db, () => db`a`)})
      AND u.workspace_id=a.workspace_id AND u.conversation_id=c.id AND u.role='user' AND u.status='complete'
    CROSS JOIN LATERAL (SELECT ${turnLineageCourse(db, "a", () => db`c.course_id`, () => db`c.owner_user_id`)} AS id) course
    CROSS JOIN LATERAL (SELECT CASE
      WHEN ${turnHasMemoryDependencies(db, refs)} OR u.context_source_refs <> '[]'::jsonb
        ${historical ? db`OR ${historical()} IS NOT NULL` : db``}
      THEN jsonb_build_object('turnId', a.id, 'ownerUserId', c.owner_user_id, 'courseId', ${course()},
        ${historical ? db`'historicalUserTurnId', ${historical()},` : db``}
        'refs', ${refs()}, 'checkedAt', clock_timestamp(), 'materialUse', ${turnMaterialUse(db, "a")},
        'standaloneSessions', ${turnHasStandaloneSessions(db, owner, () => db`a`)},
        'paired', CASE WHEN u.id IS NOT NULL THEN jsonb_build_object(
          'turnId', u.id, 'refs', COALESCE(u.context_source_refs, '[]'::jsonb),
          'courseId', ${turnLineageCourse(db, "u", () => db`c.course_id`, owner)},
          'materialUse', ${turnMaterialUse(db, "u")},
          'standaloneSessions', ${turnHasStandaloneSession(db, () => db`u`, owner)}
        ) END)
      ELSE to_jsonb(a.id) END AS id) t
    WHERE a.workspace_id = ${workspaceId} AND a.id = ANY(${turnIds}::uuid[]) AND a.status='complete'
      ${verifyOrigins ? db`AND ${verifyOrigins()}` : db``}
      AND ${assistantDirectSourcesVersioned(db, "a")}
      AND (a.role <> 'assistant' OR cardinality(a.source_ids) = 0 OR
        ${contextSourceRefsIncluded(db, workspaceId, () => turnContextSourceRefs(db, "a"), false, true,
          () => db`a.source_ids`, () => db`a.citations`)})`;
  const active = new Map<string, number>();
  const evidence = new Map<string, TurnMemoryEvidence>();
  const groups = new Map<string, Array<TurnMemorySide & { consumerId: string; ownerUserId: string; ids: string[]; memoryOnlyCount: number }>>();
  for (const { id } of rows) {
    if (typeof id === "string") {
      active.set(id, Infinity);
      continue;
    }
    const sides = id.paired ? [id, id.paired] : [id];
    const parsed = sides.map(side => parseContextMemoryDependencyIds(side.refs));
    if (parsed.some(ids => ids === null)) continue;
    evidence.set(id.turnId, id);
    for (const [index, side] of sides.entries()) {
      const memoryOnlyCount = Array.isArray(side.refs) ? side.refs.filter(ref => ref.memoryOnly === true).length : 0;
      const entry = { ...side, consumerId: id.turnId, ownerUserId: id.ownerUserId, ids: parsed[index]!, memoryOnlyCount };
      const key = `${id.ownerUserId}:${entry.materialUse}`;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
  }
  const readGroups = async (rules?: {
    collectSourceIds?: Set<string>; collectCourseIds?: Set<string>; lockedSourceIds?: readonly string[];
  }) => {
    const admitted = new Map(active);
    const deadlines = new Map<string, number>();
    for (const turns of groups.values()) {
      const { ownerUserId, materialUse } = turns[0]!;
      const scope = { workspaceId, ownerUserId };
      const memoryOnlyTurns = turns.filter(turn => turn.memoryOnlyCount > 0);
      const backingRows = memoryOnlyTurns.length ? await db<{ id: string; backings: string[][] }[]>`
        SELECT saved.id, ${turnMemoryOnlyBackingIds(db, () => db`saved.refs`, () => db`saved.course_id`,
          () => db`saved.standalone_sessions`, scope)} AS backings
        FROM jsonb_to_recordset(${db.json(memoryOnlyTurns.map(turn => ({ id: turn.turnId, refs: turn.refs as never,
          course_id: turn.courseId, standalone_sessions: turn.standaloneSessions })))}::jsonb)
          saved(id uuid, refs jsonb, course_id uuid, standalone_sessions boolean)` : [];
      const backings = new Map(backingRows.map(row => [row.id, row.backings]));
      const graph = await readMemoryDependencyStatus(db, scope,
        [...turns.flatMap(turn => turn.ids), ...backingRows.flatMap(row => row.backings.flat())], { ...rules, materialUse });
      for (const turn of turns) {
        if (turn.courseId !== null) rules?.collectCourseIds?.add(turn.courseId);
        const turnBackings = backings.get(turn.turnId) ?? [];
        const resolved = turnBackings.length === turn.memoryOnlyCount
          ? resolveMemoryDependencyStatus(graph, turn.ids, turnBackings, turn.courseId, undefined,
            turn.ids.length ? memoryOnlyRefSourceIds(turn.refs) : undefined) : null;
        const expiry = resolved?.reduce((earliest, node) => node.expires_at === null ? earliest
          : Math.min(earliest, new Date(node.expires_at).getTime()), Infinity) ?? -Infinity;
        deadlines.set(turn.consumerId, Math.min(deadlines.get(turn.consumerId) ?? Infinity, expiry));
      }
    }
    for (const turn of evidence.values()) {
      const scope = { workspaceId, ownerUserId: turn.ownerUserId };
      const history = turn.historicalUserTurnId && verifyHistory ? await verifyHistory(scope, turn.historicalUserTurnId) : undefined;
      if (history && !history.valid) continue;
      const deadline = Math.min(deadlines.get(turn.turnId) ?? Infinity, history?.earliestExpiresAtMs ?? Infinity);
      if (deadline > Math.max(Date.now(), Date.parse(turn.checkedAt))) admitted.set(turn.turnId, deadline);
    }
    return admitted;
  };
  if (sourceLocks) {
    await readGroups({ collectSourceIds: sourceLocks.sourceIds, collectCourseIds: sourceLocks.courseIds });
    const lockedSourceIds = await sourceLocks.acquire();
    const currentCourses = new Set<string>();
    const admitted = await readGroups({ lockedSourceIds, collectCourseIds: currentCourses });
    return !sourceLocks.courseIds || [...currentCourses].every(id => sourceLocks.courseIds!.has(id)) ? admitted : new Map();
  }
  return readGroups();
}

export async function readTurnsWithActiveMemoryDependencies(db: Db, workspaceId: string, turnIds: string[]) {
  return new Set((await readTurnMemoryDependencyDeadlines(db, workspaceId, turnIds)).keys());
}
