import type { CourseSourceUse, MaterialSegment, OpeningMaterialPurposePin, SourceChunk } from "@aistudy/contracts";
import {
  parsePedagogicalAst,
  rankPedagogicalEvidence,
  type PedagogicalAstBlock,
  type PedagogicalBlockKind,
  type PedagogicalChunk,
  type PedagogicalConceptNode,
  type PedagogicalGraphEdge,
  type PedagogicalRetrievalAuthorization,
  type PedagogicalVisibility,
  type ScoredCandidate,
} from "@aistudy/domain/pedagogical-retrieval";
import { keywordOverlapScore, renderContext } from "./context";
import type { ParentInteractionBudget } from "./parent-interaction-budget";

export type { MaterialSegment } from "@aistudy/contracts";
export type MaterialPedagogicalGraph = {
  readonly concepts: readonly PedagogicalConceptNode[];
  readonly edges: readonly PedagogicalGraphEdge[];
  readonly authorization: PedagogicalRetrievalAuthorization;
};
export type MaterialRetrievalInput = {
  chunks: SourceChunk[];
  sourceIds: string[];
  /** Server-resolved context. null explicitly means standalone; omission is not authorization. */
  courseContext?: { courseId: string | null; materialUse: CourseSourceUse };
  pedagogicalGraph?: MaterialPedagogicalGraph;
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
const SPACED_QED_TOKENS = ["Box", "square", "blacksquare"] as const;

function hasValidInlineMathBeforeClose(text: string, openIndex: number, closeIndex: number): boolean {
  if (closeIndex <= openIndex + 1) return false;
  if (!/\s/u.test(text[closeIndex - 1]!)) return true;
  let k = closeIndex - 1;
  while (k > openIndex) {
    const ws = text[k]!;
    if (ws === "\n" || ws === "\r" || !/\s/u.test(ws)) break;
    k--;
  }
  const tokenEnd = k + 1;
  if (tokenEnd <= openIndex + 1 || tokenEnd >= closeIndex) return false;
  for (const token of SPACED_QED_TOKENS) {
    const tokenStart = tokenEnd - token.length;
    if (tokenStart > openIndex + 1 && text.startsWith(token, tokenStart) && text[tokenStart - 1] === "\\") {
      let slashes = 0;
      for (let s = tokenStart - 1; s > openIndex && text[s] === "\\"; s--) slashes++;
      if (slashes % 2 === 1) return true;
    }
  }
  return false;
}

function hasAdjacentInlineFormula(text: string, opener: number, blankLineAt: Uint8Array, commentEnds?: Int32Array): boolean {
  const startsInline = (index: number) => Boolean(text[index + 1] && !/[\s$]/u.test(text[index + 1]!));
  if (!startsInline(opener)) return false;
  const limit = Math.min(text.length, opener + EMBEDDING_SEGMENT_HARD_LIMIT);
  for (let index = opener + 1; index < limit;) {
    const char = text[index];
    if (char === "\\") { index += 2; continue; }
    if (char === "%" && commentEnds) { index = commentEnds[index]!; continue; }
    if (blankLineAt[index]) return false;
    if (char === "$") {
      const next = text[index + 1] ?? "";
      return hasValidInlineMathBeforeClose(text, opener, index) && !/[0-9]/u.test(next)
        && (next !== "$" || startsInline(index + 1));
    }
    index++;
  }
  return false;
}

function isBareCurrencyStart(
  text: string, dollarIndex: number, displayCloseFrom: Uint8Array, blankLineAt: Uint8Array, commentEnds?: Int32Array,
): boolean {
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
    if (ch === "%" && commentEnds) {
      bodyParts.push(text.slice(bodyStart, j));
      j = commentEnds[j]!;
      bodyStart = j;
      continue;
    }
    if (blankLineAt[j]) break;
    if (ch === "$") {
      closeIdx = j;
      break;
    }
    j += 1;
  }
  const next = text[closeIdx + 1] ?? "";
  const validClose = closeIdx >= 0 && hasValidInlineMathBeforeClose(text, dollarIndex, closeIdx)
    && !(next >= "0" && next <= "9");
  if (validClose) {
    const inner = bodyParts.join("") + text.slice(bodyStart, closeIdx);
    if ((MATH_COMMAND_OR_OP_RE.test(inner) || !CURRENCY_PROSE_OR_NON_MATH_RE.test(inner))
      && (next !== "$" || (!PUNCTUATED_CURRENCY_RE.test(inner) && (
        text[closeIdx + 2] === "$" ? displayCloseFrom[closeIdx + 3]
          : hasAdjacentInlineFormula(text, closeIdx + 1, blankLineAt, commentEnds)
      )))) {
      return false;
    }
  }
  // If the candidate was not math, retry with literal percentages for prose.
  return bodyParts.length ? isBareCurrencyStart(text, dollarIndex, displayCloseFrom, blankLineAt) : true;
}

function scanMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const bracketStack: number[] = [];
  const parenStack: number[] = [];
  const envStack: Array<{ name: string; start: number }> = [];
  const envCounts = new Map<string, number>();
  const displayEnvStack: Array<{ name: string; start: number }> = [];
  const displayEnvCounts = new Map<string, number>();
  let displayDollarStart: number | null = null;
  let inlineDollarStart: number | null = null;
  const commentEnds = new Int32Array(text.length);
  const displayCloseFrom = new Uint8Array(text.length + 1);
  const blankLineAt = new Uint8Array(text.length);
  let nextLineEnd = text.length;
  let nextNonIndentIsNewline = false;
  // A display scan from any offset follows the same escape and comment rules.
  // Compute each suffix once, including suffixes that start inside prose comments.
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "%") commentEnds[i] = nextLineEnd;
    if (ch === "\n" || ch === "\r") nextLineEnd = i;
    if (ch === "\n" && nextNonIndentIsNewline) blankLineAt[i] = 1;
    if (ch !== " " && ch !== "\t" && ch !== "\r") nextNonIndentIsNewline = ch === "\n";
    if (ch === "\\" && (next === "\\" || next === "$" || next === "%")) {
      displayCloseFrom[i] = displayCloseFrom[i + 2]!;
    } else if (ch === "%") {
      displayCloseFrom[i] = displayCloseFrom[nextLineEnd]!;
    } else {
      displayCloseFrom[i] = ch === "$" && next === "$" ? 1 : displayCloseFrom[i + 1]!;
    }
  }
  // Both inline probes stop at the hard limit; comment and blank-line checks
  // remain constant-time even when whitespace or a comment crosses that limit.
  const opensInlineMath = (index: number) => !isBareCurrencyStart(text, index, displayCloseFrom, blankLineAt, commentEnds);

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
        } else {
          if (next === "b") {
            BEGIN_ENV_RE.lastIndex = i;
            const match = BEGIN_ENV_RE.exec(text);
            if (match) {
              const name = match[1]!;
              displayEnvStack.push({ name, start: i });
              displayEnvCounts.set(name, (displayEnvCounts.get(name) ?? 0) + 1);
              i = BEGIN_ENV_RE.lastIndex;
              continue;
            }
          }
          if (next === "e") {
            END_ENV_RE.lastIndex = i;
            const match = END_ENV_RE.exec(text);
            if (match) {
              const target = match[1]!;
              if ((displayEnvCounts.get(target) ?? 0) > 0) {
                for (let idx = displayEnvStack.length - 1; idx >= 0; idx--) {
                  const entry = displayEnvStack[idx]!;
                  displayEnvCounts.set(entry.name, (displayEnvCounts.get(entry.name) ?? 1) - 1);
                  if (entry.name === target) {
                    displayEnvStack.length = idx;
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
        i = Math.min(commentEnds[i]!, to);
        continue;
      }

      if (displayDollarStart !== null) {
        if (ch === "$" && text[i + 1] === "$") {
          spans.push({ start: displayDollarStart, end: i + 2 });
          displayDollarStart = null;
          displayEnvStack.length = 0;
          displayEnvCounts.clear();
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (inlineDollarStart !== null && blankLineAt[i]) {
        inlineDollarStart = null;
      }

      if (ch === "$") {
        if (text[i + 1] === "$") {
          if (inlineDollarStart !== null) {
            const next = text[i + 1] ?? "";
            if (hasValidInlineMathBeforeClose(text, inlineDollarStart, i) && !/[0-9]/.test(next)) {
              spans.push({ start: inlineDollarStart, end: i + 1 });
              inlineDollarStart = null;
              i += 1;
              continue;
            }
            inlineDollarStart = null;
          }
          if (!displayCloseFrom[i + 2]) {
            i += 2;
            continue;
          }
          displayDollarStart = i;
          displayEnvStack.length = 0;
          displayEnvCounts.clear();
          i += 2;
          continue;
        }
        if (inlineDollarStart !== null) {
          const prev = text[i - 1] ?? "";
          const next = text[i + 1] ?? "";
          if (hasValidInlineMathBeforeClose(text, inlineDollarStart, i) && !/[0-9]/.test(next)) {
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

function selectSafeMathSpans(text: string, prefixBytes: Int32Array, maxBytes: number): MathSpan[] {
  const spans = scanMathSpans(text);
  if (spans.length === 0) return [];
  // Delimiter families can cross on malformed input. Index by opening offset so
  // rejecting a crossing span never discards a later, disjoint formula.
  const endByStart = new Int32Array(text.length);
  for (const { start, end } of spans) {
    if (prefixBytes[end]! - prefixBytes[start]! <= maxBytes) {
      endByStart[start] = Math.max(endByStart[start]!, end);
    }
  }
  const topLevel: MathSpan[] = [];
  for (let start = 0; start < endByStart.length;) {
    const end = endByStart[start]!;
    if (end > start) {
      topLevel.push({ start, end });
      start = end;
    } else {
      start++;
    }
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
  let cpLimit = 0;

  while (cpStart < cpTotal) {
    const baseBytes = prefixBytes[cpStarts[cpStart]!]!;
    cpLimit = Math.max(cpLimit, cpStart + 1);
    while (cpLimit < cpTotal && prefixBytes[cpStarts[cpLimit + 1]!]! - baseBytes <= maxBytes) cpLimit++;
    let cpSplit = cpLimit;

    if (mathSpans && cpSplit < cpTotal) {
      const cutOffset = cpStarts[cpSplit]!;
      const segmentStartOffset = cpStarts[cpStart]!;
      while (spanIdx < mathSpans.length && mathSpans[spanIdx]!.end <= cutOffset) spanIdx++;
      const activeSpan = mathSpans[spanIdx];
      if (activeSpan && activeSpan.start < cutOffset && cutOffset < activeSpan.end) {
        // Isolate a formula larger than the target so only that formula exceeds it.
        const boundary = activeSpan.start > segmentStartOffset ? activeSpan.start : activeSpan.end;
        // This walk covers only the code points emitted by the current cut.
        cpSplit = cpStart;
        while (cpStarts[cpSplit]! < boundary) cpSplit++;
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

const PROSE_UNCONDITIONAL_SEALED_LINE_RE =
  /^[ \t]*(?:\*\*|__|\*|_)?(?:answers?(?:\s+key)?|official\s+solutions?|reference\s+solutions?|model\s+answers?|correct\s+answers?|rubrics?|marking\s+schemes?)(?:\s+#?\d+(?:\.\d+)*)?(?:\*\*|__|\*|_)?[ \t]*[:：]|^[ \t]*(?:【[ \t]*(?:参考答案|标准答案|正确答案|官方答案|答案|解析)[ \t]*】|(?:参考答案|标准答案|正确答案|官方答案|答案)[ \t]*[:：])/iu;
const PROSE_CONTEXTUAL_SOLUTION_LINE_RE =
  /^[ \t]*(?:\*\*|__|\*|_)?(?:worked\s+solutions?|solutions?)(?:\s+#?\d+(?:\.\d+)*)?(?:\*\*|__|\*|_)?[ \t]*[:：]|^[ \t]*(?:【[ \t]*解答[ \t]*】|解答[ \t]*[:：])/iu;
const PROSE_HINT_LINE_RE =
  /^[ \t]*(?:\*\*|__|\*|_)?(?:hints?|scaffolds?)(?:\s+#?\d+(?:\.\d+)*)?(?:\*\*|__|\*|_)?[ \t]*[:：]|^[ \t]*(?:【[ \t]*(?:提示|解题提示|思路提示|分步提示)[ \t]*】|(?:提示|解题提示|思路提示|分步提示)[ \t]*[:：])/iu;

function classifyPlainLeadKind(line: string, isHeading: boolean): PedagogicalBlockKind | null {
  const trimmed = line.trimStart().replace(/^(?:#{1,6}[ \t]+)?(?:\*\*|__|\*|_)?/, "");
  if (isHeading) {
    if (/^(?:definitions?|def\.?\b|定义)/iu.test(trimmed)) return "definition";
    if (/^(?:lemmas?\b|引理)/iu.test(trimmed)) return "lemma";
    if (/^(?:theorems?|propositions?|corollary|corollaries\b|定理|命题|推论)/iu.test(trimmed)) return "theorem";
    if (/^(?:proofs?\b|证明)/iu.test(trimmed)) return "proof";
    if (/^(?:(?:worked\s+)?examples?\b|例题)/iu.test(trimmed)) return "example";
    if (/^(?:exercises?|problems?\b|习题|练习)/iu.test(trimmed)) return "exercise";
    return null;
  }
  const match = /^(?<kw>definition|def\.?|lemma|theorem|proposition|corollary|proof|worked\s+example|example|exercise|problem|定义|引理|定理|命题|推论|证明|例题|习题|练习)(?<qual>(?:[ \t]+#?\d+(?:\.\d+)*)?(?:[ \t]*[（(][^（）()\r\n]{1,120}[）)])?)(?:\*\*|__|\*|_)?[ \t]*(?<punct>[:：.]?)/iu.exec(trimmed);
  if (!match?.groups) return null;
  const kw = match.groups.kw!.toLowerCase();
  const hasQual = Boolean(match.groups.qual?.trim());
  const punct = match.groups.punct ?? "";
  const isProofDot = (kw === "proof" || kw === "证明") && punct === ".";
  if (punct !== ":" && punct !== "：" && !(hasQual && punct === ".") && !isProofDot) return null;
  if (kw === "definition" || kw.startsWith("def") || kw === "定义") return "definition";
  if (kw === "lemma" || kw === "引理") return "lemma";
  if (kw === "theorem" || kw === "proposition" || kw === "corollary" || kw === "定理" || kw === "命题" || kw === "推论") return "theorem";
  if (kw === "proof" || kw === "证明") return "proof";
  if (kw.includes("example") || kw === "例题") return "example";
  if (kw === "exercise" || kw === "problem" || kw === "习题" || kw === "练习") return "exercise";
  return null;
}

const PEDAGOGICAL_VISIBILITY_RANK: Readonly<Record<PedagogicalVisibility, number>> = {
  public: 0,
  hint_gated: 1,
  sealed: 2,
};

function maxPedagogicalVisibility(
  a: PedagogicalVisibility,
  b: PedagogicalVisibility,
): PedagogicalVisibility {
  return PEDAGOGICAL_VISIBILITY_RANK[a] >= PEDAGOGICAL_VISIBILITY_RANK[b] ? a : b;
}

function headingMarkdownLevel(block: PedagogicalAstBlock): number | null {
  if (block.kind !== "heading") return null;
  const atx = /^[ \t]{0,3}(#{1,6})(?:[ \t]|$)/.exec(block.text);
  if (atx) return atx[1]!.length;
  const html = /^<h([1-6])(?=[\t\n\f\r />])/i.exec(block.text.trimStart());
  if (html) return Number(html[1]);
  if (/(?:^|\r?\n)[ \t]*=+[ \t]*$/.test(block.text)) return 1;
  if (/(?:^|\r?\n)[ \t]*-+[ \t]*$/.test(block.text)) return 2;
  return null;
}

function isUnescapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes++;
  return (slashes & 1) === 0;
}

function unwrapContainerBounds(
  docText: string,
  blockStart: number,
  blockEnd: number,
  firstCrossedDocStart: number,
): { innerStart: number; innerEnd: number; outerEnd: number } | null {
  if (blockEnd <= blockStart) return null;
  const slice = docText.slice(blockStart, blockEnd);
  const trimmedLen = slice.endsWith("\r\n")
    ? slice.length - 2
    : slice.endsWith("\n") || slice.endsWith("\r")
      ? slice.length - 1
      : slice.length;
  let lastLineStart = trimmedLen;
  while (lastLineStart > 0 && slice[lastLineStart - 1] !== "\n" && slice[lastLineStart - 1] !== "\r") {
    lastLineStart--;
  }

  const mdFenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r\n|\r|\n|$)/.exec(slice);
  if (mdFenceOpen && !(mdFenceOpen[1]![0] === "`" && mdFenceOpen[2]!.includes("`"))) {
    const innerStart = blockStart + mdFenceOpen[0].length;
    const fenceChar = mdFenceOpen[1]![0]!;
    const fenceLen = mdFenceOpen[1]!.length;
    const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
    const innerEnd =
      lastLineStart >= mdFenceOpen[0].length && closeRe.test(slice.slice(lastLineStart, trimmedLen))
        ? blockStart + lastLineStart
        : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd: blockEnd } : null;
  }

  const colonOpen = /^[ \t]{0,3}(:{3,})[ \t]*[a-zA-Z][\w-]*[^\r\n]*(?:\r\n|\r|\n|$)/.exec(slice);
  if (colonOpen) {
    const innerStart = blockStart + colonOpen[0].length;
    const colonLen = colonOpen[1]!.length;
    const closeRe = new RegExp(`^[ \\t]{0,3}:{${colonLen},}[ \\t]*$`);
    const innerEnd =
      lastLineStart >= colonOpen[0].length && closeRe.test(slice.slice(lastLineStart, trimmedLen))
        ? blockStart + lastLineStart
        : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd: blockEnd } : null;
  }

  const latexOpen =
    /^[ \t]*\\begin[ \t]*(?:%[^\r\n]*(?:\r\n|\r|\n)[ \t]*)?\{[ \t\r\n]*([a-zA-Z][\w-]*\*?)[ \t\r\n]*\}/.exec(
      slice,
    );
  if (latexOpen) {
    const innerStart = blockStart + latexOpen[0].length;
    const escapedEnv = latexOpen[1]!.replace(/\*/g, "\\*");
    const tail = slice.slice(latexOpen[0].length);
    const closeMatch = new RegExp(
      `\\\\end[ \\t]*(?:%[^\\r\\n]*(?:\\r\\n|\\r|\\n)[ \\t]*)?\\{[ \\t\\r\\n]*${escapedEnv}[ \\t\\r\\n]*\\}[ \\t\\r\\n]*$`,
    ).exec(tail);
    const innerEnd = closeMatch ? innerStart + closeMatch.index : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd: blockEnd } : null;
  }

  const mathOpen = /^[ \t]*(\$\$|\\\[)/.exec(slice);
  if (mathOpen) {
    const innerStart = blockStart + mathOpen[0].length;
    const tail = slice.slice(mathOpen[0].length);
    const closeMatch =
      mathOpen[1] === "$$" ? /(\$\$)[ \t\r\n]*$/.exec(tail) : /(\\\])[ \t\r\n]*$/.exec(tail);
    const innerEnd =
      closeMatch && isUnescapedAt(tail, closeMatch.index)
        ? innerStart + closeMatch.index
        : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd: blockEnd } : null;
  }

  const htmlCommentOpen = /^[ \t]*<!--(?!-?>)/.exec(slice);
  if (htmlCommentOpen) {
    const innerStart = blockStart + htmlCommentOpen[0].length;
    const tail = slice.slice(htmlCommentOpen[0].length);
    const closeMatch = /--!?>/.exec(tail);
    const innerEnd = closeMatch ? innerStart + closeMatch.index : blockEnd;
    const outerEnd = closeMatch ? innerEnd + closeMatch[0].length : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  const cdataOpen = /^[ \t]*<!\[CDATA\[/.exec(slice);
  if (cdataOpen) {
    const innerStart = blockStart + cdataOpen[0].length;
    const tail = slice.slice(cdataOpen[0].length);
    const closeIdx = tail.indexOf("]]>");
    const innerEnd = closeIdx >= 0 ? innerStart + closeIdx : blockEnd;
    const outerEnd = closeIdx >= 0 ? innerEnd + 3 : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  const piOpen = /^[ \t]*<\?/.exec(slice);
  if (piOpen) {
    const innerStart = blockStart + piOpen[0].length;
    const tail = slice.slice(piOpen[0].length);
    const closeIdx = tail.indexOf("?>");
    const innerEnd = closeIdx >= 0 ? innerStart + closeIdx : blockEnd;
    const outerEnd = closeIdx >= 0 ? innerEnd + 2 : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  const declOpen = /^[ \t]*<![A-Za-z]/.exec(slice);
  if (declOpen) {
    const innerStart = blockStart + declOpen[0].length;
    const tail = slice.slice(declOpen[0].length);
    const closeIdx = tail.indexOf(">");
    const innerEnd = closeIdx >= 0 ? innerStart + closeIdx : blockEnd;
    const outerEnd = closeIdx >= 0 ? innerEnd + 1 : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  const htmlTagOpen =
    /^[ \t]*<([a-zA-Z][^\t\n\f\r />]*)(?:[\t\n\f\r /](?:(?:"[^"]*"|'[^']*'|[^'"<>])*))?>/.exec(
      slice,
    );
  if (htmlTagOpen) {
    const innerStart = blockStart + htmlTagOpen[0].length;
    const escapedTag = htmlTagOpen[1]!.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tail = slice.slice(htmlTagOpen[0].length);
    const closeEndMatch = new RegExp(`<\\/${escapedTag}[ \\t\\r\\n]*>[ \\t\\r\\n]*$`, "i").exec(tail);
    let innerEnd = blockEnd;
    let outerEnd = blockEnd;
    if (closeEndMatch) {
      innerEnd = innerStart + closeEndMatch.index;
      outerEnd = blockEnd;
    } else if (lastLineStart > htmlTagOpen[0].length) {
      const lastLineClose = new RegExp(`<\\/${escapedTag}[ \\t\\r\\n]*>`, "i").exec(
        slice.slice(lastLineStart, trimmedLen),
      );
      if (lastLineClose) {
        innerEnd = blockStart + lastLineStart + lastLineClose.index;
        outerEnd = innerEnd + lastLineClose[0].length;
      }
    }
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  const prefixLimit = Math.min(slice.length, Math.max(0, firstCrossedDocStart - blockStart));
  const prefix = slice.slice(0, prefixLimit);
  const inlineRawMatch =
    /<!--(?!-?>)|<!\[CDATA\[|<(?<rawTag>pre|script|style|textarea)(?:[\t\n\f\r /](?:(?:"[^"]*"|'[^']*'|[^'"<>])*))?>/i.exec(
      prefix,
    );
  if (inlineRawMatch) {
    const innerStart = blockStart + inlineRawMatch.index + inlineRawMatch[0].length;
    const tail = slice.slice(inlineRawMatch.index + inlineRawMatch[0].length);
    let closeIdx = -1;
    let closeLen = 0;
    if (inlineRawMatch[0] === "<!--") {
      const commentClose = /--!?>/.exec(tail);
      if (commentClose) {
        closeIdx = commentClose.index;
        closeLen = commentClose[0].length;
      }
    } else if (inlineRawMatch[0] === "<![CDATA[") {
      closeIdx = tail.indexOf("]]>");
      if (closeIdx >= 0) closeLen = 3;
    } else {
      const rawTag = inlineRawMatch.groups!.rawTag!.toLowerCase();
      const rawClose = new RegExp(`<\\/${rawTag}[ \\t\\r\\n]*>`, "i").exec(tail);
      if (rawClose) {
        closeIdx = rawClose.index;
        closeLen = rawClose[0].length;
      }
    }
    const innerEnd = closeIdx >= 0 ? innerStart + closeIdx : blockEnd;
    const outerEnd = closeIdx >= 0 ? innerEnd + closeLen : blockEnd;
    return innerEnd > innerStart ? { innerStart, innerEnd, outerEnd } : null;
  }

  return null;
}

function collectHtmlLiteralSpans(
  docText: string,
  sliceStart: number,
  sliceEnd: number,
): Array<{ outerStart: number; outerEnd: number; innerStart: number; innerEnd: number }> {
  const slice = docText.slice(sliceStart, sliceEnd);
  if (!slice.includes("<")) return [];
  const results: Array<{ outerStart: number; outerEnd: number; innerStart: number; innerEnd: number }> = [];
  const failedTickRunUntil = new Map<number, number>();
  const openRe =
    /(?:<!--|<!\[CDATA\[|<\?|<(?<rawTag>pre|script|style|textarea)(?:[\t\n\f\r /](?:(?:"[^"]*"|'[^']*'|[^'"<>])*))?>)/iy;
  const commentCloseRe = /--!?>/g;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  let pos = 0;

  while (pos < slice.length) {
    const atLineStart = pos === 0 || slice[pos - 1] === "\n" || slice[pos - 1] === "\r";
    let lineEnd = pos;
    while (lineEnd < slice.length && slice[lineEnd] !== "\n" && slice[lineEnd] !== "\r") {
      lineEnd++;
    }
    const nextLineStart =
      lineEnd < slice.length
        ? slice[lineEnd] === "\r" && slice[lineEnd + 1] === "\n"
          ? lineEnd + 2
          : lineEnd + 1
        : slice.length;
    const line = slice.slice(pos, lineEnd);

    if (fenceChar !== null) {
      if (atLineStart && new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`).test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      pos = nextLineStart;
      continue;
    }

    if (atLineStart) {
      const fenceOpen = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
      if (fenceOpen && !(fenceOpen[1]![0] === "`" && fenceOpen[2]!.includes("`"))) {
        fenceChar = fenceOpen[1]![0]!;
        fenceLen = fenceOpen[1]!.length;
        pos = nextLineStart;
        continue;
      }
    }

    let jumpedOffset = -1;
    for (let i = pos; i < lineEnd; ) {
      const ch = slice[i]!;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        let tickEnd = i + 1;
        while (tickEnd < slice.length && slice[tickEnd] === "`") tickEnd++;
        const runLen = tickEnd - i;
        if ((failedTickRunUntil.get(runLen) ?? -1) > i) {
          i = tickEnd;
          continue;
        }
        let search = tickEnd;
        let matchedTickEnd = -1;
        while (search < slice.length) {
          const sc = slice[search]!;
          if (sc === "\n" || sc === "\r") {
            let afterNl = search + (sc === "\r" && slice[search + 1] === "\n" ? 2 : 1);
            while (afterNl < slice.length && (slice[afterNl] === " " || slice[afterNl] === "\t")) {
              afterNl++;
            }
            if (afterNl < slice.length && (slice[afterNl] === "\n" || slice[afterNl] === "\r")) {
              break;
            }
            search = afterNl;
            continue;
          }
          if (sc === "`") {
            let closeEnd = search + 1;
            while (closeEnd < slice.length && slice[closeEnd] === "`") closeEnd++;
            if (closeEnd - search === runLen) {
              matchedTickEnd = closeEnd;
              break;
            }
            search = closeEnd;
            continue;
          }
          search++;
        }
        if (matchedTickEnd !== -1) {
          if (matchedTickEnd > lineEnd) {
            jumpedOffset = matchedTickEnd;
            break;
          }
          i = matchedTickEnd;
        } else {
          failedTickRunUntil.set(runLen, search);
          i = tickEnd;
        }
        continue;
      }
      if (ch === "<") {
        if (slice.startsWith("<!-->", i)) {
          i += 5;
          continue;
        }
        if (slice.startsWith("<!--->", i)) {
          i += 6;
          continue;
        }
        openRe.lastIndex = i;
        const openMatch = openRe.exec(slice);
        if (openMatch) {
          const relInnerStart = i + openMatch[0].length;
          let relInnerEnd = slice.length;
          let relOuterEnd = slice.length;
          if (openMatch[0] === "<!--") {
            commentCloseRe.lastIndex = relInnerStart;
            const closeMatch = commentCloseRe.exec(slice);
            if (closeMatch) {
              relInnerEnd = closeMatch.index;
              relOuterEnd = closeMatch.index + closeMatch[0].length;
            }
          } else if (openMatch[0] === "<![CDATA[") {
            const closeIdx = slice.indexOf("]]>", relInnerStart);
            if (closeIdx !== -1) {
              relInnerEnd = closeIdx;
              relOuterEnd = closeIdx + 3;
            }
          } else if (openMatch[0] === "<?") {
            const closeIdx = slice.indexOf("?>", relInnerStart);
            if (closeIdx !== -1) {
              relInnerEnd = closeIdx;
              relOuterEnd = closeIdx + 2;
            }
          } else {
            const rawTag = openMatch.groups!.rawTag!.toLowerCase();
            const rawCloseRe = new RegExp(`<\\/${rawTag}[ \\t\\r\\n]*>`, "gi");
            rawCloseRe.lastIndex = relInnerStart;
            const closeMatch = rawCloseRe.exec(slice);
            if (closeMatch) {
              relInnerEnd = closeMatch.index;
              relOuterEnd = closeMatch.index + closeMatch[0].length;
            }
          }
          if (relInnerEnd > relInnerStart) {
            results.push({
              outerStart: sliceStart + i,
              outerEnd: sliceStart + relOuterEnd,
              innerStart: sliceStart + relInnerStart,
              innerEnd: sliceStart + relInnerEnd,
            });
          }
          if (relOuterEnd > lineEnd) {
            jumpedOffset = relOuterEnd;
            break;
          }
          i = Math.max(i + 1, relOuterEnd);
          continue;
        }
      }
      i++;
    }

    pos = jumpedOffset !== -1 ? jumpedOffset : nextLineStart;
  }

  return results;
}

function splitChunkDiscourseBlocks(
  text: string,
  rawBlocks: readonly PedagogicalAstBlock[] = parsePedagogicalAst(text),
  initialInWorkedExample = false,
): PedagogicalAstBlock[] {
  const refined: PedagogicalAstBlock[] = [];
  let inWorkedExample = initialInWorkedExample;
  let workedExampleHeadingLevel: number | null = null;

  for (const block of rawBlocks) {
    if (block.visibility === "sealed") {
      if (block.kind === "heading") {
        inWorkedExample = false;
        workedExampleHeadingLevel = null;
      }
      refined.push(block);
      continue;
    }
    if (block.kind === "example") {
      inWorkedExample = true;
      workedExampleHeadingLevel = null;
      refined.push(block);
      continue;
    }
    if (block.kind === "heading") {
      const level = headingMarkdownLevel(block) ?? 1;
      const headingKind = block.visibility === "public"
        ? classifyPlainLeadKind(block.label ?? block.text, true)
        : null;
      if (headingKind === "example") {
        inWorkedExample = true;
        workedExampleHeadingLevel = level;
      } else if (headingKind || workedExampleHeadingLevel === null || level <= workedExampleHeadingLevel) {
        inWorkedExample = false;
        workedExampleHeadingLevel = null;
      }
      refined.push(headingKind ? { ...block, kind: headingKind } : block);
      continue;
    }
    if (block.kind !== "prose") {
      if (block.kind === "exercise" || block.kind === "theorem" || block.kind === "definition" || block.kind === "lemma") {
        inWorkedExample = false;
        workedExampleHeadingLevel = null;
      }
      refined.push(block);
      continue;
    }

    const slice = text.slice(block.startOffset, block.endOffset);
    const lineStarts: number[] = [0];
    for (const nl of slice.matchAll(/\r\n?|\n/g)) {
      const nextStart = nl.index + nl[0].length;
      if (nextStart < slice.length) lineStarts.push(nextStart);
    }

    type SubSpan = { relStart: number; kind: PedagogicalBlockKind; visibility: PedagogicalVisibility };
    const spans: SubSpan[] = [];
    for (let idx = 0; idx < lineStarts.length; idx++) {
      const relStart = lineStarts[idx]!;
      const relEnd = idx + 1 < lineStarts.length ? lineStarts[idx + 1]! : slice.length;
      const line = slice.slice(relStart, relEnd).replace(/\r?\n$/, "");
      if (!line.trim()) continue;

      let lineKind: PedagogicalBlockKind | null = null;
      let lineVis: PedagogicalVisibility = block.visibility;
      if (PROSE_UNCONDITIONAL_SEALED_LINE_RE.test(line) || (!inWorkedExample && PROSE_CONTEXTUAL_SOLUTION_LINE_RE.test(line))) {
        lineKind = "solution";
        lineVis = "sealed";
      } else if (PROSE_HINT_LINE_RE.test(line)) {
        lineKind = "hint";
        lineVis = block.visibility === "public" ? "hint_gated" : block.visibility;
      } else if (block.visibility === "public") {
        lineKind = classifyPlainLeadKind(line, false);
        if (lineKind === "example") {
          inWorkedExample = true;
          workedExampleHeadingLevel = null;
        } else if (lineKind === "exercise" || lineKind === "theorem" || lineKind === "definition" || lineKind === "lemma") {
          inWorkedExample = false;
          workedExampleHeadingLevel = null;
        }
      }

      if (spans.length === 0) {
        spans.push({ relStart: 0, kind: lineKind ?? block.kind, visibility: lineVis });
      } else if (lineKind !== null && (lineVis !== spans[spans.length - 1]!.visibility || lineKind !== spans[spans.length - 1]!.kind)) {
        spans.push({ relStart, kind: lineKind, visibility: lineVis });
      }
    }

    if (spans.length <= 1) {
      const only = spans[0];
      refined.push(
        only && (only.kind !== block.kind || only.visibility !== block.visibility)
          ? { ...block, kind: only.kind, visibility: only.visibility }
          : block,
      );
      continue;
    }

    for (let s = 0; s < spans.length; s++) {
      const cur = spans[s]!;
      const nextRel = s + 1 < spans.length ? spans[s + 1]!.relStart : slice.length;
      const absStart = block.startOffset + cur.relStart;
      const absEnd = block.startOffset + nextRel;
      if (absEnd > absStart) {
        refined.push({
          ...block,
          kind: cur.kind,
          visibility: cur.visibility,
          startOffset: absStart,
          endOffset: absEnd,
          text: text.slice(absStart, absEnd),
        });
      }
    }
  }

  return refined;
}

function selectSegmentBlockKind(blocks: readonly PedagogicalAstBlock[]): PedagogicalBlockKind {
  const kinds = new Set<PedagogicalBlockKind>(blocks.map(b => b.kind));
  if (kinds.has("definition") && (kinds.has("proof") || kinds.has("theorem") || kinds.has("lemma"))) {
    if (kinds.has("proof")) return "proof";
    if (kinds.has("theorem")) return "theorem";
    return "lemma";
  }
  if (kinds.has("definition")) return "definition";
  if (kinds.has("lemma")) return "lemma";
  if (kinds.has("theorem")) return "theorem";
  if (kinds.has("proof")) return "proof";
  if (kinds.has("display_math")) return "display_math";
  if (kinds.has("example")) return "example";
  if (kinds.has("exercise")) return "exercise";
  if (kinds.has("hint")) return "hint";
  return blocks[0]?.kind ?? "prose";
}

function matchesPrivacyEpoch(itemEpoch: number | undefined, expectedEpoch: number | undefined): boolean {
  if (expectedEpoch === undefined) return true;
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) return false;
  return itemEpoch === expectedEpoch;
}

function stableSegmentOrder(a: MaterialSegment, b: MaterialSegment): number {
  return a.chunk.sourceId.localeCompare(b.chunk.sourceId)
    || (a.chunk.page ?? Infinity) - (b.chunk.page ?? Infinity)
    || a.chunk.id.localeCompare(b.chunk.id)
    || a.segmentIndex - b.segmentIndex;
}

function mergePedagogicalBudgetedSegments(selected: readonly MaterialSegment[], maxCharacters: number): SourceChunk[] {
  if (maxCharacters <= 0) return [];
  const budgeted: MaterialSegment[] = [];
  let used = 0;
  for (const segment of selected) {
    const { chunk } = segment;
    const separator = budgeted.length ? 1 : 0;
    const fullLength = renderContext([chunk]).length + separator;
    const remaining = maxCharacters - used;
    if (fullLength <= remaining) {
      budgeted.push(segment);
      used += fullLength;
    } else if (budgeted.length === 0) {
      const textLength = remaining - renderContext([{ ...chunk, text: "" }]).length;
      if (textLength > 0) {
        const text = chunk.text.slice(0, textLength).replace(/[\uD800-\uDBFF]$/u, "");
        if (text || chunk.imageObjectKey) {
          budgeted.push({ chunk: { ...chunk, text }, segmentIndex: segment.segmentIndex });
        }
        break;
      }
    }
  }
  const grouped = new Map<string, { base: SourceChunk; parts: Array<{ segmentIndex: number; text: string }> }>();
  for (const { chunk, segmentIndex } of budgeted) {
    const existing = grouped.get(chunk.id);
    if (existing) {
      existing.parts.push({ segmentIndex, text: chunk.text });
    } else {
      grouped.set(chunk.id, { base: { ...chunk }, parts: [{ segmentIndex, text: chunk.text }] });
    }
  }
  const result: SourceChunk[] = [];
  for (const { base, parts } of grouped.values()) {
    parts.sort((a, b) => a.segmentIndex - b.segmentIndex);
    result.push({ ...base, text: parts.map(p => p.text).join("\n[…]\n") });
  }
  return result;
}

function selectAndMergeStandard(
  segments: MaterialSegment[],
  dense: MaterialSegment[],
  input: { query: string; maxCharacters: number; preferChunkId?: string; preferPage?: number },
): SourceChunk[] {
  const all = new Map(segments.map(segment => [materialSegmentKey(segment), segment]));
  const lexical = segments.map(segment => ({ segment, score: materialLexicalScore(input.query, segment.chunk.text) }))
    .sort((a, b) => b.score - a.score || stableSegmentOrder(a.segment, b.segment));
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
      if ((preference(b) - preference(a) || score(b) - score(a) || stableSegmentOrder(a, b)) < 0) best = index;
    }
    const next = candidates.splice(best, 1)[0]!;
    selected.push(next);
    counts.set(next.chunk.sourceId, (counts.get(next.chunk.sourceId) ?? 0) + 1);
  }
  const merged = new Map<string, SourceChunk>();
  for (const chunk of budgetRankedMaterial(selected.map(segment => segment.chunk), input.maxCharacters)) {
    const previous = merged.get(chunk.id);
    if (previous) previous.text += `\n[…]\n${chunk.text}`;
    else merged.set(chunk.id, { ...chunk });
  }
  return [...merged.values()];
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

  if (!input.pedagogicalGraph) {
    return selectAndMergeStandard(segments, dense, input);
  }

  const { authorization } = input.pedagogicalGraph;
  const admissibleSourceIds = authorization.admissibleSourceIds instanceof Set
    ? authorization.admissibleSourceIds
    : new Set(authorization.admissibleSourceIds);
  const excludedItemFamilyIds = !authorization.excludedItemFamilyIds
    ? new Set<string>()
    : authorization.excludedItemFamilyIds instanceof Set
      ? authorization.excludedItemFamilyIds
      : new Set(authorization.excludedItemFamilyIds);
  const allowHintGated = authorization.allowHintGated ?? false;
  const expectedPrivacyEpoch = authorization.expectedPrivacyEpoch;
  const admissibleSourceVersions = authorization.admissibleSourceVersions;

  const isAdmissibleSourceAndVersion = (sourceId: string): boolean => {
    if (!admissibleSourceIds.has(sourceId)) return false;
    if (admissibleSourceVersions !== undefined) {
      if (!Object.hasOwn(admissibleSourceVersions, sourceId)) return false;
      const expected = admissibleSourceVersions[sourceId];
      if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) return false;
    }
    return true;
  };

  const isChunkSourceVersionAdmissible = (sourceId: string, sourceVersion: number): boolean => {
    if (!isAdmissibleSourceAndVersion(sourceId)) return false;
    if (admissibleSourceVersions !== undefined && admissibleSourceVersions[sourceId] !== sourceVersion) {
      return false;
    }
    return true;
  };

  chunksById ??= new Map(input.chunks.map(chunk => [chunk.id, chunk]));
  const allPhysicalChunkIds = new Set(input.chunks.map(chunk => chunk.id));

  type DocChunkItem = { chunk: SourceChunk; inputIndex: number };
  type IndexedDocAst = {
    blocks: readonly PedagogicalAstBlock[];
    prefixMaxEnd: Float64Array;
  };
  type UnwrappedRange = { start: number; end: number };
  type UnwrappedScope = {
    ranges: readonly UnwrappedRange[];
    ast: IndexedDocAst;
  };
  type ChunkDocSpan = {
    docAst: IndexedDocAst;
    overlayAst: IndexedDocAst | undefined;
    unwrappedScopes: readonly UnwrappedScope[];
    docStart: number;
    docEnd: number;
    chunkHasProtectedAst: boolean;
  };

  const isProtectedVisibility = (visibility: PedagogicalVisibility): boolean =>
    visibility === "sealed" || (visibility === "hint_gated" && !allowHintGated);
  const isProtectedAstBlock = (b: PedagogicalAstBlock): boolean =>
    isProtectedVisibility(b.visibility);

  const indexAstBlocks = (rawBlocks: readonly PedagogicalAstBlock[]): IndexedDocAst => {
    const blocks = [...rawBlocks].sort(
      (a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset,
    );
    const prefixMaxEnd = new Float64Array(blocks.length);
    let maxEnd = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i]!.endOffset > maxEnd) maxEnd = blocks[i]!.endOffset;
      prefixMaxEnd[i] = maxEnd;
    }
    return { blocks, prefixMaxEnd };
  };

  const getIndexedAstBlocks = (text: string): IndexedDocAst =>
    indexAstBlocks(splitChunkDiscourseBlocks(text));

  const chunkAstById = new Map<string, IndexedDocAst>();
  const getOrCreateChunkAst = (chunkId: string, text: string): IndexedDocAst => {
    let cached = chunkAstById.get(chunkId);
    if (!cached) {
      cached = getIndexedAstBlocks(text);
      chunkAstById.set(chunkId, cached);
    }
    return cached;
  };

  const collectUnwrappedContainerBlocks = (
    docText: string,
    rootBlocks: readonly PedagogicalAstBlock[],
    spans: ReadonlyArray<{ docStart: number; docEnd: number }>,
  ): { blocks: PedagogicalAstBlock[]; scopes: UnwrappedScope[] } => {
    if (spans.length <= 1 || rootBlocks.length === 0) return { blocks: [], scopes: [] };
    const extraOverlayBlocks: PedagogicalAstBlock[] = [];
    const unwrappedScopes: UnwrappedScope[] = [];
    const processedSliceKeys = new Set<string>();
    const maxUnwrapParses = Math.min(32, Math.max(8, spans.length * 2));
    let unwrapParses = 0;

    const firstCrossedBoundary = (outerStart: number, outerEnd: number): number => {
      if (outerEnd <= outerStart + 1) return -1;
      let lo = 1;
      let hi = spans.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (spans[mid]!.docStart <= outerStart) lo = mid + 1;
        else hi = mid;
      }
      return lo < spans.length && spans[lo]!.docStart < outerEnd ? spans[lo]!.docStart : -1;
    };

    const unwrapSlice = (
      innerStart: number,
      innerEnd: number,
      outerEnd: number,
      rangeEnd: number,
      afterRangeSegments: readonly UnwrappedRange[],
      inWorkedExample: boolean,
      fallbackBlock?: PedagogicalAstBlock,
    ): void => {
      if (innerEnd <= innerStart) return;
      const postCloserSegments: UnwrappedRange[] = [];
      if (outerEnd < rangeEnd) {
        postCloserSegments.push({ start: outerEnd, end: rangeEnd });
      }
      for (const seg of afterRangeSegments) {
        if (seg.end > seg.start) postCloserSegments.push(seg);
      }
      const tailEndKey =
        postCloserSegments.length > 0
          ? postCloserSegments[postCloserSegments.length - 1]!.end
          : innerEnd;
      const sliceKey = `${innerStart}:${innerEnd}:${outerEnd}:${tailEndKey}`;
      if (processedSliceKeys.has(sliceKey)) return;
      processedSliceKeys.add(sliceKey);

      if (unwrapParses >= maxUnwrapParses) {
        const template = fallbackBlock ?? rootBlocks[0]!;
        const sealedFallback: PedagogicalAstBlock = {
          ...template,
          kind: "solution",
          visibility: "sealed",
          startOffset: innerStart,
          endOffset: tailEndKey,
          text: docText.slice(innerStart, tailEndKey),
        };
        extraOverlayBlocks.push(sealedFallback);
        unwrappedScopes.push({
          ranges: [{ start: innerStart, end: tailEndKey }],
          ast: indexAstBlocks([sealedFallback]),
        });
        return;
      }
      unwrapParses++;

      const interiorSlice = docText.slice(innerStart, innerEnd);
      const innerLen = innerEnd - innerStart;
      const rawInteriorBlocks = parsePedagogicalAst(interiorSlice);

      let probeTailVis: PedagogicalVisibility = "public";
      let hasCarryableHeadingScope = false;
      if (postCloserSegments.length > 0 && rawInteriorBlocks.some(b => b.visibility !== "public")) {
        probeTailVis = parsePedagogicalAst(`${interiorSlice}\n\nprobe`).at(-1)?.visibility ?? "public";
        hasCarryableHeadingScope =
          probeTailVis !== "public"
          && (parsePedagogicalAst(`${interiorSlice}\n\n# Reset\n\nprobe`).at(-1)?.visibility ?? "public")
            === "public";
      }

      if (hasCarryableHeadingScope) {
        const template = rawInteriorBlocks.at(-1) ?? fallbackBlock ?? rootBlocks[0]!;
        const scopeBlocks: PedagogicalAstBlock[] = [];
        const scopeRanges: UnwrappedRange[] = [{ start: innerStart, end: innerEnd }];
        const tailPieces: UnwrappedRange[] = [];

        for (let idx = 0; idx < postCloserSegments.length; idx++) {
          const seg = postCloserSegments[idx]!;
          let segStart = seg.start;
          if (
            idx === 0
            && segStart > 0
            && docText[segStart - 1] !== "\n"
            && docText[segStart - 1] !== "\r"
          ) {
            let sameLineEnd = segStart;
            while (
              sameLineEnd < seg.end
              && docText[sameLineEnd] !== "\n"
              && docText[sameLineEnd] !== "\r"
            ) {
              sameLineEnd++;
            }
            if (sameLineEnd > segStart) {
              if (docText.slice(segStart, sameLineEnd).trim()) {
                scopeBlocks.push({
                  ...template,
                  kind: probeTailVis === "sealed" ? "solution" : "hint",
                  visibility: probeTailVis,
                  startOffset: segStart,
                  endOffset: sameLineEnd,
                  text: docText.slice(segStart, sameLineEnd),
                });
              }
              scopeRanges.push({ start: segStart, end: sameLineEnd });
              segStart = sameLineEnd;
            }
          }
          if (seg.end > segStart) {
            tailPieces.push({ start: segStart, end: seg.end });
            scopeRanges.push({ start: segStart, end: seg.end });
          }
        }

        type VirtPiece = { virtStart: number; virtEnd: number; docStart: number };
        const virtPieces: VirtPiece[] = [{ virtStart: 0, virtEnd: innerLen, docStart: innerStart }];
        const extParts: string[] = [interiorSlice];
        let virtOffset = innerLen;
        for (const piece of tailPieces) {
          extParts.push("\n\n");
          virtOffset += 2;
          const pieceLen = piece.end - piece.start;
          virtPieces.push({
            virtStart: virtOffset,
            virtEnd: virtOffset + pieceLen,
            docStart: piece.start,
          });
          extParts.push(docText.slice(piece.start, piece.end));
          virtOffset += pieceLen;
        }
        const extendedText = extParts.join("");
        const extendedBlocks = splitChunkDiscourseBlocks(
          extendedText,
          tailPieces.length > 0 ? parsePedagogicalAst(extendedText) : rawInteriorBlocks,
          inWorkedExample,
        );

        const interiorMappedBlocks: PedagogicalAstBlock[] = [];
        for (const b of extendedBlocks) {
          for (let p = 0; p < virtPieces.length; p++) {
            const vp = virtPieces[p]!;
            const ovStart = Math.max(b.startOffset, vp.virtStart);
            const ovEnd = Math.min(b.endOffset, vp.virtEnd);
            if (ovEnd > ovStart) {
              const mappedStart = vp.docStart + (ovStart - vp.virtStart);
              const mappedEnd = vp.docStart + (ovEnd - vp.virtStart);
              const mapped: PedagogicalAstBlock = {
                ...b,
                startOffset: mappedStart,
                endOffset: mappedEnd,
                text: docText.slice(mappedStart, mappedEnd),
              };
              scopeBlocks.push(mapped);
              if (p === 0) interiorMappedBlocks.push(mapped);
            }
          }
        }

        extraOverlayBlocks.push(...scopeBlocks);
        unwrappedScopes.push({
          ranges: scopeRanges,
          ast: indexAstBlocks(scopeBlocks),
        });
        inspectRangeAndBlocks(innerStart, innerEnd, interiorMappedBlocks, postCloserSegments);
        return;
      }

      const subBlocks = splitChunkDiscourseBlocks(
        interiorSlice,
        rawInteriorBlocks,
        inWorkedExample,
      ).map(sb => ({
        ...sb,
        startOffset: sb.startOffset + innerStart,
        endOffset: sb.endOffset + innerStart,
      }));
      extraOverlayBlocks.push(...subBlocks);
      unwrappedScopes.push({
        ranges: [{ start: innerStart, end: innerEnd }],
        ast: indexAstBlocks(subBlocks),
      });
      inspectRangeAndBlocks(innerStart, innerEnd, subBlocks, postCloserSegments);
    };

    const inspectRangeAndBlocks = (
      rangeStart: number,
      rangeEnd: number,
      blocks: readonly PedagogicalAstBlock[],
      afterRangeSegments: readonly UnwrappedRange[],
    ): void => {
      for (const block of blocks) {
        if (block.visibility === "sealed") continue;
        const crossedDocStart = firstCrossedBoundary(block.startOffset, block.endOffset);
        if (crossedDocStart === -1) continue;
        const unwrapped = unwrapContainerBounds(
          docText,
          block.startOffset,
          block.endOffset,
          crossedDocStart,
        );
        if (!unwrapped) continue;
        unwrapSlice(
          unwrapped.innerStart,
          unwrapped.innerEnd,
          unwrapped.outerEnd,
          rangeEnd,
          afterRangeSegments,
          block.kind === "example",
          block,
        );
      }

      for (const htmlSpan of collectHtmlLiteralSpans(docText, rangeStart, rangeEnd)) {
        if (firstCrossedBoundary(htmlSpan.outerStart, htmlSpan.outerEnd) === -1) continue;
        unwrapSlice(
          htmlSpan.innerStart,
          htmlSpan.innerEnd,
          htmlSpan.outerEnd,
          rangeEnd,
          afterRangeSegments,
          false,
        );
      }
    };

    inspectRangeAndBlocks(0, docText.length, rootBlocks, []);
    return { blocks: extraOverlayBlocks, scopes: unwrappedScopes };
  };

  const sliceOverlappingAstBlocks = (
    docAst: IndexedDocAst,
    rangeStart: number,
    rangeEnd: number,
  ): PedagogicalAstBlock[] => {
    const { blocks, prefixMaxEnd } = docAst;
    if (blocks.length === 0 || rangeEnd <= rangeStart) return [];
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prefixMaxEnd[mid]! <= rangeStart) lo = mid + 1;
      else hi = mid;
    }
    const result: PedagogicalAstBlock[] = [];
    for (let i = lo; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.startOffset >= rangeEnd) break;
      if (block.endOffset > rangeStart) result.push(block);
    }
    return result;
  };

  const findPrecedingAstBlock = (
    docAst: IndexedDocAst,
    beforeOffset: number,
  ): PedagogicalAstBlock | undefined => {
    const { blocks } = docAst;
    let lo = 0;
    let hi = blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (blocks[mid]!.startOffset < beforeOffset) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 ? blocks[lo - 1] : undefined;
  };

  const docGroups = new Map<string, DocChunkItem[]>();
  const seenDocChunkIds = new Set<string>();
  for (let idx = 0; idx < input.chunks.length; idx++) {
    const rawChunk = input.chunks[idx]!;
    if (seenDocChunkIds.has(rawChunk.id)) continue;
    seenDocChunkIds.add(rawChunk.id);
    const canonical = chunksById.get(rawChunk.id) ?? rawChunk;
    if (!canonical.text.trim()) continue;
    const docKey = `${canonical.sourceId}\0${canonical.sourceVersion}`;
    const group = docGroups.get(docKey);
    if (group) group.push({ chunk: canonical, inputIndex: idx });
    else docGroups.set(docKey, [{ chunk: canonical, inputIndex: idx }]);
  }

  const chunkDocSpanById = new Map<string, ChunkDocSpan>();
  for (const [, group] of docGroups) {
    group.sort(
      (a, b) =>
        (a.chunk.page ?? Number.MAX_SAFE_INTEGER) - (b.chunk.page ?? Number.MAX_SAFE_INTEGER)
        || (a.chunk.startMs ?? Number.MAX_SAFE_INTEGER) - (b.chunk.startMs ?? Number.MAX_SAFE_INTEGER)
        || a.inputIndex - b.inputIndex,
    );
    const parts: string[] = [];
    const spans: Array<{ chunk: SourceChunk; docStart: number; docEnd: number }> = [];
    let offset = 0;
    let prevText = "";
    for (let i = 0; i < group.length; i++) {
      const currChunk = group[i]!.chunk;
      const currText = currChunk.text;
      if (i > 0) {
        const hasBoundaryNewline =
          prevText.endsWith("\n") || prevText.endsWith("\r")
          || currText.startsWith("\n") || currText.startsWith("\r");
        if (!hasBoundaryNewline) {
          parts.push("\n\n");
          offset += 2;
        }
      }
      const docStart = offset;
      parts.push(currText);
      offset += currText.length;
      spans.push({ chunk: currChunk, docStart, docEnd: offset });
      prevText = currText;
    }
    const docText = parts.join("");
    const docAst = getIndexedAstBlocks(docText);
    const { blocks: extraOverlayBlocks, scopes: unwrappedScopes } = collectUnwrappedContainerBlocks(
      docText,
      docAst.blocks,
      spans,
    );
    const overlayAst = extraOverlayBlocks.length > 0 ? indexAstBlocks(extraOverlayBlocks) : undefined;

    for (const span of spans) {
      const localAst = getOrCreateChunkAst(span.chunk.id, span.chunk.text);
      const docChunkBlocks = sliceOverlappingAstBlocks(docAst, span.docStart, span.docEnd);
      const overlayChunkBlocks = overlayAst
        ? sliceOverlappingAstBlocks(overlayAst, span.docStart, span.docEnd)
        : [];
      chunkDocSpanById.set(span.chunk.id, {
        docAst,
        overlayAst,
        unwrappedScopes,
        docStart: span.docStart,
        docEnd: span.docEnd,
        chunkHasProtectedAst:
          docChunkBlocks.some(isProtectedAstBlock)
          || overlayChunkBlocks.some(isProtectedAstBlock)
          || localAst.blocks.some(isProtectedAstBlock),
      });
    }
  }

  const pedagogicalChunks: PedagogicalChunk[] = [];
  const admissibleSegments: MaterialSegment[] = [];
  const fallbackSegments: MaterialSegment[] = [];
  const admissibleSegmentKeys = new Set<string>();
  const quarantinedSegmentKeys = new Set<string>();
  const quarantinedPhysicalChunkIds = new Set<string>();
  const admissibleSegmentKeysByPhysicalChunkId = new Map<string, string[]>();

  for (const entry of entries) {
    const segKey = materialSegmentKey(entry.segment);
    const originalChunk = chunksById.get(entry.segment.chunk.id) ?? entry.segment.chunk;
    const chunkEpoch = Object.hasOwn(originalChunk, "privacyEpoch")
      ? (originalChunk as SourceChunk & { privacyEpoch?: number }).privacyEpoch
      : expectedPrivacyEpoch;
    const chunkAdmissible = isChunkSourceVersionAdmissible(originalChunk.sourceId, originalChunk.sourceVersion)
      && matchesPrivacyEpoch(chunkEpoch, expectedPrivacyEpoch);
    const chunkFamilyId = Object.hasOwn(originalChunk, "itemFamilyId")
      ? (originalChunk as SourceChunk & { itemFamilyId?: string }).itemFamilyId
      : undefined;

    if (!originalChunk.text.trim() && originalChunk.imageObjectKey) {
      const excludedByFamily = chunkFamilyId !== undefined && excludedItemFamilyIds.has(chunkFamilyId);
      pedagogicalChunks.push({
        id: segKey,
        sourceId: originalChunk.sourceId,
        sourceVersion: originalChunk.sourceVersion,
        ...(chunkEpoch !== undefined ? { privacyEpoch: chunkEpoch } : {}),
        kind: "prose",
        constructKinds: ["prose"],
        visibility: "public",
        atomicConstruct: false,
        text: entry.segment.chunk.text,
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        pageStart: originalChunk.page,
        pageEnd: originalChunk.page,
        startMs: originalChunk.startMs,
        endMs: originalChunk.endMs,
        keyframeChunkId: null,
        oversizedSplit: false,
        ...(chunkFamilyId !== undefined ? { itemFamilyId: chunkFamilyId } : {}),
      });
      if (chunkAdmissible && !excludedByFamily) {
        admissibleSegments.push(entry.segment);
        fallbackSegments.push(entry.segment);
        admissibleSegmentKeys.add(segKey);
        const list = admissibleSegmentKeysByPhysicalChunkId.get(originalChunk.id);
        if (list) list.push(segKey);
        else admissibleSegmentKeysByPhysicalChunkId.set(originalChunk.id, [segKey]);
      } else {
        quarantinedSegmentKeys.add(segKey);
        quarantinedPhysicalChunkIds.add(originalChunk.id);
      }
      continue;
    }

    const chunkSpan = chunkDocSpanById.get(originalChunk.id);
    let docAst: IndexedDocAst;
    let overlayAst: IndexedDocAst | undefined;
    let localAst: IndexedDocAst;
    let segDocStart: number;
    let segDocEnd: number;
    let localStart: number;
    let localEnd: number;
    let chunkHasProtectedAst: boolean;
    if (chunkSpan && entry.endOffset <= chunkSpan.docEnd - chunkSpan.docStart) {
      docAst = chunkSpan.docAst;
      overlayAst = chunkSpan.overlayAst;
      localAst = getOrCreateChunkAst(originalChunk.id, originalChunk.text);
      segDocStart = chunkSpan.docStart + entry.startOffset;
      segDocEnd = chunkSpan.docStart + entry.endOffset;
      localStart = entry.startOffset;
      localEnd = entry.endOffset;
      chunkHasProtectedAst = chunkSpan.chunkHasProtectedAst;
    } else {
      const fitsOriginal = entry.endOffset <= originalChunk.text.length;
      localAst = fitsOriginal
        ? getOrCreateChunkAst(originalChunk.id, originalChunk.text)
        : getIndexedAstBlocks(entry.segment.chunk.text);
      docAst = localAst;
      overlayAst = undefined;
      localStart = fitsOriginal ? entry.startOffset : 0;
      localEnd = fitsOriginal ? entry.endOffset : entry.segment.chunk.text.length;
      segDocStart = localStart;
      segDocEnd = localEnd;
      chunkHasProtectedAst = localAst.blocks.some(isProtectedAstBlock);
    }

    const docOverlapping = sliceOverlappingAstBlocks(docAst, segDocStart, segDocEnd);
    const overlayOverlapping = overlayAst
      ? sliceOverlappingAstBlocks(overlayAst, segDocStart, segDocEnd)
      : [];
    const localOverlapping = docAst === localAst
      ? docOverlapping
      : sliceOverlappingAstBlocks(localAst, localStart, localEnd);

    if (
      docOverlapping.length === 0
      && overlayOverlapping.length === 0
      && localOverlapping.length === 0
    ) {
      const prevDocBlock = findPrecedingAstBlock(docAst, segDocEnd);
      const overlayProtectedInScope =
        chunkSpan?.unwrappedScopes.some(scope => {
          if (!scope.ranges.some(r => r.start < segDocEnd && r.end > segDocStart)) return false;
          const prevOverlay = findPrecedingAstBlock(scope.ast, segDocEnd);
          return prevOverlay !== undefined && isProtectedAstBlock(prevOverlay);
        }) ?? false;
      const prevLocalBlock = docAst === localAst
        ? prevDocBlock
        : findPrecedingAstBlock(localAst, localEnd);
      const segmentInProtectedScope =
        chunkHasProtectedAst
        || (prevDocBlock !== undefined && isProtectedAstBlock(prevDocBlock))
        || overlayProtectedInScope
        || (prevLocalBlock !== undefined && isProtectedAstBlock(prevLocalBlock));
      const excludedByFamily = chunkFamilyId !== undefined && excludedItemFamilyIds.has(chunkFamilyId);
      if (chunkAdmissible && !segmentInProtectedScope && !excludedByFamily) {
        fallbackSegments.push(entry.segment);
      } else {
        quarantinedSegmentKeys.add(segKey);
        quarantinedPhysicalChunkIds.add(originalChunk.id);
      }
      continue;
    }

    let docVis: PedagogicalVisibility = "public";
    for (const block of docOverlapping) {
      docVis = maxPedagogicalVisibility(docVis, block.visibility);
      if (docVis === "sealed") break;
    }
    let overlayVis: PedagogicalVisibility = "public";
    for (const block of overlayOverlapping) {
      overlayVis = maxPedagogicalVisibility(overlayVis, block.visibility);
      if (overlayVis === "sealed") break;
    }
    let localVis: PedagogicalVisibility = "public";
    for (const block of localOverlapping) {
      localVis = maxPedagogicalVisibility(localVis, block.visibility);
      if (localVis === "sealed") break;
    }
    const visibility = maxPedagogicalVisibility(
      maxPedagogicalVisibility(docVis, overlayVis),
      localVis,
    );

    const combinedOverlapping = docAst === localAst
      ? docOverlapping
      : overlayOverlapping.length > 0
        ? [...docOverlapping, ...overlayOverlapping, ...localOverlapping]
        : [...docOverlapping, ...localOverlapping];

    let segmentFamilyId = chunkFamilyId;
    if (segmentFamilyId === undefined || !excludedItemFamilyIds.has(segmentFamilyId)) {
      for (const block of combinedOverlapping) {
        const blockFamily = (block as PedagogicalAstBlock & { itemFamilyId?: string }).itemFamilyId;
        if (blockFamily !== undefined) {
          if (excludedItemFamilyIds.has(blockFamily)) {
            segmentFamilyId = blockFamily;
            break;
          }
          segmentFamilyId ??= blockFamily;
        }
      }
    }

    const primaryOverlapping = docOverlapping.length > 0
      ? docOverlapping
      : overlayOverlapping.length > 0
        ? overlayOverlapping
        : localOverlapping;
    const visibleBlocks = primaryOverlapping.filter(
      b => b.visibility === "public" || (b.visibility === "hint_gated" && allowHintGated),
    );
    const kind: PedagogicalBlockKind =
      visibility === "sealed"
      && combinedOverlapping.some(b => b.kind === "solution" || b.visibility === "sealed")
        ? "solution"
        : visibility === "hint_gated"
          && docVis === "public"
          && combinedOverlapping.some(b => b.kind === "hint")
          ? "hint"
          : selectSegmentBlockKind(visibleBlocks.length > 0 ? visibleBlocks : primaryOverlapping);
    const constructKinds: PedagogicalBlockKind[] = [];
    for (const block of primaryOverlapping) {
      if (!constructKinds.includes(block.kind)) constructKinds.push(block.kind);
    }
    if (kind === "solution" && !constructKinds.includes("solution")) {
      constructKinds.push("solution");
    }

    pedagogicalChunks.push({
      id: segKey,
      sourceId: originalChunk.sourceId,
      sourceVersion: originalChunk.sourceVersion,
      ...(chunkEpoch !== undefined ? { privacyEpoch: chunkEpoch } : {}),
      kind,
      constructKinds,
      visibility,
      atomicConstruct: primaryOverlapping.some(b => b.atomicConstruct),
      text: entry.segment.chunk.text,
      startOffset: entry.startOffset,
      endOffset: entry.endOffset,
      pageStart: originalChunk.page,
      pageEnd: originalChunk.page,
      startMs: originalChunk.startMs,
      endMs: originalChunk.endMs,
      keyframeChunkId: null,
      oversizedSplit: false,
      ...(segmentFamilyId !== undefined ? { itemFamilyId: segmentFamilyId } : {}),
    });

    const visibilityAdmissible = visibility === "public" || (visibility === "hint_gated" && allowHintGated);
    const excludedByFamily = segmentFamilyId !== undefined && excludedItemFamilyIds.has(segmentFamilyId);
    if (chunkAdmissible && visibilityAdmissible && !excludedByFamily) {
      admissibleSegments.push(entry.segment);
      fallbackSegments.push(entry.segment);
      admissibleSegmentKeys.add(segKey);
      const list = admissibleSegmentKeysByPhysicalChunkId.get(originalChunk.id);
      if (list) list.push(segKey);
      else admissibleSegmentKeysByPhysicalChunkId.set(originalChunk.id, [segKey]);
    } else {
      quarantinedSegmentKeys.add(segKey);
      quarantinedPhysicalChunkIds.add(originalChunk.id);
    }
  }

  const resolveAdmissibleChunkRef = (refId: string): readonly string[] | undefined => {
    if (quarantinedPhysicalChunkIds.has(refId)) return undefined;
    const byPhysical = admissibleSegmentKeysByPhysicalChunkId.get(refId);
    if (byPhysical && byPhysical.length > 0) return byPhysical;
    if (!allPhysicalChunkIds.has(refId) && !quarantinedSegmentKeys.has(refId) && admissibleSegmentKeys.has(refId)) {
      return [refId];
    }
    return undefined;
  };

  const candidateConcepts: PedagogicalConceptNode[] = [];
  const rejectedConceptIds = new Set<string>();
  for (const concept of input.pedagogicalGraph.concepts) {
    if (
      quarantinedPhysicalChunkIds.has(concept.id)
      || quarantinedSegmentKeys.has(concept.id)
      || admissibleSegmentKeys.has(concept.id)
    ) {
      rejectedConceptIds.add(concept.id);
      continue;
    }
    if (!matchesPrivacyEpoch(concept.privacyEpoch, expectedPrivacyEpoch)) {
      rejectedConceptIds.add(concept.id);
      continue;
    }
    if ((concept.supportingSourceIds ?? []).some(srcId => !isAdmissibleSourceAndVersion(srcId))) {
      rejectedConceptIds.add(concept.id);
      continue;
    }
    if (!Array.isArray(concept.evidenceChunkIds) || concept.evidenceChunkIds.length === 0) {
      rejectedConceptIds.add(concept.id);
      continue;
    }
    const expandedEvidence: string[] = [];
    const seenEvidence = new Set<string>();
    let allResolved = true;
    for (const cid of concept.evidenceChunkIds) {
      const resolved = resolveAdmissibleChunkRef(cid);
      if (!resolved || resolved.length === 0) {
        allResolved = false;
        break;
      }
      for (const segKey of resolved) {
        if (!seenEvidence.has(segKey)) {
          seenEvidence.add(segKey);
          expandedEvidence.push(segKey);
        }
      }
    }
    if (!allResolved || expandedEvidence.length === 0) {
      rejectedConceptIds.add(concept.id);
      continue;
    }
    candidateConcepts.push({
      ...concept,
      evidenceChunkIds: expandedEvidence,
    });
  }

  const mappedConcepts: PedagogicalConceptNode[] = [];
  const survivingConceptIds = new Set<string>();
  for (const concept of candidateConcepts) {
    if (!rejectedConceptIds.has(concept.id) && !survivingConceptIds.has(concept.id)) {
      survivingConceptIds.add(concept.id);
      mappedConcepts.push(concept);
    }
  }

  const resolveEndpointTargets = (endpoint: string): readonly string[] | undefined => {
    if (survivingConceptIds.has(endpoint)) return [endpoint];
    if (rejectedConceptIds.has(endpoint)) return undefined;
    return resolveAdmissibleChunkRef(endpoint);
  };

  const mappedEdges: PedagogicalGraphEdge[] = [];
  for (const edge of input.pedagogicalGraph.edges) {
    if ((edge.kind as string) === "solves") continue;
    if (edge.visibility === "sealed") continue;
    if (edge.visibility === "hint_gated" && !allowHintGated) continue;
    if (!matchesPrivacyEpoch(edge.privacyEpoch, expectedPrivacyEpoch)) continue;
    if (edge.weight !== undefined && (!Number.isFinite(edge.weight) || edge.weight <= 0)) continue;
    if (edge.sourceId !== undefined && !isAdmissibleSourceAndVersion(edge.sourceId)) continue;
    if ((edge.supportingSourceIds ?? []).some(srcId => !isAdmissibleSourceAndVersion(srcId))) continue;

    let expandedSupportingChunks: string[] | undefined;
    if (edge.supportingChunkIds !== undefined) {
      expandedSupportingChunks = [];
      const seenSupport = new Set<string>();
      let allSupportResolved = true;
      for (const cid of edge.supportingChunkIds) {
        const resolved = resolveAdmissibleChunkRef(cid);
        if (!resolved || resolved.length === 0) {
          allSupportResolved = false;
          break;
        }
        for (const segKey of resolved) {
          if (!seenSupport.has(segKey)) {
            seenSupport.add(segKey);
            expandedSupportingChunks.push(segKey);
          }
        }
      }
      if (!allSupportResolved) continue;
    }

    const fromTargets = resolveEndpointTargets(edge.from);
    const toTargets = resolveEndpointTargets(edge.to);
    if (!fromTargets?.length || !toTargets?.length) continue;

    for (const fromId of fromTargets) {
      for (const toId of toTargets) {
        if (fromId === toId && edge.kind === "prerequisite") continue;
        mappedEdges.push({
          ...edge,
          from: fromId,
          to: toId,
          ...(expandedSupportingChunks !== undefined ? { supportingChunkIds: expandedSupportingChunks } : {}),
        });
      }
    }
  }

  const admissibleDense = dense.filter(seg => admissibleSegmentKeys.has(materialSegmentKey(seg)));
  if (mappedConcepts.length === 0 && mappedEdges.length === 0) {
    return selectAndMergeStandard(fallbackSegments, admissibleDense, input);
  }

  const admissibleLexical = admissibleSegments
    .map(segment => ({ segment, score: materialLexicalScore(input.query, segment.chunk.text) }))
    .sort((a, b) => b.score - a.score || stableSegmentOrder(a.segment, b.segment));

  const lexicalRanking: ScoredCandidate[] = admissibleLexical
    .filter(entry => entry.score > 0)
    .slice(0, 48)
    .map(entry => ({ id: materialSegmentKey(entry.segment), score: entry.score }));
  const denseRanking: ScoredCandidate[] = admissibleDense
    .slice(0, 48)
    .map((seg, idx) => ({ id: materialSegmentKey(seg), score: 1 / (60 + idx + 1) }));

  const normalizedAuthorization: PedagogicalRetrievalAuthorization = {
    admissibleSourceIds,
    ...(admissibleSourceVersions !== undefined ? { admissibleSourceVersions } : {}),
    ...(expectedPrivacyEpoch !== undefined ? { expectedPrivacyEpoch } : {}),
    allowHintGated,
    excludedItemFamilyIds,
  };

  const pedResult = rankPedagogicalEvidence({
    chunks: pedagogicalChunks,
    concepts: mappedConcepts,
    edges: mappedEdges,
    lexicalRanking,
    denseRanking,
    authorization: normalizedAuthorization,
    options: {
      maxResults: Math.max(64, pedagogicalChunks.length),
      orderFoundationsFirst: true,
    },
  });

  if (pedResult.ranked.length === 0) {
    return selectAndMergeStandard(fallbackSegments, admissibleDense, input);
  }

  const rankedItems = pedResult.ranked;
  const pedSelectionScores = new Float64Array(rankedItems.length);
  let runningMaxScore = 0;
  for (let i = rankedItems.length - 1; i >= 0; i--) {
    const score = rankedItems[i]!.combinedScore;
    if (score > runningMaxScore) runningMaxScore = score;
    pedSelectionScores[i] = runningMaxScore;
  }
  const pedByKey = new Map<string, { pedRankIndex: number; selectionScore: number }>();
  for (let i = 0; i < rankedItems.length; i++) {
    pedByKey.set(rankedItems[i]!.chunk.id, {
      pedRankIndex: i,
      selectionScore: pedSelectionScores[i]!,
    });
  }

  const preference = (segment: MaterialSegment) =>
    segment.chunk.id === input.preferChunkId ? 2
      : input.preferPage !== undefined && segment.chunk.page === input.preferPage ? 1 : 0;

  const admissibleByKey = new Map(admissibleSegments.map(seg => [materialSegmentKey(seg), seg]));
  const candidateKeys = new Set<string>();
  const pool: MaterialSegment[] = [];
  for (const item of rankedItems) {
    const seg = admissibleByKey.get(item.chunk.id);
    if (seg && !candidateKeys.has(item.chunk.id)) {
      candidateKeys.add(item.chunk.id);
      pool.push(seg);
    }
  }
  for (const seg of admissibleSegments) {
    const key = materialSegmentKey(seg);
    if (!candidateKeys.has(key) && preference(seg) > 0) {
      candidateKeys.add(key);
      pool.push(seg);
    }
  }

  const picked: MaterialSegment[] = [];
  const counts = new Map<string, number>();
  while (pool.length && picked.length < 64) {
    const score = (segment: MaterialSegment) =>
      (pedByKey.get(materialSegmentKey(segment))?.selectionScore ?? 0)
      - (counts.get(segment.chunk.sourceId) ?? 0) * 0.002;
    const rankTie = (a: MaterialSegment, b: MaterialSegment) => {
      const ra = pedByKey.get(materialSegmentKey(a))?.pedRankIndex ?? Number.MAX_SAFE_INTEGER;
      const rb = pedByKey.get(materialSegmentKey(b))?.pedRankIndex ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || stableSegmentOrder(a, b);
    };
    let best = 0;
    for (let index = 1; index < pool.length; index++) {
      const a = pool[index]!, b = pool[best]!;
      if ((preference(b) - preference(a) || score(b) - score(a) || rankTie(a, b)) < 0) best = index;
    }
    const next = pool.splice(best, 1)[0]!;
    picked.push(next);
    counts.set(next.chunk.sourceId, (counts.get(next.chunk.sourceId) ?? 0) + 1);
  }

  const pref2 = picked.filter(seg => preference(seg) === 2);
  const pref1 = picked.filter(seg => preference(seg) === 1);
  const pref0 = picked
    .filter(seg => preference(seg) === 0)
    .sort((a, b) =>
      ((pedByKey.get(materialSegmentKey(a))?.pedRankIndex ?? Number.MAX_SAFE_INTEGER)
        - (pedByKey.get(materialSegmentKey(b))?.pedRankIndex ?? Number.MAX_SAFE_INTEGER))
      || stableSegmentOrder(a, b));
  return mergePedagogicalBudgetedSegments([...pref2, ...pref1, ...pref0], input.maxCharacters);
}
