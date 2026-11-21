import type { KnowledgeNode, SourceChunk } from "@aistudy/contracts";

// NFC keeps superscripts and mathematical alphabets distinct (NFKC would turn x² into x2).
const canonicalText = (text: string) => text.normalize("NFC").replace(/\r\n/gu, "\n");

export function serializeKnowledgeEvidence(chunk: SourceChunk): string | null {
  if (!chunk.text?.trim()) return null;
  return JSON.stringify([chunk.sourceId, chunk.page, canonicalText(chunk.slideLabel ?? ""),
    chunk.startMs, chunk.endMs, canonicalText(chunk.text)]);
}

export function knowledgeDefinitionHeader(node: KnowledgeNode) {
  return ["knowledge-definition-v1", node.courseId, node.kind, canonicalText(node.label)];
}

/** Server-private definition: UUID/version churn is not a semantic change.
 * Keep the complete evidence text and location; never infer equivalence from labels alone. */
export function knowledgeNodeDefinition(node: KnowledgeNode, chunks: readonly SourceChunk[]): string | null {
  if (!node.evidenceChunkIds.length) return null;
  const byId = new Map(chunks.map(chunk => [chunk.id, chunk]));
  const evidence: string[] = [];
  for (const id of new Set(node.evidenceChunkIds)) {
    const chunk = byId.get(id);
    const serialized = chunk && serializeKnowledgeEvidence(chunk);
    if (!serialized) return null;
    evidence.push(serialized);
  }
  return JSON.stringify([...knowledgeDefinitionHeader(node), [...new Set(evidence)].sort()]);
}

/** Labels alone are not identity. A semantic edit must receive a new node UUID. */
export function sameKnowledgeNodeIdentity(left: KnowledgeNode, right: KnowledgeNode): boolean {
  const evidence = (node: KnowledgeNode) => [...new Set(node.evidenceChunkIds)].sort();
  const a = evidence(left), b = evidence(right);
  return left.courseId === right.courseId && left.label === right.label && left.kind === right.kind
    && a.length === b.length && a.every((id, index) => id === b[index]);
}
