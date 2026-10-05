import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptConnectionCredential, encryptConnectionCredential } from "./credential-vault";
const input = { workspaceId: "11111111-1111-4111-8111-111111111111", connectionId: "22222222-2222-4222-8222-222222222222", secret: "mail-password" };
beforeEach(() => {
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
});
afterEach(() => vi.unstubAllEnvs());
const decrypt = (value: ReturnType<typeof encryptConnectionCredential>) => decryptConnectionCredential({ ...value, workspaceId: input.workspaceId, connectionId: input.connectionId });
describe("connection credential vault", () => {
  it("uses unique nonces, bound AAD and a keyed fingerprint", () => {
    const a = encryptConnectionCredential(input); const b = encryptConnectionCredential(input);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.toString("utf8")).not.toContain(input.secret);
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).not.toBe(encryptConnectionCredential({ ...input, connectionId: "another" }).payloadHash);
    expect(decrypt(a)).toBe(input.secret);
    expect(() => decryptConnectionCredential({ ...a, workspaceId: "another", connectionId: input.connectionId })).toThrow();
    expect(() => decryptConnectionCredential({ ...a, workspaceId: input.workspaceId, connectionId: "another" })).toThrow();
    const tampered = Buffer.from(a.ciphertext); tampered[0] = tampered[0]! ^ 1;
    expect(() => decrypt({ ...a, ciphertext: tampered })).toThrow();
  });
  it("decrypts a retained old key after rotation, and refuses an unknown keyId", () => {
    const encrypted = encryptConnectionCredential(input);
    vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", JSON.stringify({ "test-key": process.env.OPENING_CONNECTION_KEY }));
    vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    vi.stubEnv("OPENING_CONNECTION_KEY_ID", "next-key");
    expect(decrypt(encrypted)).toBe(input.secret);
    expect(encryptConnectionCredential(input).keyId).toBe("next-key");
    expect(() => decrypt({ ...encrypted, keyId: "missing" })).toThrow(/key/i);
  });
  it("fails closed for missing, malformed or non-canonical keys", () => {
    vi.stubEnv("OPENING_CONNECTION_KEY", "");
    expect(() => encryptConnectionCredential(input)).toThrow(/not configured/i);
    vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(16).toString("base64"));
    expect(() => encryptConnectionCredential(input)).toThrow(/32-byte/i);
    vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32).toString("base64") + "!");
    expect(() => encryptConnectionCredential(input)).toThrow(/32-byte/i);
  });
});
