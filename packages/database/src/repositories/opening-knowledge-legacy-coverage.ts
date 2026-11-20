import type { TransactionSql } from "postgres";

/** The caller aliases the stored graph as graph. Legacy coverage can live in
 * the succeeded build receipt for that exact graph version. */
export function resolvedKnowledgeCoverage(tx: TransactionSql) {
  return tx`COALESCE(graph.snapshot->'coveredSourceVersions', (
    SELECT CASE WHEN jsonb_typeof(j.result->'coveredSourceVersions')='object' THEN j.result->'coveredSourceVersions' END
    FROM opening_jobs j WHERE j.workspace_id=graph.workspace_id AND j.owner_user_id=graph.owner_user_id
      AND j.kind='build-course-knowledge' AND j.state='succeeded' AND j.payload->>'courseId'=graph.course_id::text
      AND j.result->'version'=to_jsonb(graph.version)
    ORDER BY j.updated_at DESC, j.created_at DESC, j.id DESC LIMIT 1
  ), graph.source_versions)`;
}
