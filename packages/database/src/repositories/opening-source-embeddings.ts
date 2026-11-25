import type { Sql, TransactionSql } from "postgres";
import type { MaterialSegment, SourceChunk } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { parentBudgetFamilyPredicate } from "./opening-budget";
import { lockOpeningJobExecution } from "./opening-job-execution";
import { mapChunk } from "./opening-source-chunks";
import { containsPdfAnswerLabel, filterPublicChunkRows, isPublicSourceChunk, publicPdfChunkImageObjectKey, publicPdfChunkPredicate, publicPdfSealBoundaries } from "./opening-knowledge-definitions";
import { enqueueOpeningSourceIndex } from "./opening-source-index-jobs";
export { enqueueOpeningSourceIndex } from "./opening-source-index-jobs";

type ModelIdentity = { modelKey: string; dimensions: number };
type SearchScope = { sourceIds: string[]; chunkIds?: string[]; privacyEpoch?: number };
export type SourceIndexSnapshot = { sourceId: string; sourceVersion: number; privacyEpoch: number; chunks: SourceChunk[] };

export function createOpeningSourceEmbeddingsRepository(sql: Sql) {
  const routeFilter = ({ chunkIds, privacyEpoch }: SearchScope) => sql`
    ${chunkIds === undefined ? sql`` : sql`AND e.chunk_id = ANY(${sql.array(chunkIds)}::uuid[])`}
    ${privacyEpoch === undefined ? sql`` : sql`AND w.privacy_epoch=${privacyEpoch}`}`;
  const readSnapshot = async (db: Sql | TransactionSql, scope: OpeningScope, sourceId: string, sourceVersion?: number): Promise<SourceIndexSnapshot | null> => {
    const [source] = await db`SELECT s.id,s.version,w.privacy_epoch FROM opening_sources s JOIN workspaces w ON w.id=s.workspace_id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND s.id=${sourceId}
        AND s.upload_state='uploaded' AND s.parse_state='ready'
        AND (${sourceVersion ?? null}::integer IS NULL OR s.version=${sourceVersion ?? null})
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)`;
    if (!source) return null;
    const rows = await db`
      ${publicPdfSealBoundaries(db, scope.workspaceId, { sourceIds: [sourceId] })}
      SELECT c.*,s.mime,${publicPdfChunkImageObjectKey(db)} AS public_image_object_key FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
      WHERE c.source_id=${sourceId} AND s.workspace_id=${scope.workspaceId}
        AND c.source_version=${Number(source.version)} AND s.version=c.source_version
        AND s.upload_state='uploaded' AND s.parse_state='ready'
        AND ${publicPdfChunkPredicate(db)}
      ORDER BY c.page NULLS LAST,c.id`;
    return { sourceId, sourceVersion: Number(source.version), privacyEpoch: Number(source.privacy_epoch),
      chunks: filterPublicChunkRows(rows).map(mapChunk) };
  };
  return {
    async isTurnWithRetrievalNotSent(scope: OpeningScope, tutorId: string, retrievalId: string): Promise<boolean> {
      return sql.begin(async tx => {
        // Serialize the retry decision with admission across the full turn family.
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) return false;
        const [proof] = await tx`SELECT bool_or(parent_interaction_id=${tutorId}) AND
          bool_and(state='released' AND outcome_unknown_at IS NULL
            AND COALESCE(pending_reconcile_cents, 0) = 0
            AND COALESCE(release_reason IN ('not_sent','cancelled'), false)) AS not_sent
          FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}
            AND (${parentBudgetFamilyPredicate(tx, "parent_interaction_id", tutorId)}
              OR parent_interaction_id=${retrievalId})`;
        return proof?.not_sent === true;
      });
    },
    async authorizeChunks(scope: OpeningScope, chunks: SourceChunk[]): Promise<{ chunks: SourceChunk[]; privacyEpoch: number }> {
      const [owner] = await sql`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (!owner) throw Object.assign(new Error("workspace not found"), { code: "NOT_FOUND" });
      if (!chunks.length) return { chunks: [], privacyEpoch: Number(owner.privacy_epoch) };
      const sourceIds = [...new Set(chunks.map(chunk => chunk.sourceId))];
      const rows = await sql`
        ${publicPdfSealBoundaries(sql, scope.workspaceId, { sourceIds })}
        SELECT c.id,c.source_id,c.source_version,c.page,c.text,${publicPdfChunkImageObjectKey(sql)} AS public_image_object_key,s.mime
        FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
        JOIN workspaces w ON w.id=s.workspace_id WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
          AND s.id IN ${sql(sourceIds)} AND s.upload_state='uploaded'
          AND c.source_version<=s.version AND (c.source_version<s.version OR s.parse_state='ready')
          AND c.id=ANY(${sql.array(chunks.map(chunk => chunk.id))}::uuid[])
          AND ${publicPdfChunkPredicate(sql)}
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=w.id AND e.source_id=s.id)`;
      const allowed = new Map(filterPublicChunkRows(rows).map(row => [String(row.id), row]));
      return { chunks: chunks.flatMap(chunk => {
        const row = allowed.get(chunk.id);
        if (!row || Number(row.source_version) !== chunk.sourceVersion
          || (row.mime === "application/pdf" && !String(row.text).includes(chunk.text) && containsPdfAnswerLabel(chunk.text))) {
          return [];
        }
        return [row.mime === "application/pdf" && row.public_image_object_key == null && chunk.imageObjectKey !== null
          ? { ...chunk, imageObjectKey: null } : chunk];
      }), privacyEpoch: Number(owner.privacy_epoch) };
    },
    snapshot: (scope: OpeningScope, sourceId: string, version?: number) => readSnapshot(sql, scope, sourceId, version),
    async assertCurrent(scope: OpeningScope, snapshot: SourceIndexSnapshot): Promise<void> {
      if (scope.jobExecution) {
        const execution = scope.jobExecution;
        const active = await sql`SELECT id FROM opening_jobs WHERE id=${execution.id} AND workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND state='running' AND claim_token=${execution.token}
          AND privacy_epoch=${snapshot.privacyEpoch}`;
        if (!active.length) throw new Error("index job is no longer current");
      }
      const current = await readSnapshot(sql, scope, snapshot.sourceId, snapshot.sourceVersion);
      const ids = new Set(current?.chunks.map(chunk => chunk.id));
      if (!current || current.privacyEpoch !== snapshot.privacyEpoch || snapshot.chunks.some(chunk => !ids.has(chunk.id))) {
        throw Object.assign(new Error("source or privacy changed during embedding"), { code: "CONFLICT" });
      }
    },
    async listIndexedKeys(scope: OpeningScope, snapshot: SourceIndexSnapshot, model: ModelIdentity): Promise<string[]> {
      const rows = await sql`SELECT e.chunk_id,e.segment_index FROM opening_source_embeddings e
        JOIN opening_sources s ON s.id=e.source_id JOIN workspaces w ON w.id=s.workspace_id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} AND s.id=${snapshot.sourceId}
          AND s.version=${snapshot.sourceVersion} AND e.source_version=s.version
          AND e.model_key=${model.modelKey} AND e.dimensions=${model.dimensions}
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions x WHERE x.workspace_id=w.id AND x.source_id=s.id)`;
      return rows.map(row => `${row.chunk_id}:${row.segment_index}`);
    },
    async store(scope: OpeningScope, snapshot: SourceIndexSnapshot, model: ModelIdentity, rows: Array<MaterialSegment & { vector: number[] }>): Promise<void> {
      await sql.begin(async tx => {
        await lockOpeningJobExecution(tx, scope);
        // Same workspace/source lock order as privacy and source writes; no model call inside this transaction.
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND privacy_epoch=${snapshot.privacyEpoch} FOR SHARE`;
        const sources = owners.length ? await tx`SELECT id FROM opening_sources WHERE id=${snapshot.sourceId}
          AND workspace_id=${scope.workspaceId} AND version=${snapshot.sourceVersion} FOR SHARE` : [];
        const current = sources.length ? await readSnapshot(tx, scope, snapshot.sourceId, snapshot.sourceVersion) : null;
        if (!current) throw Object.assign(new Error("source is no longer indexable"), { code: "CONFLICT" });
        const chunks = new Map(current.chunks.map(chunk => [chunk.id, chunk]));
        for (const row of rows) {
          if (!chunks.has(row.chunk.id) || row.chunk.sourceId !== snapshot.sourceId || row.chunk.sourceVersion !== snapshot.sourceVersion
            || row.vector.length !== model.dimensions || row.vector.some(value => !Number.isFinite(value)) || !row.vector.some(value => value !== 0)) {
            throw new Error("invalid source embedding");
          }
          await tx`INSERT INTO opening_source_embeddings(chunk_id,source_id,source_version,model_key,dimensions,segment_index,text,embedding)
            VALUES(${row.chunk.id},${snapshot.sourceId},${snapshot.sourceVersion},${model.modelKey},${model.dimensions},
              ${row.segmentIndex},${row.chunk.text},${JSON.stringify(row.vector)}::vector)
            ON CONFLICT(chunk_id,model_key,segment_index) DO UPDATE SET text=excluded.text,embedding=excluded.embedding,dimensions=excluded.dimensions`;
        }
      });
    },
    async search(scope: OpeningScope, input: ModelIdentity & SearchScope & { vector: number[] }): Promise<MaterialSegment[]> {
      if (!input.sourceIds.length || input.chunkIds?.length === 0) return [];
      const queryVector = JSON.stringify(input.vector);
      const query = sql`
        ${publicPdfSealBoundaries(sql, scope.workspaceId, { sourceIds: input.sourceIds })}
        SELECT c.id,c.source_id,c.source_version,c.page,c.slide_label,c.start_ms,c.end_ms,
          ${publicPdfChunkImageObjectKey(sql)} AS image_object_key,
          CASE WHEN s.mime='application/pdf' THEN c.text END AS text,s.mime,e.text AS segment_text,e.segment_index
        FROM opening_source_embeddings e
        JOIN opening_source_chunks c ON c.id=e.chunk_id
          AND c.source_id=e.source_id AND c.source_version=e.source_version
        JOIN opening_sources s ON s.id=c.source_id
        JOIN workspaces w ON w.id=s.workspace_id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
          AND s.id IN ${sql(input.sourceIds)} AND s.version=c.source_version AND s.upload_state='uploaded' AND s.parse_state='ready'
          AND e.model_key=${input.modelKey} AND e.dimensions=${input.dimensions}
          ${routeFilter(input)}
          AND ${publicPdfChunkPredicate(sql)}
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions x WHERE x.workspace_id=w.id AND x.source_id=s.id)
        ORDER BY e.embedding <=> ${queryVector}::vector, c.id, e.segment_index`;
      const results: MaterialSegment[] = [];
      const eligibility = new Map<unknown, boolean>();
      for await (const batch of query.cursor(48)) {
        for (const row of batch) {
          const publicChunk = eligibility.get(row.id) ?? isPublicSourceChunk(row);
          eligibility.set(row.id, publicChunk);
          if (!publicChunk) continue;
          results.push({ chunk: mapChunk({ ...row, text: row.segment_text }), segmentIndex: Number(row.segment_index) });
          if (results.length === 48) return results;
        }
      }
      return results;
    },
    async hasIndex(scope: OpeningScope, input: ModelIdentity & SearchScope): Promise<boolean> {
      if (!input.sourceIds.length || input.chunkIds?.length === 0) return false;
      const query = sql`
        ${publicPdfSealBoundaries(sql, scope.workspaceId, { sourceIds: input.sourceIds })}
        SELECT CASE WHEN s.mime='application/pdf' THEN c.text END AS text,c.page,s.mime FROM opening_source_chunks c
        JOIN opening_sources s ON s.id=c.source_id JOIN workspaces w ON w.id=s.workspace_id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}
          AND s.id IN ${sql(input.sourceIds)} AND s.version=c.source_version AND s.upload_state='uploaded' AND s.parse_state='ready'
          AND ${publicPdfChunkPredicate(sql)}
          AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions x WHERE x.workspace_id=w.id AND x.source_id=s.id)
          AND EXISTS (SELECT 1 FROM opening_source_embeddings e
            WHERE e.chunk_id=c.id AND e.source_id=c.source_id AND e.source_version=c.source_version
              AND e.model_key=${input.modelKey} AND e.dimensions=${input.dimensions}
              ${routeFilter(input)})`;
      for await (const batch of query.cursor(16)) {
        if (batch.some(isPublicSourceChunk)) return true;
      }
      return false;
    },
    async reindex(scope: OpeningScope, sourceId: string): Promise<{ jobId: string }> {
      return sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        const snapshot = await readSnapshot(tx, scope, sourceId);
        if (!snapshot) throw Object.assign(new Error("source not found or unavailable"), { code: "NOT_FOUND" });
        if (!snapshot.chunks.some(chunk => chunk.text.trim())) throw Object.assign(new Error("这份材料还没有可搜索文字；可继续打开原件查看。"), { code: "CONFLICT" });
        const jobId = await enqueueOpeningSourceIndex(tx, scope, sourceId, snapshot.sourceVersion);
        if (!jobId) throw Object.assign(new Error("source is no longer available"), { code: "CONFLICT" });
        return { jobId };
      });
    },
  };
}
export type OpeningSourceEmbeddingsRepository = ReturnType<typeof createOpeningSourceEmbeddingsRepository>;
