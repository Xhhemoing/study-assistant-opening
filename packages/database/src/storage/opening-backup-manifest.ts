import type { OpeningBackupObject } from "@aistudy/domain";
import type { OpeningStorage } from "./opening-s3";

export type OpeningBackupSource = {
  sourceId: string;
  version: number;
  bytes: number;
  sha256: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

function invalid(message: string): Error {
  return new Error(message);
}

function assertSources(sources: readonly OpeningBackupSource[]): void {
  if (!Array.isArray(sources)) throw invalid("invalid backup source");
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== "object") throw invalid("invalid backup source");
    if (typeof source.sourceId !== "string" || !UUID.test(source.sourceId)) throw invalid("invalid backup source");
    if (!Number.isSafeInteger(source.version) || source.version < 0) throw invalid("invalid backup source");
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 1) throw invalid("invalid backup source");
    if (!Number.isSafeInteger(source.bytes + 1)) throw invalid("invalid backup source");
    if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) throw invalid("invalid backup source");
    const id = `${source.sourceId.toLowerCase()}/${source.version}`;
    if (seen.has(id)) throw invalid("duplicate backup source");
    seen.add(id);
  }
}

export type OpeningBackupSourceSnapshot = {
  sourceId: string;
  version: number;
  bytes: number;
  sha256: string;
};

/** Validates every source synchronously, then returns canonical field copies. */
export function snapshotOpeningBackupSources(
  sources: readonly OpeningBackupSource[],
): OpeningBackupSourceSnapshot[] {
  assertSources(sources);
  return sources.map((source) => ({
    sourceId: source.sourceId.toLowerCase(),
    version: source.version,
    bytes: source.bytes,
    sha256: source.sha256.toLowerCase(),
  }));
}

/** Verifies final object digests. Does not copy bytes or claim an archive snapshot. */
export async function verifyOpeningBackupObjects(
  sources: readonly OpeningBackupSource[],
  storage: Pick<OpeningStorage, "finalKey" | "streamDigest">,
): Promise<OpeningBackupObject[]> {
  const snapshots = snapshotOpeningBackupSources(sources);
  if (!storage || typeof storage.finalKey !== "function" || typeof storage.streamDigest !== "function") {
    throw invalid("storage unavailable");
  }
  const objects: OpeningBackupObject[] = [];
  for (const source of snapshots) {
    const key = storage.finalKey(source.sourceId, source.version);
    let digest: { bytes: number; sha256: string };
    try {
      digest = await storage.streamDigest(key, source.bytes + 1);
    } catch {
      throw invalid("storage unavailable");
    }
    if (!digest || digest.bytes !== source.bytes || digest.sha256.toLowerCase() !== source.sha256) {
      throw invalid("backup object mismatch");
    }
    objects.push({
      sourceId: source.sourceId,
      sha256: source.sha256,
      bytes: source.bytes,
      archivePath: `objects/${source.sourceId}/v${source.version}.bin`,
      actualSha256: digest.sha256.toLowerCase(),
    });
  }
  return objects;
}
