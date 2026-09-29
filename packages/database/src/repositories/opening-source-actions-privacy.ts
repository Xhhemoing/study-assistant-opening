import type { Sql, TransactionSql } from "postgres";

/** Human display hides derivatives only after asset deletion. AI exclusion alone preserves them. */
export function turnUsesDeletedSource(db: Sql | TransactionSql, alias: "t" = "t") {
  const col = (name: string) => db.unsafe(`${alias}.${name}`);
  return db`EXISTS(SELECT 1 FROM opening_privacy_exclusions deleted_source
    WHERE deleted_source.workspace_id=${col("workspace_id")} AND deleted_source.asset_deleted_at IS NOT NULL
      AND (deleted_source.source_id=ANY(${col("source_ids")})
        OR ${col("source_versions")} ? deleted_source.source_id::text
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${col("citations")})='array'
          THEN ${col("citations")} ELSE '[]'::jsonb END) citation
          WHERE lower(citation->>'sourceId')=deleted_source.source_id::text)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${col("context_source_refs")})='array'
          THEN ${col("context_source_refs")} ELSE '[]'::jsonb END) ref
          WHERE lower(ref->>'sourceId')=deleted_source.source_id::text)))`;
}

export function memoryUsesDeletedSource(db: Sql | TransactionSql) {
  return db`EXISTS(SELECT 1 FROM opening_turns t WHERE t.workspace_id=m.workspace_id
    AND m.source_turn_ids ? t.id::text AND ${turnUsesDeletedSource(db)})`;
}
