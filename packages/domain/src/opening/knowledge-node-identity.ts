import type { KnowledgeNode } from "@aistudy/contracts";

/** Labels alone are not identity. A semantic edit must receive a new node UUID. */
export function sameKnowledgeNodeIdentity(left: KnowledgeNode, right: KnowledgeNode): boolean {
  const evidence = (node: KnowledgeNode) => [...new Set(node.evidenceChunkIds)].sort();
  const a = evidence(left), b = evidence(right);
  return left.courseId === right.courseId && left.label === right.label && left.kind === right.kind
    && a.length === b.length && a.every((id, index) => id === b[index]);
}
