import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openingJobScope, createOpeningJobRepository, createOpeningPdfSegmentsRepository, createOpeningSourceChunksRepository,
  createOpeningSourceRepository } from "@aistudy/database";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const originalText = "This first page is already readable and its existing citation must remain stable across a retry.";
async function seedRetry() {
  const sourceId = randomUUID(), bytes = Buffer.from("%PDF synthetic retry");
  const sources = createOpeningSourceRepository(f.sql), chunks = createOpeningSourceChunksRepository(f.sql);
  const jobs = createOpeningJobRepository(f.sql);
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES (${sourceId},${f.scope.workspaceId},'retry.pdf','application/pdf',${bytes.length},${"a".repeat(64)},0,'uploaded','failed')`;
  await chunks.replaceChunks(f.scope, { sourceId, sourceVersion: 0, chunks: [
    { page: 1, slideLabel: null, startMs: null, endMs: null, text: originalText, imageObjectKey: null },
  ] });
  const original = await chunks.listChunks(f.scope, sourceId);
  await sources.markParseState(f.scope, sourceId, "failed", { code: "PARSE_FAILED", message: "interrupted", retryable: true });
  const key = `parse:${sourceId}:v0:retry:${randomUUID()}`;
  expect(await sources.retryParseWithJob(f.scope, sourceId, { key, payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0 }))
    .toMatchObject({ id: sourceId, version: 0, parseState: "queued", error: null });
  const [job] = await f.sql`SELECT id FROM opening_jobs WHERE workspace_id=${f.scope.workspaceId} AND key=${key}`;
  const [outbox] = await f.sql`SELECT payload FROM opening_outbox WHERE workspace_id=${f.scope.workspaceId} AND job_id=${job!.id}`;
  expect(outbox!.payload).toMatchObject({ jobId: job!.id, kind: "parse", sourceId });
  return { sourceId, sources, chunks, jobs, id: String(job!.id), original, bytes };
}

it("runs the retry outbox target through the real Worker completion and ordinary source reader", async () => {
  const d = await seedRetry(), tempDir = await mkdtemp(path.join(os.tmpdir(), "pdf-retry-queued-"));
  const runner = vi.fn(async (argv: string[]) => ({ exitCode: 0, stdout: JSON.stringify(argv.includes("--inspect-pdf")
    ? { pageCount: 2 } : { pages: [
      { page: 1, text: originalText, imagePath: null, visualKinds: [] },
      { page: 2, text: "This recovered second page has readable content without replacing the first page citation.", imagePath: null, visualKinds: [] },
    ] }) }));
  try {
    const handler = createParseSourceHandler({ sources: d.sources, chunks: d.chunks, runner, tempDir,
      segments: createOpeningPdfSegmentsRepository(f.sql),
      storage: { finalKey: () => "synthetic-original", presignGet: async () => `data:application/pdf;base64,${d.bytes.toString("base64")}` } });
    // The outbox target is invoked directly: no claim of Redis/BullMQ dispatch coverage.
    expect(await runJob(d.jobs, d.id, handler)).toBe(true);
    expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "ready", uploadState: "uploaded", version: 0 });
    expect(await d.jobs.get(f.scope, d.id)).toMatchObject({ state: "succeeded", result: { pages: 2 } });
    const saved = await d.chunks.listChunks(f.scope, d.sourceId);
    expect(saved).toHaveLength(2);
    expect(saved.find(chunk => chunk.page === 1)).toEqual(d.original[0]);
    const calls = runner.mock.calls.length;
    expect(await runJob(d.jobs, d.id, handler)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(calls);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

it("releases an unclaimed cancelled retry instead of leaving the source queued, preserving citations", async () => {
  const d = await seedRetry();
  expect(await d.jobs.cancel(f.scope, d.id)).toMatchObject({ state: "cancelled" });
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "not_started", version: 0, error: null });
  expect(await d.chunks.listChunks(f.scope, d.sourceId)).toEqual(d.original);
  const handler = vi.fn(async () => ({ pages: 2 }));
  expect(await runJob(d.jobs, d.id, handler)).toBe(false);
  expect(handler).not.toHaveBeenCalled();
  expect(await d.jobs.finish(d.id, "succeeded", { pages: 2 })).toBe(false);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "not_started" });
});

it("cannot cancel a foreign owner's retry or release a newer source version", async () => {
  const d = await seedRetry();
  expect(await d.jobs.cancel(f.otherScope, d.id)).toBeNull();
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "queued", version: 0 });
  await f.sql`UPDATE opening_sources SET version=1 WHERE id=${d.sourceId} AND workspace_id=${f.scope.workspaceId}`;
  expect(await d.jobs.cancel(f.scope, d.id)).toMatchObject({ state: "cancelled" });
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "queued", version: 1 });
  expect(await d.chunks.listChunksAtVersion(f.scope, d.sourceId, 0)).toEqual(d.original);
});

it("does not clear queued while another parse job still owns work for that source", async () => {
  const d = await seedRetry();
  const other = await d.jobs.createOnce(f.scope, { key: randomUUID(), kind: "parse",
    payload: { sourceId: d.sourceId, sourceVersion: 0 }, privacyEpoch: 0 });
  await d.jobs.cancel(f.scope, d.id);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "queued" });
  expect(await d.jobs.get(f.scope, other.id)).toMatchObject({ state: "queued" });
  await d.jobs.cancel(f.scope, other.id);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "not_started" });
});

it.each(["cancelled", "expired", "version"])("fences late chunk publication after %s without replacing old citations", async boundary => {
  const d = await seedRetry(), claimed = (await d.jobs.claim(d.id))!;
  expect(claimed.claimToken).toBeTruthy();
  if (boundary === "cancelled") await d.jobs.cancel(f.scope, d.id);
  if (boundary === "expired") {
    await f.sql`UPDATE opening_jobs SET updated_at=now()-interval '10 minutes' WHERE id=${d.id}`;
    await d.jobs.recoverExpired();
  }
  if (boundary === "version") await f.sql`UPDATE opening_sources SET version=1,parse_state='queued' WHERE id=${d.sourceId}`;
  await expect(d.chunks.replaceChunks(openingJobScope(claimed), { sourceId: d.sourceId, sourceVersion: 0, chunks: [
    { page: 1, slideLabel: null, startMs: null, endMs: null, text: "late obsolete result", imageObjectKey: null },
  ] })).rejects.toThrow();
  expect(await d.chunks.listChunksAtVersion(f.scope, d.sourceId, 0)).toEqual(d.original);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({
    parseState: boundary === "version" ? "queued" : boundary === "expired" ? "failed" : "not_started",
    version: boundary === "version" ? 1 : 0,
  });
});

it("records retry failure without replacing saved page identities, and rejects a stale claim's completion", async () => {
  const d = await seedRetry();
  expect(await runJob(d.jobs, d.id, async () => { throw new Error("controlled download interrupted"); })).toBe(true);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "failed", version: 0,
    error: { code: "PARSE_FAILED", retryable: true } });
  expect(await d.chunks.listChunks(f.scope, d.sourceId)).toEqual(d.original);
  expect(await d.jobs.finish(d.id, "succeeded", { pages: 2 }, randomUUID())).toBe(false);
  expect(await d.sources.get(f.scope, d.sourceId)).toMatchObject({ parseState: "failed" });
});
