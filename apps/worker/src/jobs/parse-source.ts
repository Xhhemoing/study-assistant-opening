import { openingJobScope } from "@aistudy/database";
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
import type { ParserRunner } from "../parsers/types";
import type { OpeningSourceChunksRepository } from "@aistudy/database";
import type { OpeningPdfSegmentsRepository } from "@aistudy/database";
import { parsePdfSegments, watchPdfExecution } from "../parsers/pdf-segments";

export class UnsupportedSourceError extends Error { readonly code = "UNSUPPORTED_SOURCE"; }
const IMAGE_SOURCE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
type Storage = { presignGet(key: string, input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string }): Promise<string>; finalKey(id: string, version: number): string };
type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState">;

export function createParseSourceHandler(deps: { sources: SourceRepo; chunks: OpeningSourceChunksRepository; storage: Storage; runner: ParserRunner; tempDir: string;
  segments?: OpeningPdfSegmentsRepository; segmentPages?: number; segmentTimeoutSeconds?: number; executionPollMs?: number }) {
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
      const text = await response.text();
      if (Buffer.byteLength(text) > source.bytes) throw new Error("source download exceeds declared bytes");
      const chunks = source.mime === "text/html" ? htmlChunks(text) : markdownChunks(text); // plain text uses markdown chunker
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks: chunks.map((chunk) => ({ page: chunk.page, slideLabel: null, startMs: null, endMs: null, text: chunk.text, imageObjectKey: null })) });
      return { pages: chunks.length };
    }
    if (IMAGE_SOURCE_MIMES.has(source.mime)) {
      const objectKey = deps.storage.finalKey(source.id, source.version);
      // OCR text is optional: empty string is allowed when imageObjectKey is set.
      await deps.chunks.replaceChunks(scope, {
        sourceId: source.id,
        sourceVersion: source.version,
        chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null, text: "", imageObjectKey: objectKey }],
      });
      return { pages: 1, imageOnly: true };
    }
    // Legacy .ppt and .eml: keep the object stored, but do not claim readable text for tutoring.
    if (source.mime === "application/vnd.ms-powerpoint" || source.mime === "message/rfc822") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true, storedOnly: true };
    }
    if (source.mime !== "application/pdf" && source.mime !== "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true };
    }
    const url = await deps.storage.presignGet(deps.storage.finalKey(source.id, source.version), { expiresInSeconds: 900, responseContentDisposition: "attachment", responseCacheControl: "private, no-store" });
    await mkdir(tempDir, { recursive: true });
    const workDir = await mkdtemp(path.join(tempDir, `${source.id}-${source.version}-`));
    const temp = path.join(workDir, "source");
    let execution: Awaited<ReturnType<typeof watchPdfExecution>> | undefined;
    try {
      if (source.mime === "application/pdf" && deps.segments) execution = await watchPdfExecution(
        () => deps.segments!.assertCurrent(scope, { sourceId: source.id, sourceVersion: source.version }), deps.executionPollMs,
      );
      const signal = execution?.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error("source download failed");
      let bytes = 0;
      const limited = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > source.bytes) callback(new Error("source download exceeds declared bytes")); else { callback(null, chunk); } } });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limited, createWriteStream(temp), { signal });
      const pages = source.mime === "application/pdf"
        ? await parsePdfSegments({ path: temp, sourceId: source.id, sourceVersion: source.version, scope, runner: deps.runner,
          segments: deps.segments, signal, segmentPages: deps.segmentPages, timeoutSeconds: deps.segmentTimeoutSeconds })
        : await parser.parseDocument({ path: temp, mime: source.mime, maxPages: 2000 }, signal);
      signal.throwIfAborted();
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks: pages.map((page) => ({ page: page.page, slideLabel: null, startMs: null, endMs: null, text: page.text, imageObjectKey: null })) });
      return { pages: pages.length };
    } catch (error) {
      if (error instanceof UnsupportedMimeError) throw new UnsupportedSourceError("unsupported source MIME");
      if (error instanceof ConversionFailedError) throw new Error(`document conversion failed: ${error.message}`);
      throw error;
    } finally { await execution?.stop(); await rm(workDir, { recursive: true, force: true }); }
  };
}
