import { validatePdfSegmentPages, type OpeningPdfSegmentsRepository, type OpeningScope, type PdfSegmentPage } from "@aistudy/database";
import { BoundsExceededError, ConversionFailedError, createDoclingProcess } from "./docling-process";
import { pdfParserProfile } from "./ocr-health";
import type { ParserRunner } from "./types";

export const DEFAULT_PDF_SEGMENT_PAGES = 10;
export const DEFAULT_PDF_SEGMENT_TIMEOUT_SECONDS = 240;
export const PDF_EXECUTION_POLL_MS = 1_000;

export type PdfSegmentParseResult = PdfSegmentPage[] & { failedRanges: string[] };

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
  segmentPages?: number; timeoutSeconds?: number; parserProfile?: string;
}): Promise<PdfSegmentParseResult> {
  const size = input.segmentPages ?? DEFAULT_PDF_SEGMENT_PAGES;
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_PDF_SEGMENT_TIMEOUT_SECONDS;
  if (!Number.isInteger(size) || size < 1 || size > 100 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new RangeError("invalid PDF segment bounds");
  input.signal.throwIfAborted();
  const inspectionSignal = AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]);
  const inspected = await input.runner(["-m", "opening_parser", "--input", input.path, "--mime", "application/pdf", "--max-pages", "2000", "--inspect-pdf"], inspectionSignal);
  inspectionSignal.throwIfAborted();
  if (inspected.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
  if (inspected.exitCode !== 0) throw new ConversionFailedError("document conversion failed during PDF inspection");
  const { pageCount } = JSON.parse(inspected.stdout) as { pageCount?: unknown };
  if (!Number.isInteger(pageCount) || Number(pageCount) < 1 || Number(pageCount) > 2000) throw new RangeError("invalid PDF page count");
  const parser = createDoclingProcess({ run: input.runner });
  const pages: PdfSegmentPage[] = [];
  let outputBytes = 0;
  const append = (segment: PdfSegmentPage[]) => {
    outputBytes += Buffer.byteLength(JSON.stringify(segment));
    if (outputBytes > 8 * 1024 * 1024) throw new BoundsExceededError("combined PDF output exceeds capture bound");
    pages.push(...segment);
  };
  const failed: string[] = [];
  for (let start = 1; start <= Number(pageCount); start += size) {
    input.signal.throwIfAborted();
    const end = Math.min(Number(pageCount), start + size - 1);
    const identity = { sourceId: input.sourceId, sourceVersion: input.sourceVersion,
      parserProfile: input.parserProfile ?? pdfParserProfile(), pageStart: start, pageEnd: end };
    const cached = await input.segments?.read(input.scope, identity);
    input.signal.throwIfAborted();
    if (cached?.state === "ready") {
      append(validatePdfSegmentPages(cached.pages, start, end));
      continue;
    }
    let parsed: PdfSegmentPage[] | undefined;
    let error: unknown;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        parsed = validatePdfSegmentPages(await parser.parseDocument({ path: input.path, mime: "application/pdf", maxPages: 2000,
          pageStart: start, pageEnd: end, timeoutSeconds }, input.signal), start, end);
      } catch (caught) { error = caught; }
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
    await input.segments?.save(input.scope, identity, { state: "ready", pages: parsed }, input.signal);
    append(parsed);
  }
  input.signal.throwIfAborted();
  if (failed.length && pages.length === 0) throw new ConversionFailedError(`PDF segments failed (${failed.join(", ")})`);
  Object.defineProperty(pages, "failedRanges", { value: failed, enumerable: false });
  return pages as PdfSegmentParseResult;
}
