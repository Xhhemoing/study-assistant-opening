import { validatePdfSegmentPages, type OpeningPdfSegmentsRepository, type OpeningScope, type PdfSegmentPage, type PdfSegmentIdentity } from "@aistudy/database";
import { BoundsExceededError, ConversionFailedError } from "./docling-process";
import { pdfParserProfile } from "./ocr-health";
import type { ParserRunner } from "./types";

export const DEFAULT_PDF_SEGMENT_PAGES = 5;
export const DEFAULT_PDF_SEGMENT_TIMEOUT_SECONDS = 240;
export const PDF_EXECUTION_POLL_MS = 1_000;

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
}): Promise<PdfSegmentPage[]> {
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
  const identities: PdfSegmentIdentity[] = [];
  const missing: PdfSegmentIdentity[] = [];
  const completed = new Map<number, PdfSegmentPage[]>();
  let outputBytes = 0;
  const accept = (identity: PdfSegmentIdentity, pages: PdfSegmentPage[]) => {
    outputBytes += Buffer.byteLength(JSON.stringify(pages));
    if (outputBytes > 8 * 1024 * 1024) throw new BoundsExceededError("combined PDF output exceeds capture bound");
    completed.set(identity.pageStart, pages);
  };
  // Finish all cache reads before starting the single converter. Cache reads and
  // each subsequent save retain the repository's authoritative execution fence.
  for (let start = 1; start <= Number(pageCount); start += size) {
    input.signal.throwIfAborted();
    const end = Math.min(Number(pageCount), start + size - 1);
    const identity = { sourceId: input.sourceId, sourceVersion: input.sourceVersion,
      parserProfile: input.parserProfile ?? pdfParserProfile(), pageStart: start, pageEnd: end };
    identities.push(identity);
    const cached = await input.segments?.read(input.scope, identity);
    input.signal.throwIfAborted();
    if (cached?.state === "ready") accept(identity, validatePdfSegmentPages(cached.pages, start, end));
    else missing.push(identity);
  }
  if (missing.length) {
    // Measured converter creation: 45–50s, PDF pipeline warmup: ~40s.
    // Both are outside range timers; allow extra startup time under load.
    const startupMs = 240_000;
    const budgetMs = startupMs + missing.length * Math.ceil(timeoutSeconds * 1000);
    if (!Number.isSafeInteger(budgetMs) || budgetMs > 24 * 60 * 60 * 1000) throw new RangeError("PDF execution budget exceeds one day");
    const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(budgetMs)]);
    const argv = ["-m", "opening_parser", "--input", input.path, "--mime", "application/pdf", "--max-pages", "2000",
      "--timeout-seconds", String(timeoutSeconds), "--ranges", missing.map(i => `${i.pageStart}-${i.pageEnd}`).join(",")];
    let received = 0;
    const failed: string[] = [];
    const result = await input.runner(argv, deadline, { onLine: async line => {
      deadline.throwIfAborted();
      const identity = missing[received];
      const value: unknown = JSON.parse(line);
      if (!identity || !value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("unexpected PDF range output");
      const row = value as Record<string, unknown>;
      if (!Array.isArray(row.range) || row.range.length !== 2 || row.range[0] !== identity.pageStart || row.range[1] !== identity.pageEnd) {
        throw new TypeError("out-of-order, duplicate or unrequested PDF range");
      }
      if ("error" in row) {
        if ("pages" in row || typeof row.error !== "string" || !["timeout", "invalid_output", "conversion_failed"].includes(row.error)) throw new TypeError("invalid PDF range error");
        // Do not catch save failures: a lost claim/privacy/version fence must
        // terminate the stream, not be rewritten as an ordinary failed segment.
        await input.segments?.save(input.scope, identity, { state: "failed", errorCode: row.error as "timeout" | "invalid_output" | "conversion_failed" }, input.signal);
        failed.push(`${identity.pageStart}-${identity.pageEnd}`);
        // A timed-out Python converter can retain executor/native threads or
        // descendants. The runner kills its process group on callback failure;
        // do not wait out the entire remaining batch deadline after this receipt.
        if (row.error === "timeout") throw new ConversionFailedError(`PDF segments failed (${failed.join(", ")}); retry reuses completed segments`);
      } else {
        const pages = validatePdfSegmentPages(row.pages, identity.pageStart, identity.pageEnd);
        accept(identity, pages);
        await input.segments?.save(input.scope, identity, { state: "ready", pages }, input.signal);
      }
      deadline.throwIfAborted();
      received++;
    } });
    deadline.throwIfAborted();
    if (result.exitCode === 5) throw new BoundsExceededError("parser bounds exceeded");
    if (result.exitCode !== 0 || failed.length || received !== missing.length) {
      throw new ConversionFailedError(`PDF segments failed (${failed.join(", ") || "process failure or missing ranges"}); retry reuses completed segments`);
    }
  }
  input.signal.throwIfAborted();
  return identities.flatMap(identity => completed.get(identity.pageStart)!);
}
