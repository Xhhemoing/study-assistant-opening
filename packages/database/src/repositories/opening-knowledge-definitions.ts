import type { Scope, SourceChunk } from "@aistudy/contracts";
import { knowledgeDefinitionHeader, knowledgeNodeDefinition, serializeKnowledgeEvidence } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { storedKnowledgeSnapshotSchema } from "./opening-knowledge-snapshot";

const definitionPatchByteLimit = 256 * 1024;
const pdfHeadingContainer = /^(?:(?:chapter|section|lecture|part|unit|appendix)[ \t]+[\w.]+|第[ \t]*[一二三四五六七八九十百千\d]+[ \t]*(?:章|节|讲|部分|单元)|附录[ \t]*[A-Z0-9一二三四五六七八九十]+)(?:[ \t]*[:：.\-—–][ \t]*|[ \t]+)/iu;
const explicitPdfAnswerLabel = /^(?:(?:answer[ \t]+(?:key|section)|(?:model|selected|official|reference|correct|sample|odd-numbered|even-numbered)[ \t]+answers?|(?:official|reference)[ \t]+solutions?|solutions?[ \t]+manual|answers?)(?:[ \t]*\([ \t]*(?:continued|cont\.?)[ \t]*\))?[ \t]*(?:[:：]|$)|(?:answers?|solutions?|key)[ \t]+to[ \t]+(?:the[ \t]+)?(?:exercises?|problems?|questions?)\b|(?:【[ \t]*)?(?:参考答案|标准答案|正确答案|习题答案|练习答案|答案与解析|参考解答|详细解答|答案|解答)[ \t]*(?:】|[:：]|$))/iu;
const numberedPdfAnswerLabel = /^(?:(?:(?:model|selected|official|reference|correct|sample|odd-numbered|even-numbered|worked|full)[ \t]+)?(?:answers?(?:[ \t]+key)?|solutions?)|key)(?:[ \t]+to[ \t]+(?:exercise|problem|question))?[ \t]+\d+(?:\.\d+)*(?:[ \t]*\([ \t]*(?:continued|cont\.?|cont['’]?d)[ \t]*\))?[ \t]*[:：]|^(?:参考答案|标准答案|正确答案|习题答案|练习答案|参考解答|详细解答|答案|解答|详解|解析|解)[ \t]*\d+(?:[.-]\d+)*(?:[ \t]*[（(](?:续|接上页)[）)])?[ \t]*[:：]/iu;

export function containsPdfAnswerLabel(text: string): boolean {
  // Bare "Solution" may belong to a worked example spanning several pages.
  return text.split(/\r?\n/u).some(line => {
    const heading = line.trim().replace(/^#{1,6}[ \t]+/u, "").replace(/\*\*|__/gu, "");
    const container = pdfHeadingContainer.exec(heading)?.[0];
    const title = container ? heading.slice(container.length) : heading;
    return numberedPdfAnswerLabel.test(title) || explicitPdfAnswerLabel.test(title) || Boolean(container &&
      /^(?:(?:model|selected|official|reference|correct|sample|odd-numbered|even-numbered)[ \t]+)?solutions?[ \t]*(?:[:：]|$)/iu.test(title));
  });
}

/** Chunk and source aliases are c and s at each publication read. */
export function publicPdfChunkPredicate(sql: Sql) {
  return sql`(s.mime<>'application/pdf' OR c.page IS NULL OR NOT EXISTS (
    SELECT 1 FROM opening_pdf_parse_segments seal
    WHERE seal.workspace_id=s.workspace_id AND seal.source_id=c.source_id AND seal.source_version=c.source_version
      AND seal.parser_profile='pdf-publication-page-seal-v1' AND seal.state='ready'
      AND seal.page_end=seal.page_start AND seal.page_start<=c.page
      AND (
        ((seal.pages->0->>'sectionSealedAtEnd'='true' OR seal.pages->0->>'inlineSealedAtEnd'='true'
          OR seal.pages->0->>'publicationSealUnknown'='true')
          AND (s.parse_state<>'ready' OR seal.updated_at>s.updated_at))
        OR (seal.page_start=c.page
          AND (seal.pages->0->>'hadSealedContent'='true' OR seal.pages->0->>'inlineSealedAtEnd'='true'
            OR seal.pages->0->>'sectionSealedAtEnd'='true' OR seal.pages->0->>'publicationSealUnknown'='true')
          AND (c.image_object_key IS NOT NULL OR s.parse_state<>'ready' OR seal.updated_at>s.updated_at))
      )
  ))`;
}

async function readCitedChunk(tx: TransactionSql, scope: Scope, courseId: string, id: string) {
  // Read one text at a time. A single existing chunk can itself exceed 256 KiB in UTF-8.
  const [row] = await tx<Array<SourceChunk & { mime: string }>>`SELECT c.id,c.source_id AS "sourceId",c.source_version AS "sourceVersion",
    s.mime AS mime,
    c.page,c.slide_label AS "slideLabel",c.start_ms AS "startMs",c.end_ms AS "endMs",c.text,c.image_object_key AS "imageObjectKey"
    FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id
      AND v.version=c.source_version AND v.availability='available'
    JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.course_id=${courseId}
      AND m.asset_type='source' AND m.asset_id=s.id
    JOIN opening_course_knowledge graph ON graph.workspace_id=s.workspace_id AND graph.course_id=m.course_id
      AND graph.owner_user_id=${scope.ownerUserId}
    WHERE c.id=${id} AND c.source_version::text=graph.source_versions->>s.id::text
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      AND ${publicPdfChunkPredicate(tx)}
    FOR SHARE OF c,s,v,m`;
  if (row?.id !== id) return undefined;
  const { mime, ...chunk } = row;
  return mime === "application/pdf" && containsPdfAnswerLabel(chunk.text) ? undefined : chunk;
}

/** Upgrade pre-definition graphs before the parser replaces their evidence UUIDs.
 * Workspace → graph → source/chunks matches graph publication and privacy writes. */
export async function preserveOpeningKnowledgeDefinitions(tx: TransactionSql, scope: Scope, sourceId: string, sourceVersion: number): Promise<void> {
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner) throw new Error("workspace not found");
  const graphs = await tx<{ course_id: string; node_indexes: number[] }[]>`SELECT graph.course_id, missing.node_indexes
    FROM opening_course_knowledge graph
    CROSS JOIN LATERAL (
      SELECT array_agg((node.position - 1)::int ORDER BY node.position) AS node_indexes
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(graph.snapshot->'nodes')='array'
        THEN graph.snapshot->'nodes' ELSE '[]'::jsonb END) WITH ORDINALITY AS node(value,position)
      WHERE COALESCE(graph.node_definitions->(node.value->>'id'), 'null'::jsonb)
        IN ('null'::jsonb, '""'::jsonb, 'false'::jsonb, '0'::jsonb)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(node.value->'evidenceChunkIds')='array'
            THEN node.value->'evidenceChunkIds' ELSE '[]'::jsonb END) AS cited(id)
          JOIN opening_source_chunks c ON c.id=CASE WHEN pg_input_is_valid(cited.id, 'uuid') THEN cited.id::uuid END
          WHERE c.source_id=${sourceId} AND c.source_version=${sourceVersion}
        )
    ) missing
    WHERE graph.workspace_id=${scope.workspaceId} AND graph.owner_user_id=${scope.ownerUserId}
      AND graph.source_versions->>${sourceId}=${String(sourceVersion)} AND missing.node_indexes IS NOT NULL
    ORDER BY graph.course_id FOR UPDATE OF graph`;
  let evidenceStageReady = false;
  for (const { course_id: courseId, node_indexes: nodeIndexes } of graphs) {
    const [graph] = await tx`SELECT snapshot FROM opening_course_knowledge
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
    const parsed = storedKnowledgeSnapshotSchema.safeParse(graph?.snapshot);
    if (!parsed.success || parsed.data.courseId !== courseId) continue;

    let patch: Record<string, string> = {};
    let patchCount = 0;
    let patchBytes = 0;
    const flush = async () => {
      if (!patchCount) return;
      await tx`UPDATE opening_course_knowledge SET node_definitions=node_definitions || ${tx.json(patch)}::jsonb
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      patch = {};
      patchCount = 0;
      patchBytes = 0;
    };

    for (const index of nodeIndexes) {
      const node = parsed.data.nodes[index]!;
      const evidenceIds = new Set(node.evidenceChunkIds);
      if (evidenceIds.size === 1) {
        const chunk = await readCitedChunk(tx, scope, courseId, node.evidenceChunkIds[0]!);
        const definition = chunk && knowledgeNodeDefinition(node, [chunk]);
        if (!definition) continue;
        const bytes = Buffer.byteLength(JSON.stringify(definition)) + node.id.length + 4;
        if (patchCount === 16 || patchBytes + bytes > definitionPatchByteLimit) await flush();
        patch[node.id] = definition;
        patchCount++;
        patchBytes += bytes;
        continue;
      }

      // A single definition can cite every page. Keep its serialized evidence in
      // PostgreSQL, using UTF-16 sort keys to match JavaScript's exact definition format.
      await flush();
      if (!evidenceStageReady) {
        await tx`CREATE TEMP TABLE opening_legacy_knowledge_evidence (content text, sort_key bytea) ON COMMIT DROP`;
        evidenceStageReady = true;
      }
      let complete = true;
      for (const id of evidenceIds) {
        const chunk = await readCitedChunk(tx, scope, courseId, id);
        const content = chunk && serializeKnowledgeEvidence(chunk);
        if (!content) { complete = false; break; }
        const sortKey = Buffer.from(content, "utf16le").swap16();
        await tx`INSERT INTO pg_temp.opening_legacy_knowledge_evidence (content,sort_key) VALUES (${content},${sortKey})`;
      }
      if (complete) {
        const header = JSON.stringify(knowledgeDefinitionHeader(node)).slice(0, -1);
        await tx`UPDATE opening_course_knowledge SET node_definitions=node_definitions || jsonb_build_object(
            ${node.id}::text, ${header}::text || ',[' || (
              SELECT string_agg(to_json(content)::text, ',' ORDER BY sort_key)
              FROM (SELECT DISTINCT ON (sort_key) content,sort_key FROM pg_temp.opening_legacy_knowledge_evidence
                ORDER BY sort_key) evidence
            ) || ']]')
          WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}`;
      }
      await tx`TRUNCATE pg_temp.opening_legacy_knowledge_evidence`;
    }
    await flush();
  }
}
