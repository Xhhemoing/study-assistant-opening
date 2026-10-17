import { createHash } from "node:crypto";
import { ListMultipartUploadsCommand, ListPartsCommand } from "@aws-sdk/client-s3";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpeningSourceService } from "../../apps/web/src/features/opening/sources/source-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { createOpeningTestStorage } from "./opening-storage-fixture";

const storage = createOpeningTestStorage();
let fixture: OpeningFixture;
let service: ReturnType<typeof createOpeningSourceService>;
let principal: { userId: string; workspaceId: string; sessionId: string };
const keys: string[] = [];

beforeAll(async () => {
  fixture = await createOpeningFixture();
  service = createOpeningSourceService(fixture.sql, storage);
  principal = { userId: fixture.scope.ownerUserId, workspaceId: fixture.scope.workspaceId, sessionId: "stream-integration" };
});
beforeEach(async () => { await fixture.reset(); });
afterAll(async () => { for (const key of keys) await storage.deleteObject(key); await fixture?.close(); });

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 64 * 1024);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}
async function ticket(bytes: Uint8Array) {
  const result = await service.beginUpload(principal, { name: "stream.pdf", mime: "application/pdf", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  keys.push(storage.stagingKey(result.source.id), storage.finalKey(result.source.id, result.source.version));
  return result;
}
async function noPartialObject(sourceId: string) {
  const key = storage.stagingKey(sourceId);
  expect((await storage.headObject(key)).exists).toBe(false);
  const uploads = await storage.client.send(new ListMultipartUploadsCommand({ Bucket: storage.bucket, Prefix: key }));
  expect(uploads.Uploads ?? []).toHaveLength(0);
}

describe("streaming staging uploads against real PostgreSQL + MinIO", () => {
  it("uploads more than one part and completes the existing digest/magic verification", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6 * 1024 * 1024, 0x78)]);
    const upload = await ticket(bytes);
    await service.putStagingStream(principal, upload.source.id, { contentType: "application/pdf", body: stream(bytes) });
    const done = await service.completeUpload(principal, upload.source.id);
    expect(done.uploadState).toBe("uploaded");
    const digest = await storage.streamDigest(storage.finalKey(done.id, done.version));
    expect(digest.bytes).toBe(bytes.length);
    expect(digest.sha256).toBe(upload.source.sha256);
  });

  it("aborts multipart state on short, oversized, or hash-mismatched streams", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6 * 1024 * 1024, 0x78)]);
    for (const actual of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([1])]), Buffer.alloc(bytes.length, 0x79)]) {
      const upload = await ticket(bytes);
      await expect(service.putStagingStream(principal, upload.source.id, { contentType: "application/pdf", body: stream(actual) })).rejects.toThrow(/bytes|sha256|过大/);
      await noPartialObject(upload.source.id);
    }
  });

  it("cancels an in-progress stream and leaves no staging object or multipart upload", async () => {
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6 * 1024 * 1024, 0x78)]);
    const upload = await ticket(bytes);
    const abort = new AbortController();
    let cancelled = false;
    let emitted = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (!emitted) { emitted = true; controller.enqueue(bytes.subarray(0, 5 * 1024 * 1024)); } },
      cancel() { cancelled = true; },
    });
    const uploading = service.putStagingStream(principal, upload.source.id, { contentType: "application/pdf", body, signal: abort.signal });
    let confirmedPart = false;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const pending = await storage.client.send(new ListMultipartUploadsCommand({ Bucket: storage.bucket, Prefix: storage.stagingKey(upload.source.id) }));
        if (pending.Uploads?.[0]?.UploadId) {
          const parts = await storage.client.send(new ListPartsCommand({ Bucket: storage.bucket, Key: storage.stagingKey(upload.source.id), UploadId: pending.Uploads[0].UploadId }));
          if (parts.Parts?.length) { confirmedPart = true; break; }
        }
        await setTimeout(20);
      }
    } finally { abort.abort(); }
    await expect(uploading).rejects.toThrow(/取消/);
    expect(confirmedPart).toBe(true);
    expect(cancelled).toBe(true);
    await noPartialObject(upload.source.id);
  }, 10_000);
});
