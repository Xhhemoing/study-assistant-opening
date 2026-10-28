import type { Scope, TeachingSourceRef } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";

export type GradingReferenceChunk = { id: string; source_id: string; source_version: number; page: number | null; text: string;
  image_object_key: string | null; mime: string; bytes: number };

/** Resolve immutable teaching locators; a surviving page cannot stand in for a removed chunk. */
export async function readOpeningPinnedTeachingChunks(db: Sql | TransactionSql, scope: Scope,
  refs: TeachingSourceRef[], sourceVersions: Record<string, number>): Promise<GradingReferenceChunk[]> {
  const result = new Map<string, GradingReferenceChunk>();
  for (const ref of refs) {
    if (ref.version == null || sourceVersions[ref.sourceId] === undefined || Number(ref.version) !== sourceVersions[ref.sourceId]) {
      throw learningError("CONFLICT", "课堂题目原图版本已变化，请重新开始练习。");
    }
    const rows = await db<GradingReferenceChunk[]>`SELECT c.id,c.source_id,c.source_version,c.page,c.text,c.image_object_key,s.mime,s.bytes
      FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id AND s.version=c.source_version
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      WHERE s.workspace_id=${scope.workspaceId} AND s.id=${ref.sourceId} AND s.version=${Number(ref.version)}
        AND s.upload_state='uploaded' AND s.parse_state='ready'
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        AND (${ref.chunkId ?? null}::text IS NULL OR c.id::text=${ref.chunkId ?? null})
        AND (${ref.page ?? null}::integer IS NULL OR c.page=${ref.page ?? null}) ORDER BY c.page,c.id`;
    if (!rows.length || !ref.chunkId && !ref.page && rows.some(row => row.image_object_key)
      || rows.some(row => row.image_object_key && (!Number.isInteger(row.page) || Number(row.page) < 1))) {
      throw learningError("CONFLICT", "课堂题目引用的原图或材料片段已不可定位，请重新开始练习。");
    }
    for (const row of rows) result.set(row.id, row);
  }
  return [...result.values()];
}
