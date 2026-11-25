import type { Sql } from "postgres";
import { OpeningSourceError, type OpeningScope } from "./opening-sources";
import { filterPublicSamePagePdfChunks, publicPdfChunkPredicate, publicPdfSealBoundaries, type ArchivePdfCursorState } from "./opening-knowledge-definitions";

type PageStats = { page: number | null; characters: number; readable: boolean };

/** Owner-only, version-pinned plain text; object keys and rendered HTML never leave this reader. */
export async function readOpeningSourceContent(sql: Sql, scope: OpeningScope, id: string, input: { version?: number; page?: number }) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const rows = await tx`SELECT s.version,s.mime,s.parse_state,s.upload_state,s.error,
      EXISTS (SELECT 1 FROM opening_jobs j WHERE j.workspace_id=s.workspace_id
        AND j.owner_user_id=${scope.ownerUserId} AND j.kind='index-source'
        AND j.payload->>'sourceId'=s.id::text AND j.payload->>'sourceVersion'=s.version::text) AS published,
      EXISTS (SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) AS ai_excluded
      FROM opening_sources s
      JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
      WHERE s.id=${id} AND s.workspace_id=${scope.workspaceId}`;
    const source = rows[0];
    if (!source) throw new OpeningSourceError("NOT_FOUND", "Source not found");
    const version = input.version ?? Number(source.version);
    if (version < 0 || version > Number(source.version)) throw new OpeningSourceError("NOT_FOUND", "Source version not found");
    // replaceChunks atomically commits ready chunks and the index-source job.
    // That existing publication receipt survives retries; raw/staged chunks do not qualify.
    // AI exclusion is not asset deletion: keep existing ready/historical self-reads.
    // Only the additional non-ready PDF retry access is denied for excluded material.
    const publishedPdf = source.mime === "application/pdf" && source.published === true
      && source.ai_excluded === false
      && (source.error as { code?: string } | null)?.code !== "PRIVACY_EXCLUDED"
      && ["queued", "running", "failed", "not_started"].includes(String(source.parse_state));
    if (source.upload_state !== "uploaded" || (version === Number(source.version) && source.parse_state !== "ready" && !publishedPdf)) {
      throw new OpeningSourceError("CONFLICT", "材料尚未完成正文解析");
    }
    const pdf = source.mime === "application/pdf";
    const permittedIds = new Map<number | null, string[]>();
    const pdfBoundary = pdf ? publicPdfSealBoundaries(tx, scope.workspaceId, { sourceIds: [id], sourceVersion: version }) : tx``;
    const fromPdf = pdf ? tx`FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
      WHERE c.source_id=${id} AND c.source_version=${version} AND s.workspace_id=${scope.workspaceId}
        AND ${publicPdfChunkPredicate(tx)}` : tx``;
    let stats: PageStats[];
    if (pdf) {
      // Stream complete chunks in deterministic intra-page order so same-page split chunks share primary lookahead.
      const query = tx`${pdfBoundary}
        SELECT c.id,c.page,length(c.text)::int AS characters,c.text ~ '[^[:space:]]' AS readable,c.text
        ${fromPdf} ORDER BY c.page NULLS LAST,c.created_at,c.id`;
      const byPage = new Map<number | null, PageStats>();
      const cursorState: ArchivePdfCursorState = {
        inWorkedExample: false,
        inExercise: false,
        previousNumberedQuestion: false,
      };
      let lastFlushedPage: number | null | undefined;
      let bufferedPage: number | null | undefined;
      let pageRows: Array<Record<string, unknown> & { text: string; page: number | null }> = [];
      const flushPage = () => {
        if (!pageRows.length) return;
        const currentPage = pageRows[0]?.page == null ? null : Number(pageRows[0].page);
        if (currentPage === null) {
          cursorState.inWorkedExample = false;
          cursorState.inExercise = false;
          cursorState.previousNumberedQuestion = false;
        } else if (lastFlushedPage !== undefined && lastFlushedPage !== null && currentPage > lastFlushedPage + 1) {
          cursorState.previousNumberedQuestion = false;
        }
        for (const row of filterPublicSamePagePdfChunks(pageRows, currentPage === null ? undefined : cursorState)) {
          const page = row.page == null ? null : Number(row.page);
          const current = byPage.get(page);
          byPage.set(page, { page, characters: (current?.characters ?? 0) + Number(row.characters), readable: Boolean(current?.readable || row.readable) });
          const ids = permittedIds.get(page) ?? [];
          ids.push(String(row.id));
          permittedIds.set(page, ids);
        }
        lastFlushedPage = currentPage;
        pageRows = [];
      };
      for await (const rows of query.cursor(16)) {
        for (const row of rows) {
          const page = row.page == null ? null : Number(row.page);
          if (bufferedPage !== undefined && page !== bufferedPage) flushPage();
          bufferedPage = page;
          pageRows.push(row as Record<string, unknown> & { text: string; page: number | null });
        }
      }
      flushPage();
      stats = [...byPage.values()];
    } else {
      stats = await tx<PageStats[]>`SELECT page,sum(length(text))::int AS characters,bool_or(text ~ '[^[:space:]]') AS readable
        FROM opening_source_chunks WHERE source_id=${id} AND source_version=${version} GROUP BY page ORDER BY page NULLS LAST`;
    }
    if (!stats.length) throw new OpeningSourceError("NOT_FOUND", "该版本没有解析正文");
    const pages = stats.map(row => row.page == null ? null : Number(row.page));
    const page = input.page ?? pages[0]!;
    if (!pages.includes(page)) throw new OpeningSourceError("NOT_FOUND", "该页没有解析记录");
    // Limit each database value before sending; a physical page may contain multiple chunks.
    // Repeatable read pins the same publisher state and exact chunk rows cleared above.
    const bodies = pdf ? await tx`SELECT left(c.text,20001) AS text FROM opening_source_chunks c
      WHERE c.source_id=${id} AND c.source_version=${version}
        AND c.page IS NOT DISTINCT FROM ${page} AND c.id=ANY(${permittedIds.get(page) ?? []}::uuid[])
      ORDER BY c.created_at,c.id`
      : await tx`SELECT left(text,20001) AS text FROM opening_source_chunks
        WHERE source_id=${id} AND source_version=${version} AND page IS NOT DISTINCT FROM ${page} ORDER BY created_at,id`;
    const text = bodies.map(row => String(row.text)).join("\n\n");
    return { sourceId: id, version, currentVersion: Number(source.version), page, pages,
      pageKind: source.mime === "text/markdown" || source.mime === "text/plain" || source.mime === "text/html" ? "section" as const : "physical" as const,
      readablePages: stats.filter(row => row.readable).length,
      characters: stats.reduce((sum, row) => sum + Number(row.characters), 0),
      text: text.slice(0,20000), truncated: text.length > 20000 };
  });
}
