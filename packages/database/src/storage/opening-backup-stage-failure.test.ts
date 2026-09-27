import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream as actualCreateWriteStream } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
  let actualRm: typeof import("node:fs/promises").rm = async () => undefined;
  let actualMkdir: typeof import("node:fs/promises").mkdir = async () => undefined;
  const rm = vi.fn(async (...args: Parameters<typeof import("node:fs/promises").rm>) => actualRm(...args));
  const mkdir = vi.fn(async (...args: Parameters<typeof import("node:fs/promises").mkdir>) => actualMkdir(...args));
  const writeStream = { calls: 0, privateError: null as Error | null };
  return {
    rm, mkdir, writeStream,
    setActual(nextRm: typeof actualRm, nextMkdir: typeof actualMkdir) {
      actualRm = nextRm;
      actualMkdir = nextMkdir;
      rm.mockImplementation(async (...args) => actualRm(...args));
      mkdir.mockImplementation(async (...args) => actualMkdir(...args));
    },
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm, actual.mkdir);
  return { ...actual, rm: boundary.rm, mkdir: boundary.mkdir };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      boundary.writeStream.calls += 1;
      const error = boundary.writeStream.privateError;
      if (!error) return actual.createWriteStream(...args);
      return new Writable({ write(_chunk, _encoding, callback) {
        queueMicrotask(() => { callback(error); this.destroy(); });
      } });
    },
  };
});

const { stageOpeningBackupObjects } = await import("./opening-backup-stage");

const ID_A = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const ID_B = "b2c3d4e5-f6a7-4890-b123-456789abcdef";
const roots: string[] = [];
const leaked: string[] = [];

function source(overrides: Partial<{ sourceId: string; version: number; bytes: number; sha256: string }> = {}) {
  return { sourceId: ID_A, version: 0, bytes: 4, sha256: "ab".repeat(32), ...overrides };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function parent(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opening-stage-fail-"));
  roots.push(directory);
  await writeFile(path.join(directory, "sentinel"), "keep");
  return directory;
}

async function expectOnlySentinel(root: string): Promise<void> {
  expect(await readdir(root)).toEqual(["sentinel"]);
}

afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  boundary.setActual(actual.rm, actual.mkdir);
  boundary.writeStream.calls = 0;
  boundary.writeStream.privateError = null;
  await Promise.all(leaked.splice(0).map((directory) => actual.rm(directory, { recursive: true, force: true })));
  await Promise.all(roots.splice(0).map((directory) => actual.rm(directory, { recursive: true, force: true })));
});

