import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpeningBackup } from "@aistudy/domain";
import { writeOpeningBackupArchive, readOpeningBackupArchive } from "./opening-backup-archive";

const workspaceId = "a1000000-0000-4000-8000-000000000001";
const sourceId = "c3000000-0000-4000-8000-000000000010";
const secondSourceId = "d4000000-0000-4000-8000-000000000020";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const roots: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-archive-"));
  roots.push(directory);
  return directory;
}

async function fixture(directory: string): Promise<{ draft: OpeningBackup; staging: string }> {
  const staging = path.join(directory, "staging");
  await mkdir(path.join(staging, "objects", sourceId), { recursive: true });
  await writeFile(path.join(staging, "objects", sourceId, "v1.bin"), "abcd");
  const draft: OpeningBackup = {
    format: "opening-backup",
    version: 1,
    workspaceId,
    privacyEpoch: 4,
    deletionJournal: [],
    tables: { opening_sources: [{ id: sourceId, workspace_id: workspaceId }] },
    objects: [{ sourceId, sha256: hash("abcd"), bytes: 4, archivePath: `objects/${sourceId}/v1.bin` }],
  };
  return { draft, staging };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("opening backup archive", () => {
  it("writes a draft plus object bytes and reads back verified metadata and bytes", async () => {
    const directory = await scratch();
    const { draft, staging } = await fixture(directory);
    const destination = path.join(directory, "backup.opening");

    await writeOpeningBackupArchive(draft, staging, destination);
    const archive = await readOpeningBackupArchive(destination);

    expect(archive.metadata).toEqual(draft);
    const chunks: Uint8Array[] = [];
    for await (const chunk of archive.objectBytes(`objects/${sourceId}/v1.bin`)) chunks.push(chunk);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe("abcd");
    await archive.close();
  });

  it("reads multiple objects by declared path in any order", async () => {
    const directory = await scratch();
    const staging = path.join(directory, "staging");
    await mkdir(path.join(staging, "objects", sourceId), { recursive: true });
    await mkdir(path.join(staging, "objects", secondSourceId), { recursive: true });
    await writeFile(path.join(staging, "objects", sourceId, "v1.bin"), "first");
    await writeFile(path.join(staging, "objects", secondSourceId, "v1.bin"), "second");
    const draft: OpeningBackup = {
      format: "opening-backup", version: 1, workspaceId, privacyEpoch: 4, deletionJournal: [],
      tables: { opening_sources: [
        { id: sourceId, workspace_id: workspaceId },
        { id: secondSourceId, workspace_id: workspaceId },
      ] },
      objects: [
        { sourceId, sha256: hash("first"), bytes: 5, archivePath: `objects/${sourceId}/v1.bin` },
        { sourceId: secondSourceId, sha256: hash("second"), bytes: 6, archivePath: `objects/${secondSourceId}/v1.bin` },
      ],
    };
    const destination = path.join(directory, "multi.opening");
    await writeOpeningBackupArchive(draft, staging, destination);
    const archive = await readOpeningBackupArchive(destination);
    const read = async (archivePath: string) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of archive.objectBytes(archivePath)) chunks.push(chunk);
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
    };
    expect(await read(`objects/${secondSourceId}/v1.bin`)).toBe("second");
    expect(await read(`objects/${sourceId}/v1.bin`)).toBe("first");
    expect(await Promise.all([read(`objects/${sourceId}/v1.bin`), read(`objects/${secondSourceId}/v1.bin`)])).toEqual(["first", "second"]);
    await archive.close();
  });

  it("refuses to overwrite and removes partial output when a staged object is missing", async () => {
    const directory = await scratch();
    const { draft, staging } = await fixture(directory);
    const destination = path.join(directory, "backup.opening");
    await writeOpeningBackupArchive(draft, staging, destination);

    await expect(writeOpeningBackupArchive(draft, staging, destination)).rejects.toThrow(/exists/i);
    const broken = { ...draft, objects: [{ ...draft.objects[0]!, archivePath: "objects/missing.bin" }] };
    const other = path.join(directory, "other.opening");
    await expect(writeOpeningBackupArchive(broken, staging, other)).rejects.toThrow(/mismatch/i);
    await expect(readdir(directory)).resolves.toEqual(["backup.opening", "staging"]);
  });

  it("fails closed on truncated files, unknown members, and corrupted bytes", async () => {
    const directory = await scratch();
    const { draft, staging } = await fixture(directory);
    const destination = path.join(directory, "backup.opening");
    await writeOpeningBackupArchive(draft, staging, destination);
    const good = await readFile(destination);

    await writeFile(path.join(directory, "short.opening"), good.subarray(0, 10));
    const shortArchive = readOpeningBackupArchive(path.join(directory, "short.opening"));
    await expect(shortArchive).rejects.toThrow(/not an opening backup archive/i);

    const tampered = Buffer.from(good);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
    await writeFile(path.join(directory, "bad.opening"), tampered);
    const bad = await readOpeningBackupArchive(path.join(directory, "bad.opening"));
    const stream = bad.objectBytes(`objects/${sourceId}/v1.bin`);
    await expect((async () => {
      for await (const _chunk of stream) void _chunk;
    })()).rejects.toThrow(/object verification failed/i);
    await bad.close();

    const archive = await readOpeningBackupArchive(destination);
    expect(() => archive.objectBytes("objects/other.bin")).toThrow(/unknown archive object/i);
    await archive.close();
  });
});
