import type { UploadInput } from "@aistudy/contracts";

export class UploadPolicyError extends Error {
  readonly code = "UPLOAD_MISMATCH" as const;
  constructor(message: string) {
    super(message);
    this.name = "UploadPolicyError";
  }
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
