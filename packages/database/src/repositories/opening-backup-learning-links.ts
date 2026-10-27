import type { TransactionSql } from "postgres";
type Row = Record<string, unknown>;
export async function readOpeningBackupLearningLinks(tx: TransactionSql, workspaceId: string, ownerUserId: string, tables: Record<string, Row[]>) {
  const requirements = new Set(tables.course_requirements?.map(row => row.id));
  const sources = new Set(tables.opening_sources?.map(row => row.id));
  const activities = new Set(tables.opening_teaching_activities?.map(row => row.id));
  const attempts = new Set(tables.opening_learning_attempts?.map(row => row.id));
  const evidence = await tx`SELECT * FROM course_requirement_evidence_links WHERE workspace_id=${workspaceId} AND owner_user_id=${ownerUserId} ORDER BY id`;
  const assets = await tx`SELECT * FROM opening_learning_asset_links WHERE workspace_id=${workspaceId} AND owner_user_id=${ownerUserId} AND asset_type='source' ORDER BY id`;
  return {
    course_requirement_evidence_links: evidence.filter(row => requirements.has(row.source_requirement_id) && requirements.has(row.target_requirement_id)),
    // Notes travel with native documents, whose provenance/privacy inventory owns their contents.
    opening_learning_asset_links: assets.filter(row => {
      const refs = row.source_refs as Array<{ sourceId: string }>;
      const origin = row.origin_json as { sourceId?: string; activityId?: string; attemptId?: string } | null;
      return sources.has(row.asset_id) && Array.isArray(refs) && refs.every(ref => sources.has(ref.sourceId))
        && (!origin?.sourceId || sources.has(origin.sourceId)) && (!origin?.activityId || activities.has(origin.activityId))
        && (!origin?.attemptId || attempts.has(origin.attemptId));
    }),
  };
}
