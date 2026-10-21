import { materialSegmentKey, runBudgetedEmbedding, segmentMaterialChunks, type BudgetedRepository } from "@aistudy/ai";
import type { loadOpeningEmbeddingConfig } from "@aistudy/config";
import { openingJobScope, type OpeningJobRecord, type OpeningSourceEmbeddingsRepository } from "@aistudy/database";

export type IndexSourceDeps = {
  repository: Pick<OpeningSourceEmbeddingsRepository, "snapshot" | "assertCurrent" | "listIndexedKeys" | "store">;
  config: ReturnType<typeof loadOpeningEmbeddingConfig>;
  budget(scope: { workspaceId: string; ownerUserId: string }): BudgetedRepository;
  embed?: typeof runBudgetedEmbedding;
};

export function createIndexSourceHandler(deps: IndexSourceDeps) {
  return async (job: OpeningJobRecord, payload: unknown) => {
    const input = payload as { sourceId?: unknown; sourceVersion?: unknown } | null;
    if (typeof input?.sourceId !== "string" || !Number.isInteger(input.sourceVersion)) throw new Error("invalid source index job");
    if (!deps.config) return { indexed: false, reason: "embedding_not_configured" };
    const scope = openingJobScope(job);
    const snapshot = await deps.repository.snapshot(scope, input.sourceId, input.sourceVersion as number);
    if (!snapshot || snapshot.privacyEpoch !== job.privacyEpoch) return { indexed: false, reason: "source_changed" };
    const config = deps.config;
    const segments = segmentMaterialChunks(snapshot.chunks).filter(segment => segment.chunk.text.trim());
    if (!segments.length) return { indexed: false, reason: "no_text" };
    const known = new Set(await deps.repository.listIndexedKeys(scope, snapshot, config));
    const pending = segments.filter(segment => !known.has(materialSegmentKey(segment)));
    for (let offset = 0; offset < pending.length; offset += 32) {
      const batch = pending.slice(offset, offset + 32);
      await (deps.embed ?? runBudgetedEmbedding)({
        config,
        inputs: batch.map(segment => segment.chunk.text),
        budget: deps.budget(scope),
        operationId: `source-index:${job.id}:${materialSegmentKey(batch[0]!)}`,
        beforeSend: () => deps.repository.assertCurrent(scope, snapshot),
        persistResult: result => deps.repository.store(scope, snapshot, config,
          batch.map((segment, index) => ({ ...segment, vector: result.vectors[index]! }))),
      });
    }
    return { indexed: true, segments: pending.length, modelKey: config.modelKey };
  };
}
