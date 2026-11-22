import type { CourseSourceUse, MaterialSegment, OpeningMaterialPurposePin, SourceChunk } from "@aistudy/contracts";
import { keywordOverlapScore, renderContext } from "./context";
import type { ParentInteractionBudget } from "./parent-interaction-budget";

export type { MaterialSegment } from "@aistudy/contracts";
export type MaterialRetrievalInput = {
  chunks: SourceChunk[];
  sourceIds: string[];
  /** Server-resolved context. null explicitly means standalone; omission is not authorization. */
  courseContext?: { courseId: string | null; materialUse: CourseSourceUse };
  query: string;
  maxCharacters: number;
  preferChunkId?: string;
  preferPage?: number;
  operationId: string;
  parentBudget?: ParentInteractionBudget;
  signal?: AbortSignal;
};
export type MaterialRetrievalResult = {
  chunks: SourceChunk[];
  mode: "hybrid" | "lexical";
  /** Recheck the captured admission, never recapture, before model send or output release. */
  assertCurrent?: () => Promise<void>;
  /** Original server capture, passed only to the transactional completion owner. */
  readonly purposePin?: OpeningMaterialPurposePin;
};
export type MaterialRetriever = (
  scope: { workspaceId: string; ownerUserId: string },
  input: MaterialRetrievalInput,
) => Promise<MaterialRetrievalResult>;

type MathSpan = { start: number; end: number };

function codePointUtf8Bytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 3;
  if (cp <= 0xffff) return 3;
  return 4;
}

const BEGIN_ENV_RE = /\\begin\{([A-Za-z][A-Za-z0-9*]*)\}/y;
const END_ENV_RE = /\\end\{([A-Za-z][A-Za-z0-9*]*)\}/y;
const CURRENCY_PROSE_OR_NON_MATH_RE = /\b(?:and|to|or|per|for|in|of|at|from|with|by|on|million|billion|thousand|hundred|usd|eur|gbp|cad|aud|cny|rmb|jpy|hkd|sgd|dollars?|cents?|each|more|less|off|only|about|around|over|under|between|is|are|was|were|costs?|prices?)\b|^\d[\d,.]*[;:]\s*[a-z]|[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/iu;
const MATH_COMMAND_OR_OP_RE = /\\[A-Za-z]+|[=+\-*/^_<>!{}|]/;
const PUNCTUATED_CURRENCY_RE = /^\d[\d,]*(?:\.\d+)?[.,]$/;

function endOfLatexComment(text: string, start: number, end: number): number {
  let index = start + 1;
  while (index < end && text[index] !== "\n" && text[index] !== "\r") index++;
  return index;
}

function hasAdjacentInlineFormula(text: string, opener: number, commentEnd?: (start: number) => number): boolean {
  const startsInline = (index: number) => Boolean(text[index + 1] && !/[\s$]/u.test(text[index + 1]!));
  if (!startsInline(opener)) return false;
  const limit = Math.min(text.length, opener + EMBEDDING_SEGMENT_HARD_LIMIT);
  for (let index = opener + 1; index < limit;) {
    const char = text[index];
    if (char === "\\") { index += 2; continue; }
    if (char === "%" && commentEnd) { index = commentEnd(index); continue; }
    if (char === "\n" && isBlankLineBreakAt(text, index)) return false;
    if (char === "$") {
      const next = text[index + 1] ?? "";
      return !/\s/u.test(text[index - 1]!) && !/[0-9]/u.test(next)
        && (next !== "$" || startsInline(index + 1));
    }
    index++;
  }
  return false;
}

function isBareCurrencyStart(text: string, dollarIndex: number, commentEnd?: (start: number) => number): boolean {
  const first = text[dollarIndex + 1];
  if (!first || first < "0" || first > "9") return false;
  let closeIdx = -1;
  let bodyStart = dollarIndex + 1;
  const bodyParts: string[] = [];
  const limit = Math.min(text.length, dollarIndex + EMBEDDING_SEGMENT_HARD_LIMIT);
  for (let j = bodyStart; j < limit; ) {
    const ch = text[j]!;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "%" && commentEnd) {
      bodyParts.push(text.slice(bodyStart, j));
      j = commentEnd(j);
      bodyStart = j;
      continue;
    }
    if (ch === "\n" && isBlankLineBreakAt(text, j)) break;
    if (ch === "$") {
      closeIdx = j;
      break;
    }
    j += 1;
  }
  const prev = text[closeIdx - 1] ?? "";
  const next = text[closeIdx + 1] ?? "";
  const validClose = closeIdx >= 0 && !/\s/.test(prev) && !(next >= "0" && next <= "9");
  if (validClose) {
    const inner = bodyParts.join("") + text.slice(bodyStart, closeIdx);
    if ((MATH_COMMAND_OR_OP_RE.test(inner) || !CURRENCY_PROSE_OR_NON_MATH_RE.test(inner))
      && (next !== "$" || (!PUNCTUATED_CURRENCY_RE.test(inner) && hasAdjacentInlineFormula(text, closeIdx + 1, commentEnd)))) {
      return false;
    }
  }
  // If the candidate was not math, retry with literal percentages for prose.
  return bodyParts.length ? isBareCurrencyStart(text, dollarIndex) : true;
}

