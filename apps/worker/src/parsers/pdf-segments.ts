import { validatePdfSegmentPages, type OpeningPdfSegmentsRepository, type OpeningScope, type PdfSegmentPage } from "@aistudy/database";
import { BoundsExceededError, ConversionFailedError, UnsupportedMimeError, UsageError, createDoclingProcess } from "./docling-process";
import { pdfParserProfile } from "./ocr-health";
import type { ParserRunner } from "./types";

export const DEFAULT_PDF_SEGMENT_PAGES = 10;
export const DEFAULT_PDF_SEGMENT_TIMEOUT_SECONDS = 240;
export const PDF_EXECUTION_POLL_MS = 1_000;
export const MAX_PDF_BOOK_PAGES = 2_000;
export const MAX_PDF_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_PAGE_TEXT_BYTES = 1024 * 1024;
export const MAX_PDF_PAGE_TEXT_LENGTH = 200_020;
export const MAX_PDF_BOOK_BYTES = 64 * 1024 * 1024;

export type AcademicDiscourseKind =
  | "definition"
  | "theorem"
  | "proof"
  | "worked_example"
  | "exercise"
  | "solution_sealed"
  | "narrative"
  | "figure_caption";

export type DiscourseVisibilityHint = "public" | "hint_gated" | "sealed";

export type PdfDiscourseBlock = {
  kind: AcademicDiscourseKind;
  text: string;
  pageNumber: number;
  charStart: number;
  charEnd: number;
  continuedFromPrevPage: boolean;
  continuesOnNextPage: boolean;
  visibilityHint: DiscourseVisibilityHint;
  associatedVisualKind?: "formula" | "table" | "picture" | null;
  captionRef?: string | null;
};

export type PdfSegmentBatch = {
  pageStart: number;
  pageEnd: number;
  pages: PdfSegmentPage[];
  cached: boolean;
  segmentBytes: number;
};

export type PdfSegmentParseResult = { pageCount: number; failedRanges: string[] };

function parseInspectOutput(stdout: string): { pageCount?: unknown } {
  const start = stdout.indexOf("{");
  return JSON.parse(start < 0 ? stdout : stdout.slice(start)) as { pageCount?: unknown };
}

function validatePositiveBound(value: number | undefined, fallback: number, min: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw new RangeError(`invalid ${label}`);
  return resolved;
}

/** Serial polling is only a prompt cancellation signal. Each cache/chunk write
 * still locks and checks the execution transactionally, including the last gap. */
export async function watchPdfExecution(assertCurrent: () => Promise<void>, pollMs = PDF_EXECUTION_POLL_MS) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending: Promise<void> | undefined;
  const check = async () => {
    try { await assertCurrent(); }
    catch (error) { controller.abort(error); }
  };
  await check();
  const schedule = () => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => { pending = check().then(schedule); }, pollMs);
    timer.unref();
  };
  schedule();
  return { signal: controller.signal, async stop() { stopped = true; clearTimeout(timer); await pending; } };
}

