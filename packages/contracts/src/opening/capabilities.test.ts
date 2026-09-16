import { describe, expect, it } from "vitest";
import { connectionViewSchema, imapSetupInputSchema } from "./connections";
import { emailImportInputSchema } from "./imports";
import { mediaUploadInputSchema } from "./media";
import { uploadInputSchema } from "./sources";

const U = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);

describe("X01 capability contracts", () => {
  it("never exposes credentials in a connection view", () => {
    expect(connectionViewSchema.safeParse({
      id: U, version: 0, kind: "imap", label: "学校", state: "disabled",
      allowedScopes: [], lastSuccessAt: null, errorCode: null, secret: "private",
    }).success).toBe(false);
  });

  it("rejects invalid TLS modes", () => {
    expect(imapSetupInputSchema.safeParse({
      label: "学校", host: "imap.example.edu", port: 993, tlsMode: "plain",
      username: "student", folders: ["INBOX"], since: "2026-09-01", clientKey: "client-key",
    }).success).toBe(false);
  });

  it("accepts video and rejects video over 512 MiB", () => {
    const base = { name: "lesson.mp4", mime: "video/mp4" as const, sha256: SHA };
    expect(mediaUploadInputSchema.safeParse({ ...base, bytes: 512 * 1024 * 1024 }).success).toBe(true);
    expect(mediaUploadInputSchema.safeParse({ ...base, bytes: 512 * 1024 * 1024 + 1 }).success).toBe(false);
  });

  it("accepts eml and rejects mail over 25 MiB", () => {
    expect(emailImportInputSchema.safeParse({ name: "message.eml", mime: "message/rfc822", bytes: 25 * 1024 * 1024, sha256: SHA }).success).toBe(true);
    expect(emailImportInputSchema.safeParse({ name: "message.eml", mime: "message/rfc822", bytes: 25 * 1024 * 1024 + 1, sha256: SHA }).success).toBe(false);
  });

  it("keeps legacy PDF source input valid", () => {
    expect(uploadInputSchema.safeParse({ name: "notes.pdf", mime: "application/pdf", bytes: 12, sha256: SHA }).success).toBe(true);
  });
});