function isBlankLineBreakAt(text: string, newlineIndex: number): boolean {
  for (let j = newlineIndex + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return false;
}

function scanMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const bracketStack: number[] = [];
  const parenStack: number[] = [];
  const envStack: Array<{ name: string; start: number }> = [];
  const envCounts = new Map<string, number>();
  let displayDollarStart: number | null = null;
  let inlineDollarStart: number | null = null;
  let commentStart = -1;
  let commentStop = -1;
  const endOfInlineComment = (start: number) => {
    // Multiple ambiguous dollar amounts on the same line share the scan to its end.
    if (start < commentStart || start >= commentStop) {
      commentStart = start;
      commentStop = endOfLatexComment(text, start, text.length);
    }
    return commentStop;
  };
  const opensInlineMath = (index: number) => !isBareCurrencyStart(text, index, endOfInlineComment);

  const scanRange = (from: number, to: number) => {
    for (let i = from; i < to; ) {
      const ch = text[i]!;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "\\" || next === "$" || next === "%") {
          i += 2;
          continue;
        }
        if (displayDollarStart === null) {
          if (next === "[") { bracketStack.push(i); i += 2; continue; }
          if (next === "]") {
            const open = bracketStack.pop();
            if (open !== undefined) spans.push({ start: open, end: i + 2 });
            i += 2;
            continue;
          }
          if (next === "(") { parenStack.push(i); i += 2; continue; }
          if (next === ")") {
            const open = parenStack.pop();
            if (open !== undefined) spans.push({ start: open, end: i + 2 });
            i += 2;
            continue;
          }
          if (next === "b") {
            BEGIN_ENV_RE.lastIndex = i;
            const match = BEGIN_ENV_RE.exec(text);
            if (match) {
              const name = match[1]!;
              envStack.push({ name, start: i });
              envCounts.set(name, (envCounts.get(name) ?? 0) + 1);
              i = BEGIN_ENV_RE.lastIndex;
              continue;
            }
          }
          if (next === "e") {
            END_ENV_RE.lastIndex = i;
            const match = END_ENV_RE.exec(text);
            if (match) {
              const target = match[1]!;
              if ((envCounts.get(target) ?? 0) > 0) {
                for (let idx = envStack.length - 1; idx >= 0; idx--) {
                  const entry = envStack[idx]!;
                  envCounts.set(entry.name, (envCounts.get(entry.name) ?? 1) - 1);
                  if (entry.name === target) {
                    envStack.length = idx;
                    spans.push({ start: entry.start, end: END_ENV_RE.lastIndex });
                    break;
                  }
                }
              }
              i = END_ENV_RE.lastIndex;
              continue;
            }
          }
        }
        i += 1;
        continue;
      }

      if (ch === "%" && (displayDollarStart !== null || inlineDollarStart !== null
        || bracketStack.length > 0 || parenStack.length > 0 || envStack.length > 0)) {
        i = endOfLatexComment(text, i, to);
        continue;
      }

      if (displayDollarStart !== null) {
        if (ch === "$" && text[i + 1] === "$") {
          spans.push({ start: displayDollarStart, end: i + 2 });
          displayDollarStart = null;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === "\n" && inlineDollarStart !== null && isBlankLineBreakAt(text, i)) {
        inlineDollarStart = null;
      }

      if (ch === "$") {
        if (text[i + 1] === "$") {
          if (inlineDollarStart !== null) {
            const prev = text[i - 1] ?? "";
            const next = text[i + 1] ?? "";
            if (!/\s/.test(prev) && !/[0-9]/.test(next)) {
              spans.push({ start: inlineDollarStart, end: i + 1 });
              inlineDollarStart = null;
              i += 1;
              continue;
            }
            inlineDollarStart = null;
          }
          displayDollarStart = i;
          i += 2;
          continue;
        }
        if (inlineDollarStart !== null) {
          const prev = text[i - 1] ?? "";
          const next = text[i + 1] ?? "";
          if (!/\s/.test(prev) && !/[0-9]/.test(next)) {
            spans.push({ start: inlineDollarStart, end: i + 1 });
            inlineDollarStart = null;
          } else if (/\s/.test(prev) && next && !/\s/.test(next) && opensInlineMath(i)) {
            inlineDollarStart = i;
          }
          i += 1;
          continue;
        }
        const next = text[i + 1] ?? "";
        if (next && !/\s/.test(next) && opensInlineMath(i)) {
          inlineDollarStart = i;
        }
        i += 1;
        continue;
      }

      i += 1;
    }
  };

  scanRange(0, text.length);
  if (displayDollarStart !== null) {
    // At most one unclosed $$ can exist (near EOF); re-scan its suffix for inline/env spans.
    const suffixStart = displayDollarStart + 2;
    displayDollarStart = null;
    inlineDollarStart = null;
    bracketStack.length = 0;
    parenStack.length = 0;
    envStack.length = 0;
    envCounts.clear();
    scanRange(suffixStart, text.length);
  }
  return spans;
}

