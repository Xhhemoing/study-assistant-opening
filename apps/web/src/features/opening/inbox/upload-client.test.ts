import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import { createUploadClient, sha256Hex } from "./upload-client";

const ISO = "2026-09-21T00:00:00.000Z";
const ID = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function pdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function source(patch: Partial<SourceRecord> = {}): SourceRecord {
  const bytes = pdfBytes();
  return {
    id: ID,
    workspaceId: WS,
    name: "notes.pdf",
    mime: "application/pdf",
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    version: 0,
    uploadState: "pending",
    parseState: "not_started",
    error: null,
    createdAt: ISO,
    ...patch,
  };
}

function ticket(patch: Partial<SourceRecord> = {}): UploadTicket {
  return {
    source: source(patch),
    uploadUrl: "https://minio.local/aistudy/opening/staging/object?X-Amz-Signature=abc",
    expiresAt: ISO,
  };
}

describe("createUploadClient", () => {
  it("computes SHA-256 with the browser Web Crypto API", async () => {
    await expect(sha256Hex(pdfBytes())).resolves.toBe(
      "e16fa5d9b51928755db85b917f0297babaf22c7a47e97d9212adab56e61ba04e",
    );
  });
  it("puts private bytes before complete and reports actual byte progress", async () => {
    const bytes = pdfBytes();
    const calls: string[] = [];
    const progress: number[] = [];
    const begin = vi.fn(async () => {
      calls.push("begin");
      return ticket();
    });
    const complete = vi.fn(async () => {
      calls.push("complete");
      return source({ uploadState: "uploaded" });
    });
    let putLoaded = 0;
    const put = vi.fn(async (_url: string, body: Uint8Array, onProgress: (loaded: number) => void, mime: string) => {
      calls.push("put");
      expect(body).toEqual(bytes);
      expect(mime).toBe("application/pdf");
      putLoaded = 3;
      onProgress(putLoaded);
      putLoaded = bytes.byteLength;
      onProgress(putLoaded);
    });
    const client = createUploadClient({ begin, complete, put });
    const accepted = await client.uploadFile(
      { name: "notes.pdf", type: "application/pdf", bytes },
      { onBytes: (loaded, total) => progress.push(loaded / total) },
    );
    expect(calls).toEqual(["begin", "put", "complete"]);
    expect(progress).toEqual([3 / bytes.byteLength, 1]);
    expect(accepted?.uploadState).toBe("uploaded");
    expect(begin).toHaveBeenCalledWith({
      name: "notes.pdf",
      mime: "application/pdf",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });

  it("does not complete or invent a second source when the private PUT fails", async () => {
    const begin = vi.fn(async () => ticket());
    const complete = vi.fn(async () => source({ uploadState: "uploaded" }));
    const put = vi.fn(async () => {
      throw new Error("put interrupted");
    });
    const client = createUploadClient({ begin, complete, put });
    const result = await client.uploadFile({
      name: "notes.pdf",
      type: "application/pdf",
      bytes: pdfBytes(),
    });
    expect(result).toMatchObject({
      phase: "interrupted",
      sourceId: ID,
      keptLocal: true,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("does not begin again when retrying an interrupted upload", async () => {
    const bytes = pdfBytes();
    const begin = vi.fn(async () => ticket());
    const complete = vi.fn(async () => source({ uploadState: "uploaded" }));
    let puts = 0;
    const put = vi.fn(async () => {
      puts += 1;
      if (puts === 1) throw new Error("backgrounded");
    });
    const client = createUploadClient({ begin, complete, put });
    const file = { name: "notes.pdf", type: "application/pdf", bytes };
    const first = await client.uploadFile(file);
    expect(first).toMatchObject({ phase: "interrupted", sourceId: ID });
    if (!("ticket" in first) || !first.ticket) throw new Error("missing ticket");
    const second = await client.uploadFile(file, { resumeSourceId: ID, ticket: first.ticket });
    expect(second).toMatchObject({ id: ID, uploadState: "uploaded" });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries completion on the same source id", async () => {
    const begin = vi.fn(async () => ticket());
    const complete = vi.fn(async () => source({ uploadState: "uploaded" }));
    const put = vi.fn(async () => undefined);
    const client = createUploadClient({ begin, complete, put });
    const file = { name: "notes.pdf", type: "application/pdf", bytes: pdfBytes() };
    await expect(client.uploadFile(file)).resolves.toMatchObject({ id: ID });
    const replay = await client.retryComplete(ID);
    expect(replay.uploadState).toBe("uploaded");
    expect(begin).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenNthCalledWith(1, ID);
    expect(complete).toHaveBeenNthCalledWith(2, ID);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported formats before begin", async () => {
    const begin = vi.fn();
    const client = createUploadClient({
      begin: begin as never,
      complete: vi.fn() as never,
      put: vi.fn() as never,
    });
    await expect(
      client.uploadFile({ name: "photo.heic", type: "", bytes: pdfBytes() }),
    ).resolves.toMatchObject({ phase: "unsupported" });
    expect(begin).not.toHaveBeenCalled();
  });
});
