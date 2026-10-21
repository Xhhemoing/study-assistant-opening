import type { KnowledgeSnapshot } from "@aistudy/contracts";
import { knowledgeNodeDefinition, sameKnowledgeNodeIdentity } from "@aistudy/domain";
import type { AuthorizedChunk, ExtractedGraph } from "./build-course-knowledge";

export const KNOWLEDGE_BATCH_CHARACTERS = 12_000;
const MAX_BATCH_CHUNKS = 16;
const chapterHeading = /^(?:#{1,3}\s+.{1,120}|第[一二三四五六七八九十百零〇\d]+[章节篇].{0,100}|chapter\s+\d+\b.{0,100})$/imu;

export type KnowledgeExtractionBatch = { index: number; chapter: string | null; chunks: AuthorizedChunk[] };

/** Preserve material order and exact text; a long parser chunk is sent in bounded slices. */
export function knowledgeExtractionBatches(chunks: readonly AuthorizedChunk[]): KnowledgeExtractionBatch[] {
  const batches: KnowledgeExtractionBatch[] = [];
  let current: KnowledgeExtractionBatch | null = null, size = 0, sourceId: string | null = null;
  let chapter: string | null = null;
  for (const chunk of chunks) {
    if (!chunk.text?.trim()) continue;
    const heading = chunk.text.match(chapterHeading)?.[0]?.trim() ?? null;
    if (sourceId !== chunk.sourceId || heading && heading !== chapter) {
      current = null; size = 0;
      chapter = heading; sourceId = chunk.sourceId;
    }
    for (let offset = 0; offset < chunk.text.length;) {
      let end = Math.min(chunk.text.length, offset + KNOWLEDGE_BATCH_CHARACTERS);
      if (end < chunk.text.length && /[\uD800-\uDBFF]/u.test(chunk.text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(chunk.text[end]!)) end -= 1;
      const text = chunk.text.slice(offset, end);
      offset = end;
      if (!current || size + text.length > KNOWLEDGE_BATCH_CHARACTERS || current.chunks.length >= MAX_BATCH_CHUNKS) {
        current = { index: batches.length, chapter, chunks: [] }; batches.push(current); size = 0;
      }
      current.chunks.push({ ...chunk, text }); size += text.length;
    }
  }
  return batches;
}

/** Labels are local to each extraction. Merge only the same evidence-backed definition. */
export function mergeKnowledgeBatches(courseId: string, version: number, snapshots: KnowledgeSnapshot[], chunks: AuthorizedChunk[],
  slicedChunkIds: ReadonlySet<string> = new Set()): KnowledgeSnapshot {
  const merged: KnowledgeSnapshot = { courseId, version, nodes: [], edges: [] };
  const definitions = new Map<string, string>();
  const edgeKeys = new Set<string>();
  for (const snapshot of snapshots) {
    const ids = new Map<string, string>();
    const counts = new Map<string, number>();
    for (const node of snapshot.nodes) {
      const definition = knowledgeNodeDefinition(node, chunks);
      if (definition) counts.set(definition, (counts.get(definition) ?? 0) + 1);
    }
    for (const node of snapshot.nodes) {
      const definition = knowledgeNodeDefinition(node, chunks);
      // Two distant slices sharing one parser UUID do not prove the same definition.
      const candidates = node.evidenceChunkIds.some(id => slicedChunkIds.has(id)) ? [] : merged.nodes.filter(candidate => definition
        ? counts.get(definition) === 1 && definitions.get(candidate.id) === definition
        : node.evidenceChunkIds.length > 0 && sameKnowledgeNodeIdentity(candidate, node));
      const existing = candidates.length === 1 ? candidates[0] : undefined;
      ids.set(node.id, existing?.id ?? node.id);
      if (existing) {
        existing.evidenceChunkIds = [...new Set([...existing.evidenceChunkIds, ...node.evidenceChunkIds])];
        if (node.status === "needs_check") existing.status = "needs_check";
      } else {
        merged.nodes.push({ ...node, evidenceChunkIds: [...node.evidenceChunkIds] });
        if (definition) definitions.set(node.id, definition);
      }
    }
    for (const edge of snapshot.edges) {
      const next = { ...edge, from: ids.get(edge.from)!, to: ids.get(edge.to)! };
      const key = JSON.stringify([next.from, next.to, next.kind, [...next.evidenceChunkIds].sort(), next.status]);
      if (!edgeKeys.has(key)) { edgeKeys.add(key); merged.edges.push(next); }
    }
  }
  return merged;
}

/** A chapter can cite an earlier concept without redefining it in its own batch. */
export function connectKnowledgeChapters(snapshot: KnowledgeSnapshot, edges: ExtractedGraph["edges"]): KnowledgeSnapshot {
  const labels = new Map<string, string[]>();
  for (const node of snapshot.nodes) labels.set(node.label, [...labels.get(node.label) ?? [], node.id]);
  const connected = [...snapshot.edges];
  for (const edge of edges) {
    const from = labels.get(edge.fromLabel), to = labels.get(edge.toLabel);
    if (from?.length !== 1 || to?.length !== 1) continue;
    if (connected.some(existing => existing.from === from[0] && existing.to === to[0] && existing.kind === edge.kind)) continue;
    connected.push({ from: from[0]!, to: to[0]!, kind: edge.kind, evidenceChunkIds: edge.evidenceChunkIds,
      status: edge.evidenceChunkIds.length ? edge.status ?? "supported" : "suggested" });
  }
  return { ...snapshot, edges: connected };
}
