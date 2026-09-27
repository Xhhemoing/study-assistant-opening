import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { writeExclusiveOpeningBackupFile } from "./opening-backup-file-publication";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { OpeningBackup } from "@aistudy/domain";

/** Container format: MAGIC | 8-byte metadata length | metadata JSON | object bytes in declared order. */
const MAGIC = "OPENING-BACKUP-V1";
const MAGIC_BYTES = Buffer.from(MAGIC, "utf8");
const LENGTH_BYTES = 8;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

export type OpeningArchiveReader = {
  metadata: OpeningBackup;
  objectBytes(archivePath: string): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

type ArchiveObject = { archivePath: string; sha256: string; bytes: number };

function invalid(message: string): Error {
  return new Error(message);
}

function metadataBytes(backup: OpeningBackup): Buffer {
  return Buffer.from(JSON.stringify(backup), "utf8");
}

async function verifyStagedObject(staging: string, object: ArchiveObject): Promise<void> {
  let handle;
  try {
    handle = await open(path.join(staging, object.archivePath), "r");
  } catch {
    throw invalid("backup object mismatch");
  }
  try {
    const hash = createHash("sha256");
    let seen = 0;
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
      seen += chunk.byteLength;
    }
    if (seen !== object.bytes || hash.digest("hex") !== object.sha256.toLowerCase()) {
      throw invalid("backup object mismatch");
    }
  } finally {
    await handle.close();
  }
}

/** Writes metadata plus verified staged object bytes. Never overwrites an existing archive. */
export async function writeOpeningBackupArchive(
  backup: OpeningBackup,
  staging: string,
  destination: string,
): Promise<void> {
  const objects = backup.objects;
  for (const object of objects) await verifyStagedObject(staging, object);
  await writeExclusiveOpeningBackupFile(destination, "backup archive already exists", async (handle) => {
    const metadata = metadataBytes(backup);
    const header = Buffer.alloc(MAGIC_BYTES.length + LENGTH_BYTES);
    MAGIC_BYTES.copy(header, 0);
    header.writeBigUInt64BE(BigInt(metadata.length), MAGIC_BYTES.length);
    await handle.write(header);
    await handle.write(metadata);
    for (const object of objects) {
      const source = createReadStream(path.join(staging, object.archivePath));
      let closed = false;
      source.on("close", () => {
        closed = true;
      });
      const target = {
        write: async (chunk: Buffer) => {
          await handle.write(chunk);
        },
      };
      await pipeline(source, async function* (chunks) {
        for await (const chunk of chunks) {
          await target.write(chunk);
          yield chunk;
        }
      });
      if (!closed) throw invalid("backup object mismatch");
    }
    await handle.sync().catch(() => undefined);
  });
}

type LocatedObject = ArchiveObject & { start: bigint };

function locateObjects(objects: ArchiveObject[], start: bigint): LocatedObject[] {
  let offset = start;
  return objects.map((object) => {
    const entry = { ...object, start: offset };
    offset += BigInt(object.bytes);
    return entry;
  });
}

async function parseHeader(handle: import("node:fs/promises").FileHandle): Promise<{
  metadata: OpeningBackup;
  located: LocatedObject[];
}> {
  const magic = await readExact(handle, MAGIC_BYTES.length);
  if (!magic.equals(MAGIC_BYTES)) throw invalid("not an opening backup archive");
  const length = Buffer.from(await readExact(handle, LENGTH_BYTES)).readBigUInt64BE(0);
  if (length > BigInt(MAX_METADATA_BYTES)) throw invalid("not an opening backup archive");
  let metadata: OpeningBackup;
  try {
    metadata = JSON.parse((await readExact(handle, Number(length))).toString("utf8")) as OpeningBackup;
  } catch {
    throw invalid("not an opening backup archive");
  }
  if (!metadata || metadata.format !== "opening-backup" || metadata.version !== 1 || !Array.isArray(metadata.objects)) {
    throw invalid("not an opening backup archive");
  }
  return { metadata, located: locateObjects(metadata.objects, BigInt(MAGIC_BYTES.length + LENGTH_BYTES) + length) };
}

async function readExact(handle: import("node:fs/promises").FileHandle, length: number, position?: bigint): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position === undefined ? null : position + BigInt(offset));
    if (bytesRead === 0) throw invalid("not an opening backup archive");
    offset += bytesRead;
  }
  return buffer;
}

export async function readOpeningBackupArchive(destination: string): Promise<OpeningArchiveReader> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(destination, "r");
  } catch {
    throw invalid("not an opening backup archive");
  }
  const { metadata, located } = await parseHeader(handle).catch(async (error) => {
    await handle?.close();
    throw error;
  });
  let closed = false;
  return {
    metadata,
    objectBytes(archivePath: string): AsyncIterable<Uint8Array> {
      if (closed) throw invalid("archive reader is closed");
      const object = located.find((candidate) => candidate.archivePath === archivePath);
      if (!object) throw invalid("unknown archive object");
      let delivered = 0;
      const hash = createHash("sha256");
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async (): Promise<IteratorResult<Uint8Array>> => {
              if (delivered >= object.bytes) return { done: true, value: undefined };
              const size = Math.min(1024 * 1024, object.bytes - delivered);
              const chunk = await readExact(handle!, size, object.start + BigInt(delivered));
              hash.update(chunk);
              delivered += size;
              if (delivered === object.bytes && hash.digest("hex") !== object.sha256.toLowerCase()) {
                closed = true;
                await handle?.close();
                throw invalid("object verification failed");
              }
              return { done: false, value: new Uint8Array(chunk) };
            },
          };
        },
      };
    },
    close: async () => {
      if (!closed) {
        closed = true;
        await handle?.close();
      }
    },
  };
}
