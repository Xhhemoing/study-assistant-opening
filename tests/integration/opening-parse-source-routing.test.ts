import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpeningModelRoutingError } from "@aistudy/ai";
import {
  createOpeningJobRepository, createOpeningPdfSegmentsRepository,
  createOpeningSourceChunksRepository, createOpeningSourceRepository, createOpeningSourceVisualRecognitionsRepository,
  type PdfSegmentPage,
} from "@aistudy/database";
import { createParseSourceHandler, type ParseSourceVisualPageInput } from "../../apps/worker/src/jobs/parse-source";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
let tempDir: string;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-routing-integration-"));
});
afterEach(async () => {
  try { expect(await readdir(tempDir)).toEqual([]); }
  finally { await rm(tempDir, { recursive: true, force: true }); }
});
afterAll(async () => { await fixture?.close(); });

const mixedPages: PdfSegmentPage[] = [
  { page: 1, text: "Native paragraph", imagePath: null, visualKinds: [] },
  { page: 2, text: "Native formula caption", imagePath: null, visualKinds: ["formula"] },
  { page: 3, text: "Local OCR transcription", imagePath: null, visualKinds: ["scan"] },
];

async function seed(mime: "application/pdf" | "image/png") {
  const sourceId = randomUUID();
  // Synthetic bytes: the runner is controlled; no real parser/model/storage service is invoked.
  const original = Buffer.from(mime === "application/pdf" ? "%PDF synthetic routing fixture" : "synthetic PNG fixture");
  const originalKey = `sources/${sourceId}/0/original`;
  await fixture.sql`INSERT INTO opening_sources
    (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'routing-fixture', ${mime},
      ${original.length}, ${"a".repeat(64)}, 0, 'uploaded', 'queued')`;
  const jobs = createOpeningJobRepository(fixture.sql);
  const sources = createOpeningSourceRepository(fixture.sql);
  const chunks = createOpeningSourceChunksRepository(fixture.sql);
  const segments = createOpeningPdfSegmentsRepository(fixture.sql);
  const job = await jobs.createOnce(fixture.scope, {
    key: randomUUID(), kind: "parse", payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0,
  });
  const storage = {
    finalKey: (id: string, version: number) => `sources/${id}/${version}/original`,
    presignGet: vi.fn(async (key: string) => {
      expect(key).toBe(originalKey);
      return `data:${mime};base64,${original.toString("base64")}`;
    }),
  };
  const runner = vi.fn(async (argv: string[]) => ({
    exitCode: 0,
    stdout: JSON.stringify(argv.includes("--inspect-pdf") ? { pageCount: mixedPages.length } : { pages: mixedPages }),
  }));
  const execute = async (recognizePage: (input: ParseSourceVisualPageInput) => Promise<never>) => {
    const handler = createParseSourceHandler({
      sources, chunks, segments, storage, runner, tempDir, recognizePage,
      assertCurrent: (scope, input) => createOpeningSourceVisualRecognitionsRepository(fixture.sql).assertCurrent(scope, input),
    });
    expect(await runJob(jobs, job.id, handler)).toBe(true);
  };
  return { sourceId, original, originalKey, jobs, sources, chunks, job, storage, runner, execute };
}

describe("parse routing fallback through real repositories and worker receipt", () => {
  it("persists native and local OCR PDF text, tries only the first visual page, and succeeds", async () => {
    const d = await seed("application/pdf");
    const recognizePage = vi.fn(async (input: ParseSourceVisualPageInput): Promise<never> => {
      expect(await readFile(input.localFilePath)).toEqual(d.original);
      throw new OpeningModelRoutingError("请先配置 gpt-6-luna");
    });
    await d.execute(recognizePage);
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(recognizePage).toHaveBeenCalledWith(expect.objectContaining({ physicalPage: 2, nativeText: mixedPages[1]!.text }));
    expect(d.runner).toHaveBeenCalledTimes(2);
    const rows = await fixture.sql`SELECT page, text, image_object_key, source_version
      FROM opening_source_chunks WHERE source_id = ${d.sourceId} ORDER BY page`;
    expect(rows.map(row => ({ ...row }))).toEqual(mixedPages.map(page => ({
      page: page.page, text: page.text, image_object_key: null, source_version: 0,
    })));
    expect(await d.sources.get(fixture.scope, d.sourceId)).toMatchObject({ parseState: "ready", uploadState: "uploaded", error: null });
    expect(await d.jobs.get(fixture.scope, d.job.id)).toMatchObject({ state: "succeeded", result: { pages: 3 } });
    const [segment] = await fixture.sql`SELECT state, pages FROM opening_pdf_parse_segments WHERE source_id = ${d.sourceId}`;
    expect(segment).toMatchObject({ state: "ready", pages: mixedPages });
  });

  it("persists the original image key with no invented recognition and an imageOnly success receipt", async () => {
    const d = await seed("image/png");
    const recognizePage = vi.fn(async (input: ParseSourceVisualPageInput): Promise<never> => {
      expect(await readFile(input.localFilePath)).toEqual(d.original);
      throw new OpeningModelRoutingError("请先配置 gpt-6-luna");
    });
    await d.execute(recognizePage);
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(d.runner).not.toHaveBeenCalled();
    const rows = await fixture.sql`SELECT page, text, image_object_key, source_version
      FROM opening_source_chunks WHERE source_id = ${d.sourceId}`;
    expect(rows.map(row => ({ ...row }))).toEqual([{ page: 1, text: "", image_object_key: d.originalKey, source_version: 0 }]);
    expect(await d.chunks.listForSources(fixture.scope, [d.sourceId])).toMatchObject([{ text: "", imageObjectKey: d.originalKey }]);
    expect(await d.sources.get(fixture.scope, d.sourceId)).toMatchObject({ parseState: "ready", uploadState: "uploaded", error: null });
    expect(await d.jobs.get(fixture.scope, d.job.id)).toMatchObject({ state: "succeeded", result: { pages: 1, imageOnly: true } });
  });

  it("fails ordinary provider errors without replacing saved chunks or losing original references", async () => {
    const d = await seed("application/pdf");
    await d.chunks.replaceChunks(fixture.scope, { sourceId: d.sourceId, sourceVersion: 0, chunks: [
      { page: 1, slideLabel: null, startMs: null, endMs: null, text: "Previously saved text", imageObjectKey: d.originalKey },
    ] });
    const before = await fixture.sql`SELECT * FROM opening_source_chunks WHERE source_id = ${d.sourceId}`;
    await d.sources.markParseState(fixture.scope, d.sourceId, "queued");
    const recognizePage = vi.fn(async (): Promise<never> => { throw new Error("provider unavailable"); });
    await d.execute(recognizePage);
    expect(recognizePage).toHaveBeenCalledOnce();
    const after = await fixture.sql`SELECT * FROM opening_source_chunks WHERE source_id = ${d.sourceId}`;
    expect([...after]).toEqual([...before]);
    expect(await d.sources.get(fixture.scope, d.sourceId)).toMatchObject({
      version: 0, uploadState: "uploaded", parseState: "failed", error: { code: "PARSE_FAILED", retryable: true },
    });
    expect(await d.jobs.get(fixture.scope, d.job.id)).toMatchObject({ state: "failed", result: { error: "provider unavailable", retryable: true } });
    expect(d.storage.presignGet).toHaveBeenCalledWith(d.originalKey, expect.any(Object));
  });
});