function buildCodePointIndex(text: string): { cpStarts: number[]; prefixBytes: Int32Array } {
  const cpStarts: number[] = [];
  // Math delimiters and chunk cuts are all at code-point boundaries.
  const prefixBytes = new Int32Array(text.length + 1);
  let totalBytes = 0;
  for (let i = 0; i < text.length; ) {
    cpStarts.push(i);
    const cp = text.codePointAt(i)!;
    totalBytes += codePointUtf8Bytes(cp);
    i += cp > 0xffff ? 2 : 1;
    prefixBytes[i] = totalBytes;
  }
  cpStarts.push(text.length);
  return { cpStarts, prefixBytes };
}

function findCodePointForOffset(cpStarts: number[], offset: number): number {
  let lo = 0;
  let hi = cpStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cpStarts[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function selectSafeMathSpans(text: string, prefixBytes: Int32Array, maxBytes: number): MathSpan[] {
  const valid = scanMathSpans(text)
    .filter(span => prefixBytes[span.end]! - prefixBytes[span.start]! <= maxBytes)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const topLevel: MathSpan[] = [];
  for (const span of valid) {
    const prev = topLevel[topLevel.length - 1];
    if (!prev || span.start >= prev.end) topLevel.push(span);
  }
  return topLevel;
}

const DEFAULT_EMBEDDING_SEGMENT_MAX_BYTES = 6000;
const EMBEDDING_SEGMENT_HARD_LIMIT = 8192;
const SEGMENT_HASH_STRIDE = 262_144;

type SegmentedEntry = {
  segment: MaterialSegment;
  startOffset: number;
  endOffset: number;
};

function splitChunkOffsets(
  cpStarts: number[],
  prefixBytes: Int32Array,
  maxBytes: number,
  mathSpans: MathSpan[] | null,
): number[] {
  const cpTotal = cpStarts.length - 1;
  const cuts: number[] = [];
  let spanIdx = 0;
  let cpStart = 0;

  while (cpStart < cpTotal) {
    const baseBytes = prefixBytes[cpStarts[cpStart]!]!;
    let lo = cpStart + 1;
    let hi = cpTotal;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (prefixBytes[cpStarts[mid]!]! - baseBytes <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    let cpSplit = lo;

    if (mathSpans && cpSplit < cpTotal) {
      const cutOffset = cpStarts[cpSplit]!;
      const segmentStartOffset = cpStarts[cpStart]!;
      while (spanIdx < mathSpans.length && mathSpans[spanIdx]!.end <= cutOffset) spanIdx++;
      const activeSpan = mathSpans[spanIdx];
      if (activeSpan && activeSpan.start < cutOffset && cutOffset < activeSpan.end) {
        // Isolate a formula larger than the target so only that formula exceeds it.
        cpSplit = findCodePointForOffset(cpStarts, activeSpan.start > segmentStartOffset ? activeSpan.start : activeSpan.end);
      }
    }

    cuts.push(cpSplit);
    cpStart = cpSplit;
  }

  return cuts;
}

function hashSegmentCuts(maxBytes: number, cpStarts: number[], cuts: number[]): number {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (value >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  };
  mix(maxBytes);
  mix(cuts.length);
  for (const cut of cuts) mix(cpStarts[cut]!);
  return ((hash >>> 0) % 4096 + 1) * SEGMENT_HASH_STRIDE;
}

function segmentChunksWithRanges(chunks: SourceChunk[], maxBytes = DEFAULT_EMBEDDING_SEGMENT_MAX_BYTES): SegmentedEntry[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > EMBEDDING_SEGMENT_HARD_LIMIT) {
    throw new Error("embedding segment byte limit must be 4..8192");
  }
  const entries: SegmentedEntry[] = [];
  for (const chunk of chunks) {
    if (!chunk.text.trim()) {
      if (chunk.imageObjectKey) {
        entries.push({ segment: { chunk, segmentIndex: 0 }, startOffset: 0, endOffset: chunk.text.length });
      }
      continue;
    }
    const { cpStarts, prefixBytes } = buildCodePointIndex(chunk.text);
    const blindCuts = splitChunkOffsets(cpStarts, prefixBytes, maxBytes, null);
    const mathSpans = selectSafeMathSpans(chunk.text, prefixBytes, EMBEDDING_SEGMENT_HARD_LIMIT);
    const mathCuts = splitChunkOffsets(cpStarts, prefixBytes, maxBytes, mathSpans);
    const cutsDifferFromLegacy = mathCuts.length !== blindCuts.length
      || mathCuts.some((cut, idx) => cut !== blindCuts[idx]);
    const baseSegmentIndex = cutsDifferFromLegacy ? hashSegmentCuts(maxBytes, cpStarts, mathCuts) : 0;

    let cpStart = 0;
    for (let i = 0; i < mathCuts.length; i++) {
      const cpSplit = mathCuts[i]!;
      const startOffset = cpStarts[cpStart]!;
      const endOffset = cpStarts[cpSplit]!;
      entries.push({
        segment: { chunk: { ...chunk, text: chunk.text.slice(startOffset, endOffset) }, segmentIndex: baseSegmentIndex + i },
        startOffset,
        endOffset,
      });
      cpStart = cpSplit;
    }
  }
  return entries;
}

/** Split at Unicode code points while keeping closed LaTeX math spans up to 8192 bytes unbroken. */
export function segmentMaterialChunks(chunks: SourceChunk[], maxBytes = DEFAULT_EMBEDDING_SEGMENT_MAX_BYTES): MaterialSegment[] {
  return segmentChunksWithRanges(chunks, maxBytes).map(entry => entry.segment);
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
  const entries = segmentChunksWithRanges(input.chunks, DEFAULT_EMBEDDING_SEGMENT_MAX_BYTES);
  const segments = entries.map(entry => entry.segment);
  const all = new Map(segments.map(segment => [materialSegmentKey(segment), segment]));
  // Dense rows must be members of the same source/version/chunk snapshot.
  const inputDense = input.dense ?? [];
  const resolvedDirect: Array<MaterialSegment | undefined> = [];
  const directMatchedSegmentKeys = new Set<string>();
  for (const segment of inputDense) {
    const original = all.get(materialSegmentKey(segment));
    if (original && original.chunk.sourceVersion === segment.chunk.sourceVersion && original.chunk.text === segment.chunk.text) {
      resolvedDirect.push(original);
      directMatchedSegmentKeys.add(materialSegmentKey(original));
    } else {
      resolvedDirect.push(undefined);
    }
  }
  const dense: MaterialSegment[] = [];
  const seenDenseKeys = new Set<string>();
  let chunksById: Map<string, SourceChunk> | undefined;
  let entriesByChunkId: Map<string, SegmentedEntry[]> | undefined;
  let blindRangesCache: Map<string, Array<{ start: number; end: number }>> | undefined;
  for (let i = 0; i < inputDense.length; i++) {
    const direct = resolvedDirect[i];
    if (direct) {
      const key = materialSegmentKey(direct);
      if (!seenDenseKeys.has(key)) {
        seenDenseKeys.add(key);
        dense.push(direct);
      }
      continue;
    }
    const segment = inputDense[i]!;
    if (!Number.isInteger(segment.segmentIndex) || segment.segmentIndex < 0) continue;
    chunksById ??= new Map(input.chunks.map(chunk => [chunk.id, chunk]));
    const sourceChunk = chunksById.get(segment.chunk.id);
    if (!sourceChunk || sourceChunk.sourceVersion !== segment.chunk.sourceVersion || !sourceChunk.text.trim()) continue;
    blindRangesCache ??= new Map();
    let legacyRanges = blindRangesCache.get(sourceChunk.id);
    if (!legacyRanges) {
      const { cpStarts, prefixBytes } = buildCodePointIndex(sourceChunk.text);
      const blindCuts = splitChunkOffsets(cpStarts, prefixBytes, DEFAULT_EMBEDDING_SEGMENT_MAX_BYTES, null);
      legacyRanges = [];
      let cpStart = 0;
      for (const cut of blindCuts) {
        legacyRanges.push({ start: cpStarts[cpStart]!, end: cpStarts[cut]! });
        cpStart = cut;
      }
      blindRangesCache.set(sourceChunk.id, legacyRanges);
    }
    const legacyRange = legacyRanges[segment.segmentIndex];
    if (!legacyRange || sourceChunk.text.slice(legacyRange.start, legacyRange.end) !== segment.chunk.text) continue;
    if (!entriesByChunkId) {
      entriesByChunkId = new Map();
      for (const entry of entries) {
        const list = entriesByChunkId.get(entry.segment.chunk.id);
        if (list) list.push(entry);
        else entriesByChunkId.set(entry.segment.chunk.id, [entry]);
      }
    }
    const chunkEntries = entriesByChunkId.get(sourceChunk.id) ?? [];
    let bestEntry: SegmentedEntry | undefined;
    let bestOverlap = 0;
    for (const candidate of chunkEntries) {
      const overlap = Math.min(candidate.endOffset, legacyRange.end) - Math.max(candidate.startOffset, legacyRange.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestEntry = candidate;
      }
    }
    if (bestEntry) {
      const key = materialSegmentKey(bestEntry.segment);
      if (!directMatchedSegmentKeys.has(key) && !seenDenseKeys.has(key)) {
        seenDenseKeys.add(key);
        dense.push(bestEntry.segment);
      }
    }
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
