import { openingJobScope } from "@aistudy/database";
import { randomUUID } from "node:crypto";
import type {
  KnowledgeEdge,
  KnowledgeNode,
  KnowledgeSnapshot,
  ProviderInput,
  ProviderOutput,
  SourceChunk,
} from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import { knowledgeNodeDefinition, sameKnowledgeNodeIdentity, validateKnowledgeSnapshot } from "@aistudy/domain";
import { connectKnowledgeChapters, knowledgeExtractionBatches, mergeKnowledgeBatches, type KnowledgeExtractionBatch } from "./knowledge-extraction-batches";

type Scope = { workspaceId: string; ownerUserId: string };

export type AuthorizedChunk = SourceChunk & {
  /** Course the chunk's source belongs to (must match job courseId). */
  courseId: string;
};

export type KnowledgeExtractProvider = {
  complete(input: ProviderInput, signal?: AbortSignal): Promise<ProviderOutput>;
};

export type BuildCourseKnowledgePayload = {
  courseId: string;
};

export type BuildCourseKnowledgeDeps = {
  listAuthorizedChunks(scope: Scope, courseId: string): Promise<AuthorizedChunk[]>;
  /** Explicit course bindings and existing evidence keep their original node definition. */
  listReferencedNodeIds?(scope: Scope, courseId: string): Promise<string[]>;
  /** Data repo get — null when none (expectedVersion 0). */
  get(
    scope: Scope,
    courseId: string,
  ): Promise<{ version: number; snapshot: KnowledgeSnapshot; sourceVersions: Record<string, number>; nodeDefinitions?: Record<string, string> } | null>;
  /** Defaults to domain validateKnowledgeSnapshot. */
  validateSnapshot?(snapshot: KnowledgeSnapshot): KnowledgeSnapshot;
  /** Data repo replace — CAS write. */
  replace(
    scope: Scope,
    courseId: string,
    input: {
      expectedVersion: number;
      expectedReferencedNodeIds?: readonly string[];
      snapshot: KnowledgeSnapshot;
      sourceVersions: Record<string, number>;
    },
  ): Promise<{ version: number; snapshot: KnowledgeSnapshot }>;
  provider?: KnowledgeExtractProvider | null;
  /** Resolve a live, budgeted provider when extractGraph is not injected (production). */
  resolveProvider?: (scope: Scope, job: OpeningJobRecord, batch: KnowledgeExtractionBatch & { count: number }) => Promise<KnowledgeExtractProvider>;
  /** Optional: override LLM extraction for tests. */
  extractGraph?: (chunks: AuthorizedChunk[]) => Promise<ExtractedGraph>;
};

export type ExtractedGraph = {
  nodes: Array<{
    label: string;
    kind: KnowledgeNode["kind"];
    evidenceChunkIds: string[];
    status?: KnowledgeNode["status"];
  }>;
  edges: Array<{
    fromLabel: string;
    toLabel: string;
    kind: KnowledgeEdge["kind"];
    evidenceChunkIds: string[];
    status?: KnowledgeEdge["status"];
  }>;
};

const EXTRACTION_INSTRUCTION = [
  "从当前章节的已授权材料分块中提取知识结构。相同概念仅输出一次，标签要带必要限定词，以区分不同定义。",
  "只输出 JSON：{nodes:[{label,kind,evidenceChunkIds,status}],edges:[{fromLabel,toLabel,kind,evidenceChunkIds,status}]}。",
  "kind 仅限 chapter|concept|procedure|problem_type；边 kind 仅限 contains|prerequisite|applies_to。",
  "supported 必须引用真实 chunk id；无原文依据的先修只能标 suggested；含糊公式不要标 supported。",
  "不要编造 chunk id。",
].join("");

/**
 * Drop unauthorized evidence, force course membership, and mark material-free
 * prerequisite edges as suggested (never invent evidence).
 */
