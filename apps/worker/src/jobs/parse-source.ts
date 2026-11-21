import { OpeningModelRoutingError } from "@aistudy/ai";
import { openingJobScope } from "@aistudy/database";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { OpeningJobRecord } from "@aistudy/database";
import type { OpeningSourceRepository } from "@aistudy/database";
import { createDoclingProcess, UnsupportedMimeError, ConversionFailedError } from "../parsers/docling-process";
import { markdownChunks } from "./markdown-chunks";
import { htmlChunks } from "./html-chunks";
import type { ParserRunner, ParsedPage, VisualPageKind } from "../parsers/types";
import type { OpeningScope } from "@aistudy/database";
import type { NewSourceChunk, OpeningPdfChunkPublisher, OpeningSourceChunksRepository } from "@aistudy/database";
import type { OpeningPdfSegmentsRepository } from "@aistudy/database";
import { parsePdfSegments, watchPdfExecution, type PdfDiscourseBlock } from "../parsers/pdf-segments";
import { checkPdfPageQuality } from "../parsers/pdf-page-quality";
import { createPdfPartialError } from "./pdf-partial-error";

export class UnsupportedSourceError extends Error { readonly code = "UNSUPPORTED_SOURCE"; }
const IMAGE_SOURCE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
// The database checks code points. Bounding UTF-16 units also bounds code points.
const PDF_CHUNK_TEXT_LIMIT = 100_000;
type Storage = { presignGet(key: string, input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string }): Promise<string>; finalKey(id: string, version: number): string };
type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState">;

type AnnotatedParsedPage = ParsedPage & {
  discourseBlocks?: ReadonlyArray<Partial<PdfDiscourseBlock> & {
    visibility_hint?: unknown;
    page_number?: unknown;
    char_start?: unknown;
    char_end?: unknown;
  }>;
};

const SEALED_HEADING_RE = new RegExp(
  "^(?:#{1,6}\\s+|\\*\\*|__)*(?:" +
  "(?:Answer\\s+Key|Answers?\\s+to\\s+(?:Exercises?|Problems?|Selected\\s+(?:Exercises?|Problems?)|Odd-Numbered\\s+(?:Exercises?|Problems?))|Selected\\s+Answers?|Model\\s+Answers?|Key\\s+to\\s+Exercises?)\\b(?:\\s*(?:\\(\\s*continued\\s*\\))?\\s*(?:[:：.\\-—]|$))?" +
  "|(?:Answer|Answers)\\s*(?:\\d+(?:\\.\\d+)*)?\\s*(?:\\(\\s*continued\\s*\\))?\\s*(?:[:：.\\-—]|$)" +
  "|(?:(?:Worked|Full|Official|Reference|Sample)\\s+)?Solutions?(?:\\s+to\\s+(?:Exercises?|Problems?|Questions?)?(?:\\s*\\d+(?:\\.\\d+)*)?)?\\s*(?:\\(\\s*continued\\s*\\))?\\s*(?:\\d+(?:\\.\\d+)*)?\\s*(?:[:：.\\-—]|$)" +
  "|【\\s*(?:参考答案|标准答案|习题答案|练习答案|课后答案|答案与解析|参考解答|详细解答|答案|解答|详解|解析)\\s*】" +
  "|(?:参考答案|标准答案|习题答案|练习答案|课后答案|答案与解析|参考解答|详细解答)\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\))?\\s*(?:[:：.．、\\-—]|$)" +
  "|(?:答案|解答|详解|解析)\\s*(?:\\d+(?:[.\\-]\\d+)*)?\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\))?\\s*(?:[:：.．、\\-—]|$)" +
  "|解\\s*(?:\\d+(?:[.\\-]\\d+)*)?\\s*[:：]" +
  ")",
  "iu",
);

