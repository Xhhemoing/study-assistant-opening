import type { SourceChunk } from "@aistudy/contracts";

type Scope = { workspaceId: string; ownerUserId: string };
type Chunks = {
  listChunksAtVersion(scope: Scope, sourceId: string, sourceVersion: number): Promise<SourceChunk[]>;
};

export async function chunksAtSnapshots(
  chunks: Chunks,
  scope: Scope,
  sourceIds: string[],
  versions: Record<string, number>,
): Promise<SourceChunk[]> {
  const groups = await Promise.all(sourceIds.map(async (sourceId) => {
    const version = versions[sourceId];
    if (version === undefined) throw new Error(`source material is unavailable: missing snapshot for ${sourceId}`);
    const rows = (await chunks.listChunksAtVersion(scope, sourceId, version)).filter(chunk => chunk.text.trim());
    if (!rows.length) throw new Error(`source material is unavailable: missing chunks for ${sourceId}@${version}`);
    return rows;
  }));
  return groups.flat();
}
