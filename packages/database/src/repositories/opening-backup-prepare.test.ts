import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { OpeningBackupSourceError, type OpeningBackupSourceSnapshot } from "./opening-backup-sources";
import { OpeningBackupCurrentError } from "./opening-backup-current";
import { readOpeningBackupSources } from "./opening-backup-sources";
import { assertOpeningBackupSnapshotCurrent } from "./opening-backup-current";
import { prepareOpeningSourceBackup } from "./opening-backup-prepare";

vi.mock("./opening-backup-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opening-backup-sources")>();
  return { ...actual, readOpeningBackupSources: vi.fn() };
});

vi.mock("./opening-backup-current", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opening-backup-current")>();
  return { ...actual, assertOpeningBackupSnapshotCurrent: vi.fn() };
});

const readSources = vi.mocked(readOpeningBackupSources);
const assertCurrent = vi.mocked(assertOpeningBackupSnapshotCurrent);
const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-0000000000aa";
const sourceId = "c3000000-0000-4000-8000-000000000010";
const sql = {} as Sql;
const roots: string[] = [];

function snapshot(): OpeningBackupSourceSnapshot {
  const body = new TextEncoder().encode("abcd");
  return {
    workspaceId,
    privacyEpoch: 4,
    deletionJournal: [],
    sources: [{
      sourceId,
      version: 2,
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    }],
  };
}

function reader() {
  const calls: string[] = [];
  return {
    calls,
    finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
    readObject: async (key: string) => {
      calls.push(key);
      return Readable.from([new TextEncoder().encode("abcd")]);
    },
  };
}

async function parent(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-prepare-"));
  roots.push(directory);
  await writeFile(path.join(directory, "sentinel"), "keep");
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareOpeningSourceBackup", () => {
  beforeEach(() => {
    readSources.mockReset();
    assertCurrent.mockReset();
    assertCurrent.mockResolvedValue(undefined);
  });

  it("stages the copied inventory, then rechecks, and returns source staging only", async () => {
    const order: string[] = [];
    const root = await parent();
    const expected = snapshot();
    const fake = reader();
    readSources.mockImplementation(async () => {
      order.push("read");
      return expected;
    });
    assertCurrent.mockImplementation(async () => {
      order.push("recheck");
    });
    const originalRead = fake.readObject;
    fake.readObject = async (key) => {
      order.push("readObject");
      return originalRead(key);
    };

    const result = await prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, fake);

    expect(order).toEqual(["read", "readObject", "recheck"]);
    expect(result.snapshot).toEqual(expected);
    expect(result.snapshot).not.toBe(expected);
    expect(result.directory.startsWith(root)).toBe(true);
    expect(result.objects).toEqual([{
      sourceId,
      sha256: expected.sources[0]!.sha256,
      bytes: 4,
      archivePath: `objects/${sourceId}/v2.bin`,
      actualSha256: expected.sources[0]!.sha256,
    }]);
    expect(await readFile(path.join(result.directory, "objects", sourceId, "v2.bin"))).toEqual(Buffer.from("abcd"));
    expect(fake.calls).toEqual([`opening/sources/${sourceId}/v2`]);
    expect(readSources).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId });
    expect(assertCurrent).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId }, expected);
    expect("manifest" in result).toBe(false);
  });

  it("does not read objects or create staging when the owner gate rejects", async () => {
    const root = await parent();
    const fake = reader();
    readSources.mockRejectedValue(new OpeningBackupSourceError());

    const rejection = prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, fake);

    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupSourceError);
    await expect(rejection).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fake.calls).toEqual([]);
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("uses the scope copied before the owner read when the caller mutates it", async () => {
    const root = await parent();
    const mutable = { workspaceId, ownerUserId };
    let releaseRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    readSources.mockImplementation(async (_sql, received) => {
      expect(received).toEqual({ workspaceId, ownerUserId });
      expect(received).not.toBe(mutable);
      await readStarted;
      return snapshot();
    });

    const pending = prepareOpeningSourceBackup(sql, mutable, root, reader());
    await vi.waitFor(() => expect(readSources).toHaveBeenCalledOnce());
    mutable.workspaceId = "e5000000-0000-4000-8000-000000000099";
    mutable.ownerUserId = "f6000000-0000-4000-8000-0000000000bb";
    releaseRead();

    await expect(pending).resolves.toMatchObject({ snapshot: snapshot() });
    expect(assertCurrent).toHaveBeenCalledWith(sql, { workspaceId, ownerUserId }, expect.any(Object));
  });

  it("removes only the staged directory and preserves conflict", async () => {
    const root = await parent();
    assertCurrent.mockRejectedValue(new OpeningBackupCurrentError());
    readSources.mockResolvedValue(snapshot());

    const rejection = prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, reader());

    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupCurrentError);
    await expect(rejection).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("removes staged files and preserves owner loss on recheck", async () => {
    const root = await parent();
    assertCurrent.mockRejectedValue(new OpeningBackupSourceError());
    readSources.mockResolvedValue(snapshot());

    const rejection = prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, reader());

    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupSourceError);
    await expect(rejection).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await readdir(root)).toEqual(["sentinel"]);
  });
});
