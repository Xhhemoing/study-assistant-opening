import type { Sql, TransactionSql } from "postgres";
import { lockOpeningJobExecution, type OpeningJobScope } from "./opening-job-execution";
import { OpeningSourceError } from "./opening-source-errors";

export type PdfSegmentPage = { page: number; text: string; imagePath: null; visualKinds?: ("scan" | "formula" | "table" | "picture")[]; sectionSealedAtEnd?: boolean; inlineSealedAtEnd?: boolean; inlineProofSealedAtEnd?: boolean; inlineProofBoundaryPendingAtEnd?: boolean; hadSealedContent?: boolean; inWorkedExampleAtEnd?: boolean; previousNumberedQuestionAtEnd?: boolean; inExerciseAtEnd?: boolean; publicationSealUnknown?: boolean; publicationSealHadPublicPrefix?: boolean; publicationSealCommitted?: boolean; reopenedSection?: boolean; failedRangeBoundary?: true; withheldNativeDigest?: string; withheldNativeMode?: "section_sealed" | "inline_sealed" | "inline_proof_sealed" };
export type PdfSegmentIdentity = { sourceId: string; sourceVersion: number; parserProfile: string; pageStart: number; pageEnd: number };
export type PdfSegment = { state: "ready"; pages: PdfSegmentPage[]; requiresRevalidation?: true } | { state: "failed"; errorCode: "conversion_failed" | "timeout" | "invalid_output" };
export type OpeningPdfSegmentsRepository = ReturnType<typeof createOpeningPdfSegmentsRepository>;
const conflict = () => new OpeningSourceError("CONFLICT", "PDF parse execution or source version is no longer current");

const publicationProfile = "pdf-publication-page-seal-v1";
const failureProfileSuffix = "/publication-failure-";
const boundaryPagePattern = "([1-9][0-9]{0,8})$";
export const pendingPdfFailureBoundaryPattern = failureProfileSuffix + "pending-" + boundaryPagePattern;
const failureBoundaryPattern = failureProfileSuffix + "(?:pending|settled)-" + boundaryPagePattern;
const failureBoundary = new RegExp(failureBoundaryPattern, "u");
const pendingFailureBoundary = new RegExp(pendingPdfFailureBoundaryPattern, "u");

function storedSegmentKey(tx: Sql, input: PdfSegmentIdentity) {
  // A conversion has one row even when its failed-row constraint prevents JSON metadata.
  return tx`(parser_profile=${input.parserProfile} OR starts_with(parser_profile,${input.parserProfile + failureProfileSuffix}))`;
}

