import type {
  ChunkPedagogicalDocumentInput,
  ChunkTranscriptCuesInput,
  PageSpan,
  PedagogicalAstBlock,
  PedagogicalBlockKind,
  PedagogicalChunk,
  PedagogicalChunkPartition,
  PedagogicalVisibility,
} from "./types";

interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly raw: string;
}

const DEFAULT_MAX_CHUNK_CHARS = 1200;
const DEFAULT_MAX_SEALED_CHARS = 4000;

const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "flalign",
  "flalign*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "Bmatrix",
  "Vmatrix",
  "matrix",
  "smallmatrix",
  "cases",
  "dcases",
  "rcases",
  "split",
  "array",
  "eqnarray",
  "eqnarray*",
]);

const PEDAGOGICAL_LABELS: Readonly<
  Record<string, { readonly kind: PedagogicalBlockKind; readonly visibility: PedagogicalVisibility }>
> = {
  theorem: { kind: "theorem", visibility: "public" },
  corollary: { kind: "theorem", visibility: "public" },
  proposition: { kind: "theorem", visibility: "public" },
  lemma: { kind: "lemma", visibility: "public" },
  proof: { kind: "proof", visibility: "public" },
  definition: { kind: "definition", visibility: "public" },
  def: { kind: "definition", visibility: "public" },
  remark: { kind: "definition", visibility: "public" },
  example: { kind: "example", visibility: "public" },
  "worked-example": { kind: "example", visibility: "public" },
  worked_example: { kind: "example", visibility: "public" },
  exercise: { kind: "exercise", visibility: "public" },
  problem: { kind: "exercise", visibility: "public" },
  question: { kind: "exercise", visibility: "public" },
  hint: { kind: "hint", visibility: "hint_gated" },
  "hint-gated": { kind: "hint", visibility: "hint_gated" },
  hint_gated: { kind: "hint", visibility: "hint_gated" },
  scaffold: { kind: "hint", visibility: "hint_gated" },
  solution: { kind: "solution", visibility: "sealed" },
  answer: { kind: "solution", visibility: "sealed" },
  "answer-key": { kind: "solution", visibility: "sealed" },
  answer_key: { kind: "solution", visibility: "sealed" },
  rubric: { kind: "solution", visibility: "sealed" },
  sealed: { kind: "solution", visibility: "sealed" },
  "hidden-solution": { kind: "solution", visibility: "sealed" },
  hidden_solution: { kind: "solution", visibility: "sealed" },
};

const STANDALONE_PEDAGOGICAL_KINDS = new Set<PedagogicalBlockKind>([
  "definition",
  "theorem",
  "lemma",
  "proof",
  "example",
  "exercise",
  "solution",
  "hint",
  "transcript_cue",
]);

const SEALED_HEADING_RE =
  /(?:^|\b)(?:answer\s*key|official\s*solution|solutions?|answers?|rubric|marking\s*scheme)(?:\b|$)|参考答案|标准答案|习题解答|解答与评分|答案解析/iu;
const HINT_HEADING_RE = /(?:^|\b)(?:hints?|scaffolds?)(?:\b|$)|分步提示|解题提示/iu;

function splitLinesWithOffsets(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      const contentEnd = i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i;
      lines.push({ start, contentEnd, end: i + 1, raw: text.slice(start, contentEnd) });
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push({ start, contentEnd: text.length, end: text.length, raw: text.slice(start) });
  }
  return lines;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) slashes++;
  return (slashes & 1) === 1;
}

function findUnescapedToken(text: string, token: string, fromIndex: number): number {
  let pos = text.indexOf(token, fromIndex);
  while (pos !== -1) {
    if (!isEscaped(text, pos)) return pos;
    pos = text.indexOf(token, pos + 1);
  }
  return -1;
}

const VISIBILITY_RANK: Readonly<Record<PedagogicalVisibility, number>> = {
  public: 0,
  hint_gated: 1,
  sealed: 2,
};

function maxVisibility(
  a: PedagogicalVisibility,
  b: PedagogicalVisibility,
): PedagogicalVisibility {
  return VISIBILITY_RANK[a] >= VISIBILITY_RANK[b] ? a : b;
}

function classifyLabel(
  rawLabel: string | undefined,
  fallbackVisibility: PedagogicalVisibility,
  sealProofs = false,
): { readonly kind: PedagogicalBlockKind; readonly visibility: PedagogicalVisibility } | null {
  if (!rawLabel) return null;
  const normalized = rawLabel.trim().replace(/\*$/, "").toLowerCase();
  const entry = PEDAGOGICAL_LABELS[normalized];
  if (!entry) return null;
  const baseVisibility: PedagogicalVisibility =
    sealProofs && entry.kind === "proof" ? "sealed" : entry.visibility;
  return { kind: entry.kind, visibility: maxVisibility(baseVisibility, fallbackVisibility) };
}

function isTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|");
  if (cells.length === 0) return false;
  return cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function parseTimestampToMs(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secParts = parts[parts.length - 1]!.split(".");
  const seconds = Number(secParts[0]);
  const fracRaw = secParts[1] ?? "0";
  if (!/^\d+$/.test(secParts[0]!) || !/^\d{1,3}$/.test(fracRaw)) return null;
  const millis = Number(fracRaw.padEnd(3, "0"));
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (
    !Number.isSafeInteger(hours) ||
    !Number.isSafeInteger(minutes) ||
    !Number.isSafeInteger(seconds) ||
    !Number.isSafeInteger(millis) ||
    hours < 0 ||
    minutes < 0 ||
    minutes >= 60 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return null;
  }
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

function parseInlineTranscriptCue(line: string): { startMs: number; endMs: number } | null {
  const msMatch = /^[ \t]*\[startMs=(\d+),\s*endMs=(\d+)\]/.exec(line);
  if (msMatch) {
    const startMs = Number(msMatch[1]);
    const endMs = Number(msMatch[2]);
    if (Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && startMs >= 0 && endMs >= startMs) {
      return { startMs, endMs };
    }
    return null;
  }
  const clockMatch =
    /^[ \t]*\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*(?:-|–|—|->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\]/.exec(
      line,
    );
  if (!clockMatch) return null;
  const startMs = parseTimestampToMs(clockMatch[1]!);
  const endMs = parseTimestampToMs(clockMatch[2]!);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return { startMs, endMs };
}

function resolvePageRange(
  startOffset: number,
  endOffset: number,
  pageSpans?: readonly PageSpan[],
): { pageStart: number | null; pageEnd: number | null } {
  if (!pageSpans?.length) return { pageStart: null, pageEnd: null };
  let pageStart: number | null = null;
  let pageEnd: number | null = null;
  for (const span of pageSpans) {
    if (span.endOffset <= startOffset || span.startOffset >= endOffset) continue;
    if (pageStart === null || span.page < pageStart) pageStart = span.page;
    if (pageEnd === null || span.page > pageEnd) pageEnd = span.page;
  }
  return { pageStart, pageEnd };
}

function findMatchingLatexEnvBounds(
  text: string,
  envName: string,
  searchFrom: number,
): { readonly closeStart: number; readonly closeEnd: number } {
  const tokenRe = /\\(begin|end)\{([a-zA-Z][\w-]*\*?)\}/g;
  tokenRe.lastIndex = searchFrom;
  const stack: string[] = [envName];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    if (isEscaped(text, match.index)) continue;
    const directive = match[1]!;
    const name = match[2]!;
    if (directive === "begin") {
      stack.push(name);
    } else if (stack.length > 0 && stack[stack.length - 1] === name) {
      stack.pop();
      if (stack.length === 0) {
        return { closeStart: match.index, closeEnd: match.index + match[0].length };
      }
    }
  }
  return { closeStart: text.length, closeEnd: text.length };
}

function lineIndexContaining(lines: readonly SourceLine[], offset: number, startHint: number): number {
  let idx = startHint;
  while (idx + 1 < lines.length && lines[idx]!.end <= offset) idx++;
  return idx;
}

function startsSpecialBlock(lines: readonly SourceLine[], index: number): boolean {
  const raw = lines[index]!.raw;
  if (/^\s*$/.test(raw)) return true;
  if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(raw)) return true;
  if (/^[ \t]{0,3}:{3,}[ \t]*[a-zA-Z]/.test(raw)) return true;
  const latexEnv = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(raw);
  if (latexEnv) {
    const env = latexEnv[1]!;
    if (MATH_ENVS.has(env) || classifyLabel(env, "public") !== null) return true;
  }
  if (/^[ \t]*\$\$/.test(raw) && !isEscaped(raw, raw.indexOf("$$"))) return true;
  if (/^[ \t]*\\\[/.test(raw)) return true;
  if (/^[ \t]*>/.test(raw)) return true;
  if (/^[ \t]{0,3}#{1,6}[ \t]+/.test(raw)) return true;
  if (raw.includes("|") && index + 1 < lines.length && isTableDelimiterRow(lines[index + 1]!.raw)) {
    return true;
  }
  if (parseInlineTranscriptCue(raw) !== null) return true;
  return false;
}

interface InlineConstructSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label?: string;
  readonly openEnd?: number;
  readonly closeStart?: number;
}

function findInlineDisplayMathSpans(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  activeVisibility: PedagogicalVisibility,
  sealProofs: boolean,
): InlineConstructSpan[] {
  const spans: InlineConstructSpan[] = [];
  let i = rangeStart;
  while (i < rangeEnd) {
    if (text.startsWith("$$", i) && !isEscaped(text, i)) {
      const close = findUnescapedToken(text, "$$", i + 2);
      const end = close !== -1 ? close + 2 : text.length;
      spans.push({ start: i, end, kind: "display_math", visibility: activeVisibility });
      i = end;
      continue;
    }
    if (text.startsWith("\\[", i) && !isEscaped(text, i)) {
      const close = findUnescapedToken(text, "\\]", i + 2);
      const end = close !== -1 ? close + 2 : text.length;
      spans.push({ start: i, end, kind: "display_math", visibility: activeVisibility });
      i = end;
      continue;
    }
    if (text.startsWith("\\begin{", i) && !isEscaped(text, i)) {
      const m = /^\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(text.slice(i));
      if (m) {
        const envName = m[1]!;
        const isMath = MATH_ENVS.has(envName);
        const classified = isMath
          ? { kind: "display_math" as const, visibility: activeVisibility }
          : classifyLabel(envName, activeVisibility, sealProofs);
        if (classified) {
          const openEnd = i + m[0].length;
          const bounds = findMatchingLatexEnvBounds(text, envName, openEnd);
          spans.push({
            start: i,
            end: bounds.closeEnd,
            kind: classified.kind,
            visibility: classified.visibility,
            label: envName,
            ...(isMath ? {} : { openEnd, closeStart: bounds.closeStart }),
          });
          i = bounds.closeEnd;
          continue;
        }
      }
    }
    i++;
  }
  return spans;
}

interface MappedInnerBlock {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly atomicConstruct: boolean;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly label?: string;
}

function trimWhitespaceBounds(
  text: string,
  start: number,
  end: number,
  isBlockquote: boolean,
): { readonly start: number; readonly end: number } | null {
  let s = start;
  let e = end;
  if (isBlockquote) {
    while (s < e) {
      const nl = text.indexOf("\n", s);
      const lineContentEnd = nl === -1 || nl >= e ? e : nl;
      const lineNext = nl === -1 || nl >= e ? e : nl + 1;
      const lineSlice = text.slice(s, lineContentEnd).replace(/\r$/, "");
      if (/^[ \t]*(?:>[ \t]*)*$/.test(lineSlice)) {
        s = lineNext;
      } else {
        break;
      }
    }
    while (e > s) {
      const prevNl = text.lastIndexOf("\n", e - 1);
      const lineStart = prevNl < s ? s : prevNl + 1;
      const lineSlice = text.slice(lineStart, e).replace(/\r$/, "");
      if (/^[ \t]*(?:>[ \t]*)*$/.test(lineSlice)) {
        e = prevNl < s ? s : prevNl;
        if (e > s && text.charCodeAt(e - 1) === 13) e--;
      } else {
        break;
      }
    }
  }
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return s < e ? { start: s, end: e } : null;
}

