import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { open } from "node:fs/promises";
import { writeExclusiveOpeningBackupFile } from "./opening-backup-file-publication";

/** Envelope format: MAGIC | u16 salt len | u16 nonce len | salt | nonce | ciphertext | 16-byte GCM tag. */
const MAGIC = Buffer.from("OPENING-ENC-V1", "utf8");
const HEADER_FIXED = MAGIC.length + 2 + 2;
const KEY_LEN = 32;
const TAG_LEN = 16;
const CHUNK = 256 * 1024;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function fail(message: string): Error {
  return new Error(message);
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (typeof passphrase !== "string" || passphrase.length === 0) throw fail("passphrase required");
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_LEN, SCRYPT);
}

async function readExact(handle: import("node:fs/promises").FileHandle, length: number, message: string): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, null);
    if (bytesRead === 0) throw fail(message);
    offset += bytesRead;
  }
  return buffer;
}

/** Stream-encrypts a file with AES-256-GCM. Salt and nonce are random per file; the passphrase is never stored. */
export async function encryptOpeningArchive(source: string, destination: string, passphrase: string): Promise<void> {
  await writeExclusiveOpeningBackupFile(destination, "output already exists", async (out) => {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), nonce);
    const header = Buffer.alloc(HEADER_FIXED + salt.length + nonce.length);
    MAGIC.copy(header, 0);
    header.writeUInt16BE(salt.length, MAGIC.length);
    header.writeUInt16BE(nonce.length, MAGIC.length + 2);
    salt.copy(header, HEADER_FIXED);
    nonce.copy(header, HEADER_FIXED + salt.length);
    await out.write(header);
    const input = await open(source, "r");
    try {
      const buffer = Buffer.alloc(CHUNK);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, CHUNK, null);
        if (bytesRead === 0) break;
        await out.write(cipher.update(buffer.subarray(0, bytesRead)));
      }
    } finally {
      await input.close();
    }
    await out.write(cipher.final());
    await out.write(cipher.getAuthTag());
    await out.sync().catch(() => undefined);
  });
}

/** Stream-decrypts and authenticates the whole ciphertext before publishing the output. Fails closed on tampering. */
export async function decryptOpeningArchive(source: string, destination: string, passphrase: string): Promise<void> {
  await writeExclusiveOpeningBackupFile(destination, "output already exists", async (out) => {
    let handle;
    try {
      handle = await open(source, "r");
    } catch {
      throw fail("not an encrypted opening archive");
    }
    try {
      const magic = await readExact(handle, MAGIC.length, "not an encrypted opening archive");
      if (!magic.equals(MAGIC)) throw fail("not an encrypted opening archive");
      const lengths = await readExact(handle, 4, "not an encrypted opening archive");
      const saltLen = lengths.readUInt16BE(0);
      const nonceLen = lengths.readUInt16BE(2);
      if (saltLen < 8 || saltLen > 128 || nonceLen !== 12) throw fail("not an encrypted opening archive");
      const salt = await readExact(handle, saltLen, "not an encrypted opening archive");
      const nonce = await readExact(handle, nonceLen, "not an encrypted opening archive");
      const size = (await handle.stat()).size;
      const ciphertextLength = size - MAGIC.length - 4 - saltLen - nonceLen - TAG_LEN;
      if (ciphertextLength <= 0) throw fail("not an encrypted opening archive");
      const tag = Buffer.alloc(TAG_LEN);
      await handle.read(tag, 0, TAG_LEN, size - TAG_LEN);
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), nonce);
      decipher.setAuthTag(tag);
      let remaining = ciphertextLength;
      while (remaining > 0) {
        const slice = Math.min(CHUNK, remaining);
        const chunk = await readExact(handle, slice, "not an encrypted opening archive");
        await out.write(decipher.update(chunk));
        remaining -= slice;
      }
      try {
        await out.write(decipher.final());
      } catch {
        throw fail("decryption failed");
      }
    } finally {
      await handle.close();
    }
  });
}
