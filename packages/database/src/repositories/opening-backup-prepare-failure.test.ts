import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { type OpeningBackupSourceSnapshot } from "./opening-backup-sources";
import { OpeningBackupCurrentError } from "./opening-backup-current";
import { readOpeningBackupSources } from "./opening-backup-sources";
import { assertOpeningBackupSnapshotCurrent } from "./opening-backup-current";

const boundary = vi.hoisted(() => {
  let actualRm: typeof import("node:fs/promises").rm = async () => undefined;
  const rmMock = vi.fn(async (...args: Parameters<typeof import("node:fs/promises").rm>) => actualRm(...args));
  return {
    rm: rmMock,
    setActual(next: typeof actualRm) {
      actualRm = next;
      rmMock.mockImplementation(async (...args) => actualRm(...args));
    },
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm);
  return { ...actual, rm: boundary.rm };
});

vi.mock("./opening-backup-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opening-backup-sources")>();
  return { ...actual, readOpeningBackupSources: vi.fn() };
});

vi.mock("./opening-backup-current", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opening-backup-current")>();
  return { ...actual, assertOpeningBackupSnapshotCurrent: vi.fn() };
});

const { prepareOpeningSourceBackup } = await import("./opening-backup-prepare");
const readSources = vi.mocked(readOpeningBackupSources);
const assertCurrent = vi.mocked(assertOpeningBackupSnapshotCurrent);
const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-0000000000aa";
const sourceId = "c3000000-0000-4000-8000-000000000010";
const sql = {} as Sql;
const roots: string[] = [];

function snapshot(bytes = 4): OpeningBackupSourceSnapshot {
  return {
    workspaceId,
    privacyEpoch: 4, memoryDeletions: { workspaceId, memories: [] },
    deletionJournal: [],
    sources: [{ sourceId, version: 1, bytes, sha256: "ab".repeat(32) }],
  };
}

function reader(body = "abcd") {
  return {
    finalKey: (id: string, version: number) => `opening/sources/${id}/v${version}`,
    readObject: async () => Readable.from([new TextEncoder().encode(body)]),
  };
}

async function parent(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-prepare-fail-"));
  roots.push(directory);
  await writeFile(path.join(directory, "sentinel"), "keep");
  return directory;
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm);
  await Promise.all(roots.splice(0).map((directory) => actual.rm(directory, { recursive: true, force: true })));
});

describe("prepareOpeningSourceBackup failures", () => {
  beforeEach(() => {
    readSources.mockReset();
    assertCurrent.mockReset();
    boundary.rm.mockClear();
  });

  it("does not recheck when object bytes do not match the inventory", async () => {
    const root = await parent();
    const body = new TextEncoder().encode("nope");
    readSources.mockResolvedValue(snapshot(body.byteLength));

    await expect(prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, reader("nope")))
      .rejects.toThrow(/mismatch/i);
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("does not recheck when the object reader fails", async () => {
    const root = await parent();
    readSources.mockResolvedValue({
      ...snapshot(),
      sources: [{
        sourceId,
        version: 1,
        bytes: 4,
        sha256: createHash("sha256").update("abcd").digest("hex"),
      }],
    });
    const failing = {
      finalKey: () => "opening/sources/missing",
      readObject: async () => {
        throw new Error("bucket secret=super-secret-value");
      },
    };

    await expect(prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, failing))
      .rejects.toThrow(/unavailable/i);
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("surfaces generic cleanup failure and does not claim the staging is gone", async () => {
    const root = await parent();
    const body = "abcd";
    readSources.mockResolvedValue({
      ...snapshot(body.length),
      sources: [{
        sourceId,
        version: 1,
        bytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      }],
    });
    assertCurrent.mockRejectedValue(new OpeningBackupCurrentError());
    boundary.rm.mockImplementation(async (target, options) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      if (path.basename(String(target)).startsWith("opening-backup-")) {
        throw new Error("EPERM secret=super-secret-value");
      }
      return actual.rm(target, options);
    });

    const error = await prepareOpeningSourceBackup(sql, { workspaceId, ownerUserId }, root, reader(body))
      .then(() => {
        throw new Error("expected cleanup failure");
      }, (caught: unknown) => caught);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
    const staged = boundary.rm.mock.calls.map(([target]) => String(target))
      .filter((target) => target.startsWith(root) && path.basename(target).startsWith("opening-backup-"));
    expect(staged).toEqual([expect.stringMatching(/opening-backup-/)]);
    expect(boundary.rm).toHaveBeenCalledWith(staged[0], { recursive: true, force: false });
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(OpeningBackupCurrentError);
    expect((error as Error).message).toMatch(/cleanup failed/i);
    expect((error as Error).message).not.toMatch(/secret|super-secret|CONFLICT|opening-backup-/i);
    expect(await readdir(root)).toEqual(expect.arrayContaining(["sentinel", path.basename(staged[0]!)]));
    expect(await readdir(root)).toHaveLength(2);
  });
});
