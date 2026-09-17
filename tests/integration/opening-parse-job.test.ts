import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningSourceChunksRepository, createOpeningSourceRepository, OpeningS3 } from "@aistudy/database";
import { createNodeRunner } from "../../apps/worker/src/parsers/docling-process";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const storage = new OpeningS3({ endpoint: "http://127.0.0.1:9000", region: "us-east-1", bucket: "aistudy", accessKeyId: "minioadmin", secretAccessKey: "minioadmin", forcePathStyle: true });
const fixturePath = path.resolve("tests/fixtures/opening/parser-two-page.pdf");
let fixture: OpeningFixture;
let service: ReturnType<typeof createOpeningSourceService>;
const trackedKeys: string[] = [];

beforeAll(async () => {
  fixture = await createOpeningFixture();
  service = createOpeningSourceService(fixture.sql, storage);
});
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { for (const key of [...new Set(trackedKeys)]) await storage.deleteObject(key); await fixture?.close(); });

async function upload(name: string, mime: "application/pdf" | "audio/mpeg", bytes: Buffer) {
  const ticket = await service.beginUpload({ userId: fixture.scope.ownerUserId, workspaceId: fixture.scope.workspaceId, sessionId: "integration" }, { name, mime, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  trackedKeys.push(storage.stagingKey(ticket.source.id), storage.finalKey(ticket.source.id, ticket.source.version));
  const put = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  expect(put.status).toBe(200);
  await service.completeUpload({ userId: fixture.scope.ownerUserId, workspaceId: fixture.scope.workspaceId, sessionId: "integration" }, ticket.source.id);
  return ticket.source;
}

async function parse(sourceId: string, tempDir: string) {
  const handler = createParseSourceHandler({ sources: createOpeningSourceRepository(fixture.sql), chunks: createOpeningSourceChunksRepository(fixture.sql), storage, runner: createNodeRunner(path.resolve(".local/docling-venv/Scripts/python.exe"), path.resolve("services/parser")), tempDir });
  return handler({ id: "job", workspaceId: fixture.scope.workspaceId, ownerUserId: fixture.scope.ownerUserId, key: "key", kind: "parse", payload: { sourceId }, result: null, state: "queued", privacyEpoch: 0 }, { sourceId });
}

describe("opening parse job real stack", () => {
  it("converts the committed two-page PDF through the Node parser path", async () => {
    const source = await upload("parser-two-page.pdf", "application/pdf", await readFile(fixturePath));
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parser-integration-"));
    try {
      await parse(source.id, tempDir);
      const rows = await fixture.sql`SELECT page, text, source_version FROM opening_source_chunks WHERE source_id = ${source.id} ORDER BY page`;
      const state = await fixture.sql`SELECT parse_state FROM opening_sources WHERE id = ${source.id}`;
      expect(state[0].parse_state).toBe("ready");
      expect(rows.map((row) => ({ page: row.page, text: row.text, sourceVersion: row.source_version }))).toEqual([{ page: 1, text: expect.stringContaining("page one"), sourceVersion: source.version }, { page: 2, text: expect.stringContaining("page two"), sourceVersion: source.version }]);
      expect(await readdir(tempDir)).toEqual([]);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }, 120_000);

  it("marks audio uploads unsupported without creating chunks", async () => {
    const source = await upload("recording.mp3", "audio/mpeg", Buffer.from("ID3\x04\x00junk"));
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "opening-parser-integration-"));
    try {
      await parse(source.id, tempDir);
      const state = await fixture.sql`SELECT parse_state FROM opening_sources WHERE id = ${source.id}`;
      const chunks = await fixture.sql`SELECT count(*)::int AS count FROM opening_source_chunks WHERE source_id = ${source.id}`;
      expect(state[0].parse_state).toBe("unsupported");
      expect(chunks[0].count).toBe(0);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }, 120_000);
});
