import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptConnectionCredential, decryptWorkspaceSecret, encryptWorkspaceSecret } from "./opening-credential-vault";
const connection = { workspaceId: "11111111-1111-4111-8111-111111111111", connectionId: "22222222-2222-4222-8222-222222222222", secret: "mail-password" };
const provider = { workspaceId: connection.workspaceId, providerId: "33333333-3333-4333-8333-333333333333", secret: "sk-provider-key" };
beforeEach(() => {
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace secret vault", () => {
  it("binds envelopes to the provider domain and coordinates", () => {
    const a = encryptWorkspaceSecret(provider);
    const b = encryptWorkspaceSecret(provider);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.toString("utf8")).not.toContain(provider.secret);
    expect(decryptWorkspaceSecret({ workspaceId: provider.workspaceId, providerId: provider.providerId, ...a })).toBe(provider.secret);
    // Cross-domain replay of a workspace envelope must never decrypt as a connection secret.
    expect(() => decryptConnectionCredential({
      workspaceId: provider.workspaceId, connectionId: provider.providerId,
      keyId: a.keyId, nonce: a.nonce, ciphertext: a.ciphertext, authTag: a.authTag, payloadHash: "",
    })).toThrow();
    // Same domain but a different provider id must also fail.
    expect(() => decryptWorkspaceSecret({ workspaceId: provider.workspaceId, providerId: "another", ...a })).toThrow();
    const tampered = Buffer.from(a.ciphertext); tampered[0] = tampered[0]! ^ 1;
    expect(() => decryptWorkspaceSecret({ workspaceId: provider.workspaceId, providerId: provider.providerId, ...a, ciphertext: tampered })).toThrow();
  });
  it("decrypts envelopes written under a rotated-out key", () => {
    const encrypted = encryptWorkspaceSecret(provider);
    vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", JSON.stringify({ "test-key": process.env.OPENING_CONNECTION_KEY }));
    vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    vi.stubEnv("OPENING_CONNECTION_KEY_ID", "next-key");
    expect(decryptWorkspaceSecret({ workspaceId: provider.workspaceId, providerId: provider.providerId, ...encrypted })).toBe(provider.secret);
    expect(encryptWorkspaceSecret(provider).keyId).toBe("next-key");
  });
  it("fails closed when the vault key is missing", () => {
    vi.stubEnv("OPENING_CONNECTION_KEY", "");
    expect(() => encryptWorkspaceSecret(provider)).toThrow(/not configured/i);
  });
});
