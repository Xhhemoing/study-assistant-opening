import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import type { OpeningJobRecord } from "@aistudy/database";
import type { OpeningSourceRepository } from "@aistudy/database";
import { createDoclingProcess, UnsupportedMimeError, ConversionFailedError } from "../parsers/docling-process";
import type { ParserRunner } from "../parsers/types";
import type { OpeningSourceChunksRepository } from "@aistudy/database";

export class UnsupportedSourceError extends Error { readonly code = "UNSUPPORTED_SOURCE"; }
type Storage = { presignGet(key: string, input: { expiresInSeconds: number; responseContentDisposition: string; responseCacheControl: string }): Promise<string>; finalKey(id: string, version: number): string };
type SourceRepo = Pick<OpeningSourceRepository, "get" | "markParseState">;

export function createParseSourceHandler(deps: { sources: SourceRepo; chunks: OpeningSourceChunksRepository; storage: Storage; runner: ParserRunner; tempDir: string }) {
  const parser = createDoclingProcess({ run: deps.runner });
  // The parser child runs with cwd=services/parser; a relative tempDir would
  // resolve there and the CLI would reject the input as missing (exit 4).
  const tempDir = path.resolve(deps.tempDir);
  return async (job: OpeningJobRecord, payload: unknown) => {
    const sourceId = (payload as { sourceId?: unknown }).sourceId;
    if (typeof sourceId !== "string") throw new Error("parse payload missing sourceId");
    const scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    const source = await deps.sources.get(scope, sourceId);
    if (source.uploadState !== "uploaded") throw new Error("source is not uploaded");
    if (source.mime !== "application/pdf" && source.mime !== "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
      await deps.sources.markParseState(scope, source.id, "unsupported");
      return { unsupported: true };
    }
    const url = await deps.storage.presignGet(deps.storage.finalKey(source.id, source.version), { expiresInSeconds: 900, responseContentDisposition: "attachment", responseCacheControl: "private, no-store" });
    await mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `${source.id}-${source.version}`);
    try {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error("source download failed");
      let bytes = 0;
      const limited = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > source.bytes) callback(new Error("source download exceeds declared bytes")); else { callback(null, chunk); } } });
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), limited, createWriteStream(temp));
      const pages = await parser.parseDocument({ path: temp, mime: source.mime, maxPages: 2000 }, new AbortController().signal);
      await deps.chunks.replaceChunks(scope, { sourceId: source.id, sourceVersion: source.version, chunks: pages.map((page) => ({ page: page.page, slideLabel: null, startMs: null, endMs: null, text: page.text, imageObjectKey: null })) });
      return { pages: pages.length };
    } catch (error) {
      if (error instanceof UnsupportedMimeError) throw new UnsupportedSourceError("unsupported source MIME");
      if (error instanceof ConversionFailedError) throw new Error("document conversion failed");
      throw error;
    } finally { await rm(temp, { force: true }); }
  };
}
