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
  discourseBlocks?: ReadonlyArray<Partial<PdfDiscourseBlock>>;
};

type SealState = {
  mode: "none" | "section_sealed" | "inline_sealed";
  inWorkedExample: boolean;
};

const HEADING_PREFIX_RE = /^(?:#{1,6}\s+|\*\*|__)+/u;

const SECTION_SEALED_RE = new RegExp(
  "^(?:" +
  "(?:Answer\\s+Key|ANSWER\\s+KEY|Answers?\\s+Key|Key\\s+to\\s+(?:the\\s+)?(?:Exercises|Problems|Questions)|KEY\\s+TO\\s+(?:THE\\s+)?(?:EXERCISES|PROBLEMS|QUESTIONS))(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*(?:[:：]|$)" +
  "|(?:Answers?|ANSWERS?|Solutions?|SOLUTIONS?)\\s+to\\s+(?:(?:Selected|Odd-Numbered|Even-Numbered|All|Chapter\\s+\\d+|Section\\s+\\d+(?:\\.\\d+)*)\\s+)*(?:Exercises?|Problems?|Questions?|Review\\s+Questions?|Practice\\s+Problems?)(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*(?:[:：]|$)" +
  "|(?:Selected\\s+Answers?|SELECTED\\s+ANSWERS?|Model\\s+Answers?|MODEL\\s+ANSWERS?|Official\\s+Solutions?|OFFICIAL\\s+SOLUTIONS?|Reference\\s+Solutions?|REFERENCE\\s+SOLUTIONS?|Answer\\s+Section|ANSWER\\s+SECTION|Solutions?\\s+Manual|SOLUTIONS?\\s+MANUAL)(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*(?:[:：]|$)" +
  "|(?:Answers|ANSWERS)(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*(?:[:：]|$)" +
  "|【\\s*(?:参考答案|标准答案|习题答案|练习答案|课后答案|课后习题答案|答案与解析|参考解答|详细解答|参考答案与解析)\\s*】\\s*$" +
  "|(?:参考答案|标准答案|习题答案|练习答案|课后答案|课后习题答案|答案与解析|参考解答|详细解答|参考答案与解析)(?:\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\)))?\\s*(?:[:：]|$)" +
  "|(?:习题\\s*)?(?:答案|解答)(?:\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\)))?\\s*(?:[:：]|$)" +
  ")",
  "u",
);
const INLINE_WITH_BODY_RE = /[:：]\s*\S/u;
const QUALIFIED_MULTI_SECTION_RE = /^(?:Answers?\s+to\s+|Selected\s+Answers?|Model\s+Answers?|Official\s+Solutions?|Reference\s+Solutions?|Solutions?\s+to\s+|Solutions?\s+Manual|Key\s+to\s+|参考答案与解析|答案与解析|课后习题答案|习题答案)/u;

const INLINE_SEALED_ALWAYS_RE = new RegExp(
  "^(?:" +
  "(?:Answer\\s+Key|ANSWER\\s+KEY|Official\\s+Answer|OFFICIAL\\s+ANSWER|Model\\s+Answer|MODEL\\s+ANSWER|Correct\\s+Answer|CORRECT\\s+ANSWER|Answer|ANSWER|Answers|ANSWERS)(?:\\s+\\d+(?:\\.\\d+)*)?(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*[:：]" +
  "|【\\s*(?:参考答案|标准答案|正确答案|答案)\\s*】" +
  "|(?:参考答案|标准答案|正确答案|习题答案|答案)\\s*(?:\\d+(?:[.\\-]\\d+)*)?\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\))?\\s*[:：]" +
  ")",
  "u",
);

const INLINE_SEALED_NON_EXAMPLE_RE = new RegExp(
  "^(?:" +
  "(?:Worked\\s+Solution|WORKED\\s+SOLUTION|Full\\s+Solution|FULL\\s+SOLUTION|Sample\\s+Solution|SAMPLE\\s+SOLUTION|Solution|SOLUTION|Solutions|SOLUTIONS)(?:\\s+to\\s+(?:Exercise|Problem|Question)\\s*\\d*(?:\\.\\d+)*)?(?:\\s+\\d+(?:\\.\\d+)*)?(?:\\s*\\(\\s*(?:continued|cont\\.?)\\s*\\))?\\s*[:：]" +
  "|【\\s*(?:参考解答|详细解答|解答|详解|解析)\\s*】" +
  "|(?:参考解答|详细解答|解答|详解|解析|解)\\s*(?:\\d+(?:[.\\-]\\d+)*)?\\s*(?:（续）|\\(续\\)|（接上页）|\\(接上页\\))?\\s*[:：]" +
  ")",
  "u",
);

const WORKED_EXAMPLE_RE = /^(?:(?:Worked\s+Example|Example)(?:\s+\d+(?:[.-]\d+)*(?:\s*\([^)]+\))?(?:\s*[:：.\-—]|\s+|$)|(?:\s*\([^)]+\))?\s*(?:[:：.\-—]|$))|例题(?:\s*\d+(?:[.-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*[:：.．\-—]|\s+|$)|\s*(?:[:：.．\-—]|$))|例(?:\s*\d+(?:[.-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*[:：.．\-—]|\s+|$)|\s*[:：]))/u;
const WORKED_EXAMPLE_INTERNAL_RE = /^(?:(?:Worked\s+Solution|WORKED\s+SOLUTION|Solution|SOLUTION|Proof|PROOF)(?:\s*\(\s*(?:continued|cont\.?)\s*\))?\s*[:：]|(?:解答|证明|证|解|分析)\s*[:：]|【\s*(?:解答|证明|证|解|分析)\s*】)/u;
const PUBLIC_BLOCK_OPENER_RE = /^(?:(?:Definition|Notation|Terminology|Convention|Theorem|Lemma|Proposition|Corollary|Axiom|Conjecture|Claim|Proof|Exercises?|Practice\s+Problems?|Problem\s+\d+|Question\s+\d+|Chapter\s+\d+|Section\s+\d+|Part\s+\d+|Figure\s+\d+|Fig\.?\s+\d+|Table\s+\d+)\b|(?:定义|定理|引理|推论|命题|公理|猜想|证明|习题|练习题|练习|思考题|作业题|图\s*\d+|表\s*\d+|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部分])|#{1,6}\s+\S|\d+(?:\.\d+)+\s+\S)/u;
const MAJOR_NON_ANSWER_HEADING_RE = /^(?:(?:Bibliography|References|Works\s+Cited|Index|Subject\s+Index|Author\s+Index|Glossary|Notation\s+Index|Acknowledgements?|About\s+the\s+Authors?)|(?:参考文献|索引|名词索引|主题索引|符号表|后记|致谢)|Appendix\s+[A-Z0-9]+(?:\s*[:.\-—]\s*(?!.*(?:Answer|Solution)).*)?$|附录\s*[A-Z0-9一二三四五六七八九十]+(?:\s*[:：.\-—]\s*(?!.*(?:答案|解答)).*)?$)(?:\s*[:：.\-—]|$)/iu;
const SECTION_SEALED_TERMINATOR_RE = /(?:End\s+of\s+(?:Answers?|Solutions?)|答案完|解答完)\s*[.。]?\s*$/iu;
const INLINE_SEALED_TERMINATOR_RE = /(?:[□■∎]|End\s+of\s+Answers?|答案完|解答完)\s*[.。]?\s*$/iu;

function isSectionSealedHeader(stripped: string): boolean {
  if (!SECTION_SEALED_RE.test(stripped)) return false;
  if (INLINE_WITH_BODY_RE.test(stripped)) return QUALIFIED_MULTI_SECTION_RE.test(stripped);
  return true;
}

function stripSealedSolutionLines(text: string, state: SealState): string {
  const lines = text.split(/\r?\n/u);
  const kept: string[] = [];
  let changed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (state.mode === "inline_sealed") {
        state.mode = "none";
        changed = true;
      } else if (state.mode === "section_sealed") {
        changed = true;
      } else {
        kept.push(line);
      }
      continue;
    }

    const stripped = trimmed.replace(HEADING_PREFIX_RE, "");

    if (state.mode === "section_sealed") {
      if (MAJOR_NON_ANSWER_HEADING_RE.test(stripped)) {
        state.mode = "none";
        state.inWorkedExample = false;
        kept.push(line);
      } else {
        changed = true;
        if (SECTION_SEALED_TERMINATOR_RE.test(trimmed)) state.mode = "none";
      }
      continue;
    }

    if (isSectionSealedHeader(stripped)) {
      state.mode = "section_sealed";
      state.inWorkedExample = false;
      changed = true;
      if (SECTION_SEALED_TERMINATOR_RE.test(trimmed)) state.mode = "none";
      continue;
    }

    if (INLINE_SEALED_ALWAYS_RE.test(stripped)) {
      state.mode = "inline_sealed";
      state.inWorkedExample = false;
      changed = true;
      if (INLINE_SEALED_TERMINATOR_RE.test(trimmed)) state.mode = "none";
      continue;
    }

    if (state.inWorkedExample && WORKED_EXAMPLE_INTERNAL_RE.test(stripped)) {
      kept.push(line);
      continue;
    }

    if (!state.inWorkedExample && INLINE_SEALED_NON_EXAMPLE_RE.test(stripped)) {
      state.mode = "inline_sealed";
      changed = true;
      if (INLINE_SEALED_TERMINATOR_RE.test(trimmed)) state.mode = "none";
      continue;
    }

    if (WORKED_EXAMPLE_RE.test(stripped)) {
      state.mode = "none";
      state.inWorkedExample = true;
      kept.push(line);
      continue;
    }

    if (PUBLIC_BLOCK_OPENER_RE.test(stripped) || MAJOR_NON_ANSWER_HEADING_RE.test(stripped)) {
      state.mode = "none";
      state.inWorkedExample = false;
      kept.push(line);
      continue;
    }

    if (state.mode === "inline_sealed") {
      changed = true;
      if (INLINE_SEALED_TERMINATOR_RE.test(trimmed)) state.mode = "none";
      continue;
    }

    kept.push(line);
  }

  if (!changed) return text;
  while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
  return kept.join("\n");
}

