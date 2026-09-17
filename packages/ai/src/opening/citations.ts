import type { Citation, SourceChunk } from "@aistudy/contracts";

function formatTimestamp(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function label(chunk: SourceChunk): string {
  const location = chunk.slideLabel
    ? `slide ${chunk.slideLabel}`
    : `page ${chunk.page ?? "-"}`;
  const timestamp = chunk.startMs === null ? "" : ` at ${formatTimestamp(chunk.startMs)}`;
  return `source ${chunk.sourceId} v${chunk.sourceVersion} ${location}${timestamp}`;
}

export function resolveCitations(ids: string[], chunks: SourceChunk[]): Citation[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return ids.map((id) => {
    const chunk = byId.get(id);
    if (!chunk) throw new RangeError(`unknown citation: ${id}`);
    return { chunkId: chunk.id, sourceId: chunk.sourceId, sourceVersion: chunk.sourceVersion, label: label(chunk) };
  });
}
