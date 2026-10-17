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
import { sameKnowledgeNodeIdentity, validateKnowledgeSnapshot } from "@aistudy/domain";

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
  ): Promise<{ version: number; snapshot: KnowledgeSnapshot; sourceVersions: Record<string, number> } | null>;
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
  resolveProvider?: (scope: Scope, job: OpeningJobRecord) => Promise<KnowledgeExtractProvider>;
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
  "从已授权课程材料分块中提取知识结构。",
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
): KnowledgeSnapshot {
  const byId = new Map(authorized.map((chunk) => [chunk.id, chunk]));
  const allowed = new Set(authorized.filter((chunk) => chunk.courseId === courseId).map((chunk) => chunk.id));

  const labelToId = new Map<string, string>();
  const nodes: KnowledgeNode[] = [];
  for (const raw of extracted.nodes) {
    const evidenceChunkIds = [...new Set(raw.evidenceChunkIds.filter((id) => allowed.has(id)))];
    let status: KnowledgeNode["status"] = raw.status ?? (evidenceChunkIds.length ? "supported" : "suggested");
    if (status === "supported" && evidenceChunkIds.length === 0) status = "suggested";
    const id = randomUUID();
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

  // Automatic reuse requires one exact, evidence-anchored definition on each
  // side. A shared/nearby label, ambiguous duplicate, changed evidence or split
  // is never permission to attach old learning evidence to a new concept.
  const old = previous?.courseId === courseId ? previous.nodes : [];
  const generated = [...nodes];
  for (const node of generated) {
    if (!node.evidenceChunkIds.length) continue;
    const matches = old.filter(candidate => sameKnowledgeNodeIdentity(candidate, node));
    if (matches.length !== 1 || generated.filter(candidate => sameKnowledgeNodeIdentity(candidate, node)).length !== 1) continue;
    const originalId = node.id;
    node.id = matches[0]!.id;
    if (matches[0]!.status === "needs_check") node.status = "needs_check";
    for (const [label, id] of labelToId) if (id === originalId) labelToId.set(label, node.id);
  }
  // Model omission cannot delete an explicitly referenced identity. Retain its
  // original definition only while all its immutable chunks remain authorized.
  // A node explicitly removed from the current snapshot is never resurrected.
  for (const id of referencedNodeIds) {
    if (nodes.some(node => node.id === id)) continue;
    const node = old.find(candidate => candidate.id === id);
    if (node && node.evidenceChunkIds.every(chunkId => allowed.has(chunkId))) {
      const reinterpreted = generated.some(candidate => candidate.evidenceChunkIds.some(chunkId => node.evidenceChunkIds.includes(chunkId)));
      nodes.push({ ...structuredClone(node), ...(reinterpreted ? { status: "needs_check" as const } : {}) });
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: KnowledgeEdge[] = [];
  for (const raw of extracted.edges) {
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

  return { courseId, version, nodes, edges };
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
  chunks: AuthorizedChunk[],
): Promise<ExtractedGraph> {
  const output = await provider.complete({
    instruction: EXTRACTION_INSTRUCTION,
    text: "提取本课知识结构",
    history: [],
    chunks,
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
    const scope: Scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    const current = await deps.get(scope, body.courseId);
    const expectedVersion = current?.version ?? 0;
    const chunks = await deps.listAuthorizedChunks(scope, body.courseId);
    const extracted = deps.extractGraph
      ? await deps.extractGraph(chunks)
      : await (async () => {
          const provider = deps.provider
            ?? (deps.resolveProvider ? await deps.resolveProvider(scope, job) : null);
          if (!provider) {
            if (!chunks.length) return { nodes: [], edges: [] };
            throw new Error("build-course-knowledge requires a model provider");
          }
          return defaultExtract(provider, chunks);
        })();
    const referenced = await deps.listReferencedNodeIds?.(scope, body.courseId) ?? [];
    const draft = reconcileExtractedSnapshot(body.courseId, expectedVersion + 1, extracted, chunks, current?.snapshot, referenced);
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
