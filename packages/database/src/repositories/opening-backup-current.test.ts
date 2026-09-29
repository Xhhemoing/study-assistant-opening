import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { OpeningBackupSourceError, type OpeningBackupSourceSnapshot } from "./opening-backup-sources";
import { assertOpeningBackupSnapshotCurrent, OpeningBackupCurrentError } from "./opening-backup-current";
import { readOpeningBackupSources } from "./opening-backup-sources";

vi.mock("./opening-backup-sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opening-backup-sources")>();
  return { ...actual, readOpeningBackupSources: vi.fn() };
});

const readSources = vi.mocked(readOpeningBackupSources);
const workspaceId = "a1000000-0000-4000-8000-000000000001";
const ownerUserId = "b2000000-0000-4000-8000-0000000000aa";
const sourceA = "c3000000-0000-4000-8000-000000000010";
const sourceB = "d4000000-0000-4000-8000-000000000011";
const hashA = "ab".repeat(32);
const hashB = "cd".repeat(32);
const scope = { workspaceId: workspaceId.toUpperCase(), ownerUserId: ownerUserId.toUpperCase() };
const sql = {} as Sql;

function snapshot(overrides: Partial<OpeningBackupSourceSnapshot> = {}): OpeningBackupSourceSnapshot {
  return {
    workspaceId,
    privacyEpoch: 4,
    deletionJournal: [{ sourceId: sourceB, deletedAt: "2026-09-21T00:00:00.000Z" }],
    sources: [{ sourceId: sourceA, version: 3, bytes: 12, sha256: hashA }],
    ...overrides,
  };
}