export function reconcileExtractedSnapshot(
  courseId: string,
  version: number,
  extracted: ExtractedGraph,
  authorized: AuthorizedChunk[],
  previous?: KnowledgeSnapshot,
  referencedNodeIds: readonly string[] = [],
  previousDefinitions: Record<string, string> = {},
): KnowledgeSnapshot {
  const byId = new Map(authorized.map((chunk) => [chunk.id, chunk]));
  const allowed = new Set(authorized.filter((chunk) => chunk.courseId === courseId).map((chunk) => chunk.id));

  const labelToId = new Map<string, string>();
  const ambiguousLabels = new Set<string>();
  const nodes: KnowledgeNode[] = [];
  for (const raw of extracted.nodes) {
    const evidenceChunkIds = [...new Set(raw.evidenceChunkIds.filter((id) => allowed.has(id)))];
    let status: KnowledgeNode["status"] = raw.status ?? (evidenceChunkIds.length ? "supported" : "suggested");
    if (status === "supported" && evidenceChunkIds.length === 0) status = "suggested";
    const id = randomUUID();
    if (labelToId.has(raw.label)) ambiguousLabels.add(raw.label);
    labelToId.set(raw.label, id);
    nodes.push({
      id,
      courseId,
      label: raw.label,
      kind: raw.kind,
      evidenceChunkIds,
      status,
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: KnowledgeEdge[] = [];
  for (const raw of extracted.edges) {
    if (ambiguousLabels.has(raw.fromLabel) || ambiguousLabels.has(raw.toLabel)) continue;
    const from = labelToId.get(raw.fromLabel);
    const to = labelToId.get(raw.toLabel);
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    let evidenceChunkIds = [...new Set(raw.evidenceChunkIds.filter((id) => allowed.has(id)))];
    let status: KnowledgeEdge["status"] = raw.status ?? (evidenceChunkIds.length ? "supported" : "suggested");
    // Prerequisites without material evidence stay suggested — never forge chunk ids.
    if (raw.kind === "prerequisite" && evidenceChunkIds.length === 0) {
      status = "suggested";
      evidenceChunkIds = [];
    } else if (status === "supported" && evidenceChunkIds.length === 0) {
      status = "suggested";
    }
    evidenceChunkIds = evidenceChunkIds.filter((id) => byId.has(id));
    edges.push({ from, to, kind: raw.kind, evidenceChunkIds, status });
  }

  return retainKnowledgeIdentities({ courseId, version, nodes, edges }, authorized, previous, referencedNodeIds, previousDefinitions);
}

/** Reuse only a unique, unchanged definition; a reparse may replace the chunk UUIDs. */
export function retainKnowledgeIdentities(snapshot: KnowledgeSnapshot, authorized: AuthorizedChunk[], previous?: KnowledgeSnapshot,
  referencedNodeIds: readonly string[] = [], previousDefinitions: Record<string, string> = {}): KnowledgeSnapshot {
  const old = previous?.courseId === snapshot.courseId ? previous.nodes : [];
  const definitions = new Map(snapshot.nodes.map(node => [node.id, knowledgeNodeDefinition(node, authorized)]));
  const replacements = new Map<string, string>();
  const nodes = snapshot.nodes.map(node => {
    const definition = definitions.get(node.id);
    const matches = old.filter(candidate => sameKnowledgeNodeIdentity(candidate, node)
      || Boolean(definition && previousDefinitions[candidate.id] === definition));
    const unique = snapshot.nodes.filter(candidate => sameKnowledgeNodeIdentity(candidate, node)
      || Boolean(definition && definitions.get(candidate.id) === definition)).length === 1;
    if (!node.evidenceChunkIds.length || matches.length !== 1 || !unique) return node;
    replacements.set(node.id, matches[0]!.id);
    return { ...node, id: matches[0]!.id, ...(matches[0]!.status === "needs_check" ? { status: "needs_check" as const } : {}) };
  });
  const allowed = new Set(authorized.filter(chunk => chunk.courseId === snapshot.courseId).map(chunk => chunk.id));
  for (const id of referencedNodeIds) {
    if (nodes.some(node => node.id === id)) continue;
    const node = old.find(candidate => candidate.id === id);
    if (node && node.evidenceChunkIds.every(chunkId => allowed.has(chunkId))) {
      const reinterpreted = nodes.some(candidate => candidate.evidenceChunkIds.some(chunkId => node.evidenceChunkIds.includes(chunkId)));
      nodes.push({ ...structuredClone(node), ...(reinterpreted ? { status: "needs_check" as const } : {}) });
    }
  }
  return { ...snapshot, nodes, edges: snapshot.edges.map(edge => ({ ...edge,
    from: replacements.get(edge.from) ?? edge.from, to: replacements.get(edge.to) ?? edge.to })) };
}

export function sourceVersionsFromChunks(chunks: AuthorizedChunk[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const chunk of chunks) {
    const previous = versions[chunk.sourceId];
    if (previous === undefined || chunk.sourceVersion > previous) {
      versions[chunk.sourceId] = chunk.sourceVersion;
    }
  }
  return versions;
}

function parseExtractedGraph(text: string): ExtractedGraph {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("knowledge extraction returned no JSON object");
  const parsed = JSON.parse(text.slice(start, end + 1)) as ExtractedGraph;
  if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("knowledge extraction JSON missing nodes/edges");
  }
  return parsed;
}

async function defaultExtract(
  provider: KnowledgeExtractProvider,
  batch: KnowledgeExtractionBatch,
): Promise<ExtractedGraph> {
  const output = await provider.complete({
    instruction: EXTRACTION_INSTRUCTION,
    text: batch.chapter ? `提取本章节知识结构：${batch.chapter}` : "提取当前资料片段的知识结构",
    history: [],
    chunks: batch.chunks,
    mode: "explain",
    maxOutputTokens: 4096,
    mediaCapability: "text_only",
    imageParts: [],
    outputFormat: "json",
  });
  return parseExtractedGraph(output.text);
}

export function createBuildCourseKnowledgeHandler(deps: BuildCourseKnowledgeDeps) {
  return async function processBuildCourseKnowledge(
    job: OpeningJobRecord,
    payload: unknown,
  ): Promise<{ version: number; snapshot: KnowledgeSnapshot }> {
    const body = payload as BuildCourseKnowledgePayload;
    if (!body || typeof body.courseId !== "string") throw new Error("build-course-knowledge payload missing courseId");
    const scope = openingJobScope(job);
    const current = await deps.get(scope, body.courseId);
    const expectedVersion = current?.version ?? 0;
    const chunks = (await deps.listAuthorizedChunks(scope, body.courseId)).filter(chunk => chunk.courseId === body.courseId);
    const batches = knowledgeExtractionBatches(chunks), extracted: KnowledgeSnapshot[] = [];
    const chapterEdges: ExtractedGraph["edges"] = [];
    for (const batch of batches) {
      const provider = deps.extractGraph ? null : deps.provider
        ?? (deps.resolveProvider ? await deps.resolveProvider(scope, job, { ...batch, count: batches.length }) : null);
      if (!deps.extractGraph && !provider) throw new Error("build-course-knowledge requires a model provider");
      const graph = deps.extractGraph ? await deps.extractGraph(batch.chunks) : await defaultExtract(provider!, batch);
      extracted.push(reconcileExtractedSnapshot(body.courseId, expectedVersion + 1, graph, batch.chunks));
      const labels = new Set(graph.nodes.map(node => node.label)), allowed = new Set(batch.chunks.map(chunk => chunk.id));
      chapterEdges.push(...graph.edges.filter(edge => !labels.has(edge.fromLabel) || !labels.has(edge.toLabel)).map(edge => ({
        ...edge, evidenceChunkIds: [...new Set(edge.evidenceChunkIds.filter(id => allowed.has(id)))],
      })));
    }
    const referenced = await deps.listReferencedNodeIds?.(scope, body.courseId) ?? [];
    const seenChunkIds = new Set<string>(), slicedChunkIds = new Set<string>();
    for (const batch of batches) for (const chunk of batch.chunks) {
      if (seenChunkIds.has(chunk.id)) slicedChunkIds.add(chunk.id);
      seenChunkIds.add(chunk.id);
    }
    const combined = connectKnowledgeChapters(mergeKnowledgeBatches(body.courseId, expectedVersion + 1, extracted, chunks, slicedChunkIds), chapterEdges);
    const draft = retainKnowledgeIdentities(combined,
      chunks, current?.snapshot, referenced, current?.nodeDefinitions);
    const validated = (deps.validateSnapshot ?? validateKnowledgeSnapshot)(draft);
    const used = new Set([...validated.nodes, ...validated.edges].flatMap(item => item.evidenceChunkIds));
    const sourceVersions = sourceVersionsFromChunks(chunks.filter(chunk => used.has(chunk.id)));
    return deps.replace(scope, body.courseId, {
      expectedVersion,
      ...(deps.listReferencedNodeIds ? { expectedReferencedNodeIds: referenced } : {}),
      snapshot: validated,
      sourceVersions,
    });
  };
}