function parseBlockquoteInnerBlocks(
  lines: readonly SourceLine[],
  startLineIdx: number,
  endLineIdx: number,
  firstLineSliceStart: number | null,
  outerVisibility: PedagogicalVisibility,
  propagateSectionVisibility: boolean,
  innerSealProofs: boolean,
): MappedInnerBlock[] {
  const bodyParts: string[] = [];
  const charOrigStart: number[] = [];
  const charOrigEnd: number[] = [];
  const vLineToOrigLine = new Map<number, SourceLine>();
  let vCursor = 0;

  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const curLine = lines[idx]!;
    let prefixLen: number;
    if (idx === startLineIdx && firstLineSliceStart !== null) {
      prefixLen = firstLineSliceStart - curLine.start;
    } else {
      const stripMatch = /^[ \t]*>[ \t]?/.exec(curLine.raw);
      prefixLen = stripMatch ? stripMatch[0].length : 0;
    }
    const stripped = curLine.raw.slice(prefixLen);
    if (!(idx === startLineIdx && firstLineSliceStart !== null)) {
      vLineToOrigLine.set(vCursor, curLine);
    }
    for (let c = 0; c < stripped.length; c++) {
      charOrigStart.push(curLine.start + prefixLen + c);
      charOrigEnd.push(curLine.start + prefixLen + c + 1);
    }
    bodyParts.push(stripped);
    vCursor += stripped.length;

    if (idx < endLineIdx) {
      bodyParts.push("\n");
      charOrigStart.push(curLine.contentEnd);
      charOrigEnd.push(curLine.end);
      vCursor += 1;
    }
  }

  const virtualText = bodyParts.join("");
  if (!virtualText.trim()) return [];

  const innerAst = parsePedagogicalAstInternal(
    virtualText,
    {
      defaultVisibility: outerVisibility,
      propagateSectionVisibility,
    },
    innerSealProofs,
  );

  return innerAst.map(b => {
    const snappedLine = vLineToOrigLine.get(b.startOffset);
    const startOffset = snappedLine ? snappedLine.start : charOrigStart[b.startOffset]!;
    const endOffset = charOrigEnd[b.endOffset - 1]!;
    return {
      kind: b.kind,
      visibility: b.visibility,
      atomicConstruct: b.atomicConstruct,
      startOffset,
      endOffset,
      startMs: b.startMs,
      endMs: b.endMs,
      ...(b.label ? { label: b.label } : {}),
    };
  });
}

/**
 * Parse a pedagogical document into an AST of blocks where indivisible
 * constructs (display math, theorem/lemma/proof/definition/example/solution
 * blocks, fenced code, Markdown pipe tables, and timestamped cues) are sealed
 * BEFORE chunk sizing or indexing.
 */
export function parsePedagogicalAst(
  text: string,
  options: {
    readonly pageSpans?: readonly PageSpan[];
    readonly defaultVisibility?: PedagogicalVisibility;
    readonly propagateSectionVisibility?: boolean;
  } = {},
): PedagogicalAstBlock[] {
  return parsePedagogicalAstInternal(text, options, false);
}