describe("assertOpeningBackupSnapshotCurrent", () => {
  beforeEach(() => {
    readSources.mockReset();
  });
  it("authorizes the original scope after the caller changes it during the read", async () => {
    const mutable = { workspaceId, ownerUserId };
    let receivedScope: { workspaceId: string; ownerUserId: string } | undefined;
    let releaseRead: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    readSources.mockImplementation(async (_sql, received) => {
      receivedScope = { workspaceId: received.workspaceId, ownerUserId: received.ownerUserId };
      await readStarted;
      return snapshot();
    });

    const pending = assertOpeningBackupSnapshotCurrent(sql, mutable, snapshot());
    await vi.waitFor(() => expect(receivedScope).toEqual({ workspaceId, ownerUserId }));
    mutable.workspaceId = "e5000000-0000-4000-8000-000000000099";
    mutable.ownerUserId = "f6000000-0000-4000-8000-0000000000bb";
    releaseRead();

    await expect(pending).resolves.toBeUndefined();
    expect(receivedScope).toEqual({ workspaceId, ownerUserId });
    expect(mutable).toEqual({
      workspaceId: "e5000000-0000-4000-8000-000000000099",
      ownerUserId: "f6000000-0000-4000-8000-0000000000bb",
    });
  });

  it("accepts an unchanged inventory when ids and hashes differ only by case", async () => {
    readSources.mockResolvedValue(snapshot({
      workspaceId: workspaceId.toUpperCase(),
      deletionJournal: [{ sourceId: sourceB.toUpperCase(), deletedAt: "2026-09-21T00:00:00.000Z" }],
      sources: [{ sourceId: sourceA.toUpperCase(), version: 3, bytes: 12, sha256: hashA.toUpperCase() }],
    }));

    await expect(assertOpeningBackupSnapshotCurrent(sql, scope, snapshot())).resolves.toBeUndefined();
    expect(readSources).toHaveBeenCalledWith(sql, {
      workspaceId,
      ownerUserId,
    });
  });

  it("accepts the same journal and source tuples regardless of input order", async () => {
    const expected = snapshot({
      deletionJournal: [
        { sourceId: sourceA, deletedAt: "2026-09-22T00:00:00.000Z" },
        { sourceId: sourceB, deletedAt: "2026-09-21T00:00:00.000Z" },
      ],
      sources: [
        { sourceId: sourceB, version: 1, bytes: 2, sha256: hashB },
        { sourceId: sourceA, version: 3, bytes: 12, sha256: hashA },
      ],
    });
    readSources.mockResolvedValue(snapshot({
      deletionJournal: [...expected.deletionJournal].reverse(),
      sources: [...expected.sources].reverse(),
    }));

    await expect(assertOpeningBackupSnapshotCurrent(sql, scope, expected)).resolves.toBeUndefined();
  });

  it.each([
    ["epoch", snapshot({ privacyEpoch: 5 })],
    ["journal source", snapshot({ deletionJournal: [{ sourceId: sourceA, deletedAt: "2026-09-21T00:00:00.000Z" }] })],
    ["journal time", snapshot({ deletionJournal: [{ sourceId: sourceB, deletedAt: "2026-09-22T00:00:00.000Z" }] })],
    ["asset deletion", snapshot({ deletionJournal: [{ sourceId: sourceB, deletedAt: "2026-09-21T00:00:00.000Z", assetDeletedAt: "2026-09-22T00:00:00.000Z" }] })],
    ["source id", snapshot({ sources: [{ sourceId: sourceB, version: 3, bytes: 12, sha256: hashA }] })],
    ["source version", snapshot({ sources: [{ sourceId: sourceA, version: 4, bytes: 12, sha256: hashA }] })],
    ["source bytes", snapshot({ sources: [{ sourceId: sourceA, version: 3, bytes: 13, sha256: hashA }] })],
    ["source hash", snapshot({ sources: [{ sourceId: sourceA, version: 3, bytes: 12, sha256: hashB }] })],
    ["added source", snapshot({ sources: [
      { sourceId: sourceA, version: 3, bytes: 12, sha256: hashA },
      { sourceId: sourceB, version: 1, bytes: 2, sha256: hashB },
    ] })],
  ] as const)("rejects a changed %s with a generic conflict and no identifiers", async (_label, live) => {
    readSources.mockResolvedValue(live);
    const rejection = assertOpeningBackupSnapshotCurrent(sql, scope, snapshot());

    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupCurrentError);
    await expect(rejection).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(rejection).rejects.toThrow(/changed/i);
    await expect(rejection).rejects.not.toThrow(new RegExp(sourceA, "i"));
    expect(readSources).toHaveBeenCalledOnce();
  });

  it("propagates the reader owner not-found error", async () => {
    readSources.mockRejectedValue(new OpeningBackupSourceError());

    const rejection = assertOpeningBackupSnapshotCurrent(sql, scope, snapshot());
    await expect(rejection).rejects.toBeInstanceOf(OpeningBackupSourceError);
    await expect(rejection).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a workspace mismatch before reading", async () => {
    const expected = snapshot({ workspaceId: "e5000000-0000-4000-8000-000000000099" });

    const rejection = assertOpeningBackupSnapshotCurrent(sql, scope, expected);
    await expect(rejection).rejects.toMatchObject({ name: "OpeningBackupCurrentError", code: "CONFLICT" });
    expect(readSources).not.toHaveBeenCalled();
  });

  it("compares the copied snapshot when the caller mutates it while reading", async () => {
    const expected = snapshot();
    readSources.mockImplementation(async () => {
      expected.privacyEpoch = 9;
      expected.sources[0]!.sha256 = hashB;
      expected.deletionJournal.push({ sourceId: sourceA, deletedAt: "2026-09-23T00:00:00.000Z" });
      return snapshot();
    });

    await expect(assertOpeningBackupSnapshotCurrent(sql, scope, expected)).resolves.toBeUndefined();
  });

  it("rejects a null journal timestamp before reading", async () => {
    const expected = snapshot({
      deletionJournal: [{ sourceId: sourceA, deletedAt: null as unknown as string }],
    });

    await expect(assertOpeningBackupSnapshotCurrent(sql, scope, expected)).rejects.toThrow(Error);
    expect(readSources).not.toHaveBeenCalled();
  });

  it("rejects malformed epoch, journal, and source metadata before reading", async () => {
    const malformed = [
      snapshot({ privacyEpoch: 1.5 }),
      snapshot({ deletionJournal: [{ sourceId: "not-a-uuid", deletedAt: "2026-09-21T00:00:00.000Z" }] }),
      snapshot({ deletionJournal: [{ sourceId: sourceA, deletedAt: "not-a-date" }, { sourceId: sourceA, deletedAt: "2026-09-21T00:00:00.000Z" }] }),
      snapshot({ deletionJournal: [{ sourceId: sourceA, deletedAt: 1_758_412_800_000 as unknown as string }] }),
      snapshot({ sources: [{ sourceId: sourceA, version: 1.2, bytes: 12, sha256: hashA }] }),
      snapshot({ sources: [{ sourceId: sourceA, version: 3, bytes: Number.MAX_SAFE_INTEGER, sha256: "zz" }] }),
    ];

    for (const expected of malformed) {
      await expect(assertOpeningBackupSnapshotCurrent(sql, scope, expected)).rejects.toThrow(Error);
    }
    expect(readSources).not.toHaveBeenCalled();
  });
});
