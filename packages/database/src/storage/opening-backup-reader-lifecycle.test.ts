import { describe, expect, it, vi } from "vitest";
import { OpeningStorageError, OpeningS3, type S3ClientLike } from "./opening-s3";
import { createOpeningBackupReader } from "./opening-backup-reader";

const SECRET = "private-body-secret";

function storage(send: S3ClientLike["send"]) {
  return new OpeningS3({
    endpoint: "http://minio", region: "us-east-1", bucket: "opening-bucket",
    accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true,
  }, { send });
}

async function readerFor(body: unknown) {
  return createOpeningBackupReader(storage(vi.fn(async () => ({ Body: body }))));
}

describe("opening backup reader lifecycle", () => {
  it("closes before the first next without consuming the body", async () => {
    let iteratorCreated = false;
    let nextCalls = 0;
    let returnCalls = 0;
    const body = {
      [Symbol.asyncIterator]() {
        iteratorCreated = true;
        return {
          async next() {
            nextCalls += 1;
            return { done: false as const, value: new Uint8Array([1]) };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterable = await (await readerFor(body)).readObject("key");

    await iterable[Symbol.asyncIterator]().return?.();

    expect(iteratorCreated).toBe(true);
    expect(returnCalls).toBe(1);
    expect(nextCalls).toBe(0);
  });

  it("treats natural end as terminal", async () => {
    let nextCalls = 0;
    const body = {
      async next() {
        nextCalls += 1;
        return nextCalls === 1
          ? { done: true as const, value: undefined }
          : { done: false as const, value: new Uint8Array([1]) };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const iterator = (await (await readerFor(body)).readObject("key"))[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(nextCalls).toBe(1);
  });

  it("redacts a typed source error while preserving NOT_FOUND", async () => {
    const body = {
      async next() {
        throw new OpeningStorageError("NOT_FOUND", SECRET);
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const iterator = (await (await readerFor(body)).readObject("key"))[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      name: "OpeningStorageError", code: "NOT_FOUND", message: "storage object not found",
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("destroys the source when its iterator has no return method", async () => {
    let destroyed = 0;
    const body = {
      async next() { return { done: false as const, value: new Uint8Array([1]) }; },
      destroy() { destroyed += 1; },
      [Symbol.asyncIterator]() { return this; },
    };
    const iterator = (await (await readerFor(body)).readObject("key"))[Symbol.asyncIterator]();

    await iterator.return?.();

    expect(destroyed).toBe(1);
  });

  it("reports sanitized UNAVAILABLE when close and source fallback both fail", async () => {
    const body = {
      async next() { return { done: false as const, value: new Uint8Array([1]) }; },
      async return() { throw new Error(`iterator close ${SECRET}`); },
      destroy: vi.fn(() => { throw new Error(`source close ${SECRET}`); }),
      [Symbol.asyncIterator]() { return this; },
    };
    const iterator = (await (await readerFor(body)).readObject("key"))[Symbol.asyncIterator]();

    await expect(iterator.return?.()).rejects.toMatchObject({
      name: "OpeningStorageError", code: "UNAVAILABLE", message: "storage service unavailable",
    });
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });
});
