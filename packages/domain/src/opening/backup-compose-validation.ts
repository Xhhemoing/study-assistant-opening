import { LEARNING_STATE_TABLES } from "./backup-learning-state";
import type { OpeningBackupObject, OpeningDeletionMark } from "./backup-policy";
import { isJournal, isUuid } from "./backup-validation";

export const BACKUP_TABLES = new Set([
  ...LEARNING_STATE_TABLES,
  "opening_sources", "opening_source_chunks", "opening_conversations", "opening_turns",
  "opening_learning_sessions", "opening_problem_refs", "opening_help_exposures",
  "opening_learning_observations", "opening_assistant_candidates", "opening_memories",
  "opening_privacy_exclusions", "opening_tasks", "opening_retest_activities", "opening_timetable_sessions", "opening_hard_blocks",
  "opening_plan_state", "opening_plan_drafts", "opening_plan_acceptances",
  "opening_source_versions", "opening_learning_item_versions", "opening_learning_attempts", "opening_learning_history_revisions", "opening_workspace_history_revisions",
]);

const SHA256 = /^[0-9a-f]{64}$/i;

export function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

function journalKey(mark: OpeningDeletionMark): string {
  return `${mark.sourceId.toLowerCase()}\u0000${new Date(mark.deletedAt).toISOString()}\u0000${mark.assetDeletedAt ? new Date(mark.assetDeletedAt).toISOString() : ""}`;
}

export function uniqueJournal(value: unknown): value is OpeningDeletionMark[] {
  if (!isJournal(value)) return false;
  const ids = new Set<string>();
  return value.every((mark) => {
    const id = mark.sourceId.toLowerCase();
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

export function sameJournal(left: unknown, right: unknown): boolean {
  if (!uniqueJournal(left) || !uniqueJournal(right) || left.length !== right.length) return false;
  const a = new Set(left.map(journalKey));
  return right.every((mark) => a.has(journalKey(mark)));
}

export function tableJournal(tables: Record<string, Record<string, unknown>[]>): OpeningDeletionMark[] | null {
  const rows = tables.opening_privacy_exclusions ?? [];
  const marks: OpeningDeletionMark[] = [];
  for (const row of rows) {
    if (!isUuid(row.source_id)
      || (!(typeof row.deleted_at === "string" || row.deleted_at instanceof Date))
      || !Number.isFinite(new Date(row.deleted_at).getTime())) return null;
    if (row.asset_deleted_at != null && (!(typeof row.asset_deleted_at === "string" || row.asset_deleted_at instanceof Date)
      || !Number.isFinite(new Date(row.asset_deleted_at).getTime()))) return null;
    marks.push({ sourceId: row.source_id, deletedAt: new Date(row.deleted_at).toISOString(),
      ...(row.asset_deleted_at ? { assetDeletedAt: new Date(row.asset_deleted_at as string | Date).toISOString() } : {}) });
  }
  return uniqueJournal(marks) ? marks : null;
}

export function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function validSource(value: unknown): value is { sourceId: string; version: number; bytes: number; sha256: string } {
  return !!value && typeof value === "object"
    && isUuid((value as { sourceId?: unknown }).sourceId)
    && Number.isSafeInteger((value as { version?: unknown }).version)
    && ((value as { version: number }).version >= 0)
    && Number.isSafeInteger((value as { bytes?: unknown }).bytes)
    && ((value as { bytes: number }).bytes > 0)
    && validHash((value as { sha256?: unknown }).sha256);
}

export function sourceMap(rows: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isUuid(row.id) || !isUuid(row.workspace_id) || !validSource({
      sourceId: row.id, version: row.version, bytes: row.bytes, sha256: row.sha256,
    }) || result.has(row.id.toLowerCase())) return null;
    result.set(row.id.toLowerCase(), row);
  }
  return result;
}

export function canonicalObject(source: { sourceId: string; version: number }, object: OpeningBackupObject): OpeningBackupObject {
  return {
    sourceId: source.sourceId.toLowerCase(),
    sha256: object.sha256.toLowerCase(),
    bytes: object.bytes,
    archivePath: `objects/${source.sourceId.toLowerCase()}/v${source.version}.bin`,
  };
}

export const sourceVersionKey = (sourceId: string, version: number): string => `${sourceId.toLowerCase()}/${version}`;

/** Legacy archives describe only the current version; new archives retain known historical metadata. */
export function sourceVersionMap(
  sources: Map<string, Record<string, unknown>>,
  versions: readonly Record<string, unknown>[],
): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of versions) {
    if (!isUuid(row.source_id) || !Number.isSafeInteger(row.version) || (row.version as number) < 0
      || !sources.has(row.source_id.toLowerCase())
      || !["available", "unavailable", "unknown"].includes(String(row.availability))) return null;
    const key = sourceVersionKey(row.source_id, row.version as number);
    if (result.has(key)) return null;
    if (row.bytes !== null && (!Number.isSafeInteger(row.bytes) || (row.bytes as number) <= 0)) return null;
    if (row.sha256 !== null && !validHash(row.sha256)) return null;
    if (row.availability === "available" && (row.bytes === null || row.sha256 === null)) return null;
    result.set(key, row);
  }
  for (const [id, source] of sources) {
    const key = sourceVersionKey(id, source.version as number), row = result.get(key);
    if (row && (row.bytes !== source.bytes || row.sha256 !== source.sha256)) return null;
    if (!row) result.set(key, { ...source, source_id: id, availability: "available" });
  }
  return result;
}

/** Existing inventories stay complete; learning state and workspace history are additive. */
export function validBackupTableSet(tables: Record<string, unknown[]>): boolean {
  const names = Object.keys(tables);
  return names.every(name => BACKUP_TABLES.has(name))
    && [...BACKUP_TABLES].every(name => (LEARNING_STATE_TABLES as readonly string[]).includes(name)
      || name === "opening_workspace_history_revisions" || name in tables);
}