const PUBLIC_SECTION_RE = new RegExp(
  "^(?:#{1,6}\\s+|\\*\\*|__)*(?:" +
  "(?:Definition|Notation|Terminology|Theorem|Lemma|Proposition|Corollary|Axiom|Example|Worked\\s+Example|Exercises?|Practice\\s+Problems?|Problem\\s+\\d+|Question\\s+\\d+|Chapter\\s+\\d+|Section\\s+\\d+|Part\\s+\\d+|Appendix\\s+\\d+|Figure\\s+\\d+|Fig\\.?\\s+\\d+|Table\\s+\\d+)\\b" +
  "|(?:定义|定理|引理|推论|命题|公理|例题|例\\s*\\d+|例\\s*[:：]|习题|练习题|练习|思考题|作业题|图\\s*\\d+|表\\s*\\d+|第\\s*[一二三四五六七八九十百千\\d]+\\s*[章节篇部分])" +
  "|#{1,6}\\s+\\S" +
  "|\\d+(?:\\.\\d+)+\\s+\\S" +
  ")",
  "iu",
);

const SEALED_TERMINATOR_RE = /(?:[□■∎]|答案完|解答完)\s*$/u;

function stripSealedSolutionLines(text: string): string {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  let inSealed = false;
  let changed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!inSealed) kept.push(line);
      else changed = true;
      continue;
    }
    if (SEALED_HEADING_RE.test(trimmed)) {
      inSealed = true;
      changed = true;
      if (SEALED_TERMINATOR_RE.test(trimmed)) inSealed = false;
      continue;
    }
    if (inSealed) {
      if (PUBLIC_SECTION_RE.test(trimmed)) {
        inSealed = false;
        kept.push(line);
      } else {
        changed = true;
        if (SEALED_TERMINATOR_RE.test(trimmed)) inSealed = false;
      }
      continue;
    }
    kept.push(line);
  }
  if (!changed) return text;
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n");
}

