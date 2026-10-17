import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { S3ClientLike } from "./opening-s3";

export const OPENING_UPLOAD_PART_BYTES = 5 * 1024 * 1024;
export type OpeningStreamUploadOptions = { mime?: string; bytes?: number; signal?: AbortSignal };

/** One in-flight part; never accumulates the whole request in memory. */
export async function uploadOpeningMultipart(
  client: S3ClientLike,
  bucket: string,
  key: string,
  body: ReadableStream<Uint8Array>,
  input: OpeningStreamUploadOptions,
  mapError: (error: unknown) => Error,
): Promise<void> {
  if (input.bytes !== undefined && (!Number.isSafeInteger(input.bytes) || input.bytes <= 0)) {
    void body.cancel().catch(() => undefined);
    throw mapError(new Error("Invalid upload byte hint"));
  }
  const reader = body.getReader();
  let uploadId: string | undefined;
  let completed = false;
  const assertActive = () => {
    if (input.signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
  };
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  input.signal?.addEventListener("abort", cancelReader, { once: true });
  const send = async (command: unknown) => {
    assertActive();
    try { return await client.send(command, { abortSignal: input.signal }); }
    catch (error) {
      assertActive();
      throw mapError(error);
    }
  };
  try {
    const created = await send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.mime }));
    uploadId = typeof created.UploadId === "string" ? created.UploadId : undefined;
    if (!uploadId) throw mapError(new Error("Missing multipart upload id"));
    // The expected length is a hint for small, single-part documents. Larger
    // uploads use S3's minimum non-final part size, independent of request size.
    const partBytes = Math.min(OPENING_UPLOAD_PART_BYTES, input.bytes ?? OPENING_UPLOAD_PART_BYTES);
    let part = new Uint8Array(partBytes);
    let filled = 0;
    const parts: { ETag: string; PartNumber: number }[] = [];
    const uploadPart = async () => {
      const partNumber = parts.length + 1;
      const result = await send(new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
        Body: part.subarray(0, filled), ContentLength: filled,
      }));
      if (typeof result.ETag !== "string" || !result.ETag) throw mapError(new Error("Missing multipart part ETag"));
      parts.push({ ETag: result.ETag, PartNumber: partNumber });
      part = new Uint8Array(partBytes);
      filled = 0;
    };
    while (true) {
      assertActive();
      const { done, value } = await reader.read();
      assertActive();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(partBytes - filled, value.byteLength - offset);
        part.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === partBytes) await uploadPart();
      }
    }
    if (filled) await uploadPart();
    if (!parts.length) throw mapError(new Error("Empty upload"));
    await send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    completed = true;
  } finally {
    input.signal?.removeEventListener("abort", cancelReader);
    if (!completed) {
      cancelReader();
      if (uploadId) {
        try {
          // Request cancellation must not cancel cleanup as well. Bound cleanup
          // independently; a storage outage still requires bucket MPU lifecycle GC.
          await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(5_000) });
        } catch {
          console.error("UPLOAD_MULTIPART_ABORT_FAILED", { code: "STORAGE_UNAVAILABLE" });
        }
      }
    }
    reader.releaseLock();
  }
}
