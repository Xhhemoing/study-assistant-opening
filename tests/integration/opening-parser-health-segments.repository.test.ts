import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningJobRepository, createOpeningSourceChunksRepository, createOpeningSourceRepository, openingJobScope, type OpeningStorage } from "@aistudy/database";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import type { ParserRunner } from "../../apps/worker/src/parsers/types";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningPdfSegmentsRepository } from "../../packages/database/src/repositories/opening-pdf-segments";
import { createOpeningParserHealthRepository, type ParserOcrHealth } from "../../packages/database/src/repositories/opening-parser-health";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const page = { page: 1, text: "saved PDF page", imagePath: null } as const;
async function seed() {
  // Real upload service/repositories, only object storage is in memory. Do not
  // seed or increment source.version: a normal begin/complete upload stays at 0.
  const objects = new Map<string, Uint8Array>();
  const bytes = await readFile(new URL("../fixtures/opening/parser-two-page.pdf", import.meta.url));
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const get = (key: string) => {
    const value = objects.get(key);
    if (!value) throw new Error("fixture object missing");
    return value;
  };
  const unused = async () => { throw new Error("unexpected storage call"); };
  const storage: OpeningStorage = {
    stagingKey: id => `opening/staging/${id}`, finalKey: (id, version) => `opening/sources/${id}/v${version}`,
    putObject: async (key, value) => { objects.set(key, value); },
    headObject: async key => ({ exists: objects.has(key), bytes: get(key).length, etag: digest(get(key)), mime: "application/pdf" }),
    streamDigest: async (key, limit) => {
      const value = get(key);
      if (value.length > (limit ?? Number.MAX_SAFE_INTEGER)) throw new Error("fixture digest limit exceeded");
      return { bytes: value.length, sha256: digest(value), firstBytes: value.slice(0, 16) };
    },
    copyStagingToFinal: async (from, to, input) => {
      expect(input.expectedEtag).toBe(digest(get(from)));
      objects.set(to, get(from));
    },
    deleteObject: async key => { objects.delete(key); },
    presignPut: unused, presignGet: async key => `data:application/pdf;base64,${Buffer.from(get(key)).toString("base64")}`, copyObject: unused,
    putObjectStream: unused, getObjectStream: unused, objectExists: unused,
  };
  const service = createOpeningSourceService(f.sql, storage);
  const principal = { userId: f.scope.ownerUserId, workspaceId: f.scope.workspaceId, sessionId: "segment-test" };
  const ticket = await service.beginUpload(principal, { name: "small.pdf", mime: "application/pdf", bytes: bytes.length, sha256: digest(bytes) });
  expect(ticket.source.version).toBe(0);
  await service.putStaging(principal, ticket.source.id, { contentType: "application/pdf", bytes });
  const source = await service.completeUpload(principal, ticket.source.id);
  expect(source).toMatchObject({ version: 0, uploadState: "uploaded", parseState: "queued" });
  expect(get(storage.finalKey(source.id, source.version))).toEqual(bytes);
  expect(objects.has(storage.stagingKey(source.id))).toBe(false);
  const jobs = createOpeningJobRepository(f.sql);
  const rows = await f.sql`SELECT id,payload FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId}
    AND kind='parse' AND payload->>'sourceId'=${source.id}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toEqual({ sourceId: source.id, sourceVersion: 0 });
  const claimed = await jobs.claim(rows[0]!.id as string);
  if (!claimed) throw new Error("fixture job not claimed");
  return { jobs, claimed, storage, service, principal, scope: openingJobScope(claimed), identity: { sourceId: source.id, sourceVersion: source.version, parserProfile: "test-docling-v2/text", pageStart: 1, pageEnd: 1 } };
}

describe("0094/0095 PDF segment persistence and execution fencing", () => {
  it("publishes successful pages after two segment failures and requeues only the failed segment", async () => {
    const d = await seed(), sources = createOpeningSourceRepository(f.sql);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "partial-pdf-"));
    const starts: number[] = [];
    let fail = true;
    const runner: ParserRunner = async argv => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":2}' };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      starts.push(start);
      return fail && start === 2 ? { exitCode: 4, stdout: "" }
        : { exitCode: 0, stdout: JSON.stringify({ pages: [{ page: start, text: `Readable page ${start}`, imagePath: null }] }) };
    };
    const handler = createParseSourceHandler({ sources, chunks: createOpeningSourceChunksRepository(f.sql),
      segments: createOpeningPdfSegmentsRepository(f.sql), storage: d.storage, runner, tempDir, segmentPages: 1 });
    try {
      const result = await handler(d.claimed, d.claimed.payload);
      expect(result).toEqual({ pages: 1 });
      expect(starts).toEqual([1, 2, 2]);
      expect(await sources.get(f.scope, d.identity.sourceId)).toMatchObject({ parseState: "ready",
        error: { code: "PARSE_PARTIAL", retryable: true, message: "第 2 页未能识别，可以重新解析" } });
      expect(await f.sql`SELECT page,text FROM opening_source_chunks WHERE source_id=${d.identity.sourceId} ORDER BY page`)
        .toEqual([{ page: 1, text: "Readable page 1" }]);
      expect(await f.sql`SELECT page_start,state FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId} ORDER BY page_start`)
        .toEqual([{ page_start: 1, state: "ready" }, { page_start: 2, state: "failed" }]);
      await d.jobs.finish(d.claimed.id, "succeeded", result, d.claimed.claimToken);
      // Exercise the public service as well as retryParseWithJob's real SQL.
      expect(await d.service.retryParse(d.principal, d.identity.sourceId)).toMatchObject({ parseState: "queued", error: null });
      const [retry] = await f.sql`SELECT id FROM opening_jobs WHERE kind='parse' AND payload->>'sourceId'=${d.identity.sourceId} AND id<>${d.claimed.id}`;
      expect(await f.sql`SELECT job_id FROM opening_outbox WHERE job_id=${retry!.id}`).toHaveLength(1);
      const claimed = await d.jobs.claim(retry!.id as string);
      expect(claimed).not.toBeNull();
      fail = false;
      starts.length = 0;
      expect(await handler(claimed!, claimed!.payload)).toEqual({ pages: 2 });
      expect(starts).toEqual([2]);
      expect(await sources.get(f.scope, d.identity.sourceId)).toMatchObject({ parseState: "ready", error: null });
      expect(await f.sql`SELECT page FROM opening_source_chunks WHERE source_id=${d.identity.sourceId} ORDER BY page`)
        .toEqual([{ page: 1 }, { page: 2 }]);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  it("keeps low-quality-only pages usable but rejects reparsing them", async () => {
    const d = await seed(), sources = createOpeningSourceRepository(f.sql);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "low-quality-pdf-"));
    const handler = createParseSourceHandler({ sources, chunks: createOpeningSourceChunksRepository(f.sql),
      segments: createOpeningPdfSegmentsRepository(f.sql), storage: d.storage, tempDir,
      runner: async argv => ({ exitCode: 0, stdout: JSON.stringify(argv.includes("--inspect-pdf") ? { pageCount: 1 }
        : { pages: [{ page: 1, text: "����文本", imagePath: null }] }) }) });
    try {
      const result = await handler(d.claimed, d.claimed.payload);
      expect(await sources.get(f.scope, d.identity.sourceId)).toMatchObject({ parseState: "ready",
        error: { code: "PARSE_PARTIAL", retryable: false, message: "第 1 页识别质量低" } });
      expect(await f.sql`SELECT page,text FROM opening_source_chunks WHERE source_id=${d.identity.sourceId}`)
        .toEqual([{ page: 1, text: "����文本" }]);
      await d.jobs.finish(d.claimed.id, "succeeded", result, d.claimed.claimToken);
      await expect(sources.retryParseWithJob(f.scope, d.identity.sourceId, { key: randomUUID(), payload: d.claimed.payload,
        privacyEpoch: d.claimed.privacyEpoch })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await f.sql`SELECT id FROM opening_jobs WHERE kind='parse' AND payload->>'sourceId'=${d.identity.sourceId}`).toHaveLength(1);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  it("reads and saves initial upload version 0 and reuses it on a new job without replacing successful segments", async () => {
    const d = await seed();
    expect(await createOpeningPdfSegmentsRepository(f.sql).read(d.scope, d.identity)).toBeNull();
    await createOpeningPdfSegmentsRepository(f.sql).save(d.scope, d.identity, { state: "ready", pages: [page] });
    expect(await f.sql`SELECT source_version FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId}`)
      .toEqual([{ source_version: 0 }]);
    await d.jobs.finish(d.claimed.id, "failed", { error: "second segment failed", retryable: true }, d.claimed.claimToken);
    const retry = await d.jobs.createOnce(f.scope, { key: randomUUID(), kind: "parse", payload: d.claimed.payload, privacyEpoch: d.claimed.privacyEpoch });
    const current = openingJobScope((await d.jobs.claim(retry.id))!);
    const restarted = createOpeningPdfSegmentsRepository(f.sql);
    expect(await restarted.read(current, d.identity)).toEqual({ state: "ready", pages: [page] });
    await restarted.save(current, d.identity, { state: "failed", errorCode: "timeout" });
    expect(await restarted.read(current, d.identity)).toEqual({ state: "ready", pages: [page] });
    expect(await restarted.read(current, { ...d.identity, parserProfile: "test-docling-v2/ocr" })).toBeNull();
    await expect(restarted.read(current, { ...d.identity, sourceVersion: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("still rejects negative/noninteger cache versions and the database rejects a negative version", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    for (const sourceVersion of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repo.read(d.scope, { ...d.identity, sourceVersion })).rejects.toThrow(TypeError);
      await expect(repo.save(d.scope, { ...d.identity, sourceVersion }, { state: "ready", pages: [page] })).rejects.toThrow(TypeError);
    }
    await expect(f.sql`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,error_code)
      VALUES(${f.scope.workspaceId},${d.identity.sourceId},-1,${d.identity.parserProfile},1,1,'failed','timeout')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "opening_pdf_parse_segments_source_version_check" });
  });

  it("updates a failed segment only, and source deletion cascades cached material", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    await repo.save(d.scope, d.identity, { state: "failed", errorCode: "timeout" });
    expect(await repo.read(d.scope, d.identity)).toEqual({ state: "failed", errorCode: "timeout" });
    await repo.save(d.scope, d.identity, { state: "ready", pages: [page] });
    await f.sql`DELETE FROM opening_sources WHERE id=${d.identity.sourceId}`;
    expect(await f.sql`SELECT source_id FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId}`).toHaveLength(0);
  });

  it("rejects cross-owner/workspace access, missing execution, stale claims and privacy epochs", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    for (const scope of [f.scope, { ...d.scope, ownerUserId: f.otherScope.ownerUserId },
      { ...d.scope, workspaceId: f.otherScope.workspaceId },
      { ...d.scope, jobExecution: { ...d.scope.jobExecution!, token: randomUUID() } },
      { ...d.scope, jobExecution: { ...d.scope.jobExecution!, privacyEpoch: d.claimed.privacyEpoch + 1 } }]) {
      await expect(repo.save(scope, d.identity, { state: "ready", pages: [page] })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(repo.read(scope, d.identity)).rejects.toMatchObject({ code: "CONFLICT" });
    }
  });

  it("rejects late cache and final chunk writes after cancel commits", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    await repo.save(d.scope, d.identity, { state: "ready", pages: [page] });
    await d.jobs.cancel(f.scope, d.claimed.id);
    await expect(repo.save(d.scope, { ...d.identity, pageStart: 2, pageEnd: 2 }, { state: "failed", errorCode: "timeout" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createOpeningSourceChunksRepository(f.sql).replaceChunks(d.scope, { sourceId: d.identity.sourceId, sourceVersion: d.identity.sourceVersion,
      chunks: [{ page: 1, text: "late", slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT * FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId}`).toHaveLength(1);
    expect(await f.sql`SELECT * FROM opening_source_chunks WHERE source_id=${d.identity.sourceId}`).toHaveLength(0);
  });

  it("does not write cancelled outcomes while a competing transaction holds the workspace lock", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const cancellation = f.sql.begin(async tx => {
      await tx`SELECT id FROM workspaces WHERE id=${f.scope.workspaceId} FOR UPDATE`;
      await tx`UPDATE opening_jobs SET state='cancelled' WHERE id=${d.claimed.id}`;
      locked();
      await gate;
    });
    await acquired;
    const save = repo.save(d.scope, d.identity, { state: "ready", pages: [page] });
    const denied = expect(save).rejects.toMatchObject({ code: "CONFLICT" });
    release();
    await cancellation;
    await denied;
    expect(await f.sql`SELECT * FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId}`).toHaveLength(0);
  });

  it("does not begin a cache write with an already cancelled signal", async () => {
    const d = await seed(), repo = createOpeningPdfSegmentsRepository(f.sql);
    const controller = new AbortController();
    controller.abort();
    await expect(repo.save(d.scope, d.identity, { state: "ready", pages: [page] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await f.sql`SELECT * FROM opening_pdf_parse_segments WHERE source_id=${d.identity.sourceId}`).toHaveLength(0);
  });
});

describe("0094 Worker OCR health observations", () => {
  const ready: ParserOcrHealth = { status: "ready", directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 12 };
  it("requires measured inference; records four states and expires/retire reports instead of assuming ready", async () => {
    const repo = createOpeningParserHealthRepository(f.sql), id = randomUUID();
    await f.sql`DELETE FROM opening_parser_health`;
    expect(await repo.read()).toBeNull();
    await expect(repo.record(id, { ...ready, inferenceMs: null })).rejects.toThrow("inference");
    for (const status of ["not_configured", "missing_files", "preflight_failed", "ready"] as const) {
      await repo.record(id, { ...ready, status, inferenceMs: status === "ready" ? 12 : null });
      expect(await repo.read()).toMatchObject({ status });
    }
    await repo.retire(id);
    expect(await repo.read()).toBeNull();
  });
  it("does not claim OCR readiness if any live parser consumer is unconfigured", async () => {
    const repo = createOpeningParserHealthRepository(f.sql), id = randomUUID(), otherId = randomUUID();
    await f.sql`DELETE FROM opening_parser_health`;
    await repo.record(id, ready);
    await repo.record(otherId, { status: "not_configured", directoryConfigured: false, directoryExists: false, missingFiles: [], inferenceMs: null });
    expect(await repo.read()).toMatchObject({ status: "not_configured" });
    await repo.retire(otherId);
    expect(await repo.read()).toMatchObject({ status: "ready" });
    await f.sql`UPDATE opening_parser_health SET expires_at=now() - interval '1 second' WHERE worker_id=${id}`;
    expect(await repo.read()).toBeNull();
  });
});
