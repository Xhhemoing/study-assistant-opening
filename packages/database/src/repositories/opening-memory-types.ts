import type { MemoryItem } from "@aistudy/contracts";

export type OpeningMemoryErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT";

export class OpeningMemoryError extends Error {
  readonly code: OpeningMemoryErrorCode;
  constructor(code: OpeningMemoryErrorCode, message: string) {
    super(message);
    this.name = "OpeningMemoryError";
    this.code = code;
  }
}

export type ProposeMemoryInput = {
  text: string;
  sourceTurnIds: string[];
  expiresAt: string | null;
  courseId?: string | null;
};

export function mapMemoryRow(row: Record<string, unknown>): MemoryItem {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    courseId: (row.course_id as string | null) ?? null,
    kind: row.kind as MemoryItem["kind"],
    text: row.text as string,
    sourceTurnIds: (row.source_turn_ids as string[]) ?? [],
    version: Number(row.version),
    expiresAt: row.expires_at
      ? new Date(row.expires_at as string | Date).toISOString()
      : null,
    status: row.status as MemoryItem["status"],
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}
