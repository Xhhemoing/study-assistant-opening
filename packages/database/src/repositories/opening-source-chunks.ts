import { controlledLearningTools, type ApiFailure, type SourceChunk } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import { lockOpeningJobExecution } from "./opening-job-execution";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { enqueueOpeningSourceIndex } from "./opening-source-index-jobs";
import { isPublicSourceChunk, preserveOpeningKnowledgeDefinitions, publicPdfChunkPredicate, publicPdfSealBoundaries } from "./opening-knowledge-definitions";
import { commitPdfPageSeals, type PdfSegmentPage } from "./opening-pdf-segments";
import { knowledgeChunkDigests } from "./opening-knowledge-snapshot";
import { resolvedKnowledgeCoverage } from "./opening-knowledge-legacy-coverage";
export type NewSourceChunk = Omit<SourceChunk, "id" | "sourceId" | "sourceVersion">;
type ChunkPublication = { sourceId: string; sourceVersion: number; warning?: ApiFailure; allowSealedEmpty?: boolean };
export type OpeningSourceChunksRepository = {
  replaceChunks(scope: OpeningScope, input: ChunkPublication & { chunks: NewSourceChunk[] }): Promise<void>;
  listChunks(scope: OpeningScope, sourceId: string): Promise<SourceChunk[]>;
  listChunksAtVersion(scope: OpeningScope, sourceId: string, sourceVersion: number, pages?: number[],
    options?: { unpublishedPdfForRecovery: true }): Promise<SourceChunk[]>;
  listForSources(scope: OpeningScope, sourceIds: string[]): Promise<SourceChunk[]>;
};
export type OpeningPdfChunkPublisher = {
  /** The stream must be staged locally before publication, with one chunk per physical page. */
  replacePdfChunks(scope: OpeningScope, input: ChunkPublication & {
    chunks: AsyncIterable<NewSourceChunk>; preservePages: number[];
    /** Pages whose archived bytes may contain sealed or unverified content. */
    unsafeLegacyPages?: number[];
    /** Marker changes whose visibility depends on this exact replacement. */
    publicationSeals?: PdfSegmentPage[];
    /** Exact page numbers stored with the warning for a same-version retry. */
    warning?: ApiFailure & { pdfTextCap?: number[] };
  }): Promise<void>;
};
export function mapChunk(row: Record<string, unknown>): SourceChunk { return { id: row.id as string, sourceId: row.source_id as string, sourceVersion: Number(row.source_version), page: row.page == null ? null : Number(row.page), slideLabel: row.slide_label as string | null, startMs: row.start_ms == null ? null : Number(row.start_ms), endMs: row.end_ms == null ? null : Number(row.end_ms), text: row.text as string, imageObjectKey: row.image_object_key as string | null }; }
async function fetchChunks(sql: Sql, scope: OpeningScope, sourceId: string, version: number, pages?: number[],
  options?: { unpublishedPdfForRecovery: true }): Promise<SourceChunk[]> {
  const recovery = options?.unpublishedPdfForRecovery === true;
  const rows = await sql`
    ${recovery ? sql`` : publicPdfSealBoundaries(sql, scope.workspaceId, { sourceIds: [sourceId] })}
    SELECT c.*, s.mime FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id
    WHERE c.source_id=${sourceId} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
      AND c.source_version=${version} ${pages ? sql`AND c.page=ANY(${pages}::int[])` : sql``}
      AND ${recovery ? sql`TRUE` : publicPdfChunkPredicate(sql)}
    ORDER BY c.page NULLS LAST, c.created_at`;
  return (recovery ? rows : rows.filter(isPublicSourceChunk)).map(mapChunk);
}
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
  digest: string, removedReadable = true, added: NewSourceChunk[] = []) {
  // The first readable change freezes the old chunk set, including uncited pages.
  // Legacy coverage may exist only in the succeeded build receipt or cited versions.
  await tx`UPDATE opening_course_knowledge graph
    SET snapshot=jsonb_set(graph.snapshot, '{coveredSourceChunkDigests}',
      COALESCE(graph.snapshot->'coveredSourceChunkDigests', '{}'::jsonb) || jsonb_build_object(${sourceId}::text, ${digest}::text))
    WHERE graph.workspace_id=${scope.workspaceId} AND graph.owner_user_id=${scope.ownerUserId}
      AND NOT (COALESCE(graph.snapshot->'coveredSourceChunkDigests', '{}'::jsonb) ? ${sourceId})
      AND ${resolvedKnowledgeCoverage(tx)}->>${sourceId}=${String(sourceVersion)}
      AND (${removedReadable} OR EXISTS (SELECT 1 FROM unnest(${added.map(chunk => chunk.text)}::text[]) added(text)
        WHERE added.text ~ '[^[:space:]]'))`;
}