describe("stageOpeningBackupObjects failure boundaries", () => {
  it("cleans after a private error yielded mid-stream and runs finally", async () => {
    const root = await parent();
    let finished = false;
    const error = await stageOpeningBackupObjects([source()], root, {
      finalKey: () => `opening/sources/${ID_A}/v0`,
      readObject: async () => (async function* interrupted() {
        try { yield bytesOf("ab"); throw new Error("private midstream secret ab"); }
        finally { finished = true; }
      })(),
    }).then(() => { throw new Error("stage succeeded"); }, (caught: unknown) => caught);
    expect(finished).toBe(true);
    expect((error as Error).message).toBe("storage unavailable");
    expect(String(error)).not.toMatch(/private|secret|\bab\b/);
    await expectOnlySentinel(root);
  });

  it("creates no directory and does not read when a later source is invalid", async () => {
    const root = await parent();
    const finalKey = vi.fn(() => "should-not-run");
    const readObject = vi.fn(async () => Readable.from([] as Uint8Array[]));
    await expect(stageOpeningBackupObjects([
      source(),
      source({ sourceId: ID_B, bytes: 0 }),
    ], root, { finalKey, readObject })).rejects.toThrow(/^invalid backup source$/);
    expect(finalKey).not.toHaveBeenCalled();
    expect(readObject).not.toHaveBeenCalled();
    await expectOnlySentinel(root);
  });

  it("redacts finalKey and unavailable parent failures without losing mismatch", async () => {
    const root = await parent();
    const readObject = vi.fn(async () => Readable.from([bytesOf("abcd")]));
    await expect(stageOpeningBackupObjects([source()], root, {
      finalKey: () => { throw new Error(`secret key ${ID_A}`); },
      readObject,
    })).rejects.toThrow(/^storage unavailable$/);
    expect(readObject).not.toHaveBeenCalled();
    await expectOnlySentinel(root);

    boundary.mkdir.mockRejectedValueOnce(new Error("EACCES secret parent path"));
    const mkdirRead = vi.fn(async () => Readable.from([bytesOf("abcd")]));
    const mkdirError = await stageOpeningBackupObjects([source()], root, {
      finalKey: () => `opening/sources/${ID_A}/v0`,
      readObject: mkdirRead,
    }).catch((error: unknown) => error);
    expect((mkdirError as Error).message).toBe("storage unavailable");
    expect(String(mkdirError)).not.toMatch(/EACCES|secret parent/);
    expect(mkdirRead).not.toHaveBeenCalled();
    await expectOnlySentinel(root);

    const blocked = path.join(root, "not-a-directory");
    await writeFile(blocked, "occupied");
    const parentError = await stageOpeningBackupObjects([source()], blocked, {
      finalKey: () => { throw new Error(`secret path ${blocked}`); },
      readObject: async () => Readable.from([bytesOf("abcd")]),
    }).catch((error: unknown) => error);
    expect((parentError as Error).message).toBe("staging unavailable");
    expect(String(parentError)).not.toMatch(/secret path|not-a-directory/);
    expect(await readdir(root)).toEqual(["not-a-directory", "sentinel"]);

    await expect(stageOpeningBackupObjects([source()], await parent(), {
      finalKey: () => `opening/sources/${ID_A}/v0`,
      readObject: async () => Readable.from([bytesOf("ab")]),
    })).rejects.toThrow(/^backup object mismatch$/);
    await expectOnlySentinel(roots.at(-1) ?? "");
  });

  it("redacts an rm failure at the fs/promises boundary and preserves other fs methods", async () => {
    const root = await parent();
    const probe = await mkdtemp(path.join(root, "probe-"));
    await pipeline(Readable.from([Buffer.from("ok")]), actualCreateWriteStream(path.join(probe, "proof.bin")));
    expect(await readdir(probe)).toEqual(["proof.bin"]);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await actual.rm(probe, { recursive: true, force: true });
    boundary.rm.mockImplementation(async (target) => {
      leaked.push(String(target));
      throw new Error("EPERM secret cleanup path");
    });
    const error = await stageOpeningBackupObjects([source()], root, {
      finalKey: () => `opening/sources/${ID_A}/v0`,
      readObject: async () => Readable.from([bytesOf("nope")]),
    }).then(() => { throw new Error("stage succeeded"); }, (caught: unknown) => caught);
    expect((error as Error).message).toBe("staging cleanup failed");
    expect(String(error)).not.toMatch(/EPERM|secret|nope/);
    expect(leaked).toHaveLength(1);
    expect((await readdir(root)).filter((name) => name !== "sentinel")).toEqual([path.basename(leaked[0] ?? "")]);
    expect(await readFile(path.join(root, "sentinel"), "utf8")).toBe("keep");
  });

  it("redacts an injected write-stream error and closes the body iterator", async () => {
    const root = await parent();
    let closed = false;
    boundary.writeStream.privateError = new Error("EIO private write secret");
    const error = await stageOpeningBackupObjects([source()], root, {
      finalKey: () => `opening/sources/${ID_A}/v0`,
      readObject: async () => (async function* body() {
        try { yield bytesOf("abcd"); } finally { closed = true; }
      })(),
    }).then(() => { throw new Error("stage succeeded"); }, (caught: unknown) => caught);
    expect(boundary.writeStream.calls).toBe(1);
    expect(closed).toBe(true);
    expect((error as Error).message).toBe("storage unavailable");
    expect(String(error)).not.toMatch(/EIO|private write|secret/);
    await expectOnlySentinel(root);
  });
});