function sealTextWithState(
  rawText: string,
  state: SealState,
  pageNumber?: number,
  discourseBlocks?: AnnotatedParsedPage["discourseBlocks"],
): string {
  let text = rawText;
  if (Array.isArray(discourseBlocks) && discourseBlocks.length > 0 && text.length > 0) {
    const codePoints = Array.from(text);
    const spans: Array<[number, number]> = [];
    for (const block of discourseBlocks) {
      if (typeof block.pageNumber === "number" && pageNumber !== undefined && block.pageNumber !== pageNumber) continue;
      if (block.kind !== "solution_sealed" && block.visibilityHint !== "sealed") continue;
      const start = block.charStart;
      const end = block.charEnd;
      if (typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= codePoints.length) {
        if (typeof block.text === "string" && codePoints.slice(start, end).join("") !== block.text) continue;
        spans.push([start, end]);
      }
    }
    if (spans.length > 0) {
      spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let cursor = 0;
      const parts: string[] = [];
      for (const [start, end] of spans) {
        if (start > cursor) parts.push(codePoints.slice(cursor, start).join(""));
        cursor = Math.max(cursor, end);
      }
      if (cursor < codePoints.length) parts.push(codePoints.slice(cursor).join(""));
      text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return stripSealedSolutionLines(text, state);
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
      const preparePage = (rawPage: AnnotatedParsedPage, saved: NewSourceChunk | undefined, sealState: SealState) => {
        const hadRawText = Boolean(rawPage.text.trim());
        const doclingSealedBlank = isPdf && rawPage.text === "" && Array.isArray(rawPage.visualKinds) && rawPage.visualKinds.length === 0;
        if (doclingSealedBlank) {
          sealState.mode = "section_sealed";
          sealState.inWorkedExample = false;
        }
        const incomingSeal: SealState = { ...sealState };
        const publicText = !isImage
          ? sealTextWithState(rawPage.text, sealState, rawPage.page, rawPage.discourseBlocks)
          : rawPage.text;
        const sealedAllText = !isImage && ((hadRawText && !publicText.trim()) || doclingSealedBlank);
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
        let sanitizedSaved: NewSourceChunk | undefined;
        if (!sealedAllText && saved) {
          if (!isImage && saved.text.trim()) {
            const sealedSavedText = sealTextWithState(saved.text, { ...incomingSeal });
            if (sealedSavedText.trim()) {
              sanitizedSaved = sealedSavedText === saved.text ? saved : { ...saved, text: sealedSavedText };
            } else if (saved.imageObjectKey) {
              // Stale saved chunk whose text was 100% sealed must not resurface via image/text reuse.
              sanitizedSaved = undefined;
            }
          } else {
            sanitizedSaved = saved;
          }
        }
        const reusable = sanitizedSaved && (!visual || sanitizedSaved.imageObjectKey) ? sanitizedSaved : undefined;
        return { page, visual, saved: sanitizedSaved, reusable, pageSealState: { ...sealState }, sealedAllText };
      };
      const consumePage = async ({ page, visual, saved, reusable, pageSealState, sealedAllText }: ReturnType<typeof preparePage>,
        recognizePage: ((input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult | null>) | undefined =
          visualRecognitionUnavailable ? undefined : deps.recognizePage,
      ): Promise<NewSourceChunk | undefined> => {
        signal.throwIfAborted();
        if (sealedAllText) return undefined;
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
            const sealedVisionText = !isImage ? sealTextWithState(result.text, { ...pageSealState }) : result.text;
            if (!isImage && !sealedVisionText.trim()) {
              if (!page.text.trim()) return undefined;
            } else {
              const extractionLabel = visual.visualKinds.includes("scan") ? "本地提取（可能含OCR）" : "原生提取";
              const nativeHeader = page.text ? `[${extractionLabel}]\n` : "";
              const visionHeader = "[视觉转写与描述]\n";
              const nativeLength = page.text ? nativeHeader.length + page.text.length + 2 : 0;
              if (isPdf && nativeLength + visionHeader.length + sealedVisionText.length > PDF_CHUNK_TEXT_LIMIT) {
                cappedTextPages.add(page.page);
                if (saved?.text.trim()) return saved;
                if (!page.text.trim()) {
                  text = visionHeader + sealedVisionText;
                  imageObjectKey = result.imageObjectKey;
                }
              } else {
                text = `${page.text ? `${nativeHeader}${page.text}\n\n` : ""}${visionHeader}${sealedVisionText}`;
                imageObjectKey = result.imageObjectKey;
              }
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
        const pdfSealState: SealState = { mode: "none", inWorkedExample: false };
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
            const prepared = pages.map(page => preparePage(page, published.get(page.page), pdfSealState));
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
        const docSealState: SealState = { mode: "none", inWorkedExample: false };
        const chunks: NewSourceChunk[] = [];
        for (const page of pages) {
          const chunk = await consumePage(preparePage(page, undefined, docSealState));
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
