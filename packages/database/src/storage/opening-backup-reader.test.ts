import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { OpeningS3, type S3ClientLike } from "./opening-s3";
import { createOpeningBackupReader } from "./opening-backup-reader";

const SECRET = "secret-object-body-and-bucket";

function sdkError(name: string, status?: number, message = SECRET): Error {
  const error = new Error(message);
  error.name = name;
  if (status !== undefined) Object.assign(error, { $metadata: { httpStatusCode: status } });
  return error;
}

function chunks(...parts: string[]): Uint8Array[] {
  return parts.map((part) => new TextEncoder().encode(part));
}

function bodyOf(parts: Uint8Array[], hooks: { returned?: boolean; destroyed?: boolean } = {}) {
  let index = 0;
  return {
    async next() {
      if (index >= parts.length) return { done: true as const, value: undefined };
      return { done: false as const, value: parts[index++] };
    },
    async return() {
      hooks.returned = true;
      return { done: true as const, value: undefined };
    },
    destroy() {
      hooks.destroyed = true;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function storage(send: S3ClientLike["send"]) {
  return new OpeningS3({
    endpoint: "http://minio", region: "us-east-1", bucket: "opening-bucket",
    accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true,
  }, { send });
}

describe("createOpeningBackupReader", () => {
  it("sends the real GetObjectCommand for the bound final key and yields chunks lazily", async () => {
    const parts = chunks("ab", "cd");
    let reads = 0;
    const body = {
      async next() {
        reads += 1;
        if (reads > parts.length) return { done: true as const, value: undefined };
        return { done: false as const, value: parts[reads - 1]! };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const send = vi.fn(async () => ({ Body: body }));
    const opening = storage(send);
    const reader = createOpeningBackupReader(opening);
    const key = reader.finalKey("source-id", 3);
    expect(key).toBe(opening.finalKey("source-id", 3));
    expect(send).not.toHaveBeenCalled();

    const iterable = await reader.readObject(key);
    expect(send).toHaveBeenCalledTimes(1);
    const command = (send.mock.calls as unknown as Array<[GetObjectCommand]>)[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as unknown as GetObjectCommand).input).toEqual({ Bucket: "opening-bucket", Key: key });
    expect(reads).toBe(0);

    const seen: Uint8Array[] = [];
    for await (const chunk of iterable) {
      seen.push(chunk);
      expect(reads).toBe(seen.length);
    }
    expect(seen).toEqual(parts);
    expect(Buffer.concat(seen).toString()).toBe("abcd");
  });

  it("keeps finalKey bound when the method is detached", () => {
    const opening = storage(vi.fn());
    const { finalKey } = createOpeningBackupReader(opening);
    expect(finalKey("source-id", 0)).toBe("opening/sources/source-id/v0");
  });

  it("closes the underlying iterator when the consumer stops early", async () => {
    const hooks: { returned?: boolean; destroyed?: boolean } = {};
    const send = vi.fn(async () => ({ Body: bodyOf(chunks("one", "two", "three"), hooks) }));
    const reader = createOpeningBackupReader(storage(send));
    const iterable = await reader.readObject("opening/sources/source-id/v1");
    const iterator = iterable[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(chunks("one")[0]);
    await iterator.return?.();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(hooks.returned || hooks.destroyed).toBe(true);
  });

  it("maps a mid-stream failure to content-free UNAVAILABLE and closes the body", async () => {
    const hooks: { returned?: boolean; destroyed?: boolean } = {};
    const body = bodyOf(chunks("kept"), hooks);
    const original = body.next.bind(body);
    let calls = 0;
    body.next = async () => {
      calls += 1;
      if (calls > 1) throw new Error(`midstream ${SECRET}`);
      return original();
    };
    const reader = createOpeningBackupReader(storage(async () => ({ Body: body })));
    const iterable = await reader.readObject("opening/sources/source-id/v1");
    const seen: Uint8Array[] = [];
    await expect((async () => {
      for await (const chunk of iterable) seen.push(chunk);
    })()).rejects.toMatchObject({
      name: "OpeningStorageError", code: "UNAVAILABLE", message: "storage service unavailable",
    });
    expect(seen).toEqual(chunks("kept"));
    expect(hooks.returned || hooks.destroyed).toBe(true);
  });

  it("maps missing objects to NOT_FOUND and other send failures to UNAVAILABLE without error text", async () => {
    const missing = createOpeningBackupReader(storage(async () => {
      throw sdkError("NoSuchKey", 404);
    }));
    await expect(missing.readObject("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(missing.readObject("missing")).rejects.toThrow(/^storage object not found$/);

    const denied = createOpeningBackupReader(storage(async () => {
      throw sdkError("AccessDenied", 403, `denied ${SECRET}`);
    }));
    await expect(denied.readObject("secret-key")).rejects.toMatchObject({
      name: "OpeningStorageError", code: "UNAVAILABLE",
    });
    await expect(denied.readObject("secret-key")).rejects.toThrow(/^storage service unavailable$/);
  });

  it("maps a missing mid-stream body to NOT_FOUND", async () => {
    const reader = createOpeningBackupReader(storage(async () => ({
      Body: (async function* body() {
        yield chunks("kept")[0]!;
        const error = sdkError("NoSuchKey", 404);
        throw error;
      })(),
    })));
    const iterable = await reader.readObject("opening/sources/source-id/v1");
    await expect((async () => {
      for await (const chunk of iterable) void chunk;
    })()).rejects.toMatchObject({ name: "OpeningStorageError", code: "NOT_FOUND" });
  });

  it("sanitizes lazy iterator-construction failures", async () => {
    const reader = createOpeningBackupReader(storage(async () => ({
      Body: { [Symbol.asyncIterator]() { throw new Error(`iterator secret ${SECRET}`); } },
    })));
    const iterable = await reader.readObject("opening/sources/source-id/v0");
    await expect((async () => {
      for await (const chunk of iterable) void chunk;
    })()).rejects.toMatchObject({
      name: "OpeningStorageError", code: "UNAVAILABLE", message: "storage service unavailable",
    });
  });

  it("sanitizes cleanup failures after a stream error", async () => {
    const reader = createOpeningBackupReader(storage(async () => ({
      Body: {
        async next() { throw new Error(`stream secret ${SECRET}`); },
        async return() { throw new Error(`return secret ${SECRET}`); },
        destroy() { throw new Error(`destroy secret ${SECRET}`); },
        [Symbol.asyncIterator]() { return this; },
      },
    })));
    const iterable = await reader.readObject("opening/sources/source-id/v0");
    await expect((async () => {
      for await (const chunk of iterable) void chunk;
    })()).rejects.toMatchObject({
      name: "OpeningStorageError", code: "UNAVAILABLE", message: "storage service unavailable",
    });
  });

  it("rejects a missing, non-iterable, or non-byte body without buffering it", async () => {
    const cases = [{}, { Body: null }, { Body: { transformToByteArray: async () => chunks("nope") } }, { Body: "text-body" }];
    for (const response of cases) {
      const reader = createOpeningBackupReader(storage(async () => response));
      await expect(reader.readObject("opening/sources/source-id/v0")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    const badChunk = createOpeningBackupReader(storage(async () => ({
      Body: { async *[Symbol.asyncIterator]() { yield "not-bytes"; } },
    })));
    await expect((async () => {
      for await (const chunk of await badChunk.readObject("opening/sources/source-id/v0")) void chunk;
    })()).rejects.toMatchObject({ code: "UNAVAILABLE", message: "storage service unavailable" });
  });
});
