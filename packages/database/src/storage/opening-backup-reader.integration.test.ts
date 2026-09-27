import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { OpeningS3 } from "./opening-s3";
import { createOpeningBackupReader } from "./opening-backup-reader";
import { stageOpeningBackupObjects } from "./opening-backup-stage";

const ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const roots: string[] = [];

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(bytes: Uint8Array) {
  return { sourceId: ID, version: 0, bytes: bytes.byteLength, sha256: digest(bytes) };
}

function opening(send: (command: unknown) => Promise<unknown>): OpeningS3 {
  return new OpeningS3({
    endpoint: "http://local", region: "us-east-1", bucket: "bucket",
    accessKeyId: "access", secretAccessKey: "secret", forcePathStyle: true,
  }, { send });
}

async function parent(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "opening-reader-"));
  roots.push(root);
  await writeFile(path.join(root, "sentinel"), "keep");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("opening backup reader with local streamed bodies", () => {
  it("stages a real local file stream through the S3 adapter", async () => {
    const root = await parent();
    const object = Buffer.from("local streamed backup");
    const input = path.join(root, "object.bin");
    await writeFile(input, object);
    let requested: GetObjectCommand | undefined;
    const reader = createOpeningBackupReader(opening(async (command) => {
      requested = command as GetObjectCommand;
      return { Body: createReadStream(input, { highWaterMark: 3 }) };
    }));

    const result = await stageOpeningBackupObjects([source(object)], root, reader);
    expect(requested?.input).toEqual({ Bucket: "bucket", Key: `opening/sources/${ID}/v0` });
    expect(await readFile(path.join(result.directory, "objects", ID, "v0.bin"))).toEqual(object);
  });

  it("redacts a mid-stream SDK failure and removes the stage", async () => {
    const root = await parent();
    let finished = false;
    const reader = createOpeningBackupReader(opening(async () => ({
      Body: (async function* body() {
        try {
          yield Buffer.from("ab");
          throw new Error("private object bytes");
        } finally {
          finished = true;
        }
      })(),
    })));

    await expect(stageOpeningBackupObjects([source(Buffer.from("abcd"))], root, reader))
      .rejects.toThrow(/^storage unavailable$/);
    expect(finished).toBe(true);
    expect(await readdir(root)).toEqual(["sentinel"]);
  });

  it("cancels the adapter body and removes the stage for an oversized object", async () => {
    const root = await parent();
    let returned = false;
    const body = {
      index: 0,
      async next() {
        this.index += 1;
        return this.index === 1
          ? { done: false as const, value: Buffer.from("abcd") }
          : { done: false as const, value: Buffer.from("x") };
      },
      async return() {
        returned = true;
        return { done: true as const, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const reader = createOpeningBackupReader(opening(async () => ({ Body: body })));

    await expect(stageOpeningBackupObjects([source(Buffer.from("abcd"))], root, reader))
      .rejects.toThrow(/^backup object mismatch$/);
    expect(returned).toBe(true);
    expect(await readdir(root)).toEqual(["sentinel"]);
  });
});
