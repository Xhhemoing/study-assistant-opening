import { rankMaterialContext, runBudgetedEmbedding, type MaterialPedagogicalGraph, type MaterialRetriever } from "@aistudy/ai";
import { loadOpeningEmbeddingConfig } from "@aistudy/config";
import {
  createOpeningCourseReadySourcesRepository,
  createOpeningKnowledgeRepository,
  createOpeningSourceEmbeddingsRepository,
  OpeningBudgetError,
  OpeningKnowledgeError,
  type OpeningBudgetRepository,
} from "@aistudy/database";
import type { Sql } from "postgres";
import type { CourseKnowledgeRecordResponse, CourseSourceUse, SourceChunk } from "@aistudy/contracts";
import { scopeBudget } from "./model-gateway";

type CourseMaterialContext = { courseId: string | null; materialUse: CourseSourceUse };
type ScopedMaterialRetriever = (scope: Parameters<MaterialRetriever>[0],
  input: Parameters<MaterialRetriever>[1] & { courseContext?: CourseMaterialContext; lexicalOnly?: boolean }) =>
    Promise<Awaited<ReturnType<MaterialRetriever>> & { assertCurrent(): Promise<void> }>;

export const retrievalBudgetId = (parentId: string) => {
  let root = parentId;
  while (root.startsWith("retrieval:")) {
    const rest = root.slice("retrieval:".length);
    if (!rest.trim()) break;
    root = rest;
  }
  return root.startsWith("retrieval:") ? root : `retrieval:${root}`;
};

const SUPPORTED_KNOWLEDGE_EDGE_KINDS = new Set(["contains", "prerequisite", "applies_to"] as const);