function parsePedagogicalAstInternal(
  text: string,
  options: {
    readonly pageSpans?: readonly PageSpan[];
    readonly defaultVisibility?: PedagogicalVisibility;
    readonly propagateSectionVisibility?: boolean;
  },
  sealProofs: boolean,
): PedagogicalAstBlock[] {
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  const lines = splitLinesWithOffsets(text);
  const blocks: PedagogicalAstBlock[] = [];
  const headingStack: Array<{ readonly level: number; readonly visibility: PedagogicalVisibility }> = [];
  const getActiveSectionVisibility = (): PedagogicalVisibility =>
    headingStack.length > 0 ? headingStack[headingStack.length - 1]!.visibility : defaultVisibility;

  const pushBlock = (
    kind: PedagogicalBlockKind,
    visibility: PedagogicalVisibility,
    atomicConstruct: boolean,
    startOffset: number,
    endOffset: number,
    extra: { startMs?: number | null; endMs?: number | null; label?: string } = {},
  ) => {
    if (endOffset <= startOffset) return;
    const { pageStart, pageEnd } = resolvePageRange(startOffset, endOffset, options.pageSpans);
    blocks.push({
      kind,
      visibility,
      atomicConstruct,
      text: text.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      pageStart,
      pageEnd,
      startMs: extra.startMs ?? null,
      endMs: extra.endMs ?? null,
      keyframeChunkId: null,
      ...(extra.label ? { label: extra.label } : {}),
    });
  };

  const emitContainerWithExtraction = (
    outerKind: PedagogicalBlockKind,
    outerVisibility: PedagogicalVisibility,
    outerAtomic: boolean,
    outerStart: number,
    outerEnd: number,
    bodyEnd: number,
    outerLabel: string | undefined,
    isBlockquote: boolean,
    innerBlocks: readonly MappedInnerBlock[],
  ) => {
    const higherBlocks = innerBlocks.filter(
      b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[outerVisibility],
    );
    if (higherBlocks.length === 0) {
      pushBlock(outerKind, outerVisibility, outerAtomic, outerStart, outerEnd, {
        ...(outerLabel ? { label: outerLabel } : {}),
      });
      return;
    }

    const firstHigher = higherBlocks[0]!;
    const prefix = trimWhitespaceBounds(text, outerStart, firstHigher.startOffset, isBlockquote);
    if (prefix) {
      pushBlock(outerKind, outerVisibility, outerAtomic, prefix.start, prefix.end, {
        ...(outerLabel ? { label: outerLabel } : {}),
      });
    }

    for (let k = 0; k < higherBlocks.length; k++) {
      const cur = higherBlocks[k]!;
      pushBlock(cur.kind, cur.visibility, cur.atomicConstruct, cur.startOffset, cur.endOffset, {
        startMs: cur.startMs,
        endMs: cur.endMs,
        ...(cur.label ? { label: cur.label } : {}),
      });
      if (k + 1 < higherBlocks.length) {
        const next = higherBlocks[k + 1]!;
        const gap = trimWhitespaceBounds(text, cur.endOffset, next.startOffset, isBlockquote);
        if (gap) {
          pushBlock(outerKind, outerVisibility, outerAtomic, gap.start, gap.end, {
            ...(outerLabel ? { label: outerLabel } : {}),
          });
        }
      }
    }

    const lastHigher = higherBlocks[higherBlocks.length - 1]!;
    const bodyTail = trimWhitespaceBounds(text, lastHigher.endOffset, bodyEnd, isBlockquote);
    if (bodyTail) {
      const fullTail = trimWhitespaceBounds(text, bodyTail.start, outerEnd, isBlockquote);
      if (fullTail) {
        pushBlock(outerKind, outerVisibility, outerAtomic, fullTail.start, fullTail.end, {
          ...(outerLabel ? { label: outerLabel } : {}),
        });
      }
    }
  };

  const emitInlineConstructsRange = (
    rangeStart: number,
    rangeEnd: number,
    activeVis: PedagogicalVisibility,
    startLineIdx: number,
    defaultNextLineIdx: number,
  ): number => {
    const inlineSpans = findInlineDisplayMathSpans(text, rangeStart, rangeEnd, activeVis, sealProofs);
    if (inlineSpans.length === 0) {
      const proseBounds = trimWhitespaceBounds(text, rangeStart, rangeEnd, false);
      if (proseBounds) {
        pushBlock("prose", activeVis, false, proseBounds.start, proseBounds.end);
      }
      return defaultNextLineIdx;
    }

    let cursor = rangeStart;
    for (const span of inlineSpans) {
      if (span.start > cursor) {
        const proseBounds = trimWhitespaceBounds(text, cursor, span.start, false);
        if (proseBounds) {
          pushBlock("prose", activeVis, false, proseBounds.start, proseBounds.end);
        }
      }
      if (
        span.openEnd !== undefined &&
        span.closeStart !== undefined &&
        span.visibility !== "sealed" &&
        span.closeStart > span.openEnd
      ) {
        const innerBlocks = parsePedagogicalAstInternal(
          text.slice(span.openEnd, span.closeStart),
          {
            defaultVisibility: span.visibility,
            propagateSectionVisibility,
          },
          span.kind === "exercise",
        ).map(b => ({
          ...b,
          startOffset: span.openEnd! + b.startOffset,
          endOffset: span.openEnd! + b.endOffset,
        }));
        emitContainerWithExtraction(
          span.kind,
          span.visibility,
          true,
          span.start,
          span.end,
          span.closeStart,
          span.label,
          false,
          innerBlocks,
        );
      } else {
        pushBlock(span.kind, span.visibility, true, span.start, span.end, {
          ...(span.label ? { label: span.label } : {}),
        });
      }
      cursor = span.end;
    }

    if (cursor > rangeEnd) {
      const endLineIdx = lineIndexContaining(lines, Math.max(rangeStart, cursor - 1), startLineIdx);
      const closeLine = lines[endLineIdx]!;
      const trailingOnCloseLine = text.slice(cursor, closeLine.contentEnd);
      if (!/^[ \t]*$/.test(trailingOnCloseLine)) {
        lines[endLineIdx] = {
          start: cursor,
          contentEnd: closeLine.contentEnd,
          end: closeLine.end,
          raw: trailingOnCloseLine,
        };
        return endLineIdx;
      }
      return endLineIdx + 1;
    }

    if (cursor < rangeEnd) {
      const tailBounds = trimWhitespaceBounds(text, cursor, rangeEnd, false);
      if (tailBounds) {
        pushBlock("prose", activeVis, false, tailBounds.start, tailBounds.end);
      }
    }
    return defaultNextLineIdx;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const raw = line.raw;

    if (/^\s*$/.test(raw)) {
      i++;
      continue;
    }

    // 1. Heading (and monotonic heading-stack section visibility propagation)
    const headingMatch = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*$/.exec(raw);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const headingText = headingMatch[2]!.trim();
      if (propagateSectionVisibility) {
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop();
        }
        const parentVisibility =
          headingStack.length > 0 ? headingStack[headingStack.length - 1]!.visibility : defaultVisibility;
        const ownVisibility: PedagogicalVisibility = SEALED_HEADING_RE.test(headingText)
          ? "sealed"
          : HINT_HEADING_RE.test(headingText)
            ? "hint_gated"
            : defaultVisibility;
        headingStack.push({
          level,
          visibility: maxVisibility(parentVisibility, ownVisibility),
        });
      }
      pushBlock("heading", getActiveSectionVisibility(), false, line.start, line.contentEnd, {
        label: headingText,
      });
      i++;
      continue;
    }

    // 2. Fenced code block (``` or ~~~)
    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fenceMatch && !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))) {
      const fenceChar = fenceMatch[1]![0]!;
      const fenceLen = fenceMatch[1]!.length;
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j]!.raw)) j++;
      const endLineIdx = j < lines.length ? j : lines.length - 1;
      pushBlock("code", getActiveSectionVisibility(), true, line.start, lines[endLineIdx]!.contentEnd);
      i = endLineIdx + 1;
      continue;
    }

    // 3. Fenced pedagogical container (:::theorem ... :::)
    const containerMatch = /^[ \t]{0,3}(:{3,})[ \t]*([a-zA-Z][\w-]*)(.*)$/.exec(raw);
    if (containerMatch) {
      const activeVis = getActiveSectionVisibility();
      const classified = classifyLabel(containerMatch[2], activeVis, sealProofs);
      if (classified) {
        const colonStack: number[] = [containerMatch[1]!.length];
        const openRe = /^[ \t]{0,3}(:{3,})[ \t]*[a-zA-Z][\w-]*/;
        const closeRe = /^[ \t]{0,3}(:{3,})[ \t]*$/;
        let inCodeFenceChar: string | null = null;
        let inCodeFenceLen = 0;
        let j = i + 1;
        while (j < lines.length && colonStack.length > 0) {
          const cur = lines[j]!.raw;
          if (inCodeFenceChar) {
            const codeClose = new RegExp(`^[ \\t]{0,3}${inCodeFenceChar}{${inCodeFenceLen},}[ \\t]*$`);
            if (codeClose.test(cur)) inCodeFenceChar = null;
          } else {
            const innerCode = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(cur);
            if (innerCode && !(innerCode[1]![0] === "`" && innerCode[2]!.includes("`"))) {
              inCodeFenceChar = innerCode[1]![0]!;
              inCodeFenceLen = innerCode[1]!.length;
            } else {
              const innerOpen = openRe.exec(cur);
              if (innerOpen) {
                colonStack.push(innerOpen[1]!.length);
              } else {
                const innerClose = closeRe.exec(cur);
                if (innerClose && innerClose[1]!.length >= colonStack[colonStack.length - 1]!) {
                  colonStack.pop();
                  if (colonStack.length === 0) break;
                }
              }
            }
          }
          j++;
        }
        const closed = j < lines.length && colonStack.length === 0;
        const endLineIdx = closed ? j : lines.length - 1;
        const label = containerMatch[3]!.trim() || containerMatch[2]!;
        const outerStart = line.start;
        const outerEnd = lines[endLineIdx]!.contentEnd;
        const headerRestStart = line.start + containerMatch[0].length - containerMatch[3]!.length;
        const bodyEnd = closed
          ? endLineIdx > i + 1
            ? lines[endLineIdx - 1]!.contentEnd
            : line.contentEnd
          : outerEnd;

        if (classified.visibility !== "sealed" && bodyEnd > headerRestStart) {
          const innerBlocks = parsePedagogicalAstInternal(
            text.slice(headerRestStart, bodyEnd),
            {
              defaultVisibility: classified.visibility,
              propagateSectionVisibility,
            },
            classified.kind === "exercise",
          ).map(b => ({
            ...b,
            startOffset: headerRestStart + b.startOffset,
            endOffset: headerRestStart + b.endOffset,
          }));
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            outerStart,
            outerEnd,
            bodyEnd,
            label,
            false,
            innerBlocks,
          );
        } else {
          pushBlock(classified.kind, classified.visibility, true, outerStart, outerEnd, { label });
        }
        i = endLineIdx + 1;
        continue;
      }
    }

    // 4. LaTeX environment (\begin{equation|align|theorem|lemma|proof|definition|solution}...)
    const envMatch = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(raw);
    if (envMatch) {
      const envName = envMatch[1]!;
      const activeVis = getActiveSectionVisibility();
      const isMath = MATH_ENVS.has(envName);
      const classified = isMath
        ? { kind: "display_math" as const, visibility: activeVis }
        : classifyLabel(envName, activeVis, sealProofs);
      if (classified) {
        const leadingWs = envMatch[0].length - envMatch[0].trimStart().length;
        const envStart = line.start + leadingWs;
        const openEndOffset = line.start + envMatch[0].length;
        const { closeStart, closeEnd } = findMatchingLatexEnvBounds(text, envName, openEndOffset);
        const endLineIdx = lineIndexContaining(lines, Math.max(envStart, closeEnd - 1), i);
        const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
        const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
        const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

        if (!isMath && classified.visibility !== "sealed" && closeStart > openEndOffset) {
          const innerBlocks = parsePedagogicalAstInternal(
            text.slice(openEndOffset, closeStart),
            {
              defaultVisibility: classified.visibility,
              propagateSectionVisibility,
            },
            classified.kind === "exercise",
          ).map(b => ({
            ...b,
            startOffset: openEndOffset + b.startOffset,
            endOffset: openEndOffset + b.endOffset,
          }));
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            envStart,
            outerEnd,
            closeStart,
            envName,
            false,
            innerBlocks,
          );
        } else {
          pushBlock(classified.kind, classified.visibility, true, envStart, outerEnd, {
            label: envName,
          });
        }

        if (hasTrailingContent) {
          const closeLine = lines[endLineIdx]!;
          lines[endLineIdx] = {
            start: closeEnd,
            contentEnd: closeLine.contentEnd,
            end: closeLine.end,
            raw: trailingOnCloseLine,
          };
          i = endLineIdx;
        } else {
          i = endLineIdx + 1;
        }
        continue;
      }
    }

    // 5. Display math ($$...$$)
    const ddMatch = /^[ \t]*\$\$/.exec(raw);
    if (ddMatch) {
      const leadingWs = ddMatch[0].length - ddMatch[0].trimStart().length;
      const startOffset = line.start + leadingWs;
      const afterOpen = line.start + ddMatch[0].length;
      const closeOffset = findUnescapedToken(text, "$$", afterOpen);
      const activeVis = getActiveSectionVisibility();
      if (closeOffset !== -1) {
        const closeEnd = closeOffset + 2;
        const endLineIdx = lineIndexContaining(lines, closeOffset + 1, i);
        const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
        const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
        const endOffset = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);
        pushBlock("display_math", activeVis, true, startOffset, endOffset);
        if (hasTrailingContent) {
          const closeLine = lines[endLineIdx]!;
          lines[endLineIdx] = {
            start: closeEnd,
            contentEnd: closeLine.contentEnd,
            end: closeLine.end,
            raw: trailingOnCloseLine,
          };
          i = endLineIdx;
        } else {
          i = endLineIdx + 1;
        }
      } else {
        pushBlock("display_math", activeVis, true, startOffset, text.length);
        i = lines.length;
      }
      continue;
    }

    // 6. LaTeX bracket display math (\[...\])
    const bracketMatch = /^[ \t]*\\\[/.exec(raw);
    if (bracketMatch) {
      const leadingWs = bracketMatch[0].length - bracketMatch[0].trimStart().length;
      const startOffset = line.start + leadingWs;
      const afterOpen = line.start + bracketMatch[0].length;
      const closeOffset = findUnescapedToken(text, "\\]", afterOpen);
      const activeVis = getActiveSectionVisibility();
      if (closeOffset !== -1) {
        const closeEnd = closeOffset + 2;
        const endLineIdx = lineIndexContaining(lines, closeOffset + 1, i);
        const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
        const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
        const endOffset = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);
        pushBlock("display_math", activeVis, true, startOffset, endOffset);
        if (hasTrailingContent) {
          const closeLine = lines[endLineIdx]!;
          lines[endLineIdx] = {
            start: closeEnd,
            contentEnd: closeLine.contentEnd,
            end: closeLine.end,
            raw: trailingOnCloseLine,
          };
          i = endLineIdx;
        } else {
          i = endLineIdx + 1;
        }
      } else {
        pushBlock("display_math", activeVis, true, startOffset, text.length);
        i = lines.length;
      }
      continue;
    }

    // 7. Markdown callout (> [!theorem], > [!proof], > [!solution], ...) and blockquotes
    const calloutRe = /^[ \t]*>[ \t]*\[!([a-zA-Z_-]+)\][+-]?(.*)$/;
    const calloutMatch = calloutRe.exec(raw);
    if (calloutMatch) {
      const activeVis = getActiveSectionVisibility();
      const classified = classifyLabel(calloutMatch[1], activeVis, sealProofs);
      if (classified) {
        let j = i + 1;
        while (j < lines.length && /^[ \t]*>/.test(lines[j]!.raw)) {
          const nextCallout = calloutRe.exec(lines[j]!.raw);
          if (nextCallout) {
            const nextClassified = classifyLabel(nextCallout[1], activeVis, sealProofs);
            if (
              nextClassified &&
              VISIBILITY_RANK[nextClassified.visibility] > VISIBILITY_RANK[classified.visibility]
            ) {
              break;
            }
          }
          j++;
        }
        let endLineIdx = j - 1;
        while (endLineIdx > i && /^[ \t]*>[ \t]*$/.test(lines[endLineIdx]!.raw)) {
          endLineIdx--;
        }
        const label = calloutMatch[2]!.trim() || calloutMatch[1]!;
        const outerStart = line.start;
        const outerEnd = lines[endLineIdx]!.contentEnd;

        if (classified.visibility !== "sealed") {
          const headerRestStart = line.start + calloutMatch[0].length - calloutMatch[2]!.length;
          const innerBlocks = parseBlockquoteInnerBlocks(
            lines,
            i,
            endLineIdx,
            headerRestStart,
            classified.visibility,
            propagateSectionVisibility,
            classified.kind === "exercise",
          );
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            outerStart,
            outerEnd,
            outerEnd,
            label,
            true,
            innerBlocks,
          );
        } else {
          pushBlock(classified.kind, classified.visibility, true, outerStart, outerEnd, { label });
        }
        i = j;
        continue;
      }
    }

    if (/^[ \t]*>/.test(raw)) {
      const activeVis = getActiveSectionVisibility();
      let j = i + 1;
      while (j < lines.length && /^[ \t]*>/.test(lines[j]!.raw)) {
        const nextCallout = calloutRe.exec(lines[j]!.raw);
        if (nextCallout && classifyLabel(nextCallout[1], activeVis, sealProofs) !== null) {
          break;
        }
        j++;
      }
      let endLineIdx = j - 1;
      while (endLineIdx > i && /^[ \t]*>[ \t]*$/.test(lines[endLineIdx]!.raw)) {
        endLineIdx--;
      }
      const outerStart = line.start;
      const outerEnd = lines[endLineIdx]!.contentEnd;

      if (activeVis !== "sealed") {
        const innerBlocks = parseBlockquoteInnerBlocks(
          lines,
          i,
          endLineIdx,
          null,
          activeVis,
          propagateSectionVisibility,
          sealProofs,
        );
        if (innerBlocks.some(b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[activeVis])) {
          emitContainerWithExtraction(
            "prose",
            activeVis,
            false,
            outerStart,
            outerEnd,
            outerEnd,
            undefined,
            true,
            innerBlocks,
          );
          i = j;
          continue;
        }
      }
      i = emitInlineConstructsRange(outerStart, outerEnd, activeVis, i, j);
      continue;
    }

    // 8. Markdown / pipe table
    if (raw.includes("|") && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1]!.raw)) {
      let j = i + 2;
      while (
        j < lines.length &&
        !/^\s*$/.test(lines[j]!.raw) &&
        lines[j]!.raw.includes("|") &&
        !/^[ \t]{0,3}(`{3,}|~{3,}|:{3,}|#{1,6}[ \t])/.test(lines[j]!.raw)
      ) {
        j++;
      }
      const endLineIdx = j - 1;
      pushBlock("table", getActiveSectionVisibility(), true, line.start, lines[endLineIdx]!.contentEnd);
      i = j;
      continue;
    }

    // 9. Inline timestamped transcript cue line
    const cueTiming = parseInlineTranscriptCue(raw);
    if (cueTiming) {
      pushBlock("transcript_cue", getActiveSectionVisibility(), true, line.start, line.contentEnd, {
        startMs: cueTiming.startMs,
        endMs: cueTiming.endMs,
      });
      i++;
      continue;
    }

    // 10. Prose paragraph (with embedded inline display-math & pedagogical-env protection)
    let j = i + 1;
    while (j < lines.length && !startsSpecialBlock(lines, j)) j++;
    const paraStart = line.start;
    const paraEnd = lines[j - 1]!.contentEnd;
    i = emitInlineConstructsRange(paraStart, paraEnd, getActiveSectionVisibility(), i, j);
  }

  return blocks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function adjustAwayFromSurrogateAndLatex(text: string, minStart: number, candidate: number): number {
  let pos = candidate;

  // Never split between a UTF-16 high surrogate and low surrogate.
  if (
    pos > minStart &&
    pos < text.length &&
    isHighSurrogate(text.charCodeAt(pos - 1)) &&
    isLowSurrogate(text.charCodeAt(pos))
  ) {
    pos--;
  }

  // Never split in the middle of a LaTeX control sequence (\command or escaped single char).
  if (pos > minStart && pos < text.length) {
    let scan = pos;
    // Walk backwards across ASCII letters belonging to a LaTeX command name.
    while (scan > minStart && /[a-zA-Z]/.test(text[scan - 1]!)) scan--;
    if (scan > minStart && text.charCodeAt(scan - 1) === 92 && !isEscaped(text, scan - 1)) {
      const backslashPos = scan - 1;
      if (backslashPos > minStart) {
        pos = backslashPos;
      } else {
        // Command starts right at minStart and exceeds the window: keep the command intact.
        while (pos < text.length && /[a-zA-Z]/.test(text[pos]!)) pos++;
      }
    } else if (text.charCodeAt(pos - 1) === 92 && !isEscaped(text, pos - 1)) {
      // candidate landed immediately after an unescaped backslash (e.g., `\|{` or `\|\\`).
      if (pos - 1 > minStart) {
        pos = pos - 1;
      } else if (pos < text.length) {
        pos++;
      }
    }
  }

  // Re-verify surrogate boundary after any LaTeX backoff.
  if (
    pos > minStart &&
    pos < text.length &&
    isHighSurrogate(text.charCodeAt(pos - 1)) &&
    isLowSurrogate(text.charCodeAt(pos))
  ) {
    pos--;
  }

  // Guarantee strictly forward progress while still respecting UTF-16 surrogate integrity.
  if (pos <= minStart) {
    pos = Math.min(text.length, minStart + 1);
    if (pos < text.length && isHighSurrogate(text.charCodeAt(pos - 1)) && isLowSurrogate(text.charCodeAt(pos))) {
      pos++;
    }
  }

  return pos;
}

/**
 * Deterministically sub-split an oversized block (> maxChars) while NEVER
 * slicing mid-UTF-16 surrogate pair or mid-LaTeX command.
 */
export function safeSubsplitText(
  text: string,
  maxChars: number,
): Array<{ readonly start: number; readonly end: number; readonly text: string }> {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) {
    throw new RangeError("maxChars must be a safe integer >= 2");
  }
  if (text.length <= maxChars) {
    return [{ start: 0, end: text.length, text }];
  }

  const parts: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= maxChars) {
      parts.push({ start, end: text.length, text: text.slice(start) });
      break;
    }

    const limit = start + maxChars;
    const minBreak = start + Math.max(1, Math.floor(maxChars * 0.25));
    const windowText = text.slice(start, limit);
    let cut = -1;

    // 1. Paragraph break
    const paraBreak = windowText.lastIndexOf("\n\n");
    if (paraBreak >= minBreak - start) cut = start + paraBreak + 2;

    // 2. LaTeX row break (\\ followed by newline)
    if (cut === -1) {
      const latexRowBreak = windowText.lastIndexOf("\\\\\n");
      if (latexRowBreak >= minBreak - start) cut = start + latexRowBreak + 3;
    }

    // 3. Line break
    if (cut === -1) {
      const lineBreak = windowText.lastIndexOf("\n");
      if (lineBreak >= minBreak - start) cut = start + lineBreak + 1;
    }

    // 4. Sentence / whitespace boundary
    if (cut === -1) {
      for (let i = limit - 1; i >= minBreak; i--) {
        const ch = text[i]!;
        if (ch === " " || ch === "\t" || ch === "。" || ch === "；" || ch === ";" || ch === ".") {
          cut = i + 1;
          break;
        }
      }
    }

    const safeCut = adjustAwayFromSurrogateAndLatex(text, start, cut === -1 ? limit : cut);
    parts.push({ start, end: safeCut, text: text.slice(start, safeCut) });
    start = safeCut;
  }

  return parts;
}

function canPackBlocks(
  current: readonly PedagogicalAstBlock[],
  next: PedagogicalAstBlock,
  maxChunkChars: number,
): boolean {
  if (current.length === 0) return true;
  const first = current[0]!;
  const last = current[current.length - 1]!;

  // Never mix visibilities in a single chunk.
  if (first.visibility !== next.visibility) return false;

  // Never merge distinct media timestamp ranges.
  if (last.startMs !== null || next.startMs !== null) return false;

  // Keep standalone pedagogical constructs separate so definitions/theorems/proofs
  // retain independent retrieval & topological ordering identity.
  if (STANDALONE_PEDAGOGICAL_KINDS.has(next.kind)) return false;
  if (current.some(b => STANDALONE_PEDAGOGICAL_KINDS.has(b.kind))) return false;

  // Check exact span length including original intervening characters.
  const combinedLength = next.endOffset - first.startOffset;
  return combinedLength <= maxChunkChars;
}

function dominantBlockKind(blocks: readonly PedagogicalAstBlock[]): PedagogicalBlockKind {
  if (blocks.length === 1) return blocks[0]!.kind;
  const priority: readonly PedagogicalBlockKind[] = [
    "solution",
    "hint",
    "theorem",
    "lemma",
    "proof",
    "definition",
    "example",
    "exercise",
    "display_math",
    "table",
    "code",
    "transcript_cue",
    "heading",
    "prose",
  ];
  for (const kind of priority) {
    if (blocks.some(b => b.kind === kind)) return kind;
  }
  return blocks[0]!.kind;
}

/**
 * Chunk a pedagogical document after AST pre-split so boundaries never slice
 * inside indivisible math, theorem/proof/definition/example/solution, code,
 * table, or timestamped cue constructs (unless exceeding `maxSealedChars`).
 */
export function chunkPedagogicalDocument(input: ChunkPedagogicalDocumentInput): PedagogicalChunk[] {
  const maxChunkChars = input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const maxSealedChars = input.maxSealedChars ?? Math.max(DEFAULT_MAX_SEALED_CHARS, maxChunkChars);
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 2) {
    throw new RangeError("maxChunkChars must be a safe integer >= 2");
  }
  if (!Number.isSafeInteger(maxSealedChars) || maxSealedChars < maxChunkChars) {
    throw new RangeError("maxSealedChars must be a safe integer >= maxChunkChars");
  }
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0) {
    throw new RangeError("sourceVersion must be a non-negative safe integer");
  }

  const astBlocks = parsePedagogicalAst(input.text, {
    pageSpans: input.pageSpans,
    defaultVisibility: input.defaultVisibility,
    propagateSectionVisibility: input.propagateSectionVisibility,
  });

  const chunks: PedagogicalChunk[] = [];
  let seq = 0;

  const emitChunk = (params: {
    kind: PedagogicalBlockKind;
    constructKinds: readonly PedagogicalBlockKind[];
    visibility: PedagogicalVisibility;
    atomicConstruct: boolean;
    startOffset: number;
    endOffset: number;
    startMs: number | null;
    endMs: number | null;
    keyframeChunkId: string | null;
    oversizedSplit: boolean;
    label?: string;
  }) => {
    const { pageStart, pageEnd } = resolvePageRange(params.startOffset, params.endOffset, input.pageSpans);
    chunks.push({
      id: `${input.sourceId}:v${input.sourceVersion}:c${seq++}`,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      ...(input.privacyEpoch !== undefined ? { privacyEpoch: input.privacyEpoch } : {}),
      kind: params.kind,
      constructKinds: params.constructKinds,
      visibility: params.visibility,
      atomicConstruct: params.atomicConstruct,
      text: input.text.slice(params.startOffset, params.endOffset),
      startOffset: params.startOffset,
      endOffset: params.endOffset,
      pageStart,
      pageEnd,
      startMs: params.startMs,
      endMs: params.endMs,
      keyframeChunkId: params.keyframeChunkId,
      oversizedSplit: params.oversizedSplit,
      ...(input.itemFamilyId ? { itemFamilyId: input.itemFamilyId } : {}),
      ...(input.itemRevisionId ? { itemRevisionId: input.itemRevisionId } : {}),
      ...(input.conceptIds?.length ? { conceptIds: [...input.conceptIds] } : {}),
      ...(params.label ? { label: params.label } : {}),
    });
  };

  let pending: PedagogicalAstBlock[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    const first = pending[0]!;
    const last = pending[pending.length - 1]!;
    const uniqueKinds: PedagogicalBlockKind[] = [];
    for (const block of pending) {
      if (!uniqueKinds.includes(block.kind)) uniqueKinds.push(block.kind);
    }
    const label = pending.find(b => b.label)?.label;
    emitChunk({
      kind: dominantBlockKind(pending),
      constructKinds: uniqueKinds,
      visibility: first.visibility,
      atomicConstruct: pending.some(b => b.atomicConstruct),
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      startMs: first.startMs,
      endMs: last.endMs,
      keyframeChunkId: first.keyframeChunkId,
      oversizedSplit: false,
      label,
    });
    pending = [];
  };

  for (const block of astBlocks) {
    const blockLimit = block.atomicConstruct ? maxSealedChars : maxChunkChars;
    if (block.text.length > blockLimit) {
      flushPending();
      const parts = safeSubsplitText(block.text, blockLimit);
      for (const part of parts) {
        emitChunk({
          kind: block.kind,
          constructKinds: [block.kind],
          visibility: block.visibility,
          atomicConstruct: block.atomicConstruct,
          startOffset: block.startOffset + part.start,
          endOffset: block.startOffset + part.end,
          startMs: block.startMs,
          endMs: block.endMs,
          keyframeChunkId: block.keyframeChunkId,
          oversizedSplit: block.atomicConstruct,
          label: block.label,
        });
      }
      continue;
    }

    if (!canPackBlocks(pending, block, maxChunkChars)) {
      flushPending();
    }
    pending.push(block);
  }
  flushPending();

  return chunks;
}

/**
 * Emit structure-preserving chunks for structured media transcript cues while
 * retaining exact `[startMs, endMs, keyframeChunkId]` anchors.
 */
export function chunkTranscriptCues(input: ChunkTranscriptCuesInput): PedagogicalChunk[] {
  const maxSealedChars = input.maxSealedChars ?? DEFAULT_MAX_SEALED_CHARS;
  if (!Number.isSafeInteger(maxSealedChars) || maxSealedChars < 2) {
    throw new RangeError("maxSealedChars must be a safe integer >= 2");
  }
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0) {
    throw new RangeError("sourceVersion must be a non-negative safe integer");
  }

  const defaultVisibility = input.defaultVisibility ?? "public";
  const chunks: PedagogicalChunk[] = [];
  let seq = 0;
  let offsetCursor = 0;

  for (const cue of input.cues) {
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs < cue.startMs
    ) {
      throw new RangeError(`Invalid transcript cue range [${cue.startMs}, ${cue.endMs}]`);
    }
    const visibility = cue.visibility ?? defaultVisibility;
    const baseOffset = offsetCursor;
    offsetCursor += cue.text.length + 1;
    if (!cue.text) continue;

    if (cue.text.length <= maxSealedChars) {
      chunks.push({
        id: `${input.sourceId}:v${input.sourceVersion}:m${seq++}`,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        ...(input.privacyEpoch !== undefined ? { privacyEpoch: input.privacyEpoch } : {}),
        kind: "transcript_cue",
        constructKinds: ["transcript_cue"],
        visibility,
        atomicConstruct: true,
        text: cue.text,
        startOffset: baseOffset,
        endOffset: baseOffset + cue.text.length,
        pageStart: null,
        pageEnd: null,
        startMs: cue.startMs,
        endMs: cue.endMs,
        keyframeChunkId: cue.keyframeChunkId ?? null,
        oversizedSplit: false,
        ...(cue.itemFamilyId ? { itemFamilyId: cue.itemFamilyId } : {}),
        ...(cue.conceptIds?.length ? { conceptIds: [...cue.conceptIds] } : {}),
        ...(cue.label ? { label: cue.label } : {}),
      });
    } else {
      const parts = safeSubsplitText(cue.text, maxSealedChars);
      for (const part of parts) {
        chunks.push({
          id: `${input.sourceId}:v${input.sourceVersion}:m${seq++}`,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          ...(input.privacyEpoch !== undefined ? { privacyEpoch: input.privacyEpoch } : {}),
          kind: "transcript_cue",
          constructKinds: ["transcript_cue"],
          visibility,
          atomicConstruct: true,
          text: part.text,
          startOffset: baseOffset + part.start,
          endOffset: baseOffset + part.end,
          pageStart: null,
          pageEnd: null,
          startMs: cue.startMs,
          endMs: cue.endMs,
          keyframeChunkId: cue.keyframeChunkId ?? null,
          oversizedSplit: true,
          ...(cue.itemFamilyId ? { itemFamilyId: cue.itemFamilyId } : {}),
          ...(cue.conceptIds?.length ? { conceptIds: [...cue.conceptIds] } : {}),
          ...(cue.label ? { label: cue.label } : {}),
        });
      }
    }
  }

  return chunks;
}

/**
 * Partition chunks by visibility BEFORE embedding or graph indexing.
 * `sealed` chunks NEVER appear in `indexableChunks`.
 */
export function partitionPedagogicalChunks(
  chunks: readonly PedagogicalChunk[],
  options: { readonly allowHintGated?: boolean } = {},
): PedagogicalChunkPartition {
  const publicChunks: PedagogicalChunk[] = [];
  const hintGatedChunks: PedagogicalChunk[] = [];
  const sealedChunks: PedagogicalChunk[] = [];

  for (const chunk of chunks) {
    if (chunk.visibility === "sealed") sealedChunks.push(chunk);
    else if (chunk.visibility === "hint_gated") hintGatedChunks.push(chunk);
    else publicChunks.push(chunk);
  }

  return {
    publicChunks,
    hintGatedChunks,
    sealedChunks,
    indexableChunks: options.allowHintGated ? [...publicChunks, ...hintGatedChunks] : [...publicChunks],
  };
}
