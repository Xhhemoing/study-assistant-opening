import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UploadPolicyError, validatedUploadStream, validateStoredUpload } from "./upload-policy";

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

describe("streamed upload validation", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\nexample");
  const metadata = { name: "a.pdf", mime: "application/pdf" as const, bytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex") };
  const body = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.subarray(0, 3)); controller.enqueue(bytes.subarray(3)); controller.close(); } });

  it("validates digest and split magic bytes without changing uploaded bytes", async () => {
    const actual = await new Response(validatedUploadStream(body(pdf), metadata)).arrayBuffer();
    expect(new Uint8Array(actual)).toEqual(pdf);
  });
  it("rejects oversized and truncated streams", async () => {
    await expect(new Response(validatedUploadStream(body(new Uint8Array(pdf.length + 1)), metadata)).arrayBuffer()).rejects.toMatchObject({ status: 413 });
    await expect(new Response(validatedUploadStream(body(pdf.subarray(0, 5)), metadata)).arrayBuffer()).rejects.toThrow(/bytes/);
  });
  it("rejects hash or magic mismatch at EOF", async () => {
    await expect(new Response(validatedUploadStream(body(pdf), { ...metadata, sha256: "a".repeat(64) })).arrayBuffer()).rejects.toThrow(/sha256/);
    const spoof = new Uint8Array(pdf.length);
    await expect(new Response(validatedUploadStream(body(spoof), { ...metadata, sha256: createHash("sha256").update(spoof).digest("hex") })).arrayBuffer()).rejects.toThrow(/magic/);
  });
});
