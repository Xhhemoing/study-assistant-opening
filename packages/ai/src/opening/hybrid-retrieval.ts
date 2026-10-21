import type { SourceChunk } from "@aistudy/contracts";
import { keywordOverlapScore, renderContext } from "./context";
import type { ParentInteractionBudget } from "./parent-interaction-budget";

export type MaterialSegment = { chunk: SourceChunk; segmentIndex: number };
export type MaterialRetrievalInput = {
  chunks: SourceChunk[];
  sourceIds: string[];
  query: string;
  maxCharacters: number;
  preferChunkId?: string;
  preferPage?: number;
  operationId: string;
  parentBudget?: ParentInteractionBudget;
  signal?: AbortSignal;
};
export type MaterialRetrievalResult = { chunks: SourceChunk[]; mode: "hybrid" | "lexical" };
export type MaterialRetriever = (
  scope: { workspaceId: string; ownerUserId: string },
  input: MaterialRetrievalInput,
) => Promise<MaterialRetrievalResult>;

/** Split at Unicode code points, including the entire tail of long physical pages. */
export function segmentMaterialChunks(chunks: SourceChunk[], maxBytes = 6000): MaterialSegment[] {
  if (maxBytes < 4 || maxBytes > 8192) throw new Error("embedding segment byte limit must be 4..8192");
  const encoder = new TextEncoder();
  const segments: MaterialSegment[] = [];
  for (const chunk of chunks) {
    if (!chunk.text.trim()) {
      if (chunk.imageObjectKey) segments.push({ chunk, segmentIndex: 0 });
      continue;
    }
    let text = "", bytes = 0, segmentIndex = 0;
    for (const character of chunk.text) {
      const size = encoder.encode(character).length;
      if (bytes + size > maxBytes) {
        segments.push({ chunk: { ...chunk, text }, segmentIndex: segmentIndex++ });
        text = ""; bytes = 0;
      }
      text += character; bytes += size;
    }
    if (text) segments.push({ chunk: { ...chunk, text }, segmentIndex });
  }
  return segments;
}

export function materialSegmentKey(segment: MaterialSegment): string {
  return `${segment.chunk.id}:${segment.segmentIndex}`;
}

const queryStopWords = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "of", "to", "in", "on", "for", "and", "or", "what", "how", "why", "please", "explain"]);
function materialLexicalScore(query: string, text: string): number {
  const meaningful = query.split(/\s+/).filter(token => {
    const word = token.replace(/^\W+|\W+$/g, "");
    return /^[A-Z]$/.test(word) || !queryStopWords.has(word.toLowerCase());
  }).join(" ");
  return keywordOverlapScore(meaningful, text);
}

/** Budget an already-ranked list without reintroducing the old lexical ordering. */
export function budgetRankedMaterial(chunks: SourceChunk[], maxCharacters: number): SourceChunk[] {
  if (maxCharacters <= 0) return [];
  const selected: SourceChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    const separator = selected.length ? 1 : 0;
    const fullLength = renderContext([chunk]).length + separator;
    const remaining = maxCharacters - used;
    if (fullLength <= remaining) {
      selected.push(chunk); used += fullLength;
    } else if (selected.length === 0) {
      // A preferred physical page can itself exceed the prompt budget.
      const textLength = remaining - renderContext([{ ...chunk, text: "" }]).length;
      if (textLength > 0) {
        const text = chunk.text.slice(0, textLength).replace(/[\uD800-\uDBFF]$/u, "");
        if (text || chunk.imageObjectKey) selected.push({ ...chunk, text });
        break;
      }
    }
  }
  return selected;
}

/** RRF followed by explicit location priority, query coverage and source diversity. */
export function rankMaterialContext(input: Omit<MaterialRetrievalInput, "sourceIds" | "operationId" | "signal"> & {
  dense?: MaterialSegment[];
}): SourceChunk[] {
  const segments = segmentMaterialChunks(input.chunks);
  const all = new Map(segments.map(segment => [materialSegmentKey(segment), segment]));
  // Dense rows must be members of the same source/version/chunk snapshot.
  const dense: MaterialSegment[] = [];
  for (const segment of input.dense ?? []) {
    const key = materialSegmentKey(segment), original = all.get(key);
    if (original && original.chunk.sourceVersion === segment.chunk.sourceVersion && original.chunk.text === segment.chunk.text) dense.push(original);
  }
  const stable = (a: MaterialSegment, b: MaterialSegment) =>
    a.chunk.sourceId.localeCompare(b.chunk.sourceId) || (a.chunk.page ?? Infinity) - (b.chunk.page ?? Infinity)
    || a.chunk.id.localeCompare(b.chunk.id) || a.segmentIndex - b.segmentIndex;
  const lexical = segments.map(segment => ({ segment, score: materialLexicalScore(input.query, segment.chunk.text) }))
    .sort((a, b) => b.score - a.score || stable(a.segment, b.segment));
  const lexicalScores = new Map(lexical.map(entry => [materialSegmentKey(entry.segment), entry.score]));
  const scores = new Map<string, number>();
  const add = (list: MaterialSegment[]) => list.forEach((segment, rank) => {
    const key = materialSegmentKey(segment);
    if (all.has(key)) scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank + 1));
  });
  add(lexical.filter(entry => entry.score > 0).slice(0, 48).map(entry => entry.segment));
  add(dense.slice(0, 48));
  const preference = (segment: MaterialSegment) => segment.chunk.id === input.preferChunkId ? 2
    : input.preferPage !== undefined && segment.chunk.page === input.preferPage ? 1 : 0;
  let candidates = [...all.values()].filter(segment => preference(segment) || scores.has(materialSegmentKey(segment)));
  if (!candidates.length) candidates = lexical.map(entry => entry.segment);
  const selected: MaterialSegment[] = [], counts = new Map<string, number>();
  // The provider accepts at most 64 chunks. A large lexical-fallback pool must not require N full sorts.
  while (candidates.length && selected.length < 64) {
    const score = (segment: MaterialSegment) => (scores.get(materialSegmentKey(segment)) ?? 0)
      + Math.min(1, lexicalScores.get(materialSegmentKey(segment)) ?? 0) * 0.001
      - (counts.get(segment.chunk.sourceId) ?? 0) * 0.002;
    let best = 0;
    for (let index = 1; index < candidates.length; index++) {
      const a = candidates[index]!, b = candidates[best]!;
      if ((preference(b) - preference(a) || score(b) - score(a) || stable(a, b)) < 0) best = index;
    }
    const next = candidates.splice(best, 1)[0]!;
    selected.push(next);
    counts.set(next.chunk.sourceId, (counts.get(next.chunk.sourceId) ?? 0) + 1);
  }
  // Citation identity stays the physical chunk id. Merge selected excerpts for a page.
  const merged = new Map<string, SourceChunk>();
  for (const chunk of budgetRankedMaterial(selected.map(segment => segment.chunk), input.maxCharacters)) {
    const previous = merged.get(chunk.id);
    if (previous) previous.text += `\n[…]\n${chunk.text}`;
    else merged.set(chunk.id, { ...chunk });
  }
  return [...merged.values()];
}
