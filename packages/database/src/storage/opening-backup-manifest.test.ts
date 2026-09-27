import { describe, expect, it, vi, type Mocked } from "vitest";
import type { OpeningStorage } from "./opening-s3";
import { verifyOpeningBackupObjects } from "./opening-backup-manifest";

const ID_A = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const ID_B = "b2c3d4e5-f6a7-4890-b123-456789abcdef";
const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);
type Source = { sourceId: string; version: number; bytes: number; sha256: string };
type Storage = Pick<OpeningStorage, "finalKey" | "streamDigest">;

function source(overrides: Partial<Source> = {}): Source {
  return { sourceId: ID_A, version: 0, bytes: 4, sha256: HASH_A, ...overrides };
}

function storage(digests: Record<string, { bytes: number; sha256: string }> = {}): Mocked<Storage> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    finalKey: vi.fn((sourceId: string, version: number) => `opening/sources/${sourceId}/v${version}`),
    streamDigest: vi.fn(async (key: string) => {
      calls.push(key);
      const digest = digests[key];
      if (!digest) throw new Error("missing");
      return { ...digest, firstBytes: new Uint8Array() };
    }),
  };
}

describe("verifyOpeningBackupObjects", () => {
  it("returns canonical objects after sequential digest checks", async () => {
    const fake = storage({
      [`opening/sources/${ID_A}/v0`]: { bytes: 4, sha256: HASH_A.toUpperCase() },
      [`opening/sources/${ID_B}/v2`]: { bytes: 8, sha256: HASH_B },
    });
    const result = await verifyOpeningBackupObjects([
      source({ sha256: HASH_A.toUpperCase() }),
      source({ sourceId: ID_B.toUpperCase(), version: 2, bytes: 8, sha256: HASH_B }),
    ], fake);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v0`, `opening/sources/${ID_B}/v2`]);
    expect(result).toEqual([
      { sourceId: ID_A, sha256: HASH_A, bytes: 4, archivePath: `objects/${ID_A}/v0.bin`, actualSha256: HASH_A },
      { sourceId: ID_B, sha256: HASH_B, bytes: 8, archivePath: `objects/${ID_B}/v2.bin`, actualSha256: HASH_B },
    ]);
    expect(fake.streamDigest).toHaveBeenNthCalledWith(1, `opening/sources/${ID_A}/v0`, 5);
    expect(fake.streamDigest).toHaveBeenNthCalledWith(2, `opening/sources/${ID_B}/v2`, 9);
  });

  it("accepts an empty source list without storage I/O", async () => {
    const fake = storage();
    await expect(verifyOpeningBackupObjects([], fake)).resolves.toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(fake.finalKey).not.toHaveBeenCalled();
    expect(fake.streamDigest).not.toHaveBeenCalled();
  });

  it("rejects invalid input before the first storage call", async () => {
    const fake = storage();
    const cases: Source[][] = [
      [source({ sourceId: "not-a-uuid" })],
      [source({ version: -1 })],
      [source({ version: 1.5 })],
      [source({ version: Number.MAX_SAFE_INTEGER + 1 })],
      [source({ bytes: 0 })],
      [source({ bytes: -1 })],
      [source({ bytes: 1.2 })],
      [source({ bytes: Number.MAX_SAFE_INTEGER })],
      [source({ sha256: "abc" })],
      [source({ sha256: "g".repeat(64) })],
      [source(), source({ sourceId: "later-bad", version: -1 })],
    ];
    for (const sources of cases) {
      await expect(verifyOpeningBackupObjects(sources, fake)).rejects.toThrow(/invalid backup source/i);
    }
    expect(fake.finalKey).not.toHaveBeenCalled();
    expect(fake.streamDigest).not.toHaveBeenCalled();
  });

  it("rejects duplicate source ids including case variants before I/O", async () => {
    const fake = storage();
    await expect(verifyOpeningBackupObjects([
      source(),
      source({ sourceId: ID_A.toUpperCase(), sha256: HASH_B }),
    ], fake)).rejects.toThrow(/duplicate/i);
    expect(fake.finalKey).not.toHaveBeenCalled();
    expect(fake.streamDigest).not.toHaveBeenCalled();
  });

  it("does not call storage when a later source is malformed", async () => {
    const fake = storage({ [`opening/sources/${ID_A}/v0`]: { bytes: 4, sha256: HASH_A } });
    await expect(verifyOpeningBackupObjects([
      source(),
      source({ sourceId: ID_B, bytes: 0 }),
    ], fake)).rejects.toThrow(/invalid backup source/i);
    expect(fake.finalKey).not.toHaveBeenCalled();
    expect(fake.streamDigest).not.toHaveBeenCalled();
  });

  it("keeps validated snapshots when the caller mutates during the first digest", async () => {
    const first = source({ sha256: HASH_A.toUpperCase() });
    const second = source({ sourceId: ID_B.toUpperCase(), version: 2, bytes: 8, sha256: HASH_B.toUpperCase() });
    const sources = [first, second];
    const before = structuredClone(sources);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = storage({
      [`opening/sources/${ID_A}/v0`]: { bytes: 4, sha256: HASH_A },
      [`opening/sources/${ID_B}/v2`]: { bytes: 8, sha256: HASH_B },
    });
    fake.streamDigest.mockImplementation(async (key: string) => {
      fake.calls.push(key);
      if (fake.calls.length === 1) {
        sources.length = 0;
        sources.push(source({ sourceId: ID_B, version: 9, bytes: 99, sha256: "e".repeat(64) }));
        first.sourceId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        first.version = 7;
        first.bytes = 99;
        first.sha256 = "f".repeat(64);
        second.version = 9;
        second.bytes = 1;
        second.sha256 = "0".repeat(64);
        release?.();
        await gate;
      }
      const digest = {
        [`opening/sources/${ID_A}/v0`]: { bytes: 4, sha256: HASH_A },
        [`opening/sources/${ID_B}/v2`]: { bytes: 8, sha256: HASH_B },
      }[key];
      if (!digest) throw new Error("missing");
      return { ...digest, firstBytes: new Uint8Array() };
    });
    const pending = verifyOpeningBackupObjects(sources, fake);
    await gate;
    await expect(pending).resolves.toEqual([
      { sourceId: ID_A, sha256: HASH_A, bytes: 4, archivePath: `objects/${ID_A}/v0.bin`, actualSha256: HASH_A },
      { sourceId: ID_B, sha256: HASH_B, bytes: 8, archivePath: `objects/${ID_B}/v2.bin`, actualSha256: HASH_B },
    ]);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v0`, `opening/sources/${ID_B}/v2`]);
    expect(fake.finalKey).toHaveBeenNthCalledWith(1, ID_A, 0);
    expect(fake.finalKey).toHaveBeenNthCalledWith(2, ID_B, 2);
    expect(fake.streamDigest).toHaveBeenNthCalledWith(1, `opening/sources/${ID_A}/v0`, 5);
    expect(fake.streamDigest).toHaveBeenNthCalledWith(2, `opening/sources/${ID_B}/v2`, 9);
    expect(sources).toEqual([source({ sourceId: ID_B, version: 9, bytes: 99, sha256: "e".repeat(64) })]);
    expect(first).toEqual({
      sourceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      version: 7,
      bytes: 99,
      sha256: "f".repeat(64),
    });
    expect(before.map((item) => item.sourceId.toLowerCase())).toEqual([ID_A, ID_B]);
  });

  it("rejects hash or byte mismatches and stops before later objects", async () => {
    const fake = storage({
      [`opening/sources/${ID_A}/v1`]: { bytes: 4, sha256: "ee".repeat(32) },
      [`opening/sources/${ID_B}/v0`]: { bytes: 9, sha256: HASH_B },
      [`opening/sources/${ID_A}/v5`]: { bytes: 3, sha256: HASH_A },
    });
    await expect(verifyOpeningBackupObjects([
      source({ version: 1 }),
      source({ sourceId: ID_B }),
    ], fake)).rejects.toThrow(/backup object mismatch/i);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v1`]);
    expect(fake.streamDigest).toHaveBeenCalledTimes(1);
    expect(fake.streamDigest).toHaveBeenCalledWith(`opening/sources/${ID_A}/v1`, 5);
    fake.calls.length = 0;
    fake.streamDigest.mockClear();
    await expect(verifyOpeningBackupObjects([
      source({ sourceId: ID_B, sha256: HASH_B }),
    ], fake)).rejects.toThrow(/backup object mismatch/i);
    expect(fake.calls).toEqual([`opening/sources/${ID_B}/v0`]);
    expect(fake.streamDigest).toHaveBeenCalledWith(`opening/sources/${ID_B}/v0`, 5);
  });

  it("rejects a missing storage object without a partial manifest", async () => {
    const fake = storage();
    await expect(verifyOpeningBackupObjects([source({ version: 3 })], fake)).rejects.toThrow(/unavailable|not found/i);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v3`]);
    expect(fake.streamDigest).toHaveBeenCalledWith(`opening/sources/${ID_A}/v3`, 5);
  });

  it("ignores untrusted extra fields and leaves the caller input unchanged", async () => {
    const fake = storage({ [`opening/sources/${ID_A}/v4`]: { bytes: 4, sha256: HASH_A } });
    const input = [{ ...source({ version: 4 }), actualSha256: "de".repeat(32) }];
    const before = structuredClone(input);
    const result = await verifyOpeningBackupObjects(input, fake);
    expect(result[0]?.actualSha256).toBe(HASH_A);
    expect(result[0]?.archivePath).toBe(`objects/${ID_A}/v4.bin`);
    expect(input).toEqual(before);
    expect(fake.streamDigest).toHaveBeenCalledWith(`opening/sources/${ID_A}/v4`, 5);
  });
});