export async function parsePdfSegments(input: {
  path: string; sourceId: string; sourceVersion: number; scope: OpeningScope;
  runner: ParserRunner; segments?: OpeningPdfSegmentsRepository; signal: AbortSignal;
  onPages?: (pages: PdfSegmentPage[]) => void | Promise<void>;
  onSegment?: (segment: PdfSegmentBatch) => void | Promise<void>;
  segmentPages?: number; timeoutSeconds?: number; parserProfile?: string;
  maxPages?: number; maxSegmentBytes?: number; maxPageTextBytes?: number; maxBookBytes?: number;
}): Promise<PdfSegmentParseResult> {
  if (!input.onPages && !input.onSegment) throw new TypeError("PDF segment consumer callback is required");
  const size = input.segmentPages ?? DEFAULT_PDF_SEGMENT_PAGES;
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_PDF_SEGMENT_TIMEOUT_SECONDS;
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new RangeError("invalid PDF segment bounds");
  }
  const maxPages = validatePositiveBound(input.maxPages, MAX_PDF_BOOK_PAGES, 1, MAX_PDF_BOOK_PAGES, "PDF book page bound");
  const maxSegmentBytes = validatePositiveBound(input.maxSegmentBytes, MAX_PDF_SEGMENT_BYTES, 1024, MAX_PDF_SEGMENT_BYTES, "PDF segment byte bound");
  const maxPageTextBytes = validatePositiveBound(input.maxPageTextBytes, MAX_PDF_PAGE_TEXT_BYTES, 1024, MAX_PDF_SEGMENT_BYTES, "PDF page text byte bound");
  const maxBookBytes = validatePositiveBound(input.maxBookBytes, MAX_PDF_BOOK_BYTES, 1024, MAX_PDF_BOOK_BYTES, "PDF book byte bound");

  input.signal.throwIfAborted();
  const inspectionSignal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const inspected = await input.runner(
    ["-m", "opening_parser", "--input", input.path, "--mime", "application/pdf", "--max-pages", String(maxPages), "--inspect-pdf"],
    inspectionSignal,
  );
  inspectionSignal.throwIfAborted();
  if (inspected.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
  if (inspected.exitCode !== 0) throw new ConversionFailedError("document conversion failed during PDF inspection");
  const { pageCount } = parseInspectOutput(inspected.stdout);
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new RangeError("invalid PDF page count");
  }
  if (pageCount > maxPages) {
    throw new BoundsExceededError(`PDF page count (${pageCount}) exceeds max (${maxPages})`);
  }

  const parser = createDoclingProcess({ run: input.runner });
  let cumulativeBookBytes = 0;

  const validateSegment = (rawPages: unknown, start: number, end: number) => {
    let segmentTextBytes = 0;
    if (Array.isArray(rawPages)) {
      for (const rawPage of rawPages) {
        if (!rawPage || typeof rawPage !== "object") continue;
        const row = rawPage as Record<string, unknown>;
        if (typeof row.text !== "string") continue;
        if (row.text.length > MAX_PDF_PAGE_TEXT_LENGTH) {
          throw new BoundsExceededError(`PDF page ${String(row.page ?? "?")} exceeds text length limit (${row.text.length} > ${MAX_PDF_PAGE_TEXT_LENGTH})`);
        }
        const pageBytes = Buffer.byteLength(row.text, "utf8");
        if (pageBytes > maxPageTextBytes) {
          throw new BoundsExceededError(`PDF page ${String(row.page ?? "?")} exceeds per-page text byte limit (${pageBytes} > ${maxPageTextBytes})`);
        }
        segmentTextBytes += pageBytes;
      }
      if (cumulativeBookBytes + segmentTextBytes > maxBookBytes) {
        throw new BoundsExceededError(`PDF whole-book UTF-8 bytes exceed limit (${cumulativeBookBytes + segmentTextBytes} > ${maxBookBytes})`);
      }
    }
    const pages = validatePdfSegmentPages(rawPages, start, end);
    const segmentBytes = Buffer.byteLength(JSON.stringify({ pages }), "utf8");
    if (segmentBytes > maxSegmentBytes) {
      throw new BoundsExceededError(`PDF segment ${start}-${end} exceeds per-segment byte limit (${segmentBytes} > ${maxSegmentBytes})`);
    }
    return { pages, segmentBytes, segmentTextBytes };
  };

  const emitSegment = async (pageStart: number, pageEnd: number, pages: PdfSegmentPage[], cached: boolean, segmentBytes: number) => {
    await input.onSegment?.({ pageStart, pageEnd, pages, cached, segmentBytes });
    await input.onPages?.(pages);
  };

  // Enforce the 8 MiB serialized payload cap per individual segment while streaming
  // segments sequentially so 500-2,000 page books stay bounded in worker memory.
  let parsedPageCount = 0;
  const failed: string[] = [];
  for (let start = 1; start <= pageCount; start += size) {
    input.signal.throwIfAborted();
    const end = Math.min(pageCount, start + size - 1);
    const identity = {
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      parserProfile: input.parserProfile ?? pdfParserProfile(),
      pageStart: start,
      pageEnd: end,
    };
    const cached = await input.segments?.read(input.scope, identity);
    input.signal.throwIfAborted();
    if (cached?.state === "ready") {
      const validated = validateSegment(cached.pages, start, end);
      cumulativeBookBytes += validated.segmentTextBytes;
      await emitSegment(start, end, validated.pages, true, validated.segmentBytes);
      parsedPageCount += validated.pages.length;
      continue;
    }
    let parsed: { pages: PdfSegmentPage[]; segmentBytes: number; segmentTextBytes: number } | undefined;
    let error: unknown;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      input.signal.throwIfAborted();
      try {
        const rawPages = await parser.parseDocument({
          path: input.path,
          mime: "application/pdf",
          maxPages,
          pageStart: start,
          pageEnd: end,
          timeoutSeconds,
        }, input.signal);
        parsed = validateSegment(rawPages, start, end);
      } catch (caught) {
        if (caught instanceof BoundsExceededError || caught instanceof UnsupportedMimeError || caught instanceof UsageError || input.signal.aborted) {
          throw caught;
        }
        error = caught;
      }
    }
    if (!parsed) {
      // A cancelled/revoked/old execution must not even write a failed segment.
      input.signal.throwIfAborted();
      const errorCode = error instanceof Error && error.name === "TimeoutError" ? "timeout"
        : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? "invalid_output" : "conversion_failed";
      await input.segments?.save(input.scope, identity, { state: "failed", errorCode }, input.signal);
      failed.push(`${start}-${end}`);
      continue;
    }
    input.signal.throwIfAborted();
    await input.segments?.save(input.scope, identity, { state: "ready", pages: parsed.pages }, input.signal);
    input.signal.throwIfAborted();
    cumulativeBookBytes += parsed.segmentTextBytes;
    await emitSegment(start, end, parsed.pages, false, parsed.segmentBytes);
    parsedPageCount += parsed.pages.length;
  }
  input.signal.throwIfAborted();
  if (!parsedPageCount) throw new ConversionFailedError(`PDF segments failed (${failed.join(", ")})`);
  return { pageCount: parsedPageCount, failedRanges: failed };
}
