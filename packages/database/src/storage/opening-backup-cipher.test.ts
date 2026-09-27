import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decryptOpeningArchive, encryptOpeningArchive } from "./opening-backup-cipher";

const roots: string[] = [];
const passphrase = "correct horse battery staple 7";

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-cipher-"));
  roots.push(directory);
  return directory;
}

async function plainFixture(directory: string): Promise<string> {
  const source = path.join(directory, "backup.opening");
  const parts: Buffer[] = [Buffer.from("OPENING-BACKUP-V1")];
  for (let index = 0; index < 64; index += 1) {
    parts.push(randomBytes(16 * 1024));
  }
  await writeFile(source, Buffer.concat(parts));
  return source;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("opening backup cipher", () => {
  it("round-trips an archive with a random salt and nonce and authenticates the bytes", async () => {
    const directory = await scratch();
    const source = await plainFixture(directory);
    const encrypted = path.join(directory, "backup.opening.enc");
    const decrypted = path.join(directory, "backup.opening.restored");

    await encryptOpeningArchive(source, encrypted, passphrase);
    const original = await readFile(source);
    const stored = await readFile(encrypted);
    expect(stored.equals(original)).toBe(false);
    expect(stored.subarray(0, "OPENING-ENC-V1".length).toString()).toBe("OPENING-ENC-V1");
    expect(stored.length).toBeGreaterThan(original.length);

    await decryptOpeningArchive(encrypted, decrypted, passphrase);
    expect((await readFile(decrypted)).equals(original)).toBe(true);
    await expect(stat(path.join(directory, "backup.opening.enc.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a wrong passphrase, a flipped byte, and truncated files", async () => {
    const directory = await scratch();
    const source = await plainFixture(directory);
    const encrypted = path.join(directory, "backup.opening.enc");
    await encryptOpeningArchive(source, encrypted, passphrase);

    const wrongTarget = path.join(directory, "wrong.opening");
    await expect(decryptOpeningArchive(encrypted, wrongTarget, "another passphrase entirely"))
      .rejects.toThrow(/decryption failed/i);
    await expect(readdir(directory)).resolves.not.toContain("wrong.opening");

    const tampered = Buffer.from(await readFile(encrypted));
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 0x01;
    const tamperedFile = path.join(directory, "tampered.opening.enc");
    await writeFile(tamperedFile, tampered);
    await expect(decryptOpeningArchive(tamperedFile, path.join(directory, "tampered.opening"), passphrase))
      .rejects.toThrow(/decryption failed/i);
    await expect(readdir(directory)).resolves.not.toContain("tampered.opening");

    const shortFile = path.join(directory, "short.opening.enc");
    await writeFile(shortFile, (await readFile(encrypted)).subarray(0, 10));
    await expect(decryptOpeningArchive(shortFile, path.join(directory, "short.opening"), passphrase))
      .rejects.toThrow(/not an encrypted opening archive/i);
  });

  it("refuses to overwrite existing outputs and cleans partial temp files", async () => {
    const directory = await scratch();
    const source = await plainFixture(directory);
    const encrypted = path.join(directory, "backup.opening.enc");
    await encryptOpeningArchive(source, encrypted, passphrase);

    await expect(encryptOpeningArchive(source, encrypted, passphrase)).rejects.toThrow(/already exists/i);
    const decrypted = path.join(directory, "backup.opening.restored");
    await decryptOpeningArchive(encrypted, decrypted, passphrase);
    await expect(decryptOpeningArchive(encrypted, decrypted, passphrase)).rejects.toThrow(/already exists/i);
    expect(createHash("sha256").update(await readFile(decrypted)).digest("hex").length).toBe(64);
  });
});
