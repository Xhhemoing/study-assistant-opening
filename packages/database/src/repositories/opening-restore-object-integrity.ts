import { createHash } from "node:crypto";
import type { OpeningBackup, OpeningBackupObject } from "@aistudy/domain";
import { snapshotOpeningBackupSources } from "../storage/opening-backup-manifest";

function reject(message: string): never {
  throw Object.assign(new Error(`restore object integrity: ${message}`), { restoreCode: "PREFLIGHT_REJECTED" });
}

/** Bind manifests to owned current/historical versions, then snapshot and verify ALL
 * bodies before the executor may cancel jobs, insert rows or publish any object.
 * Without a writer only manifests are checked; object application remains deferred.
 */
export async function prepareOpeningRestoreObjects(
  backup: OpeningBackup,
  parseVersion: (archivePath: string, sourceId: string) => number,
  resolveBody?: (archivePath: string) => Promise<Uint8Array | undefined>,
): Promise<Array<OpeningBackupObject & { body: Uint8Array }>> {
  try {
    const sources = (backup.tables.opening_sources ?? []) as Record<string, unknown>[];
    const versions = (backup.tables.opening_source_versions ?? []) as Record<string, unknown>[];
    const owned = new Set<string>();
    const explicitVersions = new Set<string>();
    const metadata = new Map<string, { bytes: number; sha256: string }>();
    function add(row: Record<string, unknown>, sourceId: unknown) {
      if (typeof row.workspace_id !== "string" || row.workspace_id.toLowerCase() !== backup.workspaceId.toLowerCase()) reject("foreign source workspace");
      const [snapshot] = snapshotOpeningBackupSources([{
        sourceId: sourceId as string, version: row.version as number,
        bytes: row.bytes as number, sha256: row.sha256 as string,
      }]);
      if (!snapshot) reject("missing source metadata");
      const key = `${snapshot.sourceId}/${snapshot.version}`;
      const previous = metadata.get(key);
      if (previous && (previous.bytes !== snapshot.bytes || previous.sha256 !== snapshot.sha256)) reject("conflicting source version metadata");
      metadata.set(key, snapshot);
      return { key, sourceId: snapshot.sourceId };
    }
    for (const row of sources) {
      const source = add(row, row.id);
      if (owned.has(source.sourceId)) reject("duplicate source");
      owned.add(source.sourceId);
    }
    for (const row of versions) {
      const version = add(row, row.source_id);
      if (!owned.has(version.sourceId)) reject("version has no owned source");
      if (explicitVersions.has(version.key)) reject("duplicate source version");
      explicitVersions.add(version.key);
    }
    const seenVersions = new Set<string>(), seenPaths = new Set<string>();
    const manifests = backup.objects.map(object => {
      const version = parseVersion(object.archivePath, object.sourceId);
      if (!Number.isSafeInteger(version) || version < 0
        || object.archivePath !== `objects/${object.sourceId}/v${version}.bin`) reject("invalid object version path");
      const key = `${object.sourceId.toLowerCase()}/${version}`;
      if (seenVersions.has(key) || seenPaths.has(object.archivePath)) reject("duplicate object source version or path");
      seenVersions.add(key); seenPaths.add(object.archivePath);
      const expected = metadata.get(key);
      if (!owned.has(object.sourceId.toLowerCase()) || !expected) reject("object has no owned source version");
      if (object.bytes !== expected.bytes || object.sha256.toLowerCase() !== expected.sha256) reject("object manifest metadata mismatch");
      return { ...object };
    });
    const prepared: Array<OpeningBackupObject & { body: Uint8Array }> = [];
    if (resolveBody) {
      for (const object of manifests) {
        const input = await resolveBody(object.archivePath);
        if (!input) reject(`missing object bytes for ${object.archivePath}`);
        // Copy in-memory bodies too: later caller mutation must not change verified bytes.
        const body = Uint8Array.from(input);
        if (body.byteLength !== object.bytes || createHash("sha256").update(body).digest("hex") !== object.sha256.toLowerCase()) {
          reject(`body length or SHA256 mismatch for ${object.archivePath}`);
        }
        prepared.push({ ...object, body });
      }
    }
    return prepared;
  } catch (error) {
    if ((error as { restoreCode?: string }).restoreCode === "PREFLIGHT_REJECTED") throw error;
    reject(error instanceof Error ? error.message : String(error));
  }
}
