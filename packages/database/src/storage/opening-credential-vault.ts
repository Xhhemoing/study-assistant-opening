import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export type EncryptedCredential = {
  keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer; payloadHash: string;
};
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
function aad(workspaceId: string, connectionId: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify(["opening-connection", workspaceId, connectionId, keyId]));
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
  const { keyId, key } = activeKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(input.workspaceId, input.connectionId, keyId));
  return {
    keyId, nonce, ciphertext: Buffer.concat([cipher.update(input.secret, "utf8"), cipher.final()]),
    authTag: cipher.getAuthTag(), payloadHash: connectionCredentialFingerprint({ ...input, keyId }),
  };
}
export function decryptConnectionCredential(input: EncryptedCredential & {
  workspaceId: string; connectionId: string;
}): string {
  const decipher = createDecipheriv("aes-256-gcm", readKey(input.keyId), input.nonce);
  decipher.setAAD(aad(input.workspaceId, input.connectionId, input.keyId));
  decipher.setAuthTag(input.authTag);
  return Buffer.concat([decipher.update(input.ciphertext), decipher.final()]).toString("utf8");
}
