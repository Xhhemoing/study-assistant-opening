import { describe, expect, it } from "vitest";
import { UploadPolicyError, validateStoredUpload } from "./upload-policy";

const expected = {
  name: "a.pdf",
  mime: "application/pdf" as const,
  bytes: 12,
  sha256: "a".repeat(64),
};

describe("validateStoredUpload", () => {
  it("rejects completion before matching the stored object", () => {
    expect(() =>
      validateStoredUpload(expected, {
        bytes: 11,
        mime: "application/pdf",
        sha256: "a".repeat(64),
      }),
    ).toThrow(UploadPolicyError);
  });

  it("rejects sha256 or mime spoof", () => {
    expect(() =>
      validateStoredUpload(expected, {
        bytes: 12,
        mime: "application/pdf",
        sha256: "b".repeat(64),
      }),
    ).toThrow(/sha256/);
    expect(() =>
      validateStoredUpload(expected, {
        bytes: 12,
        mime: "image/png",
        sha256: "a".repeat(64),
      }),
    ).toThrow(/mime/);
  });

  it("accepts an exact match", () => {
    expect(() =>
      validateStoredUpload(expected, {
        bytes: 12,
        mime: "application/pdf",
        sha256: "a".repeat(64),
      }),
    ).not.toThrow();
  });
});
