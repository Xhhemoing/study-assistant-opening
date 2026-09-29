import type { Sql, TransactionSql } from "postgres";
import type { Citation } from "@aistudy/contracts";

type Db = Sql | TransactionSql;
type Fragment = ReturnType<Db>;
export type ContextSourceRef = Pick<Citation, "sourceId" | "sourceVersion">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persisted JSON is a trust boundary. NULL is unknown, never an empty lineage. */
export function parseContextSourceRefs(value: unknown): ContextSourceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs: ContextSourceRef[] = [];
  for (const ref of value) {
    if (!ref || typeof ref !== "object" || typeof ref.sourceId !== "string"
      || !UUID.test(ref.sourceId) || !Number.isSafeInteger(ref.sourceVersion) || ref.sourceVersion < 0) return null;
    refs.push({ sourceId: ref.sourceId.toLowerCase(), sourceVersion: ref.sourceVersion });
  }
  return mergeContextSourceRefs(refs);
}

export function mergeContextSourceRefs(...groups: readonly ContextSourceRef[][]): ContextSourceRef[] {
  const unique = new Map<string, ContextSourceRef>();
  for (const group of groups) for (const ref of group) {
    const normalized = { sourceId: ref.sourceId.toLowerCase(), sourceVersion: ref.sourceVersion };
    unique.set(`${normalized.sourceId}:${normalized.sourceVersion}`, normalized);
  }
  return [...unique.values()];
}

/** SQL admission shared by live context and backup, with the latter retaining historical versions. */
export function contextSourceRefsIncluded(
  db: Db, workspaceId: string, refs: Fragment, allowHistoricalVersions = false,
): Fragment {
  return db`
    COALESCE(jsonb_typeof(${refs}) = 'array', false)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${refs}) = 'array' THEN ${refs} ELSE '[]'::jsonb END
      ) provenance_ref
      WHERE jsonb_typeof(provenance_ref) IS DISTINCT FROM 'object'
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
            AND (${allowHistoricalVersions} OR provenance_source.version::text = provenance_ref->>'sourceVersion')
            AND NOT EXISTS (
              SELECT 1 FROM opening_privacy_exclusions provenance_exclusion
              WHERE provenance_exclusion.workspace_id = ${workspaceId}
                AND provenance_exclusion.source_id = provenance_source.id
            )
        )
    )`;
}

/** User turns are original leaves; assistant turns must carry their full consumed lineage. */
export function turnContextSourceRefs(db: Db, alias: "t" | "u" | "a"): Fragment {
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
