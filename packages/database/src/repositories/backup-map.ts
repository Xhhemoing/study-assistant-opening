import { NativeBackupError, type NativeBackupFileInput, type RestoreCollection } from "@aistudy/domain";
import { BackupRestoreError } from "./backup-types";

export { BackupRestoreError } from "./backup-types";

export const COLLECTION_TABLES: Record<RestoreCollection, string> = {
  courses: "courses",
  documents: "library_documents",
  blocks: "library_blocks",
  revisions: "library_revisions",
  relations: "library_relations",
  memberships: "course_asset_memberships",
  goals: "course_goals",
  windows: "goal_time_windows",
  explorations: "explorations",
  promotions: "promotion_records",
  cards: "cards",
  events: "learning_events",
};

export function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    result[camel] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

export function filesFromBlocks(blocks: Array<Record<string, unknown>>): NativeBackupFileInput[] {
  const files: NativeBackupFileInput[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const content = asObject(block.content);
    if (!content) continue;
    const path = typeof content.href === "string" ? content.href : "";
    const bytesBase64 = typeof content.bytesBase64 === "string" ? content.bytesBase64 : "";
    if (!path || !bytesBase64 || seen.has(path)) continue;
    seen.add(path);
    files.push({
      path,
      mediaType: typeof content.mediaType === "string" ? content.mediaType : "application/octet-stream",
      bytes: Uint8Array.from(Buffer.from(bytesBase64, "base64")),
    });
  }
  return files;
}

export function wrapBackupError(error: unknown): never {
  if (error instanceof BackupRestoreError) throw error;
  if (error instanceof NativeBackupError) {
    const code = error.code === "ID_CONFLICT"
      ? "CONFLICT"
      : error.code === "INCOMPATIBLE_SCHEMA"
        ? "INCOMPATIBLE_SCHEMA"
        : error.code === "FILE_HASH_MISMATCH"
          ? "FILE_HASH_MISMATCH"
          : "VALIDATION";
    throw new BackupRestoreError(code, error.message);
  }
  throw error;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asRecords(value: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> & { id: string } => {
    return Boolean(item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");
  });
}

export function pickColumns(
  row: Record<string, unknown>,
  columns: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(columns)) {
    if (row[field] !== undefined) result[column] = row[field];
  }
  return result;
}
