import { GetObjectCommand } from "@aws-sdk/client-s3";
import { OpeningStorageError, type OpeningS3 } from "./opening-s3";

export type OpeningBackupObjectReader = {
  finalKey(sourceId: string, version: number): string;
  readObject(key: string): Promise<AsyncIterable<Uint8Array>>;
};

type ByteIterator = AsyncIterator<Uint8Array>;
type CloseableSource = AsyncIterable<unknown> & { destroy?: () => void };

function unavailable(): OpeningStorageError {
  return new OpeningStorageError("UNAVAILABLE", "storage service unavailable");
}

function mapError(error: unknown): OpeningStorageError {
  const candidate = error as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  if (candidate?.$metadata?.httpStatusCode === 404 || candidate?.name === "NoSuchKey" || candidate?.name === "NotFound" || candidate?.code === "NOT_FOUND") {
    return new OpeningStorageError("NOT_FOUND", "storage object not found");
  }
  return unavailable();
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  try {
    return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
  } catch {
    return false;
  }
}

function byteStream(source: AsyncIterable<unknown>): AsyncIterable<Uint8Array> {
  let iterator: ByteIterator | undefined;
  let closed = false;
  let closeFailure: OpeningStorageError | undefined;
  const closeableSource = source as CloseableSource;
  const ensureIterator = (): ByteIterator => {
    if (iterator) return iterator;
    iterator = source[Symbol.asyncIterator]() as ByteIterator;
    return iterator;
  };
  const close = async (): Promise<void> => {
    if (closed) {
      if (closeFailure) throw closeFailure;
      return;
    }
    closed = true;
    try {
      const current = ensureIterator();
      if (typeof current.return === "function") {
        await current.return();
        return;
      }
    } catch {
      // Fall back to destroying the SDK body below.
    }
    try {
      if (typeof closeableSource.destroy === "function") {
        closeableSource.destroy();
        return;
      }
    } catch {
      // Report the failed close without exposing the source error.
    }
    closeFailure = unavailable();
    throw closeFailure;
  };
  const wrapped: ByteIterator = {
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        const step = await ensureIterator().next();
        if (step.done) {
          closed = true;
          return { done: true, value: undefined };
        }
        if (!isBytes(step.value)) throw unavailable();
        return { done: false, value: step.value };
      } catch (error) {
        try { await close(); } catch { /* preserve the sanitized stream error */ }
        throw mapError(error);
      }
    },
    async return() {
      await close();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => wrapped };
}

export function createOpeningBackupReader(
  storage: Pick<OpeningS3, "client" | "bucket" | "finalKey">,
): OpeningBackupObjectReader {
  return {
    finalKey: (sourceId, version) => storage.finalKey(sourceId, version),
    async readObject(key) {
      let body: unknown;
      try {
        const response = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
        body = response?.Body;
      } catch (error) {
        throw mapError(error);
      }
      if (!isAsyncIterable(body)) throw unavailable();
      return byteStream(body);
    },
  };
}
