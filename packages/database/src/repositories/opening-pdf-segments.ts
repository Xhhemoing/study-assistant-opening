import type { Sql, TransactionSql } from "postgres";
import { lockOpeningJobExecution, type OpeningJobScope } from "./opening-job-execution";
import { OpeningSourceError } from "./opening-source-errors";

export type PdfSegmentPage = { page: number; text: string; imagePath: null; visualKinds?: ("scan" | "formula" | "table" | "picture")[] };
export type PdfSegmentIdentity = { sourceId: string; sourceVersion: number; parserProfile: string; pageStart: number; pageEnd: number };
export type PdfSegment = { state: "ready"; pages: PdfSegmentPage[] } | { state: "failed"; errorCode: "conversion_failed" | "timeout" | "invalid_output" };
export type OpeningPdfSegmentsRepository = ReturnType<typeof createOpeningPdfSegmentsRepository>;
const conflict = () => new OpeningSourceError("CONFLICT", "PDF parse execution or source version is no longer current");

function validateIdentity(input: PdfSegmentIdentity) {
  // Normal uploads start at version 0; cache identity follows source/chunk identity.
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0
    || !Number.isSafeInteger(input.pageStart) || !Number.isSafeInteger(input.pageEnd)
    || input.pageStart < 1 || input.pageEnd < input.pageStart || input.pageEnd - input.pageStart >= 100
    || input.parserProfile.length < 1 || input.parserProfile.length > 200) throw new TypeError("invalid PDF segment identity");
}
export function validatePdfSegmentPages(value: unknown, start: number, end: number): PdfSegmentPage[] {
  if (!Array.isArray(value) || value.length !== end - start + 1) throw new TypeError("incomplete PDF segment");
  return value.map((page: unknown, index) => {
    if (!page || typeof page !== "object") throw new TypeError("invalid PDF segment page");
    const row = page as Record<string, unknown>;
    if (row.page !== start + index || typeof row.text !== "string" || row.text.length > 200_020 || row.imagePath !== null) throw new TypeError("invalid PDF segment page");
    if (row.visualKinds !== undefined && (!Array.isArray(row.visualKinds) || row.visualKinds.length > 4
      || row.visualKinds.some(kind => !["scan", "formula", "table", "picture"].includes(String(kind)))
      || new Set(row.visualKinds).size !== row.visualKinds.length)) throw new TypeError("invalid PDF visual classification");
    return { page: row.page as number, text: row.text, imagePath: null,
      ...(row.visualKinds === undefined ? {} : { visualKinds: row.visualKinds as PdfSegmentPage["visualKinds"] }) };
  });
}

async function assertSource(tx: Sql | TransactionSql, scope: OpeningJobScope, input: { sourceId: string; sourceVersion: number }) {
  // Cache is execution-private, not an alternate read API. Reuse the same
  // workspace -> job -> source locking order as chunks/cancel/privacy changes.
  if (!scope.jobExecution) throw conflict();
  await lockOpeningJobExecution(tx, scope);
  const [job] = await tx`SELECT id FROM opening_jobs WHERE id=${scope.jobExecution.id}
    AND kind='parse' AND payload->>'sourceId'=${input.sourceId}
    AND (NOT (payload ? 'sourceVersion') OR payload->>'sourceVersion'=${String(input.sourceVersion)})`;
  const [source] = job ? await tx`SELECT id FROM opening_sources s WHERE id=${input.sourceId}
    AND workspace_id=${scope.workspaceId} AND version=${input.sourceVersion} AND upload_state='uploaded' AND mime='application/pdf'
    AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    FOR SHARE` : [];
  if (!source) throw conflict();
}

export function createOpeningPdfSegmentsRepository(sql: Sql) {
  return {
    /** Polling saves CPU; the write transaction below is the authoritative fence. */
    async assertCurrent(scope: OpeningJobScope, input: { sourceId: string; sourceVersion: number }): Promise<void> {
      await sql.begin(tx => assertSource(tx, scope, input));
    },
    async read(scope: OpeningJobScope, input: PdfSegmentIdentity): Promise<PdfSegment | null> {
      validateIdentity(input);
      return sql.begin(async (tx): Promise<PdfSegment | null> => {
        await assertSource(tx, scope, input);
        const [row] = await tx`SELECT state,pages,error_code FROM opening_pdf_parse_segments
          WHERE workspace_id=${scope.workspaceId} AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}
          AND parser_profile=${input.parserProfile} AND page_start=${input.pageStart} AND page_end=${input.pageEnd}`;
        if (!row) return null;
        return row.state === "ready" ? { state: "ready", pages: validatePdfSegmentPages(row.pages, input.pageStart, input.pageEnd) }
          : { state: "failed", errorCode: row.error_code as "conversion_failed" | "timeout" | "invalid_output" };
      });
    },
    async save(scope: OpeningJobScope, input: PdfSegmentIdentity, segment: PdfSegment, signal?: AbortSignal): Promise<void> {
      validateIdentity(input);
      const pages = segment.state === "ready" ? validatePdfSegmentPages(segment.pages, input.pageStart, input.pageEnd) : null;
      signal?.throwIfAborted();
      await sql.begin(async tx => {
        await assertSource(tx, scope, input);
        signal?.throwIfAborted();
        await tx`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages,error_code)
          VALUES(${scope.workspaceId},${input.sourceId},${input.sourceVersion},${input.parserProfile},${input.pageStart},${input.pageEnd},
            ${segment.state},${pages ? tx.json(pages) : null},${segment.state === "failed" ? segment.errorCode : null})
          ON CONFLICT(source_id,source_version,parser_profile,page_start,page_end) DO UPDATE
            SET state=EXCLUDED.state,pages=EXCLUDED.pages,error_code=EXCLUDED.error_code,updated_at=now()
            WHERE opening_pdf_parse_segments.state <> 'ready'`;
        // An abort while the SQL command was in flight rolls back the segment.
        signal?.throwIfAborted();
      });
    },
  };
}