async function publishChunks(tx: TransactionSql, scope: OpeningScope, input: ChunkPublication,
  reconcile: (sourceId: string, preservePdfDefinitions?: () => Promise<void>) => Promise<void>, preservePages?: number[]) {
  // Privacy takes history before workspace. A rejected execution rolls back the ensure too.
  await lockWorkspaceLearningHistory(tx, scope);
  await lockOpeningJobExecution(tx, scope);
  const withdrawAll = input.allowSealedEmpty && !preservePages?.length;
  if (preservePages || withdrawAll) {
    // For PDFs, remove unsafe evidence after taking the workspace and graph locks.
    const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
    if (!owner) throw new Error("workspace not found");
    if (preservePages && !withdrawAll) await tx`SELECT course_id FROM opening_course_knowledge
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND source_versions->>${input.sourceId}=${String(input.sourceVersion)}
      ORDER BY course_id FOR UPDATE`;
  } else {
    await preserveOpeningKnowledgeDefinitions(tx, scope, input.sourceId, input.sourceVersion);
  }
  const [source] = await tx`SELECT id,version,upload_state FROM opening_sources
    WHERE id=${input.sourceId} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
  if (!source) throw new Error("source not found");
  if (Number(source.version) !== input.sourceVersion || source.upload_state !== "uploaded") throw new Error("CONFLICT: source version changed during parse");
  await reconcile(String(source.id), preservePages && !withdrawAll
    ? () => preserveOpeningKnowledgeDefinitions(tx, scope, input.sourceId, input.sourceVersion)
    : undefined);
  await tx`UPDATE opening_sources SET parse_state='ready',error=${input.warning ? tx.json(input.warning) : null}::jsonb,updated_at=now()
    WHERE id=${input.sourceId} AND workspace_id=${scope.workspaceId} AND version=${input.sourceVersion}`;
  await enqueueOpeningSourceIndex(tx, scope, input.sourceId, input.sourceVersion);
}

function requireReadableContent(readable: boolean) {
  if (!readable) throw new Error("source has no readable text; check OCR or upload a text-readable original");
}

async function stagePdfChunks(tx: TransactionSql, chunks: AsyncIterable<NewSourceChunk>) {
  await tx`CREATE TEMP TABLE opening_pdf_chunk_stage (
    page int PRIMARY KEY, slide_label text, start_ms int, end_ms int, text text, image_object_key text, matched_id uuid
  ) ON COMMIT DROP`;
  const batch: { page: number | null; slide_label: string | null; start_ms: number | null; end_ms: number | null;
    text: string; image_object_key: string | null }[] = [];
  const batchByteLimit = 4 * 1024 * 1024;
  let bytes = 0;
  let readable = false;
  const flush = async () => {
    await tx`INSERT INTO pg_temp.opening_pdf_chunk_stage ${tx(batch, "page", "slide_label", "start_ms", "end_ms", "text", "image_object_key")}`;
    batch.length = 0;
    bytes = 0;
  };
  for await (const chunk of chunks) {
    const rowBytes = Buffer.byteLength(chunk.text) + Buffer.byteLength(chunk.slideLabel ?? "") +
      Buffer.byteLength(chunk.imageObjectKey ?? "");
    if (batch.length && (batch.length === 64 || bytes + rowBytes > batchByteLimit)) await flush();
    batch.push({ page: chunk.page, slide_label: chunk.slideLabel ?? null, start_ms: chunk.startMs ?? null,
      end_ms: chunk.endMs ?? null, text: chunk.text, image_object_key: chunk.imageObjectKey ?? null });
    bytes += rowBytes;
    readable ||= Boolean(chunk.text.trim() || chunk.imageObjectKey?.trim());
  }
  if (batch.length) await flush();
  return readable;
}

async function reconcilePdfChunks(tx: TransactionSql, scope: OpeningScope,
  { sourceId, sourceVersion, preservePages, allowSealedEmpty, unsafeLegacyPages = [] }:
    ChunkPublication & { preservePages: number[]; unsafeLegacyPages?: number[] },
  stagedReadable: boolean, preserveDefinitions?: () => Promise<void>) {
  // Retained pages are references only. PostgreSQL keeps the original rows and citation IDs.
  if (preservePages.length) await tx`INSERT INTO pg_temp.opening_pdf_chunk_stage (page,matched_id)
    SELECT page,id FROM opening_source_chunks
    WHERE source_id=${sourceId} AND source_version=${sourceVersion} AND page=ANY(${preservePages}::int[])
    ON CONFLICT (page) DO NOTHING`;
  if (!stagedReadable && !allowSealedEmpty) {
    const [retained] = await tx`SELECT EXISTS (
      SELECT 1 FROM pg_temp.opening_pdf_chunk_stage staged JOIN opening_source_chunks c ON c.id=staged.matched_id
      WHERE c.text ~ '[^[:space:]]' OR c.image_object_key ~ '[^[:space:]]') AS readable`;
    requireReadableContent(retained?.readable === true);
  }
  await tx`UPDATE pg_temp.opening_pdf_chunk_stage staged SET matched_id=c.id FROM opening_source_chunks c
    WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion} AND c.page=staged.page AND staged.matched_id IS NULL
      AND (c.slide_label,c.start_ms,c.end_ms,c.text,c.image_object_key)
        IS NOT DISTINCT FROM (staged.slide_label,staged.start_ms,staged.end_ms,staged.text,staged.image_object_key)`;
  const previous = await tx<{ id: string; removed: boolean }[]>`SELECT c.id, staged.matched_id IS NULL AS removed
    FROM opening_source_chunks c LEFT JOIN pg_temp.opening_pdf_chunk_stage staged ON staged.page=c.page
    WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion} AND c.text ~ '[^[:space:]]'`;
  if (previous.length) {
    const readableChanged = previous.some(chunk => chunk.removed) || (await tx`SELECT EXISTS (
      SELECT 1 FROM pg_temp.opening_pdf_chunk_stage WHERE matched_id IS NULL AND text ~ '[^[:space:]]') AS added_readable`)[0]?.added_readable;
    if (readableChanged) {
      const digest = knowledgeChunkDigests(previous.map(({ id }) => ({ id, sourceId })))[sourceId]!;
      await backfillLegacyChunkDigest(tx, scope, sourceId, sourceVersion, digest);
    }
  }
  if (preserveDefinitions) {
    // Keep ordinary replacements available for legacy definitions, but remove withdrawn or
    // contaminated rows before the backfill reads evidence. An exact staged match is public.
    await tx`DELETE FROM opening_source_chunks c
      WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion}
        AND NOT EXISTS (SELECT 1 FROM pg_temp.opening_pdf_chunk_stage staged WHERE staged.page=c.page AND staged.matched_id=c.id)
        AND (c.page=ANY(${unsafeLegacyPages}::int[]) OR NOT EXISTS (
          SELECT 1 FROM pg_temp.opening_pdf_chunk_stage staged WHERE staged.page=c.page
        ) OR EXISTS (
          SELECT 1 FROM opening_pdf_parse_segments seal
          WHERE seal.workspace_id=${scope.workspaceId} AND seal.source_id=c.source_id AND seal.source_version=c.source_version
            AND seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'
            AND seal.page_start=c.page AND seal.page_end=c.page
            AND (seal.pages->0->>'hadSealedContent'='true' OR seal.pages->0->>'sectionSealedAtEnd'='true'
              OR seal.pages->0->>'inlineSealedAtEnd'='true' OR seal.pages->0->>'publicationSealUnknown'='true')
        ))`;
    await preserveDefinitions();
  }
  await tx`DELETE FROM opening_source_chunks c WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion}
    AND NOT EXISTS (SELECT 1 FROM pg_temp.opening_pdf_chunk_stage staged WHERE staged.page=c.page AND staged.matched_id=c.id)`;
  await tx`INSERT INTO opening_source_chunks(source_id,source_version,page,slide_label,start_ms,end_ms,text,image_object_key)
    SELECT ${sourceId},${sourceVersion},page,slide_label,start_ms,end_ms,text,image_object_key
    FROM pg_temp.opening_pdf_chunk_stage WHERE matched_id IS NULL ORDER BY page`;
}

export function createOpeningSourceChunksRepository(sql: Sql): OpeningSourceChunksRepository & OpeningPdfChunkPublisher { return {
  async replaceChunks(scope, input) {
    await sql.begin(tx => publishChunks(tx, scope, input, async sourceId => {
      if (!input.allowSealedEmpty) requireReadableContent(chunksHaveReadableContent(input.chunks));
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
        const { sourceVersion } = input;
        const readableIds = new Set(existing.filter(chunk => chunk.readable).map(chunk => String(chunk.id)));
        const digest = knowledgeChunkDigests(existingChunks.filter(chunk => readableIds.has(chunk.id)))[sourceId];
        if (digest && (unmatched.some(chunk => readableIds.has(chunk.id)) || (await tx`SELECT EXISTS (
          SELECT 1 FROM unnest(${added.map(chunk => chunk.text)}::text[]) AS added(text) WHERE text ~ '[^[:space:]]'
        ) AS added_readable`)[0]?.added_readable)) await backfillLegacyChunkDigest(tx, scope, sourceId, sourceVersion, digest);
        // Free changed page keys before inserting replacements in this transaction.
        if (unmatched.length) await tx`DELETE FROM opening_source_chunks WHERE id IN ${tx(unmatched.map(chunk => chunk.id))}`;
        for (const chunk of added) await tx`INSERT INTO opening_source_chunks(source_id,source_version,page,slide_label,start_ms,end_ms,text,image_object_key)
          VALUES(${input.sourceId},${input.sourceVersion},${chunk.page},${chunk.slideLabel ?? null},${chunk.startMs ?? null},${chunk.endMs ?? null},${chunk.text},${chunk.imageObjectKey ?? null})`;
      }
    }));
  },
  async replacePdfChunks(scope, input) {
    await sql.begin(async tx => {
      // Disk staging is complete before this transaction. Hold publication locks only for reconciliation.
      const stagedReadable = await stagePdfChunks(tx, input.chunks);
      if (!input.preservePages.length && !input.allowSealedEmpty) requireReadableContent(stagedReadable);
      await publishChunks(tx, scope, input,
        async (sourceId, preserveDefinitions) => {
          await reconcilePdfChunks(tx, scope, { ...input, sourceId }, stagedReadable, preserveDefinitions);
          await commitPdfPageSeals(tx, scope.workspaceId, sourceId, input.sourceVersion, input.publicationSeals ?? []);
        },
        input.preservePages);
    });
  },
  async listChunks(scope, sourceId) { sourceId = controlledLearningTools.open_fragment.input.parse(sourceId); const rows = await sql`SELECT version FROM opening_sources WHERE id = ${sourceId} AND workspace_id = ${scope.workspaceId} AND upload_state = 'uploaded'`; const row = rows[0] as Record<string, unknown> | undefined; return row ? fetchChunks(sql, scope, sourceId, Number(row.version)) : []; },
  listChunksAtVersion: (scope, sourceId, version, pages, options) => fetchChunks(sql, scope, sourceId, version, pages, options),
  async listForSources(scope, sourceIds) {
    if (!sourceIds.length) return [];
    const rows = await sql`
      ${publicPdfSealBoundaries(sql, scope.workspaceId, { sourceIds })}
      SELECT c.*, s.mime FROM opening_source_chunks c
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
        AND ${publicPdfChunkPredicate(sql)}
        AND c.source_id IN ${sql(sourceIds)}
      ORDER BY c.source_id, c.source_version DESC, c.page NULLS LAST, c.created_at
    `;
    return rows.filter(isPublicSourceChunk).map(mapChunk);
  },
}; }
