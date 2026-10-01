import type { OpeningBackup } from "@aistudy/domain";
import type { Sql } from "postgres";

export type OpeningMemoryDeletions = NonNullable<OpeningBackup["memoryDeletions"]>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Called only inside an owner-checked snapshot transaction. Never reads memory bodies. */
export async function readOpeningMemoryDeletions(tx: Sql, workspaceId: string): Promise<OpeningMemoryDeletions> {
  const rows = await tx`
    SELECT id, updated_at FROM opening_memories
    WHERE workspace_id = ${workspaceId} AND status = 'deleted'
    ORDER BY id`;
  return { workspaceId: workspaceId.toLowerCase(), memories: rows.map(row => ({
    memoryId: String(row.id).toLowerCase(), deletedAt: new Date(row.updated_at as string | Date).toISOString(),
  })) };
}

/** Copy before an asynchronous re-read so caller mutation cannot change the comparison. */
export function copyMemoryDeletions(value: OpeningMemoryDeletions, workspaceId: string): OpeningMemoryDeletions {
  if (!value || typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId)
    || value.workspaceId.toLowerCase() !== workspaceId.toLowerCase() || !Array.isArray(value.memories)
    || Object.keys(value).some(key => key !== "workspaceId" && key !== "memories")) throw new Error("invalid memory deletion snapshot");
  const seen = new Set<string>();
  const memories = value.memories.map(mark => {
    if (!mark || typeof mark.memoryId !== "string" || !UUID.test(mark.memoryId)
      || typeof mark.deletedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(mark.deletedAt)
      || !Number.isFinite(Date.parse(mark.deletedAt))
      || Object.keys(mark).some(key => key !== "memoryId" && key !== "deletedAt")) throw new Error("invalid memory deletion snapshot");
    const memoryId = mark.memoryId.toLowerCase();
    if (seen.has(memoryId)) throw new Error("invalid memory deletion snapshot");
    seen.add(memoryId);
    return { memoryId, deletedAt: new Date(mark.deletedAt).toISOString() };
  }).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  return { workspaceId: value.workspaceId.toLowerCase(), memories };
}
