import { knowledgeSnapshotSchema, type KnowledgeSnapshot } from "@aistudy/contracts";
import { z } from "zod";

export const storedKnowledgeSnapshotSchema = knowledgeSnapshotSchema.extend({
  coveredSourceChunkDigests: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
});
export type StoredKnowledgeSnapshot = z.infer<typeof storedKnowledgeSnapshotSchema>;

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
export function readPublicKnowledgeSnapshot(raw: unknown, eligible?: Record<string, number>): KnowledgeSnapshot {
  const { coveredSourceChunkDigests: _digests, coveredSourceVersions, ...snapshot } = storedKnowledgeSnapshotSchema.parse(raw);
  const coverage = eligible ? filteredCoverage(coveredSourceVersions, eligible) : coveredSourceVersions ?? {};
  return Object.keys(coverage).length ? { ...snapshot, coveredSourceVersions: coverage } : snapshot;
}
