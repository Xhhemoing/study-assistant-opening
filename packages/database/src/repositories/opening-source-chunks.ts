import { controlledLearningTools, type SourceChunk } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { lockOpeningJobExecution } from "./opening-job-execution";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { enqueueOpeningSourceIndex } from "./opening-source-index-jobs";
import { preserveOpeningKnowledgeDefinitions } from "./opening-knowledge-definitions";
import { knowledgeChunkDigests } from "./opening-knowledge-snapshot";
export type NewSourceChunk = Omit<SourceChunk, "id" | "sourceId" | "sourceVersion">;
export type OpeningSourceChunksRepository = { replaceChunks(scope: OpeningScope, input: { sourceId: string; sourceVersion: number; chunks: NewSourceChunk[] }): Promise<void>; listChunks(scope: OpeningScope, sourceId: string): Promise<SourceChunk[]>; listChunksAtVersion(scope: OpeningScope, sourceId: string, sourceVersion: number): Promise<SourceChunk[]>; listForSources(scope: OpeningScope, sourceIds: string[]): Promise<SourceChunk[]>; };
export function mapChunk(row: Record<string, unknown>): SourceChunk { return { id: row.id as string, sourceId: row.source_id as string, sourceVersion: Number(row.source_version), page: row.page == null ? null : Number(row.page), slideLabel: row.slide_label as string | null, startMs: row.start_ms == null ? null : Number(row.start_ms), endMs: row.end_ms == null ? null : Number(row.end_ms), text: row.text as string, imageObjectKey: row.image_object_key as string | null }; }
async function fetchChunks(sql: Sql, scope: OpeningScope, sourceId: string, version: number): Promise<SourceChunk[]> { const rows = await sql`SELECT c.* FROM opening_source_chunks c JOIN opening_sources s ON s.id = c.source_id WHERE c.source_id = ${sourceId} AND s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded' AND c.source_version = ${version} ORDER BY c.page NULLS LAST, c.created_at`; return rows.map((row) => mapChunk(row as Record<string, unknown>)); }
export function chunksHaveReadableContent(chunks: NewSourceChunk[]): boolean {
  return chunks.some((chunk) => chunk.text.trim().length > 0 || Boolean(chunk.imageObjectKey?.trim()));
}
function chunkContent(chunks: NewSourceChunk[]): string[] {
  return chunks.map(chunk => JSON.stringify([
    chunk.page ?? null, chunk.slideLabel ?? null, chunk.startMs ?? null,
    chunk.endMs ?? null, chunk.text, chunk.imageObjectKey ?? null,
  ])).sort();
}

async function backfillLegacyChunkDigest(tx: TransactionSql, scope: OpeningScope, sourceId: string, sourceVersion: number,
  digest: string, removedReadable: boolean, added: NewSourceChunk[]) {
  // The first readable change freezes the old chunk set, including uncited pages.
  // Legacy coverage may exist only in the succeeded build receipt or cited versions.
  await tx`UPDATE opening_course_knowledge graph
    SET snapshot=jsonb_set(graph.snapshot, '{coveredSourceChunkDigests}',
      COALESCE(graph.snapshot->'coveredSourceChunkDigests', '{}'::jsonb) || jsonb_build_object(${sourceId}::text, ${digest}::text))
    WHERE graph.workspace_id=${scope.workspaceId} AND graph.owner_user_id=${scope.ownerUserId}
      AND NOT (COALESCE(graph.snapshot->'coveredSourceChunkDigests', '{}'::jsonb) ? ${sourceId})
      AND COALESCE(graph.snapshot->'coveredSourceVersions', (
        SELECT CASE WHEN jsonb_typeof(j.result->'coveredSourceVersions')='object' THEN j.result->'coveredSourceVersions' END
        FROM opening_jobs j WHERE j.workspace_id=graph.workspace_id AND j.owner_user_id=graph.owner_user_id
          AND j.kind='build-course-knowledge' AND j.state='succeeded' AND j.payload->>'courseId'=graph.course_id::text
          AND j.result->'version'=to_jsonb(graph.version)
        ORDER BY j.updated_at DESC, j.created_at DESC, j.id DESC LIMIT 1
      ), graph.source_versions)->>${sourceId}=${String(sourceVersion)}
      AND (${removedReadable} OR EXISTS (SELECT 1 FROM unnest(${added.map(chunk => chunk.text)}::text[]) added(text)
        WHERE added.text ~ '[^[:space:]]'))`;
}

