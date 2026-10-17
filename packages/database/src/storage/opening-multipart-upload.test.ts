import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { OPENING_UPLOAD_PART_BYTES } from "./opening-multipart-upload";
import { OpeningS3, type S3ClientLike } from "./opening-s3";

function storage(send: S3ClientLike["send"]) {
  return new OpeningS3({ endpoint: "http://minio", region: "test", bucket: "test", accessKeyId: "test", secretAccessKey: "test", forcePathStyle: true }, { send });
}
function bytesStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

describe("bounded S3 multipart uploads", () => {
  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid byte hint %s before starting multipart storage", async (bytes) => {
    let cancelled = false;
    const send = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(storage(send).putObjectStream("staging/a", body, { bytes })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it("uploads ordered parts and commits only after the source reaches EOF", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      if (command instanceof UploadPartCommand) return { ETag: `etag-${command.input.PartNumber}` };
      return {};
    });
    const bytes = new Uint8Array(OPENING_UPLOAD_PART_BYTES + 13);
    await storage(send).putObjectStream("staging/a", bytesStream(bytes), { bytes: bytes.length, mime: "video/mp4" });
    const parts = commands.filter((command): command is UploadPartCommand => command instanceof UploadPartCommand);
    expect(parts.map(({ input }) => [input.PartNumber, input.ContentLength])).toEqual([[1, OPENING_UPLOAD_PART_BYTES], [2, 13]]);
    const complete = commands.at(-1) as CompleteMultipartUploadCommand;
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(complete.input.MultipartUpload?.Parts).toEqual([{ ETag: "etag-1", PartNumber: 1 }, { ETag: "etag-2", PartNumber: 2 }]);
  });

  it("applies backpressure while a part is in flight instead of buffering the whole body", async () => {
    const totalBytes = 4 * OPENING_UPLOAD_PART_BYTES;
    const chunkBytes = 64 * 1024;
    let produced = 0;
    let releasePart!: () => void;
    let firstPartStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstPartStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releasePart = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === totalBytes) { controller.close(); return; }
        produced += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) {
        if (command.input.PartNumber === 1) { firstPartStarted(); await blocked; }
        return { ETag: `etag-${command.input.PartNumber}` };
      }
      return {};
    });
    const uploading = storage(send).putObjectStream("staging/a", body, { bytes: totalBytes });
    await started;
    expect(produced).toBeLessThanOrEqual(OPENING_UPLOAD_PART_BYTES + chunkBytes);
    expect(produced).toBeLessThan(totalBytes);
    releasePart();
    await uploading;
  });

  it("aborts partial objects when a reader/validation error occurs", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new Uint8Array(OPENING_UPLOAD_PART_BYTES));
        else controller.error(new Error("size validation failed"));
      },
    }, { highWaterMark: 0 });
    const send = vi.fn(async (command: unknown) => command instanceof CreateMultipartUploadCommand ? { UploadId: "upload" } : command instanceof UploadPartCommand ? { ETag: "etag" } : {});
    await expect(storage(send).putObjectStream("staging/a", body)).rejects.toThrow("size validation failed");
    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand)).toBe(false);
    expect(body.locked).toBe(false);
  });

  it("cancels a stalled body and cleans up using a fresh signal after request abort", async () => {
    let cancelled = false;
    let created!: () => void;
    const creation = new Promise<void>((resolve) => { created = resolve; });
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const send = vi.fn(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof CreateMultipartUploadCommand) { created(); return { UploadId: "upload" }; }
      if (command instanceof AbortMultipartUploadCommand) expect(options?.abortSignal?.aborted).toBe(false);
      return {};
    });
    const uploading = storage(send).putObjectStream("staging/a", body, { signal: abort.signal });
    await creation;
    abort.abort();
    await expect(uploading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
  });

  it("maps transport errors and still aborts the current upload", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
      if (command instanceof UploadPartCommand) throw new Error("private-storage-credential");
      return {};
    });
    await expect(storage(send).putObjectStream("staging/a", bytesStream(new Uint8Array([1])), { bytes: 1 })).rejects.toMatchObject({ code: "UNAVAILABLE", message: "storage service unavailable" });
    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
  });

  it("reports failed cleanup without losing the original failure or logging private storage details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const send = vi.fn(async (command: unknown) => {
        if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload" };
        throw new Error("private-storage-credential");
      });
      await expect(storage(send).putObjectStream("staging/a", bytesStream(new Uint8Array([1])), { bytes: 1 })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(log).toHaveBeenCalledWith("UPLOAD_MULTIPART_ABORT_FAILED", { code: "STORAGE_UNAVAILABLE" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-storage");
    } finally { log.mockRestore(); }
  });
});