function sealPdfPageText(page: AnnotatedParsedPage): string {
  let text = page.text;
  if (Array.isArray(page.discourseBlocks) && page.discourseBlocks.length > 0) {
    const spans: Array<[number, number]> = [];
    for (const block of page.discourseBlocks) {
      const blockPage = block.pageNumber ?? block.page_number;
      if (typeof blockPage === "number" && blockPage !== page.page) continue;
      const hint = block.visibilityHint ?? block.visibility_hint;
      if (block.kind !== "solution_sealed" && hint !== "sealed") continue;
      const start = block.charStart ?? block.char_start;
      const end = block.charEnd ?? block.char_end;
      if (typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= text.length) {
        spans.push([start, end]);
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cursor = 0;
      const parts: string[] = [];
      for (const [start, end] of spans) {
        if (start > cursor) parts.push(text.slice(cursor, start));
        cursor = Math.max(cursor, end);
      }
      if (cursor < text.length) parts.push(text.slice(cursor));
      text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return stripSealedSolutionLines(text);
}

function readCappedPdfPages(value: unknown): Set<number> {
  if (Array.isArray(value)) {
    return new Set(value.filter((page): page is number => Number.isInteger(page) && page >= 1 && page <= 2_000));
  }
  // Older partial warnings store only the ranges shown in the reader.
  const ranges = typeof value === "string"
    ? value.match(/(?:^|；)第 (\d{1,4}(?:–\d{1,4})?(?:、\d{1,4}(?:–\d{1,4})?)*)(?: 等共 \d{1,4})? 页达到文本长度上限，已保留原文或截短$/u)?.[1]
    : undefined;
  const pages = new Set<number>();
  for (const range of ranges?.split("、") ?? []) {
    const [start, end = start] = range.split("–").map(Number) as [number, number?];
    for (let page = Math.max(1, start); page <= Math.min(2_000, end); page++) pages.add(page);
  }
  return pages;
}

function trackSourceDownload(source: { bytes: number; sha256?: string | null }) {
  const digest = createHash("sha256");
  let bytes = 0;
  return {
    add(chunk: Uint8Array) {
      bytes += chunk.byteLength;
      if (bytes > source.bytes) throw new Error("source download exceeds declared bytes");
      digest.update(chunk);
    },
    finish() {
      if (bytes !== source.bytes) {
        throw new Error(`source download integrity check failed: expected ${source.bytes} bytes, received ${bytes}`);
      }
      const sha256 = digest.digest("hex");
      if (source.sha256 && sha256 !== source.sha256.toLowerCase()) {
        throw new Error("source download integrity check failed: SHA-256 mismatch");
      }
    },
  };
}

async function* readStagedPdfChunks(file: string, signal: AbortSignal): AsyncGenerator<NewSourceChunk> {
  let pending = "";
  for await (const data of createReadStream(file, { encoding: "utf8", signal })) {
    pending += data;
    let start = 0;
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n", start)) {
      yield JSON.parse(pending.slice(start, end)) as NewSourceChunk;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  if (pending) throw new Error("incomplete PDF chunk staging file");
}

export type ParseSourceVisualPageInput = {
  scope: OpeningScope; job: OpeningJobRecord; sourceId: string; sourceVersion: number;
  physicalPage: number; nativeText: string; visualKinds: VisualPageKind[];
  /** Worker-owned original file, not a parser/model-provided image path. */
  localFilePath: string; mime: string; signal: AbortSignal;
};
export type ParseSourceVisualPageResult = { text: string; imageObjectKey: string };
type RecognizeSourcePage = (input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult>;

export function createParseSourceHandler(deps: { sources: SourceRepo; chunks: Pick<OpeningSourceChunksRepository, "replaceChunks" | "listChunksAtVersion"> & OpeningPdfChunkPublisher; storage: Storage; runner: ParserRunner; tempDir: string;
  segments?: OpeningPdfSegmentsRepository; segmentPages?: number; segmentTimeoutSeconds?: number; executionPollMs?: number;
  recognizePage?: RecognizeSourcePage;
  /** Yields one result per input in physical page order. Null means a cache miss with model routing unavailable. */
  recognizePages?: (inputs: readonly ParseSourceVisualPageInput[], cacheOnly: boolean) => AsyncGenerator<ParseSourceVisualPageResult | null, void, void>;
  assertCurrent?: (scope: OpeningScope, input: { sourceId: string; sourceVersion: number }) => Promise<void>;
  onSourceReady?: (scope: OpeningScope, input: { sourceId: string; sourceVersion: number }) => Promise<void> }) {
  const parser = createDoclingProcess({ run: deps.runner });
  // The parser child runs with cwd=services/parser; a relative tempDir would
  // resolve there and the CLI would reject the input as missing (exit 4).
  const tempDir = path.resolve(deps.tempDir);
  return async (job: OpeningJobRecord, payload: unknown) => {
    const sourceId = (payload as { sourceId?: unknown }).sourceId;
    if (typeof sourceId !== "string") throw new Error("parse payload missing sourceId");
    const scope = openingJobScope(job);
    const source = await deps.sources.get(scope, sourceId, { includePdfTextCap: true });
    if (source.uploadState !== "uploaded") throw new Error("source is not uploaded");
    const expectedVersion = (payload as { sourceVersion?: unknown }).sourceVersion;
    if (expectedVersion !== undefined && expectedVersion !== source.version) throw Object.assign(new Error("source version changed during parse"), { code: "CONFLICT" });
    // Claimed production PDF jobs must have durable recovery and cancellation
    // wiring; legacy direct/test callers without a claim can remain ephemeral.
    if (source.mime === "application/pdf" && job.claimToken && !deps.segments) throw new Error("PDF segment repository is required for claimed parse jobs");
    if (source.mime === "text/markdown" || source.mime === "text/plain" || source.mime === "text/html") {
      const url = await deps.storage.presignGet(deps.storage.finalKey(source.id, source.version), { expiresInSeconds: 900, responseContentDisposition: "attachment", responseCacheControl: "private, no-store" });
      const response = await fetch(url);
      if (!response.ok) throw new Error("source download failed");
      const parts: Uint8Array[] = [];
      const download = trackSourceDownload(source);
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            download.add(value);
            parts.push(value);
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally { reader.releaseLock(); }
      }
      download.finish();
      const text = new TextDecoder().decode(Buffer.concat(parts));
      const chunks = source.mime === "text/html" ? htmlChunks(text) : markdownChunks(text); // plain text uses markdown chunker
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks: chunks.map((chunk) => ({ page: chunk.page, slideLabel: null, startMs: null, endMs: null, text: chunk.text, imageObjectKey: null })) });
      if (deps.onSourceReady) {
        try { await deps.onSourceReady(scope, { sourceId: source.id, sourceVersion: source.version }); } catch { /* best-effort */ }
      }
      return { pages: chunks.length };
    }
    const isImage = IMAGE_SOURCE_MIMES.has(source.mime);
    if (isImage && job.claimToken && !deps.assertCurrent) throw new Error("source execution check is required for claimed image parse jobs");
    // Legacy .ppt and .eml: keep the object stored, but do not claim readable text for tutoring.
    if (source.mime === "application/vnd.ms-powerpoint" || source.mime === "message/rfc822") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true, storedOnly: true };
    }
    if (!isImage && source.mime !== "application/pdf" && source.mime !== "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true };
    }
    const url = await deps.storage.presignGet(deps.storage.finalKey(source.id, source.version), { expiresInSeconds: 900, responseContentDisposition: "attachment", responseCacheControl: "private, no-store" });
    await mkdir(tempDir, { recursive: true });
    const workDir = await mkdtemp(path.join(tempDir, `${source.id}-${source.version}-`));
    const temp = path.join(workDir, "source");
    let execution: Awaited<ReturnType<typeof watchPdfExecution>> | undefined;
    try {
      const assertCurrent = (isImage || source.mime === "application/pdf") && deps.assertCurrent
        ? () => deps.assertCurrent!(scope, { sourceId: source.id, sourceVersion: source.version })
        : source.mime === "application/pdf" && deps.segments
          ? () => deps.segments!.assertCurrent(scope, { sourceId: source.id, sourceVersion: source.version }) : undefined;
      if (assertCurrent) execution = await watchPdfExecution(assertCurrent, deps.executionPollMs);
      const signal = execution?.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error("source download failed");
      const download = trackSourceDownload(source);
      const limited = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try { download.add(chunk); }
          catch (error) { callback(error as Error); return; }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limited, createWriteStream(temp), { signal });
      download.finish();
      signal.throwIfAborted();
      const isPdf = source.mime === "application/pdf";
      let visualRecognitionUnavailable = !deps.recognizePage && !(isPdf && deps.recognizePages);
      const skippedVisionPages: number[] = [];
      const cappedTextPages = new Set<number>();
      const preparePage = (rawPage: AnnotatedParsedPage, saved?: NewSourceChunk) => {
        const hadRawText = Boolean(rawPage.text.trim());
        const publicText = isPdf ? sealPdfPageText(rawPage) : rawPage.text;
        const sealedAllText = isPdf && hadRawText && !publicText.trim();
        const page: ParsedPage = publicText === rawPage.text ? rawPage : { ...rawPage, text: publicText };
        const visualKinds = sealedAllText
          ? []
          : page.visualKinds !== undefined
            ? page.visualKinds
            : !page.text.trim() && (isImage || isPdf)
              ? ["scan" as const]
              : [];
        const visual = (isPdf || isImage) && visualKinds.length > 0
          ? { scope, job, sourceId: source.id, sourceVersion: source.version, physicalPage: page.page,
            nativeText: page.text, visualKinds, localFilePath: temp, mime: source.mime, signal }
          : undefined;
        const reusable = saved && (!visual || saved.imageObjectKey) ? saved : undefined;
        return { page, visual, saved, reusable };
      };
      const consumePage = async ({ page, visual, saved, reusable }: ReturnType<typeof preparePage>,
        recognizePage: ((input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult | null>) | undefined =
          visualRecognitionUnavailable ? undefined : deps.recognizePage,
      ): Promise<NewSourceChunk | undefined> => {
        signal.throwIfAborted();
        if (reusable) return reusable;
        let text = page.text;
        let imageObjectKey: string | null = null;
        if (isImage && !deps.recognizePage) throw new Error(`visual recognition is required for physical page ${page.page}`);
        if (visual && recognizePage) {
          await assertCurrent?.();
          let result: ParseSourceVisualPageResult | null;
          try {
            result = await recognizePage(visual);
          } catch (error) {
            if (!(error instanceof OpeningModelRoutingError)) throw error;
            result = null;
          }
          signal.throwIfAborted();
          await assertCurrent?.();
          if (result === null) {
            visualRecognitionUnavailable = true;
          } else {
            if (!result || typeof result.text !== "string" || !result.text.trim() || typeof result.imageObjectKey !== "string" || !result.imageObjectKey.trim()) throw new Error(`visual recognition returned no readable content or image for physical page ${page.page}`);
            const extractionLabel = visual.visualKinds.includes("scan") ? "本地提取（可能含OCR）" : "原生提取";
            const nativeHeader = page.text ? `[${extractionLabel}]\n` : "";
            const visionHeader = "[视觉转写与描述]\n";
            const nativeLength = page.text ? nativeHeader.length + page.text.length + 2 : 0;
            if (isPdf && nativeLength + visionHeader.length + result.text.length > PDF_CHUNK_TEXT_LIMIT) {
              cappedTextPages.add(page.page);
              if (saved?.text.trim()) return saved;
              if (!page.text.trim()) {
                text = visionHeader + result.text;
                imageObjectKey = result.imageObjectKey;
              }
            } else {
              text = `${page.text ? `${nativeHeader}${page.text}\n\n` : ""}${visionHeader}${result.text}`;
              imageObjectKey = result.imageObjectKey;
            }
          }
        }
        if (isPdf && visual && imageObjectKey === null && !cappedTextPages.has(page.page)) {
          skippedVisionPages.push(page.page);
          if (saved) return saved;
        }
        if (isImage && visualRecognitionUnavailable) imageObjectKey = deps.storage.finalKey(source.id, source.version);
        if (text.trim() || imageObjectKey) return { page: page.page, slideLabel: null, startMs: null, endMs: null, text, imageObjectKey };
      };

      let pageCount: number;
      const publication = { sourceId: source.id, sourceVersion: source.version };
      if (isPdf) {
        const previousCappedPages = readCappedPdfPages(source.pdfTextCap ??
          (source.error?.code === "PARSE_PARTIAL" ? source.error.message : undefined));
        const lowQualityPages: number[] = [];
        const preservePages: number[] = [];
        let usablePages = 0;
        const stagePath = path.join(workDir, "chunks.ndjson");
        const stage = await open(stagePath, "wx", 0o600);
        const result = await parsePdfSegments({ path: temp, ...publication, scope, runner: deps.runner,
          segments: deps.segments, signal, segmentPages: deps.segmentPages, timeoutSeconds: deps.segmentTimeoutSeconds,
          onPages: async pages => {
            // Read only this segment's previously published text, including saved vision.
            const existing = deps.segments
              ? await deps.chunks.listChunksAtVersion(scope, source.id, source.version, pages.map(page => page.page))
              : [];
            const published = new Map(existing.map(({ page, slideLabel, startMs, endMs, text, imageObjectKey }) =>
              [page, { page, slideLabel, startMs, endMs, text, imageObjectKey }]));
            const prepared = pages.map(page => preparePage(page, published.get(page.page)));
            const recognition = deps.recognizePages?.(
              prepared.flatMap(({ visual, reusable }) => visual && !reusable ? [visual] : []), visualRecognitionUnavailable,
            );
            const recognizePage = recognition ? async () => {
              const next = await recognition.next();
              if (next.done) throw new Error("visual recognition batch ended before all pages were recognized");
              return next.value;
            } : undefined;
            try {
              for (const preparedPage of prepared) {
                let chunk = await consumePage(preparedPage, recognizePage);
                if (!chunk) continue;
                const { page, text: nativeText } = preparedPage.page;
                if (chunk === preparedPage.saved &&
                  (previousCappedPages.has(page) ||
                    (nativeText.length > PDF_CHUNK_TEXT_LIMIT && chunk.text.length <= PDF_CHUNK_TEXT_LIMIT))) {
                  cappedTextPages.add(page);
                }
                if (chunk.text.length > PDF_CHUNK_TEXT_LIMIT) {
                  if (chunk === preparedPage.saved) {
                    // Existing rows can fit PostgreSQL's code-point limit but exceed the UTF-16 bound.
                    preservePages.push(page);
                    if (checkPdfPageQuality(chunk.text).quality === "low_quality") lowQualityPages.push(page);
                    usablePages++;
                    continue;
                  }
                  cappedTextPages.add(page);
                  const text = chunk.text.slice(0, PDF_CHUNK_TEXT_LIMIT).replace(/[\uD800-\uDBFF]$/u, "");
                  if (!text.trim() && !chunk.imageObjectKey) continue;
                  chunk = { ...chunk, text };
                }
                if (checkPdfPageQuality(chunk.text).quality === "low_quality") lowQualityPages.push(page);
                await stage.appendFile(`${JSON.stringify(chunk)}\n`, "utf8");
                usablePages++;
              }
            } finally { await recognition?.return(); }
          },
        }).finally(() => stage.close());
        pageCount = result.pageCount;
        for (const range of result.failedRanges) {
          const [start, end] = range.split("-").map(Number) as [number, number];
          for (let page = start; page <= end; page++) {
            preservePages.push(page);
            if (previousCappedPages.has(page)) cappedTextPages.add(page);
          }
        }
        const failedRanges = [...result.failedRanges, ...skippedVisionPages.map(String)];
        const pdfTextCap = [...cappedTextPages];
        const warning = failedRanges.length || lowQualityPages.length || pdfTextCap.length
          ? { ...createPdfPartialError(failedRanges, lowQualityPages, pdfTextCap), ...(pdfTextCap.length ? { pdfTextCap } : {}) }
          : null;
        if (warning && !usablePages) throw new Error(warning.message);
        signal.throwIfAborted();
        await assertCurrent?.();
        await deps.chunks.replacePdfChunks(scope, { ...publication, chunks: readStagedPdfChunks(stagePath, signal), preservePages,
          ...(warning ? { warning } : {}) });
      } else {
        const pages: ParsedPage[] = isImage ? [{ page: 1, text: "", imagePath: null, visualKinds: ["scan"] }]
          : await parser.parseDocument({ path: temp, mime: source.mime, maxPages: 2000 }, signal);
        pageCount = pages.length;
        const chunks: NewSourceChunk[] = [];
        for (const page of pages) {
          const chunk = await consumePage(preparePage(page));
          if (chunk) chunks.push(chunk);
        }
        signal.throwIfAborted();
        await assertCurrent?.();
        await deps.chunks.replaceChunks(scope, { ...publication, chunks });
      }
      if (deps.onSourceReady) {
        try { await deps.onSourceReady(scope, { sourceId: source.id, sourceVersion: source.version }); } catch { /* best-effort */ }
      }
      if (isImage) return { pages: 1, imageOnly: visualRecognitionUnavailable };
      return { pages: pageCount, ...(skippedVisionPages.length ? { warnings: skippedVisionPages.length, degraded: true } : {}) };
    } catch (error) {
      if (error instanceof UnsupportedMimeError) throw new UnsupportedSourceError("unsupported source MIME");
      if (error instanceof ConversionFailedError) throw new Error(`document conversion failed: ${error.message}`);
      throw error;
    } finally {
      try { await execution?.stop(); }
      finally { await rm(workDir, { recursive: true, force: true }); }
    }
  };
}