function validateIdentity(input: PdfSegmentIdentity) {
  // Normal uploads start at version 0; cache identity follows source/chunk identity.
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0
    || !Number.isSafeInteger(input.pageStart) || !Number.isSafeInteger(input.pageEnd)
    || input.pageStart < 1 || input.pageEnd < input.pageStart || input.pageEnd - input.pageStart >= 100
    || input.parserProfile.length < 1 || input.parserProfile.length > 200
    || input.parserProfile.includes(failureProfileSuffix)) throw new TypeError("invalid PDF segment identity");
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
    if (row.sectionSealedAtEnd !== undefined && typeof row.sectionSealedAtEnd !== "boolean") throw new TypeError("invalid PDF sectionSealedAtEnd metadata");
    if (row.inlineSealedAtEnd !== undefined && typeof row.inlineSealedAtEnd !== "boolean") throw new TypeError("invalid PDF inlineSealedAtEnd metadata");
    if (row.inlineProofBoundaryPendingAtEnd !== undefined && typeof row.inlineProofBoundaryPendingAtEnd !== "boolean") throw new TypeError("invalid PDF inlineProofBoundaryPendingAtEnd metadata");
    if (row.inlineProofSealedAtEnd !== undefined && typeof row.inlineProofSealedAtEnd !== "boolean") throw new TypeError("invalid PDF inlineProofSealedAtEnd metadata");
    if (row.sectionSealedAtEnd && row.inlineSealedAtEnd || row.inlineProofSealedAtEnd && !row.inlineSealedAtEnd) throw new TypeError("conflicting PDF page end seal metadata");
    if (row.hadSealedContent !== undefined && typeof row.hadSealedContent !== "boolean") throw new TypeError("invalid PDF hadSealedContent metadata");
    if (row.previousNumberedQuestionAtEnd !== undefined && typeof row.previousNumberedQuestionAtEnd !== "boolean") throw new TypeError("invalid PDF previousNumberedQuestionAtEnd metadata");
    if (row.inWorkedExampleAtEnd !== undefined && typeof row.inWorkedExampleAtEnd !== "boolean") throw new TypeError("invalid PDF inWorkedExampleAtEnd metadata");
    if (row.inExerciseAtEnd !== undefined && typeof row.inExerciseAtEnd !== "boolean") throw new TypeError("invalid PDF inExerciseAtEnd metadata");
    if (row.publicationSealUnknown !== undefined && typeof row.publicationSealUnknown !== "boolean") throw new TypeError("invalid PDF publicationSealUnknown metadata");
    if (row.publicationSealHadPublicPrefix !== undefined && typeof row.publicationSealHadPublicPrefix !== "boolean") throw new TypeError("invalid PDF publicationSealHadPublicPrefix metadata");
    if (row.publicationSealCommitted !== undefined && typeof row.publicationSealCommitted !== "boolean") throw new TypeError("invalid PDF publicationSealCommitted metadata");
    if (row.reopenedSection !== undefined && typeof row.reopenedSection !== "boolean") throw new TypeError("invalid PDF reopenedSection metadata");
    if (row.withheldNativeDigest !== undefined || row.withheldNativeMode !== undefined || row.failedRangeBoundary !== undefined) {
      if (typeof row.withheldNativeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.withheldNativeDigest)
        || (row.withheldNativeMode !== "section_sealed" && row.withheldNativeMode !== "inline_sealed" && row.withheldNativeMode !== "inline_proof_sealed")
        || row.failedRangeBoundary !== true || row.publicationSealUnknown !== true || row.text !== "") {
        throw new TypeError("invalid PDF withheld native metadata");
      }
    }
    return { page: row.page as number, text: row.text, imagePath: null,
      ...(row.visualKinds === undefined ? {} : { visualKinds: row.visualKinds as PdfSegmentPage["visualKinds"] }),
      ...(row.sectionSealedAtEnd === undefined ? {} : { sectionSealedAtEnd: row.sectionSealedAtEnd }),
      ...(row.inlineSealedAtEnd === undefined ? {} : { inlineSealedAtEnd: row.inlineSealedAtEnd }),
      ...(row.inlineProofBoundaryPendingAtEnd === undefined ? {} : { inlineProofBoundaryPendingAtEnd: row.inlineProofBoundaryPendingAtEnd }),
      ...(row.inlineProofSealedAtEnd === undefined ? {} : { inlineProofSealedAtEnd: row.inlineProofSealedAtEnd }),
      ...(row.hadSealedContent === undefined ? {} : { hadSealedContent: row.hadSealedContent }),
      ...(row.previousNumberedQuestionAtEnd === undefined ? {} : { previousNumberedQuestionAtEnd: row.previousNumberedQuestionAtEnd }),
      ...(row.inWorkedExampleAtEnd === undefined ? {} : { inWorkedExampleAtEnd: row.inWorkedExampleAtEnd }),
      ...(row.inExerciseAtEnd === undefined ? {} : { inExerciseAtEnd: row.inExerciseAtEnd }),
      ...(row.publicationSealUnknown === undefined ? {} : { publicationSealUnknown: row.publicationSealUnknown }),
      ...(row.publicationSealHadPublicPrefix === undefined ? {} : { publicationSealHadPublicPrefix: row.publicationSealHadPublicPrefix }),
      ...(row.publicationSealCommitted === undefined ? {} : { publicationSealCommitted: row.publicationSealCommitted }),
      ...(row.reopenedSection === undefined ? {} : { reopenedSection: row.reopenedSection }),
      ...(typeof row.withheldNativeDigest === "string" ? {
        failedRangeBoundary: true, withheldNativeDigest: row.withheldNativeDigest,
        withheldNativeMode: row.withheldNativeMode as PdfSegmentPage["withheldNativeMode"],
      } : {}) };
  });
}