function reconcileCoursePedagogicalGraph(
  courseId: string,
  record: CourseKnowledgeRecordResponse,
  afterChunks: readonly SourceChunk[],
  privacyEpoch: number,
): MaterialPedagogicalGraph | undefined {
  if (
    record.sync?.status !== "up_to_date" ||
    record.snapshot.courseId !== courseId ||
    (record.snapshot.nodes.length === 0 && record.snapshot.edges.length === 0)
  ) {
    return undefined;
  }

  const admissibleSourceVersions: Record<string, number> = Object.create(null) as Record<string, number>;
  const conflictingSourceIds = new Set<string>();
  for (const chunk of afterChunks) {
    if (
      Object.hasOwn(admissibleSourceVersions, chunk.sourceId) &&
      admissibleSourceVersions[chunk.sourceId] !== chunk.sourceVersion
    ) {
      conflictingSourceIds.add(chunk.sourceId);
    } else {
      admissibleSourceVersions[chunk.sourceId] = chunk.sourceVersion;
    }
  }
  for (const badId of conflictingSourceIds) {
    delete admissibleSourceVersions[badId];
  }

  const admissibleSourceIds = new Set<string>();
  const afterChunkById = new Map<string, SourceChunk>();
  for (const chunk of afterChunks) {
    if (conflictingSourceIds.has(chunk.sourceId)) continue;
    admissibleSourceIds.add(chunk.sourceId);
    afterChunkById.set(chunk.id, chunk);
  }
  if (admissibleSourceIds.size === 0) return undefined;

  const graphConsistentSourceIds = new Set<string>();
  for (const sourceId of admissibleSourceIds) {
    const liveVersion = admissibleSourceVersions[sourceId]!;
    if (Object.hasOwn(record.sourceVersions, sourceId) && record.sourceVersions[sourceId] !== liveVersion) {
      continue;
    }
    if (
      record.snapshot.coveredSourceVersions &&
      Object.hasOwn(record.snapshot.coveredSourceVersions, sourceId) &&
      record.snapshot.coveredSourceVersions[sourceId] !== liveVersion
    ) {
      continue;
    }
    if (
      record.sync.coveredSourceVersions &&
      Object.hasOwn(record.sync.coveredSourceVersions, sourceId) &&
      record.sync.coveredSourceVersions[sourceId] !== liveVersion
    ) {
      continue;
    }
    graphConsistentSourceIds.add(sourceId);
  }
  if (graphConsistentSourceIds.size === 0) return undefined;

  type ConceptList = MaterialPedagogicalGraph["concepts"][number][];
  type EdgeList = MaterialPedagogicalGraph["edges"][number][];
  const candidateConcepts: ConceptList = [];
  const rejectedNodeIds = new Set<string>();
  for (const node of record.snapshot.nodes) {
    if (
      node.status !== "supported" ||
      node.courseId !== courseId ||
      !Array.isArray(node.evidenceChunkIds) ||
      node.evidenceChunkIds.length === 0
    ) {
      rejectedNodeIds.add(node.id);
      continue;
    }
    const supportingSources = new Set<string>();
    let allChunksValid = true;
    for (const cid of node.evidenceChunkIds) {
      const chunk = afterChunkById.get(cid);
      if (!chunk || !graphConsistentSourceIds.has(chunk.sourceId)) {
        allChunksValid = false;
        break;
      }
      supportingSources.add(chunk.sourceId);
    }
    if (!allChunksValid) {
      rejectedNodeIds.add(node.id);
      continue;
    }
    candidateConcepts.push({
      id: node.id,
      label: node.label,
      kind: node.kind,
      supportingSourceIds: [...supportingSources],
      evidenceChunkIds: [...node.evidenceChunkIds],
      privacyEpoch,
    });
  }

  const concepts: ConceptList = [];
  const survivingConceptsById = new Map<string, MaterialPedagogicalGraph["concepts"][number]>();
  for (const concept of candidateConcepts) {
    if (!rejectedNodeIds.has(concept.id) && !survivingConceptsById.has(concept.id)) {
      survivingConceptsById.set(concept.id, concept);
      concepts.push(concept);
    }
  }
  if (concepts.length === 0) return undefined;

  const edges: EdgeList = [];
  for (const edge of record.snapshot.edges) {
    const rawKind = edge.kind as string;
    if (edge.status !== "supported" || rawKind === "solves") continue;
    if (!SUPPORTED_KNOWLEDGE_EDGE_KINDS.has(edge.kind)) continue;
    const fromConcept = survivingConceptsById.get(edge.from);
    const toConcept = survivingConceptsById.get(edge.to);
    if (!fromConcept || !toConcept) continue;
    if (edge.kind === "prerequisite" && edge.from === edge.to) continue;
    if (!Array.isArray(edge.evidenceChunkIds)) continue;

    const supportingSources = new Set<string>();
    let allEdgeChunksValid = true;
    for (const cid of edge.evidenceChunkIds) {
      const chunk = afterChunkById.get(cid);
      if (!chunk || !graphConsistentSourceIds.has(chunk.sourceId)) {
        allEdgeChunksValid = false;
        break;
      }
      supportingSources.add(chunk.sourceId);
    }
    if (!allEdgeChunksValid) continue;

    if (supportingSources.size === 0) {
      for (const s of fromConcept.supportingSourceIds ?? []) supportingSources.add(s);
      for (const s of toConcept.supportingSourceIds ?? []) supportingSources.add(s);
    }

    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      supportingSourceIds: [...supportingSources],
      supportingChunkIds: [...edge.evidenceChunkIds],
      privacyEpoch,
    });
  }

  return {
    concepts,
    edges,
    authorization: {
      admissibleSourceIds,
      admissibleSourceVersions,
      expectedPrivacyEpoch: privacyEpoch,
      allowHintGated: false,
    },
  };
}

