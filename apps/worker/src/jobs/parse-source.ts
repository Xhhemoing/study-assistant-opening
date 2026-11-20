import { OpeningModelRoutingError } from "@aistudy/ai";
import { openingJobScope } from "@aistudy/database";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
import type { NewSourceChunk, OpeningSourceChunksRepository } from "@aistudy/database";
import type { OpeningPdfSegmentsRepository } from "@aistudy/database";
import { parsePdfSegments, watchPdfExecution } from "../parsers/pdf-segments";
import { checkPdfPageQuality } from "../parsers/pdf-page-quality";
import { createPdfPartialError } from "./pdf-partial-error";

export class UnsupportedSourceError extends Error { readonly code = "UNSUPPORTED_SOURCE"; }
const IMAGE_SOURCE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
type Storage = { presignGet(key: string, input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string }): Promise<string>; finalKey(id: string, version: number): string };
type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState">;

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

export type ParseSourceVisualPageInput = {
  scope: OpeningScope; job: OpeningJobRecord; sourceId: string; sourceVersion: number;
  physicalPage: number; nativeText: string; visualKinds: VisualPageKind[];
  /** Worker-owned original file, not a parser/model-provided image path. */
  localFilePath: string; mime: string; signal: AbortSignal;
};
export type ParseSourceVisualPageResult = { text: string; imageObjectKey: string };

export function createParseSourceHandler(deps: { sources: SourceRepo; chunks: OpeningSourceChunksRepository; storage: Storage; runner: ParserRunner; tempDir: string;
  segments?: OpeningPdfSegmentsRepository; segmentPages?: number; segmentTimeoutSeconds?: number; executionPollMs?: number;
  recognizePage?: (input: ParseSourceVisualPageInput) => Promise<ParseSourceVisualPageResult>;
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
    const source = await deps.sources.get(scope, sourceId);
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
      const chunks: NewSourceChunk[] = [];
      // Durable PDF pages already published at this version include any visual
      // transcription. Reuse them rather than recognizing successful pages again.
      const published = new Map<number, NewSourceChunk[]>();
      if (isPdf && deps.segments) {
        for (const chunk of await deps.chunks.listChunksAtVersion(scope, source.id, source.version)) {
          if (chunk.page == null) continue;
          const saved = published.get(chunk.page) ?? [];
          saved.push({ page: chunk.page, slideLabel: chunk.slideLabel ?? null,
            startMs: chunk.startMs, endMs: chunk.endMs, text: chunk.text, imageObjectKey: chunk.imageObjectKey });
          published.set(chunk.page, saved);
        }
      }
      let visualRecognitionUnavailable = !deps.recognizePage;
      const skippedVisionPages: number[] = [];
      const consumePage = async (page: ParsedPage) => {
        signal.throwIfAborted();
        const visualKinds = page.visualKinds?.length ? page.visualKinds : !page.text.trim() && (isImage || isPdf) ? ["scan" as const] : [];
        const needsVision = (isPdf || isImage) && visualKinds.length > 0;
        const saved = published.get(page.page);
        if (saved && (!needsVision || saved.some(chunk => chunk.imageObjectKey))) {
          chunks.push(...saved);
          return;
        }
        let text = page.text;
        let imageObjectKey: string | null = null;
        if (isImage && !deps.recognizePage) throw new Error(`visual recognition is required for physical page ${page.page}`);
        if (needsVision && !visualRecognitionUnavailable && deps.recognizePage) {
          await assertCurrent?.();
          let result: ParseSourceVisualPageResult | undefined;
          try {
            result = await deps.recognizePage({ scope, job, sourceId: source.id, sourceVersion: source.version,
              physicalPage: page.page, nativeText: page.text, visualKinds, localFilePath: temp, mime: source.mime, signal });
          } catch (error) {
            if (!(error instanceof OpeningModelRoutingError)) throw error;
            visualRecognitionUnavailable = true;
          }
          signal.throwIfAborted();
          await assertCurrent?.();
          if (!visualRecognitionUnavailable) {
            if (!result || typeof result.text !== "string" || !result.text.trim() || typeof result.imageObjectKey !== "string" || !result.imageObjectKey.trim()) throw new Error(`visual recognition returned no readable content or image for physical page ${page.page}`);
            const extractionLabel = visualKinds.includes("scan") ? "本地提取（可能含OCR）" : "原生提取";
            text = `${page.text ? `[${extractionLabel}]\n${page.text}\n\n` : ""}[视觉转写与描述]\n${result.text}`;
            imageObjectKey = result.imageObjectKey;
          }
        }
        if (isPdf && needsVision && visualRecognitionUnavailable) {
          skippedVisionPages.push(page.page);
          if (saved) { chunks.push(...saved); return; }
        }
        if (isImage && visualRecognitionUnavailable) imageObjectKey = deps.storage.finalKey(source.id, source.version);
        if (text.trim() || imageObjectKey) chunks.push({ page: page.page, slideLabel: null, startMs: null, endMs: null, text, imageObjectKey });
      };

      let pageCount: number;
      const failedRanges: string[] = [];
      if (isPdf) {
        const result = await parsePdfSegments({ path: temp, sourceId: source.id, sourceVersion: source.version, scope, runner: deps.runner,
          segments: deps.segments, signal, segmentPages: deps.segmentPages, timeoutSeconds: deps.segmentTimeoutSeconds,
          onPages: async pages => { for (const page of pages) await consumePage(page); } });
        pageCount = result.pageCount;
        failedRanges.push(...result.failedRanges, ...skippedVisionPages.map(String));
      } else {
        const pages: ParsedPage[] = isImage ? [{ page: 1, text: "", imagePath: null, visualKinds: ["scan"] }]
          : await parser.parseDocument({ path: temp, mime: source.mime, maxPages: 2000 }, signal);
        pageCount = pages.length;
        for (const page of pages) await consumePage(page);
      }

      const lowQualityPages = isPdf ? chunks.filter(chunk => checkPdfPageQuality(chunk.text).quality === "low_quality").map(chunk => chunk.page).filter((page): page is number => page != null) : [];
      const warning = failedRanges.length || lowQualityPages.length ? createPdfPartialError(failedRanges, lowQualityPages) : null;
      signal.throwIfAborted();
      await assertCurrent?.();
      if (warning && !chunks.length) throw new Error(warning.message);
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks });
      if (warning) await deps.sources.markParseState(scope, source.id, "ready", warning);
      if (deps.onSourceReady) {
        try { await deps.onSourceReady(scope, { sourceId: source.id, sourceVersion: source.version }); } catch { /* best-effort */ }
      }
      if (isImage) return { pages: 1, imageOnly: visualRecognitionUnavailable };
      return { pages: pageCount, ...(skippedVisionPages.length ? { warnings: skippedVisionPages.length, degraded: true } : {}) };
    } catch (error) {
      if (error instanceof UnsupportedMimeError) throw new UnsupportedSourceError("unsupported source MIME");
      if (error instanceof ConversionFailedError) throw new Error(`document conversion failed: ${error.message}`);
      throw error;
    } finally { await execution?.stop(); await rm(workDir, { recursive: true, force: true }); }
  };
}
