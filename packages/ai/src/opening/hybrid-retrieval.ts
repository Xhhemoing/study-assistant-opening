import type { CourseSourceUse, OpeningMaterialPurposePin, SourceChunk } from "@aistudy/contracts";
import { keywordOverlapScore, renderContext } from "./context";
import type { ParentInteractionBudget } from "./parent-interaction-budget";

export type MaterialSegment = { chunk: SourceChunk; segmentIndex: number };
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
const CURRENCY_PROSE_WORD_RE = /\b(?:and|or|to|for|per|with|from|in|of|at|is|are|was|were|cost|costs|price|prices|usd|cad|aud|eur|cents?|dollars?)\b/i;
const MATH_COMMAND_OR_OP_RE = /\\[A-Za-z]+|[=+\-*/^_<>!{}|]/;

function isBareCurrencyStart(text: string, dollarIndex: number): boolean {
  const first = text[dollarIndex + 1];
  if (!first || first < "0" || first > "9") return false;
  const limit = Math.min(text.length, dollarIndex + 2048);
  let closeIdx = -1;
  for (let j = dollarIndex + 1; j < limit; ) {
    const ch = text[j]!;
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "\n" && isBlankLineBreakAt(text, j)) break;
    if (ch === "$") {
      if (text[j + 1] === "$") return true;
      closeIdx = j;
      break;
    }
    j += 1;
  }
  if (closeIdx < 0) return true;
  const prev = text[closeIdx - 1] ?? "";
  const next = text[closeIdx + 1] ?? "";
  if (/\s/.test(prev) || (next >= "0" && next <= "9")) return true;
  const inner = text.slice(dollarIndex + 1, closeIdx);
  if (CURRENCY_PROSE_WORD_RE.test(inner)) return true;
  if (MATH_COMMAND_OR_OP_RE.test(inner)) return false;
  if (/,\s/.test(inner)) return false;
  return /^\d+(?:,\d{3})*(?:\.\d+)?$/.test(inner);
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

  const scanRange = (from: number, to: number) => {
    for (let i = from; i < to; ) {
      const ch = text[i]!;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "\\" || next === "$") {
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
          } else if (/\s/.test(prev) && next && !/\s/.test(next) && !isBareCurrencyStart(text, i)) {
            inlineDollarStart = i;
          }
          i += 1;
          continue;
        }
        const next = text[i + 1] ?? "";
        if (next && !/\s/.test(next) && !isBareCurrencyStart(text, i)) {
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
  const bytesList: number[] = [0];
  let totalBytes = 0;
  for (let i = 0; i < text.length; ) {
    cpStarts.push(i);
    const cp = text.codePointAt(i)!;
    totalBytes += codePointUtf8Bytes(cp);
    bytesList.push(totalBytes);
    i += cp > 0xffff ? 2 : 1;
  }
  cpStarts.push(text.length);
  return { cpStarts, prefixBytes: Int32Array.from(bytesList) };
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

function selectSafeMathSpans(text: string, cpStarts: number[], prefixBytes: Int32Array, maxBytes: number): MathSpan[] {
  const valid = scanMathSpans(text)
    .filter((span) => {
      const startCp = findCodePointForOffset(cpStarts, span.start);
      const endCp = findCodePointForOffset(cpStarts, span.end);
      return prefixBytes[endCp]! - prefixBytes[startCp]! <= maxBytes;
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const topLevel: MathSpan[] = [];
  for (const span of valid) {
    const prev = topLevel[topLevel.length - 1];
    if (!prev || span.start >= prev.end) topLevel.push(span);
  }
  return topLevel;
}

/** Split at Unicode code points while keeping closed LaTeX math spans <= maxBytes unbroken. */
export function segmentMaterialChunks(chunks: SourceChunk[], maxBytes = 6000): MaterialSegment[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 8192) {
    throw new Error("embedding segment byte limit must be 4..8192");
  }
  const segments: MaterialSegment[] = [];
  for (const chunk of chunks) {
    if (!chunk.text.trim()) {
      if (chunk.imageObjectKey) segments.push({ chunk, segmentIndex: 0 });
      continue;
    }
    const { cpStarts, prefixBytes } = buildCodePointIndex(chunk.text);
    const cpTotal = cpStarts.length - 1;
    const mathSpans = selectSafeMathSpans(chunk.text, cpStarts, prefixBytes, maxBytes);
    let spanIdx = 0;
    let cpStart = 0;
    let segmentIndex = 0;

    while (cpStart < cpTotal) {
      const baseBytes = prefixBytes[cpStart]!;
      let lo = cpStart + 1;
      let hi = cpTotal;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (prefixBytes[mid]! - baseBytes <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      let cpSplit = lo;

      if (cpSplit < cpTotal) {
        const cutOffset = cpStarts[cpSplit]!;
        const segmentStartOffset = cpStarts[cpStart]!;
        while (spanIdx < mathSpans.length && mathSpans[spanIdx]!.end <= cutOffset) spanIdx++;
        const activeSpan = mathSpans[spanIdx];
        if (activeSpan && activeSpan.start < cutOffset && cutOffset < activeSpan.end && activeSpan.start > segmentStartOffset) {
          const backedUpCp = findCodePointForOffset(cpStarts, activeSpan.start);
          if (backedUpCp > cpStart) cpSplit = backedUpCp;
        }
      }

      const sliceText = chunk.text.slice(cpStarts[cpStart]!, cpStarts[cpSplit]!);
      segments.push({ chunk: { ...chunk, text: sliceText }, segmentIndex: segmentIndex++ });
      cpStart = cpSplit;
    }
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
