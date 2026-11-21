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

/** User turns are original leaves; assistant turns must carry their full consumed lineage. */
export function turnContextSourceRefs(db: Db, alias: "t" | "u" | "a" | "mt"): Fragment {
  const column = (name: string) => db.unsafe(`${alias}.${name}`);
  return db`CASE WHEN ${column("role")} = 'assistant' THEN ${column("context_source_refs")}
    ELSE (
      SELECT COALESCE(jsonb_agg(ref), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('sourceId', sid.id, 'sourceVersion', ${column("source_versions")}->sid.id::text) AS ref
        FROM unnest(${column("source_ids")}) sid(id)
        UNION ALL
        SELECT jsonb_build_object('sourceId', citation->'sourceId', 'sourceVersion', citation->'sourceVersion')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${column("citations")})='array'
          THEN ${column("citations")} ELSE '[null]'::jsonb END) citation
      ) direct_refs
    ) END`;
}