async function writePdfPageSeals(tx: TransactionSql, workspaceId: string, sourceId: string, sourceVersion: number,
  markers: readonly PdfSegmentPage[], committed: boolean) {
  if (!markers.length) return;
  const pages = markers.map(marker => {
    const [page] = validatePdfSegmentPages([marker], marker.page, marker.page);
    return { ...page, publicationSealCommitted: committed };
  });
  await tx`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages,error_code)
    SELECT ${workspaceId}::uuid,${sourceId}::uuid,${sourceVersion}::int,'pdf-publication-page-seal-v1',entry.page,entry.page,'ready',jsonb_build_array(entry.marker),NULL
    FROM jsonb_array_elements(${tx.json(pages)}::jsonb) AS data(marker)
    CROSS JOIN LATERAL (SELECT (data.marker->>'page')::int AS page,data.marker) entry
    ON CONFLICT(source_id,source_version,parser_profile,page_start,page_end) DO UPDATE
      SET state=EXCLUDED.state,pages=EXCLUDED.pages,error_code=NULL,updated_at=now()`;
}

function hasPublicationSeal(page: PdfSegmentPage): boolean {
  return Boolean(page.hadSealedContent || page.sectionSealedAtEnd || page.inlineSealedAtEnd
    || page.inlineProofBoundaryPendingAtEnd || page.publicationSealUnknown);
}

/** Called after chunk reconciliation, under the publication transaction's execution and source locks. */
export async function commitPdfPageSeals(tx: TransactionSql, workspaceId: string, sourceId: string, sourceVersion: number,
  markers: readonly PdfSegmentPage[]) {
  const retained: PdfSegmentPage[] = [];
  const cleared: number[] = [];
  for (const marker of markers) {
    if (hasPublicationSeal(marker)) retained.push(marker);
    else cleared.push(marker.page);
  }
  await writePdfPageSeals(tx, workspaceId, sourceId, sourceVersion, retained, true);
  if (cleared.length) await tx`DELETE FROM opening_pdf_parse_segments
    WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND source_version=${sourceVersion}
      AND parser_profile=${publicationProfile} AND page_start=ANY(${cleared}::int[]) AND page_end=page_start`;
  // Ready conversion output can survive an interrupted publication. Keep the
  // pending boundary on that same row until the staged replacement commits.
  await tx`UPDATE opening_pdf_parse_segments
    SET parser_profile=CASE
      WHEN substring(parser_profile FROM ${failureBoundaryPattern})::int=ANY(${cleared}::int[])
        THEN regexp_replace(parser_profile,${failureBoundaryPattern},'')
      ELSE replace(parser_profile,${failureProfileSuffix + "pending-"},${failureProfileSuffix + "settled-"})
    END,updated_at=now()
    WHERE workspace_id=${workspaceId} AND source_id=${sourceId} AND source_version=${sourceVersion}
      AND (parser_profile ~ ${pendingPdfFailureBoundaryPattern}
        OR substring(parser_profile FROM ${failureBoundaryPattern})::int=ANY(${cleared}::int[]))`;
}

