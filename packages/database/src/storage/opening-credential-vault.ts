import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type EncryptedCredential = {
  keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer; payloadHash: string;
};
/** Full 128-bit GCM tag; shorter (truncated) tags must never authenticate. */
const AUTH_TAG_LENGTH = 16;
export class CredentialVaultError extends Error {
  readonly code = "CREDENTIAL_VAULT_CONFIG";
}
function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new CredentialVaultError("connection credential key must be canonical 32-byte base64");
  }
  return key;
}
function activeKey(): { keyId: string; key: Buffer } {
  const raw = process.env.OPENING_CONNECTION_KEY?.trim() ?? "";
  const keyId = process.env.OPENING_CONNECTION_KEY_ID?.trim() || "primary";
  if (!raw) throw new CredentialVaultError("connection credential encryption is not configured");
  if (keyId.length > 120) throw new CredentialVaultError("connection credential keyId is invalid");
  return { keyId, key: parseKey(raw) };
}
function readKey(keyId: string): Buffer {
  const current = activeKey();
  if (keyId === current.keyId) return current.key;
  let previous: unknown;
  try { previous = JSON.parse(process.env.OPENING_CONNECTION_PREVIOUS_KEYS || "{}"); }
  catch { throw new CredentialVaultError("previous connection keys are invalid"); }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)
    || !Object.hasOwn(previous, keyId) || typeof (previous as Record<string, unknown>)[keyId] !== "string") {
    throw new CredentialVaultError("connection credential keyId is unavailable");
  }
  return parseKey((previous as Record<string, string>)[keyId]!);
}

/**
 * Domain-separated AES-256-GCM envelope encryption. The AAD binds ciphertext to
 * its purpose and coordinates, so a blob stored for one domain can never be
 * decrypted as another. `domain` must be a stable literal per record kind.
 */
function encryptSecret(input: {
  domain: string; workspaceId: string; recordId: string; secret: string;
}): { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  const { keyId, key } = activeKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(JSON.stringify([input.domain, input.workspaceId, input.recordId, keyId])));
  return {
    keyId, nonce, ciphertext: Buffer.concat([cipher.update(input.secret, "utf8"), cipher.final()]),
    authTag: cipher.getAuthTag(),
  };
}
function decryptSecret(input: {
  domain: string; workspaceId: string; recordId: string;
  keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer;
}): string {
  const decipher = createDecipheriv("aes-256-gcm", readKey(input.keyId), input.nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(Buffer.from(JSON.stringify([input.domain, input.workspaceId, input.recordId, input.keyId])));
  decipher.setAuthTag(input.authTag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
}

/** Key material plus a replay fingerprint over the plaintext secret (connection feature). */
function connectionEnvelope(input: {
  workspaceId: string; connectionId: string; secret: string;
}): { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer; payloadHash: string } {
  const parts = encryptSecret({ domain: "opening-connection", workspaceId: input.workspaceId, recordId: input.connectionId, secret: input.secret });
  return { ...parts, payloadHash: connectionCredentialFingerprint({ ...input, keyId: parts.keyId }) };
}
export function connectionCredentialFingerprint(input: {
  workspaceId: string; connectionId: string; secret: string; keyId: string;
}): string {
  const digest = createHmac("sha256", readKey(input.keyId))
    .update(JSON.stringify(["opening-credential-replay", input.workspaceId, input.connectionId, input.secret]))
    .digest("hex");
  return JSON.stringify([input.keyId, digest]);
}

export function encryptConnectionCredential(input: {
  workspaceId: string; connectionId: string; secret: string;
}): EncryptedCredential {
  return connectionEnvelope(input);
}
export function decryptConnectionCredential(input: EncryptedCredential & {
  workspaceId: string; connectionId: string;
}): string {
  const decipher = createDecipheriv("aes-256-gcm", readKey(input.keyId), input.nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(Buffer.from(JSON.stringify(["opening-connection", input.workspaceId, input.connectionId, input.keyId])));
  decipher.setAuthTag(input.authTag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
}

/** Workspace model provider API keys; no replay ledger, PUT-overwrite semantics. */
export function encryptWorkspaceSecret(input: {
  workspaceId: string; providerId: string; secret: string;
}): { keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
  return encryptSecret({ domain: "opening-model-provider", workspaceId: input.workspaceId, recordId: input.providerId, secret: input.secret });
}
export function decryptWorkspaceSecret(input: {
  workspaceId: string; providerId: string;
  keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer;
}): string {
  return decryptSecret({ domain: "opening-model-provider", workspaceId: input.workspaceId, recordId: input.providerId, keyId: input.keyId, nonce: input.nonce, ciphertext: input.ciphertext, authTag: input.authTag });
}