export function createOpeningSourceChunksRepository(sql: Sql): OpeningSourceChunksRepository { return {
  async replaceChunks(scope, input) {
    await sql.begin(async tx => {
      // Privacy takes history before workspace; do not hold the job gate's workspace
      // lock while waiting for history. A rejected execution rolls back the ensure too.
      await lockWorkspaceLearningHistory(tx, scope);
      await lockOpeningJobExecution(tx, scope);
      await preserveOpeningKnowledgeDefinitions(tx, scope, input.sourceId);
      const [row] = await tx`SELECT id,version,upload_state FROM opening_sources
        WHERE id=${input.sourceId} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
      if (!row) throw new Error("source not found");
      if (Number(row.version) !== input.sourceVersion || row.upload_state !== "uploaded") throw new Error("CONFLICT: source version changed during parse");
      if (!chunksHaveReadableContent(input.chunks)) throw new Error("source has no readable text; check OCR or upload a text-readable original");
      const existing = await tx`SELECT *, text ~ '[^[:space:]]' AS readable FROM opening_source_chunks
        WHERE source_id=${input.sourceId} AND source_version=${input.sourceVersion}`;
      const existingChunks = existing.map(row => mapChunk(row));
      const previousContent = chunkContent(existingChunks);
      const nextContent = chunkContent(input.chunks);
      // Replaying or extending a partial parse must preserve unchanged citations.
      if (previousContent.length !== nextContent.length || previousContent.some((value, index) => value !== nextContent[index])) {
        const unmatched = [...existingChunks];
        const added: NewSourceChunk[] = [];
        for (const chunk of input.chunks) {
          const content = chunkContent([chunk])[0];
          const index = unmatched.findIndex(previous => chunkContent([previous])[0] === content);
          if (index !== -1) unmatched.splice(index, 1);
          else added.push(chunk);
        }
        const sourceId = String(row.id);
        const readableIds = new Set(existing.filter(chunk => chunk.readable).map(chunk => String(chunk.id)));
        const digest = knowledgeChunkDigests(existingChunks.filter(chunk => readableIds.has(chunk.id)))[sourceId];
        if (digest) await backfillLegacyChunkDigest(tx, scope, sourceId, input.sourceVersion, digest,
          unmatched.some(chunk => readableIds.has(chunk.id)), added);
        // Free changed page keys before inserting replacements in this transaction.
        if (unmatched.length) await tx`DELETE FROM opening_source_chunks WHERE id IN ${tx(unmatched.map(chunk => chunk.id))}`;
        for (const chunk of added) await tx`INSERT INTO opening_source_chunks(source_id,source_version,page,slide_label,start_ms,end_ms,text,image_object_key)
          VALUES(${input.sourceId},${input.sourceVersion},${chunk.page},${chunk.slideLabel ?? null},${chunk.startMs ?? null},${chunk.endMs ?? null},${chunk.text},${chunk.imageObjectKey ?? null})`;
      }
      await tx`UPDATE opening_sources SET parse_state='ready',error=NULL,updated_at=now()
        WHERE id=${input.sourceId} AND workspace_id=${scope.workspaceId} AND version=${input.sourceVersion}`;
      await enqueueOpeningSourceIndex(tx, scope, input.sourceId, input.sourceVersion);
    });
  },
  async listChunks(scope, sourceId) { sourceId = controlledLearningTools.open_fragment.input.parse(sourceId); const rows = await sql`SELECT version FROM opening_sources WHERE id = ${sourceId} AND workspace_id = ${scope.workspaceId} AND upload_state = 'uploaded'`; const row = rows[0] as Record<string, unknown> | undefined; return row ? fetchChunks(sql, scope, sourceId, Number(row.version)) : []; },
  listChunksAtVersion: (scope, sourceId, version) => fetchChunks(sql, scope, sourceId, version),
  async listForSources(scope, sourceIds) {
    if (!sourceIds.length) return [];
    const rows = await sql`
      SELECT c.* FROM opening_source_chunks c
      JOIN opening_sources s ON s.id = c.source_id
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      WHERE s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded'
        AND (s.parse_state = 'ready' OR (s.mime='application/pdf'
          AND s.error->>'code' IS DISTINCT FROM 'PRIVACY_EXCLUDED'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e
            WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
          AND s.parse_state IN ('queued','running','failed','not_started') AND EXISTS (
          SELECT 1 FROM opening_jobs j WHERE j.workspace_id=s.workspace_id
            AND j.owner_user_id=${scope.ownerUserId} AND j.kind='index-source'
            AND j.payload->>'sourceId'=s.id::text AND j.payload->>'sourceVersion'=s.version::text)))
        AND (c.text ~ '[^[:space:]]' OR (c.image_object_key IS NOT NULL AND c.image_object_key <> ''))
        AND c.source_version = s.version
        AND c.source_id IN ${sql(sourceIds)}
      ORDER BY c.source_id, c.source_version DESC, c.page NULLS LAST, c.created_at
    `;
    return rows.map((row) => mapChunk(row as Record<string, unknown>));
  },
}; }
