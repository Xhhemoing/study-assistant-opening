import { createHash } from "node:crypto";
import { storedKnowledgeSnapshotSchema, type KnowledgeSnapshot, type SourceChunk } from "@aistudy/contracts";

export { storedKnowledgeSnapshotSchema, type StoredKnowledgeSnapshot } from "@aistudy/contracts";

/** Parser retries retain identical rows and allocate new IDs for changed or added chunks. */
export function knowledgeChunkDigests(chunks: readonly Pick<SourceChunk, "id" | "sourceId">[]): Record<string, string> {
  const idsBySource = new Map<string, string[]>();
  for (const chunk of chunks) {
    const ids = idsBySource.get(chunk.sourceId) ?? [];
    ids.push(chunk.id);
    idsBySource.set(chunk.sourceId, ids);
  }
  return Object.fromEntries([...idsBySource].map(([id, ids]) => [
    id, createHash("sha256").update(ids.sort().join(",")).digest("hex"),
  ]));
}

export function filteredCoverage<T>(values: Record<string, T> | undefined, allowed: Record<string, unknown>): Record<string, T> {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => Object.hasOwn(allowed, id)));
}

export function coverageFields(versions: Record<string, number>, digests?: Record<string, string>) {
  return {
    ...(Object.keys(versions).length ? { coveredSourceVersions: versions } : {}),
    ...(digests && Object.keys(digests).length ? { coveredSourceChunkDigests: digests } : {}),
  };
}

/** Strip storage metadata before returning a strict API snapshot. */
export function readPublicKnowledgeSnapshot(raw: unknown, allowedCoverage?: Record<string, unknown>): KnowledgeSnapshot {
  const { coveredSourceChunkDigests: _digests, coveredSourceVersions, ...snapshot } = storedKnowledgeSnapshotSchema.parse(raw);
  const coverage = allowedCoverage ? filteredCoverage(coveredSourceVersions, allowedCoverage) : coveredSourceVersions ?? {};
  return Object.keys(coverage).length ? { ...snapshot, coveredSourceVersions: coverage } : snapshot;
}
