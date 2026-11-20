import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpeningModelRoutingError } from "@aistudy/ai";
import {
  createOpeningJobRepository, createOpeningPdfSegmentsRepository,
  createOpeningSourceChunksRepository, createOpeningSourceRepository, createOpeningSourceVisualRecognitionsRepository,
  openingJobScope, type PdfSegmentPage,
} from "@aistudy/database";
import { createParseSourceHandler, type ParseSourceVisualPageInput } from "../../apps/worker/src/jobs/parse-source";
import { pdfParserProfile } from "../../apps/worker/src/parsers/ocr-health";
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
      ${original.length}, ${createHash("sha256").update(original).digest("hex")}, 0, 'uploaded', 'queued')`;
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
  it("resumes and publishes over 8 MiB of cached PDF text in bounded PostgreSQL batches", async () => {
    const d = await seed("application/pdf");
    const pageCount = 51;
    const text = "教材".repeat(45_000);
    const insertBytes: number[] = [];
    const publisherName = `pdf-publish-${d.sourceId}`;
    const sql = postgres(process.env.OPENING_TEST_DATABASE_URL!, {
      max: 1,
      connection: { application_name: publisherName },
      debug: (_connection, query, parameters) => {
        if (!/INSERT INTO (?:pg_temp\.)?opening_(?:pdf_chunk_stage|source_chunks)\b/i.test(query)) return;
        insertBytes.push(parameters.reduce((bytes, value) =>
          bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0));
      },
    });
    try {
      const segments = createOpeningPdfSegmentsRepository(fixture.sql);
      const runner = vi.fn(async (argv: string[]) => {
        if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount }) };
        expect(argv[argv.indexOf("--page-start") + 1]).toBe("51");
        expect(argv[argv.indexOf("--page-end") + 1]).toBe("51");
        return { exitCode: 0, stdout: JSON.stringify({
          pages: [{ page: pageCount, text, imagePath: null, visualKinds: ["formula"] }],
        }) };
      });
      const handler = createParseSourceHandler({
        sources: d.sources, chunks: createOpeningSourceChunksRepository(sql), storage: d.storage, tempDir, segments, runner,
        recognizePage: async () => {
          const [active] = await fixture.sql`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE application_name=${publisherName} AND xact_start IS NOT NULL`;
          expect(active?.count).toBe(0);
          const [source] = await fixture.sql`SELECT parse_state FROM opening_sources WHERE id=${d.sourceId}`;
          expect(source?.parse_state).toBe("running");
          return { text: "Verified final page", imageObjectKey: "recognized/tail" };
        },
      });
      expect(await runJob(d.jobs, d.job.id, async (job, payload) => {
        for (let start = 1; start < pageCount; start += 10) {
          await segments.save(openingJobScope(job), {
            sourceId: d.sourceId, sourceVersion: 0, parserProfile: pdfParserProfile(), pageStart: start, pageEnd: start + 9,
          }, { state: "ready", pages: Array.from({ length: 10 }, (_, offset) =>
            ({ page: start + offset, text, imagePath: null })) });
        }
        return handler(job, payload);
      })).toBe(true);
      expect(runner).toHaveBeenCalledTimes(2);
      expect(await d.jobs.get(fixture.scope, d.job.id)).toMatchObject({ state: "succeeded", result: { pages: pageCount } });
      const [published] = await fixture.sql`SELECT count(*)::int AS count, sum(octet_length(c.text))::int AS bytes,
        max(c.image_object_key) AS image_key, s.parse_state, s.error
        FROM opening_source_chunks c JOIN opening_sources s ON s.id=c.source_id
        WHERE s.id=${d.sourceId} AND c.source_version=s.version GROUP BY s.id`;
      expect(published).toMatchObject({ count: pageCount, image_key: "recognized/tail", parse_state: "ready", error: null });
      expect(published?.bytes).toBeGreaterThan(8 * 1024 * 1024);
      const [outbox] = await fixture.sql`SELECT count(*)::int AS count FROM opening_outbox o
        JOIN opening_jobs j ON j.id=o.job_id WHERE j.kind='index-source' AND j.payload->>'sourceId'=${d.sourceId}`;
      expect(outbox?.count).toBe(1);
      const textBatches = insertBytes.filter(Boolean);
      expect(textBatches.length).toBeGreaterThan(1);
      expect(textBatches.length).toBeLessThan(pageCount);
      expect(Math.max(...textBatches)).toBeLessThanOrEqual(4 * 1024 * 1024);
    } finally { await sql.end({ timeout: 5 }); }
  }, 30_000);

  it("persists native and local OCR PDF text, tries only the first visual page, and records degraded coverage", async () => {
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
    expect(await d.sources.get(fixture.scope, d.sourceId)).toMatchObject({
      parseState: "ready", uploadState: "uploaded",
      error: { code: "PARSE_PARTIAL", message: "第 2–3 页未能识别，可以重新解析", retryable: true },
    });
    expect(await d.jobs.get(fixture.scope, d.job.id)).toMatchObject({
      state: "succeeded", result: { pages: 3, warnings: 2, degraded: true },
    });
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