async function assertSource(tx: Sql | TransactionSql, scope: OpeningJobScope, input: { sourceId: string; sourceVersion: number }, write = false) {
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
    ${write ? tx`FOR NO KEY UPDATE` : tx`FOR SHARE`}` : [];
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
        const [row] = await tx`SELECT state,pages,error_code,parser_profile FROM opening_pdf_parse_segments
          WHERE workspace_id=${scope.workspaceId} AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}
          AND page_start=${input.pageStart} AND page_end=${input.pageEnd} AND ${storedSegmentKey(tx, input)}
          LIMIT 1`;
        if (!row) return null;
        return row.state === "ready" ? { state: "ready", pages: validatePdfSegmentPages(row.pages, input.pageStart, input.pageEnd),
          ...(pendingFailureBoundary.test(row.parser_profile) ? { requiresRevalidation: true } : {}) }
          : { state: "failed", errorCode: row.error_code as "conversion_failed" | "timeout" | "invalid_output" };
      });
    },
    async readPageSeals(scope: OpeningJobScope, input: PdfSegmentIdentity): Promise<PdfSegmentPage[]> {
      validateIdentity(input);
      return sql.begin(async tx => {
        await assertSource(tx, scope, input);
        const rows = await tx<{ page_start: number; parser_profile: string; pages: unknown }[]>`SELECT page_start,parser_profile,pages
          FROM opening_pdf_parse_segments
          WHERE workspace_id=${scope.workspaceId} AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}
            AND page_start<=${input.pageEnd} AND page_end>=${input.pageStart}
            AND ((parser_profile=${input.parserProfile} AND page_end=page_start AND state='ready')
              OR parser_profile ~ ${failureBoundaryPattern})`;
        const markers = new Map<number, PdfSegmentPage>();
        for (const row of rows) {
          if (row.parser_profile === input.parserProfile) {
            const [marker] = validatePdfSegmentPages(row.pages, row.page_start, row.page_start);
            if (marker && (!markers.has(marker.page) || hasPublicationSeal(marker))) markers.set(marker.page, marker);
            continue;
          }
          const page = Number(failureBoundary.exec(row.parser_profile)?.[1]);
          if (!Number.isSafeInteger(page) || page < input.pageStart || page > input.pageEnd) continue;
          const existing = markers.get(page);
          if (!existing || !hasPublicationSeal(existing)) {
            markers.set(page, { page, text: "", imagePath: null, publicationSealUnknown: true, failedRangeBoundary: true });
          }
        }
        return [...markers.values()];
      });
    },
    async save(scope: OpeningJobScope, input: PdfSegmentIdentity, segment: PdfSegment, signal?: AbortSignal,
      blockingSeals: readonly PdfSegmentPage[] = [], replaceReady = false): Promise<void> {
      validateIdentity(input);
      if (blockingSeals.length && (segment.state !== "failed" || blockingSeals.some(marker =>
        marker.page < input.pageStart || marker.page > input.pageEnd || !marker.publicationSealUnknown || marker.reopenedSection))) {
        throw new TypeError("invalid failed PDF segment publication markers");
      }
      const pages = segment.state === "ready" ? validatePdfSegmentPages(segment.pages, input.pageStart, input.pageEnd) : null;
      signal?.throwIfAborted();
      await sql.begin(async tx => {
        // Serialize logical keys that can change stored profiles across retry and publication.
        await assertSource(tx, scope, input, true);
        signal?.throwIfAborted();
        let profile = input.parserProfile;
        if (profile !== publicationProfile) {
          const [existing] = await tx<{ parser_profile: string; state: string }[]>`SELECT parser_profile,state FROM opening_pdf_parse_segments
            WHERE workspace_id=${scope.workspaceId} AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}
              AND page_start=${input.pageStart} AND page_end=${input.pageEnd} AND ${storedSegmentKey(tx, input)}
            LIMIT 1 FOR UPDATE`;
          if (existing?.state === "ready" && !replaceReady) return;
          if (existing) profile = existing.parser_profile;
          if (blockingSeals.length) {
            const previousPending = Number(pendingFailureBoundary.exec(profile)?.[1] ?? Infinity);
            const boundary = Math.min(previousPending, ...blockingSeals.map(marker => marker.page));
            profile = input.parserProfile + failureProfileSuffix + "pending-" + boundary;
            if (!pendingFailureBoundary.test(profile) || profile.length > 200) throw new TypeError("invalid PDF failure boundary");
          }
          if (existing && profile !== existing.parser_profile) {
            await tx`UPDATE opening_pdf_parse_segments SET parser_profile=${profile}
              WHERE workspace_id=${scope.workspaceId} AND source_id=${input.sourceId} AND source_version=${input.sourceVersion}
                AND page_start=${input.pageStart} AND page_end=${input.pageEnd} AND parser_profile=${existing.parser_profile}`;
          }
        }
        await tx`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages,error_code)
          VALUES(${scope.workspaceId},${input.sourceId},${input.sourceVersion},${profile},${input.pageStart},${input.pageEnd},
            ${segment.state},${pages ? tx.json(pages) : null},${segment.state === "failed" ? segment.errorCode : null})
          ON CONFLICT(source_id,source_version,parser_profile,page_start,page_end) DO UPDATE
            SET state=EXCLUDED.state,pages=EXCLUDED.pages,error_code=EXCLUDED.error_code,updated_at=now()
            WHERE opening_pdf_parse_segments.state <> 'ready'
               OR EXCLUDED.parser_profile = 'pdf-publication-page-seal-v1' OR ${replaceReady}`;
        // A failure or abort rolls back both the conversion state and its publication boundary.
        signal?.throwIfAborted();
      });
    },
  };
}
