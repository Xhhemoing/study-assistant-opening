import { createHash, type Hash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { OpeningBackupObject } from "@aistudy/domain";
import { snapshotOpeningBackupSources, type OpeningBackupSource } from "./opening-backup-manifest";

export type OpeningBackupObjectReader = {
  finalKey(sourceId: string, version: number): string;
  readObject(key: string): Promise<AsyncIterable<Uint8Array>>;
};

function failure(message: string): Error {
  return new Error(message);
}

function metering(limit: number, hash: Hash): Transform & { seen: number } {
  const transform = new Transform({
    transform(chunk: Uint8Array, _encoding, callback) {
      const bytes = chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || transform.seen > limit - bytes) {
        callback(failure("backup object mismatch"));
        return;
      }
      transform.seen += bytes;
      hash.update(chunk);
      callback(null, chunk);
    },
  }) as Transform & { seen: number };
  transform.seen = 0;
  return transform;
}

async function stageOne(
  directory: string,
  source: ReturnType<typeof snapshotOpeningBackupSources>[number],
  storage: OpeningBackupObjectReader,
): Promise<OpeningBackupObject> {
  const relative = path.join("objects", source.sourceId, `v${source.version}.bin`);
  const destination = path.join(directory, relative);
  let key: string;
  try {
    key = storage.finalKey(source.sourceId, source.version);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  } catch {
    throw failure("storage unavailable");
  }
  let body: AsyncIterable<Uint8Array>;
  try {
    body = await storage.readObject(key);
  } catch {
    throw failure("storage unavailable");
  }
  const hash = createHash("sha256");
  const meter = metering(source.bytes, hash);
  try {
    await pipeline(Readable.from(body), meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    if (error instanceof Error && error.message === "backup object mismatch") throw error;
    throw failure("storage unavailable");
  }
  const actualSha256 = hash.digest("hex");
  if (meter.seen !== source.bytes || actualSha256 !== source.sha256) throw failure("backup object mismatch");
  return {
    sourceId: source.sourceId,
    sha256: source.sha256,
    bytes: source.bytes,
    archivePath: relative.split(path.sep).join("/"),
    actualSha256,
  };
}

/** Copies verified objects into a private local staging directory. Caller owns success cleanup.
 * parentDirectory must already exist and be trusted. POSIX 0700/0600 modes are requested, but Windows
 * does not enforce them; the caller must apply a restrictive Windows ACL. Mode bits are not privacy proof.
 */
export async function stageOpeningBackupObjects(
  sources: readonly OpeningBackupSource[],
  parentDirectory: string,
  storage: OpeningBackupObjectReader,
): Promise<{ directory: string; objects: OpeningBackupObject[] }> {
  const snapshots = snapshotOpeningBackupSources(sources);
  if (!storage || typeof storage.finalKey !== "function" || typeof storage.readObject !== "function") {
    throw failure("storage unavailable");
  }
  if (typeof parentDirectory !== "string" || parentDirectory.length === 0) throw failure("invalid staging parent");
  let directory: string;
  try {
    directory = await mkdtemp(path.join(parentDirectory, "opening-backup-"));
  } catch {
    throw failure("staging unavailable");
  }
  const objects: OpeningBackupObject[] = [];
  try {
    for (const source of snapshots) objects.push(await stageOne(directory, source, storage));
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: false });
    } catch {
      throw failure("staging cleanup failed");
    }
    throw error instanceof Error ? error : failure("storage unavailable");
  }
  return { directory, objects };
}
