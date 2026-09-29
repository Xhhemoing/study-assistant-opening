import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { stageOpeningBackupObjects } from "./opening-backup-stage";

const ID_A = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const ID_B = "b2c3d4e5-f6a7-4890-b123-456789abcdef";
const HASH_B = "cd".repeat(32);
type Source = { sourceId: string; version: number; bytes: number; sha256: string };
type Reader = {
  finalKey: (sourceId: string, version: number) => string;
  readObject: (key: string) => Promise<AsyncIterable<Uint8Array>>;
  calls: string[];
};

const roots: string[] = [];

function source(overrides: Partial<Source> = {}): Source {
  return { sourceId: ID_A, version: 0, bytes: 4, sha256: "ab".repeat(32), ...overrides };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(chunks: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

function reader(bodies: Record<string, Uint8Array[] | Error> = {}): Reader {
  const calls: string[] = [];
  return {
    calls,
    finalKey: (sourceId, version) => `opening/sources/${sourceId}/v${version}`,
    readObject: async (key) => {
      calls.push(key);
      const body = bodies[key];
      if (body instanceof Error) throw body;
      if (!body) throw new Error("missing object");
      return Readable.from(body.map((chunk) => Uint8Array.from(chunk)));
    },
  };
}

async function parent(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-stage-"));
  roots.push(directory);
  await writeFile(path.join(directory, "sentinel"), "keep");
  return directory;
}

async function expectOnlySentinel(root: string): Promise<void> {
  expect(await readdir(root)).toEqual(["sentinel"]);
  expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("keep");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("stageOpeningBackupObjects", () => {
  it("streams canonical objects into a private staging directory", async () => {
    const root = await parent();
    const bodyA = [bytesOf("ab"), bytesOf("cd")];
    const bodyB = [bytesOf("12345678")];
    const fake = reader({
      [`opening/sources/${ID_A}/v0`]: bodyA,
      [`opening/sources/${ID_B}/v2`]: bodyB,
    });
    const result = await stageOpeningBackupObjects([
      source({ sha256: sha256(bodyA).toUpperCase(), bytes: 4 }),
      source({ sourceId: ID_B.toUpperCase(), version: 2, bytes: 8, sha256: sha256(bodyB) }),
    ], root, fake);
    expect(result.directory.startsWith(root)).toBe(true);
    expect(result.objects).toEqual([
      { sourceId: ID_A, sha256: sha256(bodyA), bytes: 4, archivePath: `objects/${ID_A}/v0.bin`, actualSha256: sha256(bodyA) },
      { sourceId: ID_B, sha256: sha256(bodyB), bytes: 8, archivePath: `objects/${ID_B}/v2.bin`, actualSha256: sha256(bodyB) },
    ]);
    const fileA = path.join(result.directory, "objects", ID_A, "v0.bin");
    expect(await readFile(fileA)).toEqual(Buffer.from("abcd"));
    const fileStat = await stat(fileA);
    expect(fileStat.mode & 0o200).toBe(0o200);
    if (process.platform !== "win32") expect(fileStat.mode & 0o777).toBe(0o600);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v0`, `opening/sources/${ID_B}/v2`]);
  });

  it("accepts an empty source list without object reads", async () => {
    const root = await parent();
    const fake = reader();
    const result = await stageOpeningBackupObjects([], root, fake);
    expect(result.objects).toEqual([]);
    expect(result.directory.startsWith(root)).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("keep");
    expect((await readdir(root)).some((name) => name.startsWith("opening-backup-"))).toBe(true);
  });

  it("rejects invalid input before creating a directory or reading objects", async () => {
    const root = await parent();
    const fake = reader();
    const before = await stat(root);
    await expect(stageOpeningBackupObjects([source({ bytes: 0 })], root, fake)).rejects.toThrow(/invalid backup source/i);
    expect(fake.calls).toEqual([]);
    expect((await stat(root)).mtimeMs).toBe(before.mtimeMs);
    await expectOnlySentinel(root);
  });

  it("uses the snapshot taken before the first await", async () => {
    const root = await parent();
    const body = [bytesOf("abcd")];
    const first = source({ sha256: sha256(body).toUpperCase() });
    const sources = [first];
    const fake = reader({ [`opening/sources/${ID_A}/v0`]: body });
    const original = fake.readObject;
    fake.readObject = async (key) => {
      first.version = 9;
      first.bytes = 99;
      first.sha256 = "f".repeat(64);
      sources.push(source({ sourceId: ID_B, bytes: 1, sha256: "0".repeat(64) }));
      return original(key);
    };
    const result = await stageOpeningBackupObjects(sources, root, fake);
    expect(result.objects).toEqual([
      { sourceId: ID_A, sha256: sha256(body), bytes: 4, archivePath: `objects/${ID_A}/v0.bin`, actualSha256: sha256(body) },
    ]);
    expect(fake.calls).toEqual([`opening/sources/${ID_A}/v0`]);
  });

  it("cleans its own staging when a later object is short, oversized, mismatched, or interrupted", async () => {
    const root = await parent();
    const good = [bytesOf("abcd")];
    const cases: Record<string, Uint8Array[] | Error> = {
      short: [bytesOf("ab")],
      over: [bytesOf("abcd"), bytesOf("X")],
      hash: [bytesOf("wxyz")],
    };
    for (const [name, bad] of Object.entries(cases)) {
      const fake = reader({
        [`opening/sources/${ID_A}/v0`]: good,
        [`opening/sources/${ID_B}/v1`]: bad,
      });
      await expect(stageOpeningBackupObjects([
        source({ sha256: sha256(good) }),
        source({ sourceId: ID_B, version: 1, bytes: 4, sha256: name === "hash" ? HASH_B : sha256(good) }),
      ], root, fake)).rejects.toThrow(/^backup object mismatch$/);
      await expectOnlySentinel(root);
    }
    const failing = reader({ [`opening/sources/${ID_A}/v0`]: good });
    const original = failing.readObject;
    failing.readObject = async (key) => {
      if (key.endsWith("/v1")) throw new Error("secret object bytes abcd");
      return original(key);
    };
    await expect(stageOpeningBackupObjects([
      source({ sha256: sha256(good) }),
      source({ sourceId: ID_B, version: 1, bytes: 4, sha256: sha256(good) }),
    ], root, failing)).rejects.toThrow(/^storage unavailable$/);
    await expectOnlySentinel(root);
  });

  it("does not trust a caller-supplied actualSha256", async () => {
    const root = await parent();
    const body = [bytesOf("abcd")];
    const fake = reader({ [`opening/sources/${ID_A}/v4`]: body });
    const input = [{ ...source({ version: 4, sha256: sha256(body) }), actualSha256: "de".repeat(32) }];
    const result = await stageOpeningBackupObjects(input, root, fake);
    expect(result.objects[0]?.actualSha256).toBe(sha256(body));
    expect(result.objects[0]?.actualSha256).not.toBe("de".repeat(32));
  });

  it("writes multiple streamed chunks rather than one prejoined buffer", async () => {
    const root = await parent();
    const chunk = bytesOf("0123456789");
    const parts = Array.from({ length: 20 }, () => Uint8Array.from(chunk));
    const fake = reader({ [`opening/sources/${ID_A}/v0`]: parts });
    const yielded: number[] = [];
    const original = fake.readObject;
    fake.readObject = async (key) => {
      const body = await original(key);
      return (async function* counted() {
        for await (const part of body) {
          yielded.push(part.byteLength);
          yield part;
        }
      })();
    };
    const result = await stageOpeningBackupObjects([
      source({ bytes: 200, sha256: sha256(parts) }),
    ], root, fake);
    expect(yielded).toEqual(Array.from({ length: 20 }, () => 10));
    expect((await readFile(path.join(result.directory, "objects", ID_A, "v0.bin"))).length).toBe(200);
  });
});

it("stages two revisions of one source and reports confirmed missing history", async () => {
  const { OpeningStorageError } = await import("./opening-s3");
  const root = await parent(), body = [bytesOf("abcd")];
  const fake = reader({ [`opening/sources/${ID_A}/v1`]: body,
    [`opening/sources/${ID_A}/v2`]: new OpeningStorageError("NOT_FOUND", "missing") });
  const result = await stageOpeningBackupObjects([
    source({ version: 1, sha256: sha256(body) }), source({ version: 2, sha256: sha256(body) }),
  ], root, fake, { allowUnavailable: true });
  expect(result.objects.map(object => object.archivePath)).toEqual([`objects/${ID_A}/v1.bin`]);
  expect(result.unavailableSources).toEqual([{ sourceId: ID_A, version: 2 }]);
  expect(await readFile(path.join(result.directory, "objects", ID_A, "v1.bin"), "utf8")).toBe("abcd");
});
it("still fails a historical backup on network failure", async () => {
  const { OpeningStorageError } = await import("./opening-s3");
  const root = await parent();
  const fake = reader({ [`opening/sources/${ID_A}/v1`]: new OpeningStorageError("UNAVAILABLE", "network") });
  await expect(stageOpeningBackupObjects([source({ version: 1 })], root, fake, { allowUnavailable: true }))
    .rejects.toThrow("storage unavailable");
  await expectOnlySentinel(root);
});
