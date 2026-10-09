import {
  knowledgeSnapshotSchema,
  type KnowledgeEdge,
  type KnowledgeSnapshot,
} from "@aistudy/contracts";

export class KnowledgeGraphError extends Error {
  readonly code = "VALIDATION" as const;
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeGraphError";
  }
}

function assertPrerequisiteDag(nodes: ReadonlySet<string>, edges: readonly KnowledgeEdge[]): void {
  const adj = new Map<string, string[]>();
  for (const id of nodes) adj.set(id, []);
  for (const edge of edges) {
    if (edge.kind !== "prerequisite") continue;
    if (edge.from === edge.to) {
      throw new KnowledgeGraphError("self prerequisite is not allowed");
    }
    adj.get(edge.from)!.push(edge.to);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new KnowledgeGraphError("prerequisite cycle is not allowed");
    }
    visiting.add(id);
    for (const next of adj.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes) visit(id);
}

/** Structural + graph checks. Returns a parsed KnowledgeSnapshot. */
export function validateKnowledgeSnapshot(snapshot: KnowledgeSnapshot): KnowledgeSnapshot {
  const parsed = knowledgeSnapshotSchema.parse(snapshot);
  const ids = new Set<string>();
  for (const node of parsed.nodes) {
    if (ids.has(node.id)) {
      throw new KnowledgeGraphError(`duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
    if (node.courseId !== parsed.courseId) {
      throw new KnowledgeGraphError("node courseId does not match snapshot courseId");
    }
    if (node.status === "supported" && node.evidenceChunkIds.length === 0) {
      throw new KnowledgeGraphError("supported nodes require evidenceChunkIds");
    }
  }
  for (const edge of parsed.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new KnowledgeGraphError("edge references a missing node");
    }
  }
  assertPrerequisiteDag(ids, parsed.edges);
  return parsed;
}
