import { rankMaterialContext, runBudgetedEmbedding, type MaterialRetriever } from "@aistudy/ai";
import { loadOpeningEmbeddingConfig } from "@aistudy/config";
import { createOpeningCourseReadySourcesRepository, createOpeningSourceEmbeddingsRepository, type OpeningBudgetRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import type { CourseSourceUse } from "@aistudy/contracts";

type CourseMaterialContext = { courseId: string | null; materialUse: CourseSourceUse };
type ScopedMaterialRetriever = (scope: Parameters<MaterialRetriever>[0],
  input: Parameters<MaterialRetriever>[1] & { courseContext?: CourseMaterialContext }) =>
    Promise<Awaited<ReturnType<MaterialRetriever>> & { assertCurrent(): Promise<void> }>;
import { scopeBudget } from "./model-gateway";

/** One material path for saved chat, temporary chat and the teaching compiler. */
export function createOpeningMaterialRetriever(
  sql: Sql,
  budget: OpeningBudgetRepository,
  config = loadOpeningEmbeddingConfig(),
): ScopedMaterialRetriever {
  const purposes = createOpeningCourseReadySourcesRepository(sql);
  const repository = createOpeningSourceEmbeddingsRepository(sql);
  return async (scope, input) => {
    if (!input.courseContext || (input.courseContext.courseId !== null
      && (typeof input.courseContext.courseId !== "string" || !input.courseContext.courseId))
      || !["teaching", "practice", "citation"].includes(input.courseContext.materialUse)) {
      throw Object.assign(new Error("trusted course and material use are required"), { code: "CONFLICT" });
    }
    const purposePin = await purposes.readMaterialPurposePin(scope, {
      ...input.courseContext, sourceIds: input.sourceIds,
    });
    const selectedSources = new Set(input.sourceIds);
    const before = await repository.authorizeChunks(scope, input.chunks.filter(chunk => selectedSources.has(chunk.sourceId)));
    let dense: Awaited<ReturnType<typeof repository.search>> = [];
    let mode: "hybrid" | "lexical" = "lexical";
    try {
      const sourceIds = [...new Set(before.chunks.map(chunk => chunk.sourceId))];
      if (config && input.query.trim() && sourceIds.length && await repository.hasIndex(scope, { ...config, sourceIds })) {
        const query = Array.from(input.query).reduce((state, character) => {
          if (state.full) return state;
          const bytes = new TextEncoder().encode(character).length;
          return state.bytes + bytes > 8192 ? { ...state, full: true }
            : { text: state.text + character, bytes: state.bytes + bytes, full: false };
        }, { text: "", bytes: 0, full: false }).text;
        const result = await runBudgetedEmbedding({ config, inputs: [query], budget: scopeBudget(budget, scope),
          operationId: `material-query:${input.operationId}`, signal: input.signal,
          parentBudget: input.parentBudget, timeoutMs: 2_000,
          beforeSend: async () => {
            await purposes.assertMaterialPurposePin(scope, purposePin);
            const now = await repository.authorizeChunks(scope, before.chunks);
            if (now.privacyEpoch !== before.privacyEpoch || now.chunks.length !== before.chunks.length) throw new Error("material privacy changed");
          },
        });
        dense = await repository.search(scope, { ...config, sourceIds, vector: result.vectors[0]! });
        if (dense.length) mode = "hybrid";
      }
    } catch (error) {
      if (input.signal?.aborted || (error as { code?: string } | null)?.code === "CONFLICT") throw error;
      // A missing index/provider/quota affects ranking only; authorized lexical material remains usable.
    }
    await purposes.assertMaterialPurposePin(scope, purposePin);
    const after = await repository.authorizeChunks(scope, before.chunks);
    return { chunks: rankMaterialContext({ ...input, chunks: after.chunks, dense }), mode, purposePin,
      // Caller must keep this exact pin through the actual model send/release.
      assertCurrent: () => purposes.assertMaterialPurposePin(scope, purposePin) };
  };
}
