import { createHash } from "node:crypto";
import type { UploadInput } from "@aistudy/contracts";
import { magicMatchesMime } from "@aistudy/database";

export class UploadPolicyError extends Error {
  readonly code = "UPLOAD_MISMATCH" as const;
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "UploadPolicyError";
  }
}

/** Hash/meter incrementally. A failed EOF check errors before S3 can commit. */
export function validatedUploadStream(
  body: ReadableStream<Uint8Array>,
  expected: UploadInput,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  const firstBytes = new Uint8Array(16);
  let firstCount = 0;
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (chunk.byteLength > expected.bytes - bytes) throw new UploadPolicyError("请求体过大", 413);
      bytes += chunk.byteLength;
      hash.update(chunk);
      const count = Math.min(chunk.byteLength, firstBytes.length - firstCount);
      firstBytes.set(chunk.subarray(0, count), firstCount);
      firstCount += count;
      controller.enqueue(chunk);
    },
    flush() {
      validateStoredUpload(expected, { bytes, sha256: hash.digest("hex"), mime: expected.mime });
      if (!magicMatchesMime(firstBytes.subarray(0, firstCount), expected.mime)) {
        throw new UploadPolicyError("stored object magic bytes do not match declared MIME");
      }
    },
  }), { signal });
}

export type StoredUploadActual = {
  bytes: number;
  sha256: string;
  mime: string;
};

/** Completion boundary: object must match beginUpload expectations exactly. */
export function validateStoredUpload(
  expected: UploadInput,
  actual: StoredUploadActual,
): void {
  if (actual.bytes !== expected.bytes) {
    throw new UploadPolicyError(
      `stored bytes ${actual.bytes} != expected ${expected.bytes}`,
    );
  }
  if (actual.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
    throw new UploadPolicyError("stored sha256 does not match expected");
  }
  if (actual.mime !== expected.mime) {
    throw new UploadPolicyError(
      `stored mime ${actual.mime} != expected ${expected.mime}`,
    );
  }
}
