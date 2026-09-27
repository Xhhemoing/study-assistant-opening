import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
import {
  readOpeningBackupSources,
  type OpeningBackupSource,
  type OpeningBackupSourceSnapshot,
  type OpeningDeletionMark,
} from "./opening-backup-sources";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

export class OpeningBackupCurrentError extends Error {
  readonly code = "CONFLICT" as const;
  constructor() {
    super("backup snapshot changed");
    this.name = "OpeningBackupCurrentError";
  }
}

type Expected = {
  workspaceId: string;
  privacyEpoch: number;
  deletionJournal: OpeningDeletionMark[];
  sources: OpeningBackupSource[];
};

function conflict(): never {
  throw new OpeningBackupCurrentError();
}

function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new Error("invalid backup scope");
  return value.toLowerCase();
}

function copyScope(scope: OpeningScope): OpeningScope {
  return { workspaceId: requireUuid(scope.workspaceId), ownerUserId: requireUuid(scope.ownerUserId) };
}

function copyExpected(scope: OpeningScope, snapshot: OpeningBackupSourceSnapshot): Expected {
  if (typeof snapshot.workspaceId !== "string" || !UUID.test(snapshot.workspaceId) || snapshot.workspaceId.toLowerCase() !== scope.workspaceId) conflict();
  if (!Number.isSafeInteger(snapshot.privacyEpoch) || snapshot.privacyEpoch < 0) throw new Error("invalid backup epoch");
  return {
    workspaceId: snapshot.workspaceId.toLowerCase(),
    privacyEpoch: snapshot.privacyEpoch,
    deletionJournal: canonicalJournal(snapshot.deletionJournal),
    sources: canonicalSources(snapshot.sources),
  };
}

function canonicalJournal(journal: readonly OpeningDeletionMark[]): OpeningDeletionMark[] {
  if (!Array.isArray(journal)) throw new Error("invalid backup journal");
  const seen = new Set<string>();
  const marks = journal.map((mark) => {
    if (!mark || typeof mark.sourceId !== "string" || !UUID.test(mark.sourceId)) throw new Error("invalid backup journal");
    if (typeof mark.deletedAt !== "string" || !Number.isFinite(new Date(mark.deletedAt).getTime())) throw new Error("invalid backup journal");
    const sourceId = mark.sourceId.toLowerCase();
    if (seen.has(sourceId)) throw new Error("duplicate backup journal");
    seen.add(sourceId);
    return { sourceId, deletedAt: new Date(mark.deletedAt).toISOString() };
  });
  return marks.sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.deletedAt.localeCompare(right.deletedAt));
}

function canonicalSources(sources: readonly OpeningBackupSource[]): OpeningBackupSource[] {
  if (!Array.isArray(sources)) throw new Error("invalid backup source");
  const seen = new Set<string>();
  const rows = sources.map((source) => {
    if (!source || typeof source.sourceId !== "string" || !UUID.test(source.sourceId)) throw new Error("invalid backup source");
    if (!Number.isSafeInteger(source.version) || source.version < 0) throw new Error("invalid backup source");
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 1 || !Number.isSafeInteger(source.bytes + 1)) throw new Error("invalid backup source");
    if (typeof source.sha256 !== "string" || !SHA256.test(source.sha256)) throw new Error("invalid backup source");
    const sourceId = source.sourceId.toLowerCase();
    if (seen.has(sourceId)) throw new Error("duplicate backup source");
    seen.add(sourceId);
    return { sourceId, version: source.version, bytes: source.bytes, sha256: source.sha256.toLowerCase() };
  });
  return rows.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function sameTuples(expected: Expected, live: Expected): boolean {
  return expected.privacyEpoch === live.privacyEpoch
    && expected.deletionJournal.length === live.deletionJournal.length
    && expected.sources.length === live.sources.length
    && expected.deletionJournal.every((mark, index) => {
      const current = live.deletionJournal[index];
      return current?.sourceId === mark.sourceId && current.deletedAt === mark.deletedAt;
    })
    && expected.sources.every((source, index) => {
      const current = live.sources[index];
      return current?.sourceId === source.sourceId
        && current.version === source.version
        && current.bytes === source.bytes
        && current.sha256 === source.sha256;
    });
}

/**
 * Boundary observation only. Copying metadata before the re-read cannot stop a
 * later deletion, and this is not a table-wide or database-plus-object atomic lock.
 * The final publish protocol is not designed here.
 */
export async function assertOpeningBackupSnapshotCurrent(
  sql: Sql,
  scope: OpeningScope,
  snapshot: OpeningBackupSourceSnapshot,
): Promise<void> {
  const stableScope = copyScope(scope);
  const expected = copyExpected(stableScope, snapshot);
  const current = copyExpected(stableScope, await readOpeningBackupSources(sql, stableScope));
  if (current.workspaceId !== expected.workspaceId || !sameTuples(expected, current)) conflict();
}