/** One material path for saved chat, temporary chat and the teaching compiler. */
export function createOpeningMaterialRetriever(
  sql: Sql,
  budget: OpeningBudgetRepository,
  config = loadOpeningEmbeddingConfig(),
): ScopedMaterialRetriever {
  const purposes = createOpeningCourseReadySourcesRepository(sql);
  const repository = createOpeningSourceEmbeddingsRepository(sql);
  const hasSqlClient = Boolean(
    sql && (
      typeof (sql as { begin?: unknown }).begin === "function"
      || typeof (sql as { savepoint?: unknown }).savepoint === "function"
    ),
  );
  const knowledge = hasSqlClient ? createOpeningKnowledgeRepository(sql) : null;
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
      const route = { sourceIds, chunkIds: before.chunks.map(chunk => chunk.id), privacyEpoch: before.privacyEpoch };
      if (!input.lexicalOnly && config && input.query.trim() && sourceIds.length && await repository.hasIndex(scope, { ...config, ...route })) {
        const query = Array.from(input.query).reduce((state, character) => {
          if (state.full) return state;
          const bytes = new TextEncoder().encode(character).length;
          return state.bytes + bytes > 8192 ? { ...state, full: true }
            : { text: state.text + character, bytes: state.bytes + bytes, full: false };
        }, { text: "", bytes: 0, full: false }).text;
        const result = await runBudgetedEmbedding({ config, inputs: [query], budget: scopeBudget(budget, scope),
          operationId: `material-query:${input.operationId}`, signal: input.signal,
          // A post-send embedding timeout holds workspace spend and blocks embedding retries.
          // Give it its own interaction so lexical fallback can still fund the tutor response.
          parentBudget: input.parentBudget && { ...input.parentBudget, id: retrievalBudgetId(input.parentBudget.id) },
          timeoutMs: 2_000,
          beforeSend: async () => {
            await purposes.assertMaterialPurposePin(scope, purposePin);
            const now = await repository.authorizeChunks(scope, before.chunks);
            if (now.privacyEpoch !== before.privacyEpoch || now.chunks.length !== before.chunks.length) throw new Error("material privacy changed");
          },
        });
        dense = await repository.search(scope, { ...config, ...route, vector: result.vectors[0]! });
        if (dense.length) mode = "hybrid";
      }
    } catch (error) {
      // A legacy embedding key can already belong to the tutor parent. The ledger
      // refuses reassignment. Keep lexical fallback, but propagate material conflicts.
      if (input.signal?.aborted || ((error as { code?: string } | null)?.code === "CONFLICT" && !(error instanceof OpeningBudgetError))) throw error;
      // A missing index/provider/quota affects ranking only; authorized lexical material remains usable.
    }
    await purposes.assertMaterialPurposePin(scope, purposePin);
    const after = await repository.authorizeChunks(scope, before.chunks);

    let pedagogicalGraph = input.pedagogicalGraph;
    if (!pedagogicalGraph && knowledge !== null && input.courseContext.courseId !== null && after.chunks.length > 0) {
      if (input.signal?.aborted) {
        throw input.signal.reason instanceof Error
          ? input.signal.reason
          : Object.assign(new Error("material retrieval aborted"), { code: "ABORTED" });
      }
      try {
        const record = await knowledge.getWithSync(scope, input.courseContext.courseId);
        if (input.signal?.aborted) {
          throw input.signal.reason instanceof Error
            ? input.signal.reason
            : Object.assign(new Error("material retrieval aborted"), { code: "ABORTED" });
        }
        pedagogicalGraph = reconcileCoursePedagogicalGraph(
          input.courseContext.courseId,
          record,
          after.chunks,
          after.privacyEpoch,
        );
      } catch (error) {
        if (
          input.signal?.aborted ||
          !(
            (error instanceof OpeningKnowledgeError && error.code === "VALIDATION") ||
            (error as { name?: string } | null)?.name === "ZodError"
          )
        ) {
          throw error;
        }
      }
    }

    return {
      chunks: rankMaterialContext({
        ...input,
        chunks: after.chunks,
        dense,
        ...(pedagogicalGraph ? { pedagogicalGraph } : {}),
      }),
      mode,
      purposePin,
      // Caller must keep this exact pin through the actual model send/release.
      assertCurrent: () => purposes.assertMaterialPurposePin(scope, purposePin),
    };
  };
}
