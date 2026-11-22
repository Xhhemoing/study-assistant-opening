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
  "proof-key": { kind: "solution", visibility: "sealed" },
  proof_key: { kind: "solution", visibility: "sealed" },
  rubric: { kind: "solution", visibility: "sealed" },
  sealed: { kind: "solution", visibility: "sealed" },
  spoiler: { kind: "solution", visibility: "sealed" },
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
  /(?:^|\b)(?:answer[\s_-]*key|official[\s_-]*solution|proof[\s_-]*key|hidden[\s_-]*solution|solutions?|answers?|rubric|marking[\s_-]*scheme)(?:\b|$)|参考答案|标准答案|习题解答|解答与评分|答案解析/iu;
const HINT_HEADING_RE = /(?:^|\b)(?:hints?|scaffolds?)(?:\b|$)|分步提示|解题提示/iu;
const HTML_TAG_ATTRIBUTES = /(?:"[^"]*"|'[^']*'|[^'"<>])*/.source;
const HTML_TAG_TOKEN = /<(?<prefix>[!/?]?)(?<tag>[a-z][^\s/'"=<>]*)(?=[\s/>])/.source + HTML_TAG_ATTRIBUTES + ">";
const DETAILS_OPEN_RE = new RegExp(/^<details(?=[\s/>])/.source + HTML_TAG_ATTRIBUTES + ">", "i");
const ATX_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*$/;

interface HeadingScope {
  readonly level: number;
  readonly visibility: PedagogicalVisibility;
}

interface HeadingContext {
  readonly stack?: HeadingScope[];
  readonly baseVisibility?: PedagogicalVisibility;
  readonly firstHeadingIsLocal?: boolean;
  readonly onHeading?: (offset: number, level: number) => void;
}

function splitLinesWithOffsets(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (const newline of text.matchAll(/\r\n?|\n/g)) {
    const contentEnd = newline.index;
    const end = contentEnd + newline[0].length;
    lines.push({ start, contentEnd, end, raw: text.slice(start, contentEnd) });
    start = end;
  }
  if (start < text.length) {
    lines.push({ start, contentEnd: text.length, end: text.length, raw: text.slice(start) });
  }
  return lines;
}

function nextLineBreak(text: string, from: number) {
  const newline = /\r\n?|\n/g;
  newline.lastIndex = from;
  return newline.exec(text);
}

function containingLineStart(text: string, offset: number): number {
  while (offset > 0 && text[offset - 1] !== "\r" && text[offset - 1] !== "\n") offset--;
  return offset;
}

function precedingLineBreakStart(text: string, lineStart: number): number {
  const last = lineStart - 1;
  return text[last] === "\n" && text[last - 1] === "\r" ? last - 1 : last;
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

const LATEX_LITERAL_TOKENS = /%|(?<verb>\\verb(?![a-zA-Z])\*?)|\\begin\{(?<literalEnvironment>verbatim\*?|lstlisting)\}/.source;

function endOfLatexVerb(text: string, start: number): number {
  const codePoint = text.codePointAt(start);
  if (codePoint === undefined) return start;
  const delimiter = String.fromCodePoint(codePoint);
  if (/\s/.test(delimiter)) return start;
  const lineEnd = nextLineBreak(text, start)?.index ?? text.length;
  const close = text.indexOf(delimiter, start + delimiter.length);
  return close === -1 || close >= lineEnd ? lineEnd : close + delimiter.length;
}

// Include LATEX_LITERAL_TOKENS before the structural tokens in each pattern.
function* scanLatexTokens(text: string, pattern: RegExp, from: number, limit = text.length) {
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match && pattern.lastIndex <= limit; match = pattern.exec(text)) {
    const environment = match.groups?.literalEnvironment;
    const isVerb = match.groups?.verb;
    if (match[0] !== "%" && !isVerb && !environment) {
      yield match;
    } else if (!isEscaped(text, match.index)) {
      if (environment) {
        const closing = "\\end{" + environment + "}";
        const close = text.indexOf(closing, pattern.lastIndex);
        pattern.lastIndex = close === -1 ? text.length : close + closing.length;
      } else if (isVerb) {
        pattern.lastIndex = endOfLatexVerb(text, pattern.lastIndex);
      } else {
        pattern.lastIndex = nextLineBreak(text, pattern.lastIndex)?.index ?? text.length;
      }
      if (pattern.lastIndex >= limit) break;
    }
  }
}

function stripLatexComment(line: string): string {
  const comment = findUnescapedToken(line, "%", 0);
  return comment === -1 ? line : line.slice(0, comment);
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

function tableDelimiterColumnCount(line: string): number {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return 0;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|");
  return cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell)) ? cells.length : 0;
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

type InlineCueTiming = {
  startMs: number;
  endMs: number;
  prefixLength: number;
};

function parseInlineTranscriptCue(line: string): InlineCueTiming | null {
  const msMatch = /^[ \t]*\[startMs=(\d+),\s*endMs=(\d+)\][ \t]?/.exec(line);
  if (msMatch) {
    const startMs = Number(msMatch[1]);
    const endMs = Number(msMatch[2]);
    if (Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && startMs >= 0 && endMs >= startMs) {
      return { startMs, endMs, prefixLength: msMatch[0].length };
    }
    return null;
  }
  const clockMatch =
    /^[ \t]*\[(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*(?:-|–|—|->)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\][ \t]?/.exec(
      line,
    );
  if (!clockMatch) return null;
  const startMs = parseTimestampToMs(clockMatch[1]!);
  const endMs = parseTimestampToMs(clockMatch[2]!);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return { startMs, endMs, prefixLength: clockMatch[0].length };
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
  limit = text.length,
): { readonly closeStart: number; readonly closeEnd: number } {
  const stack: string[] = [envName];
  const pattern = new RegExp(LATEX_LITERAL_TOKENS + "|" + /\\(?<directive>begin|end)\{(?<name>[a-zA-Z][\w-]*\*?)\}/.source, "g");
  for (const match of scanLatexTokens(text, pattern, searchFrom, limit)) {
    if (isEscaped(text, match.index)) continue;
    const directive = match.groups!.directive;
    const name = match.groups!.name!;
    if (directive === "begin") {
      stack.push(name);
    } else if (stack.length > 0 && stack[stack.length - 1] === name) {
      stack.pop();
      if (stack.length === 0) {
        return { closeStart: match.index, closeEnd: match.index + match[0].length };
      }
    }
  }
  return { closeStart: limit, closeEnd: limit };
}

function lineIndexContaining(lines: readonly SourceLine[], offset: number, startHint: number): number {
  let idx = startHint;
  while (idx + 1 < lines.length && lines[idx]!.end <= offset) idx++;
  return idx;
}

function endOfHtmlComment(text: string, afterOpener: number): number {
  const end = text.indexOf("-->", afterOpener);
  return end === -1 ? text.length : end + 3;
}

function endOfBacktickSpan(text: string, start: number, limit = text.length): number {
  const runs = /\x60+|(?:\r\n|\r(?!\n)|(?<!\r)\n)[ \t]*(?:\r\n|\r(?!\n)|(?<!\r)\n)/g;
  runs.lastIndex = start;
  const length = runs.exec(text)![0].length;
  for (let next = runs.exec(text); next && runs.lastIndex <= limit; next = runs.exec(text)) {
    if (!next[0].startsWith("\x60")) break;
    if (next[0].length === length) return runs.lastIndex;
  }
  return -1;
}

function endOfDetailsCodeFence(
  text: string,
  afterOpener: number,
  opener: string,
  containers: readonly MarkdownContainer[],
): number {
  let newline = nextLineBreak(text, afterOpener);
  while (newline) {
    const start = newline.index + newline[0].length;
    newline = nextLineBreak(text, start);
    const line = text.slice(start, newline?.index ?? text.length);
    const { depth, body } = continueMarkdownContainers(line, containers);
    if (depth !== containers.length) return start;
    if (closesFence(body, opener)) return newline ? newline.index + newline[0].length : text.length;
  }
  return text.length;
}

interface DetailsBounds {
  readonly closeStart: number;
  readonly closeEnd: number;
  readonly summary?: {
    readonly openStart: number;
    readonly openEnd: number;
    readonly closeStart: number;
    readonly closeEnd: number;
  };
}

function findMatchingDetailsBounds(
  text: string,
  searchFrom: number,
): DetailsBounds {
  const literals =
    /<!--|(?<fence>^[ \t]*(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)*(?:\x60{3,}[^\x60\r\n]*|~{3,}[^\r\n]*)(?=\r|\n|$))|(?<ticks>\x60+)/.source;
  const tokenRe = new RegExp(literals + "|" + HTML_TAG_TOKEN, "gim");
  tokenRe.lastIndex = searchFrom;
  let containers: MarkdownContainer[] = [];
  let nextLineStart = containingLineStart(text, searchFrom);
  let body = "";
  let inIndentedCode = false;
  let afterBlockBoundary = true;
  const readThroughLine = (offset: number) => {
    while (nextLineStart <= offset && nextLineStart < text.length) {
      const newline = nextLineBreak(text, nextLineStart);
      const line = text.slice(nextLineStart, newline?.index ?? text.length);
      const current = readMarkdownContainerLine(line, containers);
      const sameContainer = current.continuedDepth === containers.length &&
        current.containers.length === containers.length;
      containers = current.containers;
      body = current.body;
      const endsSetext = sameContainer && !afterBlockBoundary && !inIndentedCode && SETEXT_UNDERLINE_RE.test(body);
      inIndentedCode = /^(?: {4}| {0,3}\t)/.test(body) &&
        (afterBlockBoundary || !sameContainer || inIndentedCode);
      afterBlockBoundary = !body.trim() || endsSetext || /^[ ]{0,3}#{1,6}(?:[ \t]|$)/.test(body) ||
        THEMATIC_BREAK_RE.test(body);
      nextLineStart = newline ? newline.index + newline[0].length : text.length;
    }
  };
  const skipLiteralLines = (end: number) => {
    if (end < nextLineStart) return;
    const newline = nextLineBreak(text, end);
    nextLineStart = newline ? newline.index + newline[0].length : text.length;
  };

  let depth = 1;
  let summaryOpening: { openStart: number; openEnd: number } | undefined;
  let summary: DetailsBounds["summary"];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    readThroughLine(match.index);
    if (inIndentedCode) {
      tokenRe.lastIndex = nextLineStart;
      continue;
    }
    if (match[0] === "<!--") {
      tokenRe.lastIndex = endOfHtmlComment(text, tokenRe.lastIndex);
      skipLiteralLines(tokenRe.lastIndex);
      if (body.trimStart().startsWith("<!--")) {
        const end = nextLineBreak(text, tokenRe.lastIndex)?.index ?? text.length;
        if (!text.slice(tokenRe.lastIndex, end).trim()) afterBlockBoundary = true;
      }
      continue;
    }
    if (match.groups?.ticks) {
      if (!isEscaped(text, match.index)) {
        const end = endOfBacktickSpan(text, match.index);
        if (end !== -1) {
          tokenRe.lastIndex = end;
          skipLiteralLines(end);
        }
      }
      continue;
    }
    if (match.groups?.fence) {
      const fence = matchFenceOpening(body)?.[1];
      if (fence) {
        nextLineStart = endOfDetailsCodeFence(text, tokenRe.lastIndex, fence, containers);
        tokenRe.lastIndex = nextLineStart;
        afterBlockBoundary = true;
      } else {
        tokenRe.lastIndex = match.index + 1;
      }
      continue;
    }
    skipLiteralLines(tokenRe.lastIndex);
    const tag = match.groups?.tag?.toLowerCase();
    const prefix = match.groups?.prefix;
    if (tag === "summary") {
      if (prefix === "/") {
        const end = nextLineBreak(text, tokenRe.lastIndex)?.index ?? text.length;
        if (!text.slice(tokenRe.lastIndex, end).trim()) afterBlockBoundary = true;
        if (depth === 1 && summaryOpening && !summary) {
          summary = { ...summaryOpening, closeStart: match.index, closeEnd: tokenRe.lastIndex };
        }
      } else if (!prefix && depth === 1 && !summaryOpening) {
        summaryOpening = { openStart: match.index, openEnd: tokenRe.lastIndex };
      }
    }
    if (tag !== "details") continue;
    if (prefix === "/") {
      depth--;
      if (depth === 0) {
        return { closeStart: match.index, closeEnd: tokenRe.lastIndex, summary };
      }
    } else if (!prefix) {
      depth++;
    }
  }
  return { closeStart: text.length, closeEnd: text.length, summary };
}

function maskSummaryLiterals(text: string): string {
  const parts: string[] = [];
  const tokens = new RegExp(/<!--|\x60+/.source + "|" + HTML_TAG_TOKEN, "gi");
  let copied = 0;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    if (match[0] === "<!--") {
      tokens.lastIndex = endOfHtmlComment(text, tokens.lastIndex);
      parts.push(text.slice(copied, match.index), " ".repeat(tokens.lastIndex - match.index));
    } else if (match.groups?.tag) {
      // Keep real tag boundaries while hiding markup inside quoted attributes.
      parts.push(text.slice(copied, match.index + 1), match[0].slice(1, -1).replace(/[<>]/g, " "), ">");
    } else {
      const end = isEscaped(text, match.index) ? -1 : endOfBacktickSpan(text, match.index);
      if (end === -1) continue;
      tokens.lastIndex = end;
      parts.push(text.slice(copied, match.index), text.slice(match.index, end).replace(/[<>]/g, " "));
    }
    copied = tokens.lastIndex;
  }
  return parts.length > 0 ? parts.join("") + text.slice(copied) : text;
}

function classifyDetailsElement(
  text: string,
  openEnd: number,
  { summary }: DetailsBounds,
  activeVisibility: PedagogicalVisibility,
): {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label: string;
  readonly summaryEndOffset: number | null;
} {
  if (summary && !maskSummaryLiterals(text.slice(openEnd, summary.openStart)).trim()) {
    const summaryContents = maskSummaryLiterals(text.slice(summary.openEnd, summary.closeStart));
    const summaryText = summaryContents.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (
      !SEALED_HEADING_RE.test(summaryText) &&
      !/\bspoiler\b/i.test(summaryText) &&
      !/<details\b/i.test(summaryContents) &&
      HINT_HEADING_RE.test(summaryText)
    ) {
      return {
        kind: "hint",
        visibility: maxVisibility("hint_gated", activeVisibility),
        label: summaryText || "hint",
        summaryEndOffset: summary.closeEnd,
      };
    }
    return {
      kind: "solution",
      visibility: maxVisibility("sealed", activeVisibility),
      label: summaryText || "solution",
      summaryEndOffset: summary.closeEnd,
    };
  }
  // Fail closed: any <details> without an explicit hint-only <summary> is sealed.
  return {
    kind: "solution",
    visibility: maxVisibility("sealed", activeVisibility),
    label: "details",
    summaryEndOffset: null,
  };
}

function sanitizeHeaderLabel(
  text: string,
  headerRestStart: number,
  headerRestEnd: number,
  higherBlocks: readonly { readonly startOffset: number; readonly endOffset: number }[],
  fallbackLabel: string,
): string {
  if (headerRestEnd <= headerRestStart) return fallbackLabel;
  let hasOverlap = false;
  for (const block of higherBlocks) {
    if (block.endOffset > headerRestStart && block.startOffset < headerRestEnd) {
      hasOverlap = true;
      break;
    }
  }
  if (!hasOverlap) {
    return text.slice(headerRestStart, headerRestEnd).trim() || fallbackLabel;
  }
  let cursor = headerRestStart;
  const kept: string[] = [];
  for (const block of higherBlocks) {
    if (block.endOffset <= headerRestStart) continue;
    if (block.startOffset >= headerRestEnd) break;
    if (block.startOffset > cursor) {
      kept.push(text.slice(cursor, block.startOffset));
    }
    cursor = Math.max(cursor, Math.min(block.endOffset, headerRestEnd));
  }
  if (cursor < headerRestEnd) {
    kept.push(text.slice(cursor, headerRestEnd));
  }
  const cleaned = kept.join(" ").replace(/\s+/g, " ").trim();
  return cleaned || fallbackLabel;
}

function parseTableRowCells(
  sourceLine: Pick<SourceLine, "raw" | "start">,
  tableSpans?: readonly InlineConstructSpan[],
  leadingEmptyCell = false,
) {
  const raw = sourceLine.raw;
  const spans = tableSpans ?? (raw.includes("|")
    ? findInlineConstructSpans(raw, 0, raw.length, "public", false, true)
    : []);
  const spanOffset = tableSpans ? sourceLine.start : 0;
  const pipePositions: number[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw.charCodeAt(idx) === 124 && !isEscaped(raw, idx)) {
      const pos = spanOffset + idx;
      if (spans.some(span => pos >= span.start && pos < span.end)) {
        continue;
      }
      pipePositions.push(idx);
    }
  }
  if (pipePositions.length === 0) {
    return { cells: [{ start: sourceLine.start, end: sourceLine.start + raw.length }], hasSeparator: false };
  }
  const hasLeadingPipe = !leadingEmptyCell && pipePositions[0] === raw.length - raw.trimStart().length;
  const hasTrailingPipe = pipePositions.at(-1) === raw.trimEnd().length - 1;

  const boundaries: number[] = [];
  let pStart = 0;
  let pEnd = pipePositions.length;
  if (hasLeadingPipe) {
    boundaries.push(pipePositions[0]! + 1);
    pStart = 1;
  } else {
    boundaries.push(0);
  }
  if (hasTrailingPipe && pEnd > pStart) {
    pEnd -= 1;
  }
  for (let k = pStart; k < pEnd; k++) {
    boundaries.push(pipePositions[k]!);
    boundaries.push(pipePositions[k]! + 1);
  }
  if (hasTrailingPipe) {
    boundaries.push(pipePositions[pipePositions.length - 1]!);
  } else {
    boundaries.push(raw.length);
  }

  const cells: Array<{ readonly start: number; readonly end: number }> = [];
  for (let k = 0; k + 1 < boundaries.length; k += 2) {
    const cStart = sourceLine.start + boundaries[k]!;
    const cEnd = sourceLine.start + boundaries[k + 1]!;
    if (cEnd >= cStart) {
      cells.push({ start: cStart, end: cEnd });
    }
  }
  return { cells, hasSeparator: true };
}

const THEMATIC_BREAK_RE = /^[ ]{0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const LIST_ITEM_RE = /^([ ]{0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$))(?:\[[ xX]\][ \t]+)?/;
const SETEXT_UNDERLINE_RE = /^[ ]{0,3}(=+|-+)[ \t]*$/;
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*>[ \t]?/;
const CALLOUT_HEADER_RE = /^\[!([a-zA-Z_-]+)\][+-]?(.*)$/;
const CALLOUT_RE = /^[ \t]*>[ \t]*\[!([a-zA-Z_-]+)\][+-]?(.*)$/;

type MarkdownContainer = "quote" | number; // List items store their continuation indentation.

function continueMarkdownContainers(line: string, containers: readonly MarkdownContainer[]) {
  let body = line;
  let depth = 0;
  for (const container of containers) {
    if (container === "quote") {
      const quote = BLOCKQUOTE_PREFIX_RE.exec(body);
      if (!quote) break;
      body = body.slice(quote[0].length);
    } else {
      const { length, padding } = listContinuationPrefix(body, container);
      if (!length && body.trim()) break;
      body = " ".repeat(padding) + body.slice(length);
    }
    depth++;
  }
  return { body, depth };
}

function readMarkdownContainerLine(line: string, previous: readonly MarkdownContainer[] = []) {
  const { body: continuedBody, depth } = continueMarkdownContainers(line, previous);
  let body = continuedBody;
  const containers = previous.slice(0, depth);
  while (body) {
    const quote = BLOCKQUOTE_PREFIX_RE.exec(body);
    if (quote) {
      containers.push("quote");
      body = body.slice(quote[0].length);
      continue;
    }
    const list = LIST_ITEM_RE.exec(body);
    if (!list || THEMATIC_BREAK_RE.test(body)) break;
    containers.push(listContentIndent(list[1]!));
    body = body.slice(list[0].length);
  }
  return { body, containers, continuedDepth: depth };
}

function innermostQuoteBody(line: string): string | null {
  const { body, containers } = readMarkdownContainerLine(line);
  return containers.includes("quote") ? body : null;
}

const HTML_BLOCK_START_RE =
  /^[ ]{0,3}<(?:\?|!(?:--|\[CDATA\[|[A-Z])|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$))/i;
const STANDALONE_HTML_TAG_RE = /^[ ]{0,3}<\/?[A-Za-z][\w-]*(?:[ \t]+[^<>]*?)?\/?>[ \t]*$/;

function interruptsPipeTable(line: string): boolean {
  return matchFenceOpening(line) !== null || /^[ \t]{0,3}(?::{3,}|#{1,6}(?:[ \t]|$)|>)/.test(line) ||
    THEMATIC_BREAK_RE.test(line) || LIST_ITEM_RE.test(line) ||
    HTML_BLOCK_START_RE.test(line) || STANDALONE_HTML_TAG_RE.test(line);
}

function isPipeTableBodyRow(line: string): boolean {
  return Boolean(line.trim()) && !interruptsPipeTable(line);
}

function isPipeParagraphLine(line: string): boolean {
  return line.includes("|") && isPipeTableBodyRow(line) &&
    !/^(?:\$\$|\\\[|\\begin\{)/.test(line.trimStart());
}

function pipeTableHeaderCells(header: Pick<SourceLine, "raw" | "start">, delimiter?: string) {
  if (delimiter === undefined || !header.raw.includes("|") || !isPipeTableBodyRow(header.raw)) return null;
  const columns = tableDelimiterColumnCount(delimiter);
  if (columns === 0) return null;
  const { cells, hasSeparator } = parseTableRowCells(header);
  return hasSeparator && cells.length === columns ? cells : null;
}

function isPipeTableStart(header: string, delimiter?: string): boolean {
  return pipeTableHeaderCells({ raw: header, start: 0 }, delimiter) !== null;
}

function tableColumnVisibility(label: string): PedagogicalVisibility {
  if (SEALED_HEADING_RE.test(label)) return "sealed";
  if (HINT_HEADING_RE.test(label)) return "hint_gated";
  return "public";
}

function parseTableBodyRowCells(
  row: Pick<SourceLine, "raw" | "start">,
  columnCount: number,
  captionRow: boolean,
  tableSpans?: readonly InlineConstructSpan[],
) {
  const parsed = parseTableRowCells(row, tableSpans);
  const leadingEmptyCell = captionRow && parsed.cells.length < columnCount &&
    row.raw.trimStart().startsWith("|") && !row.raw.trimEnd().endsWith("|");
  return { ...(leadingEmptyCell ? parseTableRowCells(row, tableSpans, true) : parsed), leadingEmptyCell };
}

function timedTableRowVisibility(
  raw: string,
  columns: readonly PedagogicalVisibility[],
  captionRow: boolean,
): PedagogicalVisibility {
  if (columns.every(visibility => visibility === "public")) return "public";
  const { cells, hasSeparator, leadingEmptyCell } = parseTableBodyRowCells(
    { raw, start: 0 }, columns.length, captionRow,
  );
  if (!hasSeparator) return columns[0] ?? "public";
  let visibility: PedagogicalVisibility = "public";
  for (const [index, cell] of cells.entries()) {
    if (!raw.slice(cell.start, cell.end).trim()) continue;
    const column = columns[index] ?? "public";
    const alternate = leadingEmptyCell ? columns[index - 1] ?? "public" : "public";
    visibility = maxVisibility(visibility, maxVisibility(column, alternate));
  }
  return visibility;
}

function tableBoundaryVisibility(
  start: number,
  end: number,
  columns: readonly PedagogicalVisibility[],
  readRow: (index: number) => { body: string; captionRow: boolean },
): PedagogicalVisibility {
  let visibility: PedagogicalVisibility = "public";
  for (let index = start; index < end && visibility !== "sealed"; index++) {
    const { body, captionRow } = readRow(index);
    visibility = maxVisibility(visibility, timedTableRowVisibility(body, columns, captionRow));
  }
  return visibility;
}

function getTableColumnVisibilities(header: string, cells: readonly { start: number; end: number }[], start = 0) {
  return cells.map(cell => tableColumnVisibility(header.slice(cell.start - start, cell.end - start)));
}

type ReadMarkdownLine = (index: number) => string | undefined;

function createProtectedSetextLookup(readRaw: ReadMarkdownLine) {
  let checkedBefore = -1;
  let checkedContainers: readonly MarkdownContainer[] = [];
  let checkedColumns: readonly PedagogicalVisibility[] | undefined;
  let checkedCaptionRow = false;
  return (
    start: number,
    { body, containers }: ReturnType<typeof readMarkdownContainerLine>,
    columns?: readonly PedagogicalVisibility[],
    captionRow = false,
  ): number | undefined => {
    // A suffix of a checked, unprotected paragraph cannot introduce a protected title.
    if (start < checkedBefore && columns === checkedColumns && captionRow === checkedCaptionRow &&
      containers.length === checkedContainers.length &&
      containers.every((container, index) => container === checkedContainers[index])) return undefined;

    let firstProtectedTitleLine = Infinity;
    const readLine: ReadMarkdownLine = index => {
      const raw = readRaw(index);
      if (raw === undefined) return undefined;
      const line = continueMarkdownContainers(raw, containers);
      if (index !== start && line.depth !== containers.length) return undefined;
      const titleLine = index === start ? body : line.body;
      if (columns && tableColumnVisibility(titleLine) !== "public") {
        firstProtectedTitleLine = Math.min(firstProtectedTitleLine, index);
      }
      // Data rows cannot become an earlier part of a later hint heading and lose column protection.
      if (columns && index < firstProtectedTitleLine &&
        timedTableRowVisibility(line.depth === containers.length ? line.body : raw, columns, captionRow) !== "public") {
        return undefined;
      }
      return titleLine;
    };
    const paragraph = readSetextParagraph(readLine, start);
    if (paragraph.level !== undefined) {
      const title: string[] = [];
      for (let index = start; index < paragraph.index; index++) title.push(readLine(index)!);
      if (tableColumnVisibility(title.join("\n")) !== "public") return paragraph.index;
    }
    checkedBefore = paragraph.index;
    checkedContainers = containers;
    checkedColumns = columns;
    checkedCaptionRow = captionRow;
    return undefined;
  };
}

function startsTimedTableBoundary(
  { body, containers, continuedDepth }: ReturnType<typeof readMarkdownContainerLine>,
  tableActive = true,
): boolean {
  if (interruptsPipeTable(body) || (tableActive && containers.includes("quote", continuedDepth))) return true;
  if (containers.at(-1) === "quote" && CALLOUT_HEADER_RE.test(body.trimStart())) return true;
  const latex = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}[ \t]*$/.exec(body);
  return latex !== null && (MATH_ENVS.has(latex[1]!) || classifyLabel(latex[1], "public") !== null);
}

function isListLikeTableRow(line: string): boolean {
  return LIST_ITEM_RE.test(line) && !THEMATIC_BREAK_RE.test(line);
}

function isCaptionTableBodyRow(line: string): boolean {
  if (isPipeTableBodyRow(line)) return true;
  if (!isListLikeTableRow(line)) return false;
  const projected = readMarkdownContainerLine(line);
  return !startsTimedTableBoundary(projected);
}

function matchFenceOpening(line: string): RegExpExecArray | null {
  const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return match && !(match[1]![0] === "`" && match[2]!.includes("`")) ? match : null;
}

function closesFence(line: string, opener: string): boolean {
  const match = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return match !== undefined && match[0] === opener[0] && match.length >= opener.length;
}

function createTranscriptCueSeparator(
  cueTexts: readonly string[],
  preserveBoundaryVisibility?: (cueIndex: number, offset: number, visibility: PedagogicalVisibility) => void,
) {
  const lines: string[] = [];
  const offsets: number[] = [];
  const cueLineStarts = cueTexts.map(text => {
    const start = lines.length;
    for (const line of splitLinesWithOffsets(text)) {
      lines.push(line.raw);
      offsets.push(line.start);
    }
    const last = text.at(-1);
    if (last === undefined || last === "\r" || last === "\n") {
      lines.push("");
      offsets.push(text.length);
    }
    return start;
  });
  let containers: MarkdownContainer[] = [];
  let previousBody = "";
  let tableColumns: PedagogicalVisibility[] | undefined;
  let setextThrough = -1;
  const protectedUnderline = createProtectedSetextLookup(index => lines[index]);
  const readCaptionRow = (index: number) => ({
    ...continueMarkdownContainers(lines[index]!, containers),
    captionRow: true,
  });
  return (cueIndex: number, joinNext = true, breakBefore = false): string => {
    const start = cueLineStarts[cueIndex]!;
    const end = cueLineStarts[cueIndex + 1] ?? lines.length;
    // Keep the synthetic separator separate from a cue's terminal bare CR.
    const newline = cueTexts[cueIndex]!.endsWith("\r") ? "\r" : "\n";
    if (breakBefore) {
      containers = readMarkdownContainerLine("", containers).containers;
      previousBody = "";
      tableColumns = undefined;
      const underline = protectedUnderline(start, readMarkdownContainerLine(lines[start]!, containers));
      if (underline !== undefined) setextThrough = underline;
    }
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      const continuation = continueMarkdownContainers(line, containers);
      const current = readMarkdownContainerLine(line, containers);
      if (tableColumns && continuation.depth === containers.length) {
        const explicitBoundary = startsTimedTableBoundary(current);
        const canContinue = isCaptionTableBodyRow(continuation.body);
        const underline = !explicitBoundary && canContinue
          ? protectedUnderline(index, current, tableColumns, true)
          : undefined;
        if (explicitBoundary || underline !== undefined) {
          if (underline !== undefined) setextThrough = underline;
          preserveBoundaryVisibility?.(cueIndex, offsets[index]!,
            tableBoundaryVisibility(index, underline ?? index + 1, tableColumns, readCaptionRow));
        } else if (canContinue) {
          previousBody = continuation.body;
          continue;
        }
      }
      const sameContainer = current.continuedDepth === containers.length &&
        current.continuedDepth === current.containers.length;
      const headerCells = sameContainer ? pipeTableHeaderCells({ raw: previousBody, start: 0 }, current.body) : null;
      tableColumns = headerCells ? getTableColumnVisibilities(previousBody, headerCells) : undefined;
      containers = current.containers;
      previousBody = current.body;
    }
    const nextLine = lines[end];
    if (!joinNext || nextLine === undefined) return "";
    const continued = continueMarkdownContainers(nextLine, containers);
    if (tableColumns && continued.depth === containers.length) {
      const next = readMarkdownContainerLine(nextLine, containers);
      const explicitBoundary = startsTimedTableBoundary(next);
      const underline = explicitBoundary ? undefined : protectedUnderline(end, next, tableColumns, true);
      if (explicitBoundary || underline !== undefined) {
        if (underline !== undefined) setextThrough = underline;
        preserveBoundaryVisibility?.(cueIndex + 1, offsets[end]!,
          tableBoundaryVisibility(end, underline ?? end + 1, tableColumns, readCaptionRow));
        previousBody = "";
        tableColumns = undefined;
        return newline.repeat(2);
      }
    }
    const continuesTable = continued.depth === containers.length && (
      (tableColumns !== undefined && isCaptionTableBodyRow(continued.body)) || isPipeTableStart(previousBody, continued.body)
    );
    const continuesQuote = innermostQuoteBody(lines[end - 1]!) !== null && innermostQuoteBody(nextLine) !== null;
    const continuesSetext = end <= setextThrough ||
      (continued.depth === containers.length && SETEXT_UNDERLINE_RE.test(continued.body));
    const continuesPipeParagraph = continued.depth === containers.length &&
      isPipeParagraphLine(previousBody) && isPipeParagraphLine(continued.body);
    if (continuesTable || continuesQuote || continuesSetext || continuesPipeParagraph) return newline;

    // The synthetic paragraph break also ends any table.
    previousBody = "";
    tableColumns = undefined;
    return newline.repeat(2);
  };
}

function nextMarkdownColumn(column: number, character: string): number {
  return character === "\t" ? column + (4 - column % 4) : column + 1;
}

function listContentIndent(prefix: string): number {
  let column = 0;
  for (const character of prefix) column = nextMarkdownColumn(column, character);
  return column;
}

function listContinuationPrefix(line: string, indent: number): { length: number; padding: number } {
  let column = 0;
  let length = 0;
  while (column < indent && (line[length] === " " || line[length] === "\t")) {
    column = nextMarkdownColumn(column, line[length]!);
    length++;
  }
  // A tab consumed at the list boundary can still contribute indentation to the inner block.
  return column >= indent ? { length, padding: column - indent } : { length: 0, padding: 0 };
}

// Malformed math should stop at the paragraph or Markdown container boundary
// so the main parser can still visit protected sections and blocks.
function findMathBoundary(text: string, afterOpen: number, through = text.length): number {
  let boundary = text.length;
  let containers: MarkdownContainer[] = [];
  let paragraphStart: number | undefined;
  let newline = nextLineBreak(text, afterOpen);
  while (newline && newline.index < through) {
    const lineStart = newline.index + newline[0].length;
    const nextNewline = nextLineBreak(text, lineStart);
    const line = text.slice(lineStart, nextNewline?.index ?? text.length);
    const nextLineStart = nextNewline ? nextNewline.index + nextNewline[0].length : text.length;
    const nextLine = text.slice(nextLineStart, nextLineBreak(text, nextLineStart)?.index ?? text.length);
    const current = readMarkdownContainerLine(line, containers);
    if (current.continuedDepth !== containers.length || current.continuedDepth !== current.containers.length) {
      paragraphStart = undefined;
    }
    containers = current.containers;
    const body = stripLatexComment(current.body).trimStart();
    const latex = /^\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(body);
    const beforeLine = newline.index;
    if (
      !line.trim() ||
      /^(?:#{1,6}(?:[ \t]|$)|:{3,}|\x60{3,}|~{3,})/.test(body) ||
      CALLOUT_HEADER_RE.test(body) ||
      DETAILS_OPEN_RE.test(body) ||
      (latex && classifyLabel(latex[1], "public") !== null) ||
      parseInlineTranscriptCue(line) !== null ||
      THEMATIC_BREAK_RE.test(line)
    ) {
      boundary = beforeLine;
      break;
    }
    if (body && !/^(?:\$\$|\\\[|\\\]|\\end\{)/.test(body) && !/^(?: {4}| {0,3}\t)/.test(current.body)) {
      paragraphStart ??= beforeLine;
      const underline = continueMarkdownContainers(nextLine, containers);
      if (underline.depth === containers.length && SETEXT_UNDERLINE_RE.test(underline.body)) {
        boundary = paragraphStart;
        break;
      }
    } else {
      paragraphStart = undefined;
    }
    newline = nextNewline;
  }
  const inline = new RegExp(LATEX_LITERAL_TOKENS + "|" +
    /<details(?=[\s>])|\\begin\{(?<name>[a-zA-Z][\w-]*\*?)\}/.source, "gi");
  for (const match of scanLatexTokens(text, inline, afterOpen, Math.min(boundary, through))) {
    const start = match.index;
    const name = match.groups!.name;
    if (!name) return start;
    const classified = classifyLabel(name, "public");
    if (classified && classified.visibility !== "public" && !isEscaped(text, start)) return start;
  }
  return boundary;
}

function findMathDelimiter(text: string, start: number, token: "$$" | "\\]") {
  const afterOpen = start + 2;
  let close = -1;
  const delimiters = new RegExp(LATEX_LITERAL_TOKENS + "|" + (token === "$$" ? /\$\$/.source : /\\\]/.source), "g");
  for (const match of scanLatexTokens(text, delimiters, afterOpen)) {
    if (!isEscaped(text, match.index)) {
      close = match.index;
      break;
    }
    delimiters.lastIndex = match.index + 1;
  }
  const boundary = findMathBoundary(text, afterOpen, close < 0 ? text.length : close);
  if (close === -1 || close >= boundary) return { end: boundary, closed: false };

  if (token === "$$") {
    const openerLineStart = containingLineStart(text, start);
    const closerLineStart = containingLineStart(text, close);
    const closerLineEnd = nextLineBreak(text, close + 2)?.index ?? text.length;
    const openerLineEnd = nextLineBreak(text, afterOpen)?.index ?? text.length;
    const flowOpener = closerLineStart > openerLineStart
      && !text.slice(openerLineStart, start).trim()
      && !stripLatexComment(text.slice(afterOpen, openerLineEnd)).trim();
    const standaloneCloser = !text.slice(closerLineStart, close).trim()
      && !stripLatexComment(text.slice(close + 2, closerLineEnd)).trim();
    const startsLaterFormula = closerLineStart > openerLineStart
      && !text.slice(closerLineStart, close).trim()
      && !standaloneCloser;
    if ((flowOpener && !standaloneCloser) || startsLaterFormula) {
      return { end: precedingLineBreakStart(text, closerLineStart), closed: false };
    }
  }
  return { end: close + 2, closed: true };
}

function findMathEnvironment(text: string, envName: string, afterOpen: number) {
  const limit = findMathBoundary(text, afterOpen);
  const bounds = findMatchingLatexEnvBounds(text, envName, afterOpen, limit);
  return { ...bounds, closed: bounds.closeStart < limit };
}

function startsSpecialLine(raw: string, next?: string, interruptsParagraph = false): boolean {
  if (/^\s*$/.test(raw)) return true;
  if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(raw)) return true;
  if (/^[ \t]{0,3}:{3,}[ \t]*[a-zA-Z]/.test(raw)) return true;
  const latexEnv = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(raw);
  if (latexEnv) {
    const env = latexEnv[1]!;
    if (MATH_ENVS.has(env) || classifyLabel(env, "public") !== null) return true;
  }
  if (DETAILS_OPEN_RE.test(raw.trimStart())) return true;
  if (/^[ \t]*\$\$/.test(raw) && !isEscaped(raw, raw.indexOf("$$"))) return true;
  if (/^[ \t]*\\\[/.test(raw)) return true;
  if (/^[ \t]*>/.test(raw)) return true;
  if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(raw)) return true;
  if (THEMATIC_BREAK_RE.test(raw)) return true;
  const list = LIST_ITEM_RE.exec(raw);
  if (list && (!interruptsParagraph ||
    (raw.slice(list[1]!.length).trim() && /^(?:[-+*]|1[.)])/.test(list[1]!.trimStart())))) return true;
  if (isPipeTableStart(raw, next)) return true;
  if (parseInlineTranscriptCue(raw) !== null) return true;
  return false;
}

function startsSpecialBlock(lines: readonly SourceLine[], index: number): boolean {
  return startsSpecialLine(lines[index]!.raw, lines[index + 1]?.raw);
}

interface QuoteParagraph {
  open: boolean;
  fence?: string;
}

function updateQuotedParagraph(state: QuoteParagraph, rawBody: string) {
  const body = rawBody.trimStart();
  const fence = /^(\x60{3,}|~{3,}|\$\$(?=[ \t]*$))(.*)$/.exec(body);
  if (state.fence) {
    if (fence && fence[1]![0] === state.fence[0] && fence[1]!.length >= state.fence.length && !fence[2]!.trim()) {
      state.fence = undefined;
    }
    return;
  }
  state.fence = fence?.[1];
  state.open = !startsSpecialLine(body);
}

function continuesLazyQuote(state: QuoteParagraph, raw: string, next?: string): boolean {
  return state.open && !startsSpecialLine(raw, next, true) && !/^[ \t]*:{3,}[ \t]*$/.test(raw);
}

function findBlockquoteEnd(
  lines: readonly SourceLine[],
  start: number,
  interruptsQuote: (line: string, index: number) => boolean,
): number {
  const state: QuoteParagraph = { open: false };
  let inHtmlComment = false;
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index]!.raw;
    if (BLOCKQUOTE_PREFIX_RE.test(raw)) {
      const body = innermostQuoteBody(raw)!;
      const trimmed = body.trimStart();
      if (!state.fence && (inHtmlComment || trimmed.startsWith("<!--"))) {
        inHtmlComment = trimmed.indexOf("-->", inHtmlComment ? 0 : 4) === -1;
        state.open = false;
        continue;
      }
      if (!state.fence && index > start && interruptsQuote(raw, index)) return index;
      updateQuotedParagraph(state, body);
    } else if (!continuesLazyQuote(state, raw, lines[index + 1]?.raw)) {
      return index;
    }
  }
  return lines.length;
}

function readSetextParagraph(readLine: ReadMarkdownLine, firstLine: number): { index: number; level?: number } {
  const titleStart = readLine(firstLine);
  if (
    titleStart === undefined ||
    startsSpecialLine(titleStart, readLine(firstLine + 1)) ||
    /^(?: {4}| {0,3}\t)/.test(titleStart)
  ) return { index: firstLine };

  for (let index = firstLine + 1; ; index++) {
    const raw = readLine(index);
    if (raw === undefined) return { index };
    const underline = SETEXT_UNDERLINE_RE.exec(raw);
    if (underline) return { index, level: underline[1]![0] === "=" ? 1 : 2 };
    if (startsSpecialLine(raw, readLine(index + 1))) return { index };
  }
}

interface InlineConstructSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label?: string;
  readonly openEnd?: number;
  readonly closeStart?: number;
  readonly summaryEndOffset?: number | null;
}

function findTableLiteralEnd(text: string, start: number, end: number): number {
  const marker = text[start]!;
  if (isEscaped(text, start) || (text[start - 1] === marker && !isEscaped(text, start - 1))) return -1;
  const lineEnd = Math.min(end, nextLineBreak(text, start)?.index ?? end);
  if (marker === "\x60") return endOfBacktickSpan(text, start, lineEnd);

  const first = text[start + 1];
  if (!first || first === "$" || /\s/.test(first)) return -1;
  let close = findUnescapedToken(text, "$", start + 1);
  while (close !== -1 && close < lineEnd) {
    const after = text[close + 1];
    if (after === "$") return -1;
    if (!/\s/.test(text[close - 1]!) && (after === undefined || !/\d/.test(after))) return close + 1;
    close = findUnescapedToken(text, "$", close + 1);
  }
  return -1;
}

function findInlineConstructSpans(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  activeVisibility: PedagogicalVisibility,
  sealProofs: boolean,
  tableLiterals = false,
): InlineConstructSpan[] {
  const spans: InlineConstructSpan[] = [];
  let i = rangeStart;
  while (i < rangeEnd) {
    if (tableLiterals && (text[i] === "\x60" || text[i] === "$")) {
      const end = findTableLiteralEnd(text, i, rangeEnd);
      if (end !== -1) {
        const kind = text[i] === "\x60" ? "code" : "display_math";
        spans.push({ start: i, end, kind, visibility: activeVisibility });
        i = end;
        continue;
      }
    }
    if (text.startsWith("$$", i) && !isEscaped(text, i)) {
      const { end, closed } = findMathDelimiter(text, i, "$$");
      spans.push({ start: i, end, kind: "display_math", visibility: closed ? activeVisibility : "sealed" });
      i = end;
      continue;
    }
    if (text.startsWith("\\[", i) && !isEscaped(text, i)) {
      const { end, closed } = findMathDelimiter(text, i, "\\]");
      spans.push({ start: i, end, kind: "display_math", visibility: closed ? activeVisibility : "sealed" });
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
          const math = isMath ? findMathEnvironment(text, envName, openEnd) : null;
          const bounds = math ?? findMatchingLatexEnvBounds(text, envName, openEnd);
          spans.push({
            start: i,
            end: bounds.closeEnd,
            kind: classified.kind,
            visibility: math?.closed === false ? "sealed" : classified.visibility,
            label: envName,
            ...(isMath ? {} : { openEnd, closeStart: bounds.closeStart }),
          });
          i = bounds.closeEnd;
          continue;
        }
      }
    }
    if (text.charCodeAt(i) === 60 && text.slice(i, i + 8).toLowerCase() === "<details") {
      const m = DETAILS_OPEN_RE.exec(text.slice(i));
      if (m) {
        const openEnd = i + m[0].length;
        const bounds = findMatchingDetailsBounds(text, openEnd);
        const classified = classifyDetailsElement(text, openEnd, bounds, activeVisibility);
        spans.push({
          start: i,
          end: bounds.closeEnd,
          kind: classified.kind,
          visibility: classified.visibility,
          label: classified.label,
          openEnd,
          closeStart: bounds.closeStart,
          summaryEndOffset: classified.summaryEndOffset,
        });
        i = bounds.closeEnd;
        continue;
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
      const nl = nextLineBreak(text, s);
      const lineContentEnd = Math.min(e, nl?.index ?? e);
      const lineNext = nl ? Math.min(e, nl.index + nl[0].length) : e;
      const lineSlice = text.slice(s, lineContentEnd);
      if (/^[ \t]*(?:>[ \t]*)*$/.test(lineSlice)) {
        s = lineNext;
      } else {
        break;
      }
    }
    while (e > s) {
      const lineStart = Math.max(s, containingLineStart(text, e));
      const lineSlice = text.slice(lineStart, e);
      if (/^[ \t]*(?:>[ \t]*)*$/.test(lineSlice)) {
        e = Math.max(s, precedingLineBreakStart(text, lineStart));
      } else {
        break;
      }
    }
  }
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return s < e ? { start: s, end: e } : null;
}

function parsePrefixedInnerBlocks(
  lines: readonly SourceLine[],
  startLineIdx: number,
  endLineIdx: number,
  firstLineSliceStart: number | null,
  outerVisibility: PedagogicalVisibility,
  propagateSectionVisibility: boolean,
  innerSealProofs: boolean,
  captionRowStarts?: ReadonlySet<number>,
  boundaryFloors?: ReadonlyMap<number, PedagogicalVisibility>,
  readPrefix = (line: SourceLine, _index: number) => ({
    length: BLOCKQUOTE_PREFIX_RE.exec(line.raw)?.[0].length ?? 0, padding: 0,
  }),
  headingContext?: HeadingContext,
): MappedInnerBlock[] {
  const bodyParts: string[] = [];
  const charOrigStart: number[] = [];
  const charOrigEnd: number[] = [];
  const vLineToOrigLine = new Map<number, SourceLine>();
  const projectedCaptionRows = captionRowStarts && new Set<number>();
  const projectedBoundaryFloors = boundaryFloors && new Map<number, PedagogicalVisibility>();
  let vCursor = 0;

  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const curLine = lines[idx]!;
    const { length, padding } = idx === startLineIdx && firstLineSliceStart !== null
      ? { length: firstLineSliceStart - curLine.start, padding: 0 }
      : readPrefix(curLine, idx);
    const stripped = curLine.raw.slice(length);
    if (captionRowStarts?.has(curLine.start)) projectedCaptionRows?.add(vCursor);
    const boundaryFloor = boundaryFloors?.get(curLine.start);
    if (boundaryFloor !== undefined && !(idx === startLineIdx && firstLineSliceStart !== null)) {
      projectedBoundaryFloors?.set(vCursor, boundaryFloor);
    }
    if (!(idx === startLineIdx && firstLineSliceStart !== null)) {
      vLineToOrigLine.set(vCursor, curLine);
    }
    for (let column = 0; column < padding; column++) {
      charOrigStart.push(curLine.start + length - 1);
      charOrigEnd.push(curLine.start + length);
    }
    for (let c = 0; c < stripped.length; c++) {
      charOrigStart.push(curLine.start + length + c);
      charOrigEnd.push(curLine.start + length + c + 1);
    }
    bodyParts.push(" ".repeat(padding), stripped);
    vCursor += padding + stripped.length;

    if (idx < endLineIdx) {
      bodyParts.push("\n");
      charOrigStart.push(curLine.contentEnd);
      charOrigEnd.push(curLine.end);
      vCursor += 1;
    }
  }

  const virtualText = bodyParts.join("");
  if (!virtualText.trim()) return [];

  const observeHeading = headingContext?.onHeading;
  const innerAst = parsePedagogicalAstInternal(
    virtualText,
    {
      defaultVisibility: outerVisibility,
      propagateSectionVisibility,
    },
    innerSealProofs,
    projectedCaptionRows,
    projectedBoundaryFloors,
    observeHeading ? {
      ...headingContext,
      onHeading: (offset, level) => {
        const original = vLineToOrigLine.get(offset);
        if (original) observeHeading(original.start, level);
      },
    } : headingContext,
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

type ReadAstRange = (
  start: number,
  end: number,
  visit: (block: PedagogicalAstBlock, start: number, end: number) => void,
) => void;

function readAstRanges(blocks: readonly PedagogicalAstBlock[]): ReadAstRange {
  let index = 0;
  return (start, end, visit) => {
    while (index < blocks.length && blocks[index]!.endOffset <= start) index++;
    while (index < blocks.length && blocks[index]!.startOffset < end) {
      const block = blocks[index]!;
      visit(block, Math.max(start, block.startOffset), Math.min(end, block.endOffset));
      if (block.endOffset > end) break;
      index++;
    }
  };
}

interface CueSpan {
  start: number;
  end: number;
  visibility: PedagogicalVisibility;
  construct?: PedagogicalAstBlock;
}

function splitCueVisibility(
  text: string,
  start: number,
  end: number,
  floor: PedagogicalVisibility,
  readRange: ReadAstRange,
  keepProtectedKinds = false,
): CueSpan[] {
  const spans: CueSpan[] = [];
  let cursor = start;
  const addSpan = (spanEnd: number, visibility: PedagogicalVisibility, construct?: PedagogicalAstBlock) => {
    if (spanEnd <= cursor) return;
    const previous = spans.at(-1);
    if (previous?.visibility === visibility && previous.construct === construct) previous.end = spanEnd;
    else spans.push({ start: cursor, end: spanEnd, visibility, construct });
    cursor = spanEnd;
  };
  const addGap = (gapEnd: number, nearbyVisibility: PedagogicalVisibility, construct?: PedagogicalAstBlock) => {
    if (gapEnd <= cursor) return;
    // Whitespace can follow a neighboring span. Unclassified content stays sealed.
    if (/\S/u.test(text.slice(cursor, gapEnd))) addSpan(gapEnd, "sealed");
    else addSpan(gapEnd, nearbyVisibility, construct);
  };
  readRange(start, end, (block, blockStart, blockEnd) => {
    const visibility = maxVisibility(floor, block.visibility);
    const construct = keepProtectedKinds && visibility !== "public" && block.kind !== "prose" && block.kind !== "heading"
      ? block
      : undefined;
    const previous = spans.at(-1);
    addGap(blockStart, previous?.visibility ?? visibility, previous ? previous.construct : construct);
    addSpan(blockEnd, visibility, construct);
  });
  const last = spans.at(-1);
  addGap(end, last?.visibility ?? floor, last?.construct);
  return spans;
}

interface AstParseOptions {
  readonly pageSpans?: readonly PageSpan[];
  readonly defaultVisibility?: PedagogicalVisibility;
  readonly propagateSectionVisibility?: boolean;
}

interface TranscriptRegion {
  readonly start: number;
  end: number;
  readonly sourceStart: number;
  readonly cue?: { readonly timing: InlineCueTiming; readonly lineStart: number };
}

function scanInlineCueTimings(
  lines: readonly SourceLine[],
  captionRowStarts?: ReadonlySet<number>,
  boundaryFloors?: ReadonlyMap<number, PedagogicalVisibility>,
) {
  let containers: MarkdownContainer[] = [];
  let fence: { opener: string; literal: boolean } | undefined;
  let table: { columns: PedagogicalVisibility[]; timed: boolean; delimiterIndex: number } | undefined;
  const cueTimings = lines.map(line => parseInlineTranscriptCue(line.raw));
  const cueCounts = [0];
  for (const timing of cueTimings) cueCounts.push(cueCounts.at(-1)! + (timing ? 1 : 0));
  const readCueBody = (index: number) => {
    const raw = lines[index]?.raw;
    return raw?.slice(cueTimings[index]?.prefixLength ?? 0);
  };
  const protectedUnderline = createProtectedSetextLookup(readCueBody);
  const tableBreakVisibilities = new Map<number, PedagogicalVisibility>();
  const timings = lines.map(({ raw, start }, index) => {
    const timing = cueTimings[index]!;
    if (fence) {
      const fenceTiming = fence.literal ? null : timing;
      const continuation = continueMarkdownContainers(raw.slice(fenceTiming?.prefixLength ?? 0), containers);
      if (continuation.depth === containers.length) {
        if (closesFence(continuation.body, fence.opener)) fence = undefined;
        return fenceTiming;
      }
      // A fenced block ends with its list or quote even without a closing marker.
      fence = undefined;
    }
    if (table?.delimiterIndex === index) return table.timed ? timing : null;
    const cueBody = timing ? raw.slice(timing.prefixLength) : "";
    const cueLine = timing && readMarkdownContainerLine(cueBody, containers);
    const documentLine = readMarkdownContainerLine(raw, containers);
    const next = lines[index + 1];
    const markedBoundary = boundaryFloors?.has(start);
    let explicitBoundary = markedBoundary || (cueLine !== null && startsTimedTableBoundary(cueLine, table !== undefined));
    if (table && !markedBoundary) {
      const timedTable = table.timed;
      const readTableRow = (rowIndex: number) => {
        const row = lines[rowIndex]!;
        const projectedRow = timedTable && cueTimings[rowIndex];
        return {
          ...continueMarkdownContainers(projectedRow ? readCueBody(rowIndex)! : row.raw, containers),
          captionRow: Boolean(projectedRow || captionRowStarts?.has(row.start)),
        };
      };
      const continuation = readTableRow(index);
      const { captionRow } = continuation;
      const canContinue = isPipeTableBodyRow(continuation.body) || (captionRow && isCaptionTableBodyRow(continuation.body));
      if (continuation.depth === containers.length && (canContinue || table.timed)) {
        const candidate = cueLine ?? documentLine;
        explicitBoundary ||= table.timed && startsTimedTableBoundary(candidate);
        const underline = !explicitBoundary
          ? protectedUnderline(index, candidate, table.columns, captionRow)
          : undefined;
        explicitBoundary ||= underline !== undefined && cueCounts[underline + 1]! > cueCounts[index]!;
        if (!explicitBoundary && canContinue) return table.timed ? timing : null;
        if (explicitBoundary) {
          tableBreakVisibilities.set(index,
            tableBoundaryVisibility(index, underline ?? index + 1, table.columns, readTableRow));
        }
      }
    }
    table = undefined;

    const delimiter = next && continueMarkdownContainers(next.raw, documentLine.containers);
    const literalHeader = !explicitBoundary && !interruptsPipeTable(cueBody) &&
      delimiter?.depth === documentLine.containers.length
      ? pipeTableHeaderCells({ raw: documentLine.body, start: 0 }, delimiter.body)
      : null;
    const projectedHeader = cueLine ?? documentLine;
    const nextTiming = cueTimings[index + 1];
    const projectedDelimiter = next && continueMarkdownContainers(
      next.raw.slice(nextTiming?.prefixLength ?? 0), projectedHeader.containers,
    );
    const timedHeader = !explicitBoundary && (timing || nextTiming) &&
      projectedDelimiter?.depth === projectedHeader.containers.length
      ? pipeTableHeaderCells({ raw: projectedHeader.body, start: 0 }, projectedDelimiter.body)
      : null;
    const cells = timedHeader ?? literalHeader;
    if (cells) {
      const header = timedHeader ? projectedHeader : documentLine;
      containers = header.containers;
      table = {
        columns: getTableColumnVisibilities(header.body, cells),
        timed: timedHeader !== null,
        delimiterIndex: index + 1,
      };
      return table.timed ? timing : null;
    }

    const line = cueLine ?? documentLine;
    containers = line.containers;
    const opener = matchFenceOpening(line.body)?.[1];
    if (opener) fence = { opener, literal: !timing };
    return timing;
  });
  return { timings, tableBreakVisibilities };
}

function parseInlineCuedDocument(
  source: string,
  lines: readonly SourceLine[],
  timings: readonly (InlineCueTiming | null)[],
  tableBreakVisibilities: ReadonlyMap<number, PedagogicalVisibility>,
  options: AstParseOptions,
  sealProofs: boolean,
  captionRowStarts?: ReadonlySet<number>,
  boundaryFloors?: ReadonlyMap<number, PedagogicalVisibility>,
  headingContext?: HeadingContext,
): PedagogicalAstBlock[] {
  const parts: string[] = [];
  const regions: TranscriptRegion[] = [];
  const timedRows = new Set<number>();
  const boundaryFloorByProjectedOffset = new Map<number, PedagogicalVisibility>();
  const observeHeading = headingContext?.onHeading;
  const projectedLineOrigins = observeHeading && new Map<number, number>();
  const bodies = lines.map((line, index) => line.raw.slice(timings[index]?.prefixLength ?? 0));
  const cueSeparator = createTranscriptCueSeparator(bodies);
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const timing = timings[index];
    const next = timings[index + 1];
    const body = bodies[index]!;
    projectedLineOrigins?.set(offset, line.start);
    const tableFloor = tableBreakVisibilities.get(index);
    const priorFloor = boundaryFloors?.get(line.start);
    const breakBefore = tableFloor !== undefined || priorFloor !== undefined;
    if (breakBefore) {
      boundaryFloorByProjectedOffset.set(offset, maxVisibility(tableFloor ?? "public", priorFloor ?? "public"));
    }
    const joinNext = Boolean(timing && next && !tableBreakVisibilities.has(index + 1) &&
      !boundaryFloors?.has(lines[index + 1]!.start));
    const separator = cueSeparator(index, joinNext, breakBefore);
    if (timing || captionRowStarts?.has(line.start)) timedRows.add(offset);
    if (timing) {
      const lineEnding = joinNext ? separator : source.slice(line.contentEnd, line.end);
      regions.push({
        start: offset, end: offset + body.length, sourceStart: line.start + timing.prefixLength,
        cue: { timing, lineStart: line.start },
      });
      parts.push(body, lineEnding);
      offset += body.length + lineEnding.length;
    } else {
      const previous = regions.at(-1);
      const end = offset + line.end - line.start;
      if (previous && !previous.cue && !breakBefore) previous.end = end;
      else regions.push({ start: offset, end, sourceStart: line.start });
      parts.push(source.slice(line.start, line.end));
      offset = end;
    }
  }

  const markdown = parts.join("");
  const readRange = readAstRanges(parsePedagogicalAstInternal(markdown, {
    defaultVisibility: options.defaultVisibility,
    propagateSectionVisibility: options.propagateSectionVisibility,
  }, sealProofs, timedRows, boundaryFloorByProjectedOffset, observeHeading ? {
    ...headingContext,
    onHeading: (projectedOffset, level) => {
      const original = projectedLineOrigins?.get(projectedOffset);
      if (original !== undefined) observeHeading(original, level);
    },
  } : headingContext));
  const blocks: PedagogicalAstBlock[] = [];
  for (const region of regions) {
    const { start, end, sourceStart, cue } = region;
    const sourceDelta = sourceStart - start;
    if (!cue) {
      readRange(start, end, (block, from, to) => {
        const startOffset = from + sourceDelta;
        const endOffset = to + sourceDelta;
        blocks.push({
          ...block, startOffset, endOffset, text: source.slice(startOffset, endOffset),
          ...resolvePageRange(startOffset, endOffset, options.pageSpans),
        });
      });
      continue;
    }

    const spans = start === end
      ? [{ start, end, visibility: "sealed" } satisfies CueSpan]
      : splitCueVisibility(markdown, start, end, options.defaultVisibility ?? "public", readRange, true);
    for (const span of spans) {
      const startOffset = span.start === start ? cue.lineStart : span.start + sourceDelta;
      const endOffset = span.end + sourceDelta;
      blocks.push({
        kind: span.construct?.kind ?? "transcript_cue",
        visibility: span.visibility,
        atomicConstruct: true,
        text: source.slice(startOffset, endOffset),
        startOffset,
        endOffset,
        ...resolvePageRange(startOffset, endOffset, options.pageSpans),
        startMs: cue.timing.startMs,
        endMs: cue.timing.endMs,
        keyframeChunkId: null,
        ...(span.construct?.label ? { label: span.construct.label } : {}),
      });
    }
  }
  return blocks;
}

/**
 * Parse a pedagogical document into an AST of blocks where indivisible
 * constructs (display math, theorem/lemma/proof/definition/example/solution
 * blocks, fenced code, Markdown pipe tables, and timestamped cues) are sealed
 * BEFORE chunk sizing or indexing.
 */
export function parsePedagogicalAst(
  text: string,
  options: AstParseOptions = {},
): PedagogicalAstBlock[] {
  return parsePedagogicalAstInternal(text, options, false);
}

function parsePedagogicalAstInternal(
  text: string,
  options: AstParseOptions,
  sealProofs: boolean,
  captionRowStarts?: ReadonlySet<number>,
  boundaryFloors?: ReadonlyMap<number, PedagogicalVisibility>,
  headingContext?: HeadingContext,
): PedagogicalAstBlock[] {
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  const lines = splitLinesWithOffsets(text);
  const { timings, tableBreakVisibilities } = scanInlineCueTimings(lines, captionRowStarts, boundaryFloors);
  if (timings.some(Boolean)) {
    return parseInlineCuedDocument(text, lines, timings, tableBreakVisibilities,
      options, sealProofs, captionRowStarts, boundaryFloors, headingContext);
  }
  const protectedCaptionUnderline = captionRowStarts && createProtectedSetextLookup(index => lines[index]?.raw);
  const blocks: PedagogicalAstBlock[] = [];
  const headingStack = headingContext?.stack ?? [];
  const sectionBaseVisibility = headingContext?.baseVisibility ?? defaultVisibility;
  let localHeading: HeadingScope | undefined;
  const getActiveSectionVisibility = (): PedagogicalVisibility =>
    maxVisibility(localHeading?.visibility ?? defaultVisibility,
      maxVisibility(defaultVisibility, headingStack.at(-1)?.visibility ?? sectionBaseVisibility));

  const parseInnerSlice = (
    start: number,
    end: number,
    visibility: PedagogicalVisibility,
    kind: PedagogicalBlockKind,
  ): MappedInnerBlock[] => {
    const slice = text.slice(start, end);
    const rebasedCaptions = captionRowStarts && new Set<number>();
    const rebasedFloors = boundaryFloors && new Map<number, PedagogicalVisibility>();
    if (rebasedCaptions || rebasedFloors) {
      for (const line of splitLinesWithOffsets(slice)) {
        const offset = start + line.start;
        if (captionRowStarts?.has(offset)) rebasedCaptions?.add(line.start);
        const floor = boundaryFloors?.get(offset);
        if (floor !== undefined) rebasedFloors?.set(line.start, floor);
      }
    }
    return parsePedagogicalAstInternal(
      slice,
      { defaultVisibility: visibility, propagateSectionVisibility },
      sealProofs || kind === "exercise",
      rebasedCaptions,
      rebasedFloors,
    ).map(block => ({
      ...block,
      startOffset: start + block.startOffset,
      endOffset: start + block.endOffset,
    }));
  };

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
    const inlineSpans = findInlineConstructSpans(text, rangeStart, rangeEnd, activeVis, sealProofs);
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
        const innerBlocks = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind);
        const higherBlocks = innerBlocks.filter(
          b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[span.visibility],
        );
        const safeLabel =
          span.summaryEndOffset != null &&
          higherBlocks.some(b => b.startOffset < span.summaryEndOffset! && b.endOffset > span.openEnd!)
            ? span.kind
            : span.label;
        emitContainerWithExtraction(
          span.kind,
          span.visibility,
          true,
          span.start,
          span.end,
          span.closeStart,
          safeLabel,
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

  const splitNonSealedSpan = (span: InlineConstructSpan): MappedInnerBlock[] => {
    if (
      span.openEnd === undefined ||
      span.closeStart === undefined ||
      span.visibility === "sealed" ||
      span.closeStart <= span.openEnd
    ) {
      return [
        {
          kind: span.kind,
          visibility: span.visibility,
          atomicConstruct: true,
          startOffset: span.start,
          endOffset: span.end,
          startMs: null,
          endMs: null,
          ...(span.label ? { label: span.label } : {}),
        },
      ];
    }

    const inner = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind);
    const higherInner = inner.filter(
      b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[span.visibility],
    );
    if (higherInner.length === 0) {
      return [
        {
          kind: span.kind,
          visibility: span.visibility,
          atomicConstruct: true,
          startOffset: span.start,
          endOffset: span.end,
          startMs: null,
          endMs: null,
          ...(span.label ? { label: span.label } : {}),
        },
      ];
    }

    const out: MappedInnerBlock[] = [];
    const safeSpanLabel =
      span.summaryEndOffset != null &&
      higherInner.some(b => b.startOffset < span.summaryEndOffset! && b.endOffset > span.openEnd!)
        ? span.kind
        : span.label ?? span.kind;
    let spanCursor = span.start;
    for (const hb of higherInner) {
      const pre = trimWhitespaceBounds(text, spanCursor, hb.startOffset, false);
      if (pre) {
        out.push({
          kind: span.kind,
          visibility: span.visibility,
          atomicConstruct: true,
          startOffset: pre.start,
          endOffset: pre.end,
          startMs: null,
          endMs: null,
          label: safeSpanLabel,
        });
      }
      out.push(hb);
      spanCursor = hb.endOffset;
    }
    const tail = trimWhitespaceBounds(text, spanCursor, span.closeStart, false);
    if (tail) {
      const fullTail = trimWhitespaceBounds(text, tail.start, span.end, false);
      if (fullTail) {
        out.push({
          kind: span.kind,
          visibility: span.visibility,
          atomicConstruct: true,
          startOffset: fullTail.start,
          endOffset: fullTail.end,
          startMs: null,
          endMs: null,
          label: safeSpanLabel,
        });
      }
    } else if (span.end > span.closeStart) {
      const closingBounds = trimWhitespaceBounds(text, span.closeStart, span.end, false);
      if (closingBounds) {
        out.push({
          kind: span.kind,
          visibility: span.visibility,
          atomicConstruct: true,
          startOffset: closingBounds.start,
          endOffset: closingBounds.end,
          startMs: null,
          endMs: null,
          label: safeSpanLabel,
        });
      }
    }
    return out;
  };

  const extractProtectedBlocksFromSpans = (
    inlineSpans: readonly InlineConstructSpan[],
    rangeEnd: number,
    activeVis: PedagogicalVisibility,
  ): MappedInnerBlock[] => {
    const extracted: MappedInnerBlock[] = [];
    for (const span of inlineSpans) {
      if (VISIBILITY_RANK[span.visibility] > VISIBILITY_RANK[activeVis]) {
        extracted.push(...splitNonSealedSpan(span));
      } else if (
        span.end > rangeEnd &&
        VISIBILITY_RANK[span.visibility] >= VISIBILITY_RANK["hint_gated"]
      ) {
        // Multi-line or unclosed sealed/hint_gated span extending past this line/block
        // must consume through `span.end` so a later same-level heading cannot reset visibility.
        extracted.push(...splitNonSealedSpan(span));
      } else if (
        span.kind !== "display_math" &&
        span.visibility !== "sealed" &&
        span.openEnd !== undefined &&
        span.closeStart !== undefined &&
        span.closeStart > span.openEnd
      ) {
        const inner = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind);
        for (const b of inner) {
          if (VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[activeVis]) {
            extracted.push(b);
          }
        }
      }
    }
    return extracted;
  };

  let quotedHeadings: HeadingScope[] = [];
  let quotedHeadingLevels: Map<number, number> | undefined;
  let quoteContinuesAt = -1;
  let tableHeadingFloor: { offset: number; visibility: PedagogicalVisibility } | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const raw = line.raw;

    if (/^\s*$/.test(raw)) {
      i++;
      continue;
    }

    // 1. Heading (and monotonic heading-stack section visibility propagation)
    const headingMatch = ATX_HEADING_RE.exec(raw);
    const setext = headingMatch ? null : readSetextParagraph(index => lines[index]?.raw, i);
    const level = headingMatch?.[1]?.length ?? setext?.level;
    const boundaryFloor = boundaryFloors?.get(line.start) ??
      (tableHeadingFloor?.offset === line.start ? tableHeadingFloor.visibility : "public");
    if (level !== undefined) {
      const headingLastIndex = setext?.index ?? i;
      const headingEnd = lines[headingLastIndex]!.contentEnd;
      const headingTextStart = headingMatch
        ? line.start + raw.indexOf(headingMatch[2]!, raw.indexOf(headingMatch[1]!) + level)
        : line.start;
      const headingTextEnd = headingMatch
        ? headingTextStart + headingMatch[2]!.length
        : lines[headingLastIndex - 1]!.contentEnd;
      const headingText = text.slice(headingTextStart, headingTextEnd).trim();
      const inlineEnd = setext ? headingTextEnd : headingEnd;
      const rawInlineSpans = findInlineConstructSpans(
        text,
        line.start,
        inlineEnd,
        defaultVisibility,
        sealProofs,
      );
      const nonMathInlineSpans = rawInlineSpans.filter(s => s.kind !== "display_math");
      const cleanHeadingTitle =
        nonMathInlineSpans.length > 0
          ? sanitizeHeaderLabel(
              text,
              headingTextStart,
              headingTextEnd,
              nonMathInlineSpans.map(s => ({ startOffset: s.start, endOffset: s.end })),
              "",
            )
          : headingText;
      const isSectionHeading = line.start > 0 || !headingContext?.firstHeadingIsLocal;
      if (isSectionHeading) headingContext?.onHeading?.(line.start, level);
      if (propagateSectionVisibility) {
        const ownVisibility: PedagogicalVisibility = SEALED_HEADING_RE.test(cleanHeadingTitle)
          ? "sealed"
          : HINT_HEADING_RE.test(cleanHeadingTitle)
            ? "hint_gated"
            : sectionBaseVisibility;
        const visibility = maxVisibility(ownVisibility, boundaryFloor);
        if (isSectionHeading) {
          if (localHeading && localHeading.level >= level) localHeading = undefined;
          while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
            headingStack.pop();
          }
          const parentVisibility = headingStack.at(-1)?.visibility ?? sectionBaseVisibility;
          headingStack.push({ level, visibility: maxVisibility(parentVisibility, visibility) });
        } else {
          localHeading = { level, visibility };
        }
      }
      const activeVis = maxVisibility(getActiveSectionVisibility(), boundaryFloor);
      const headingInlineSpans =
        rawInlineSpans.length > 0
          ? findInlineConstructSpans(text, line.start, inlineEnd, activeVis, sealProofs)
          : [];
      const extracted = extractProtectedBlocksFromSpans(headingInlineSpans, inlineEnd, activeVis);
      if (extracted.length > 0) {
        extracted.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
        const safeLabel = sanitizeHeaderLabel(text, headingTextStart, headingTextEnd, extracted, "heading");
        let cursor = line.start;
        for (const block of extracted) {
          if (block.startOffset > cursor) {
            const pre = trimWhitespaceBounds(text, cursor, block.startOffset, false);
            if (pre) {
              pushBlock("heading", activeVis, false, pre.start, pre.end, { label: safeLabel });
            }
          }
          pushBlock(block.kind, block.visibility, block.atomicConstruct, block.startOffset, block.endOffset, {
            startMs: block.startMs,
            endMs: block.endMs,
            ...(block.label ? { label: block.label } : {}),
          });
          cursor = Math.max(cursor, block.endOffset);
        }
        if (cursor > headingEnd) {
          const closeLineIdx = lineIndexContaining(lines, Math.max(line.start, cursor - 1), i);
          const closeLine = lines[closeLineIdx]!;
          const trailingOnCloseLine = text.slice(cursor, closeLine.contentEnd);
          if (!/^[ \t]*$/.test(trailingOnCloseLine)) {
            lines[closeLineIdx] = {
              start: cursor,
              contentEnd: closeLine.contentEnd,
              end: closeLine.end,
              raw: trailingOnCloseLine,
            };
            i = closeLineIdx;
          } else {
            i = closeLineIdx + 1;
          }
        } else {
          if (cursor < headingEnd) {
            const suf = trimWhitespaceBounds(text, cursor, headingEnd, false);
            if (suf) {
              pushBlock("heading", activeVis, false, suf.start, suf.end, { label: safeLabel });
            }
          }
          i = headingLastIndex + 1;
        }
        continue;
      }
      pushBlock("heading", activeVis, false, line.start, headingEnd, {
        label: headingText,
      });
      i = headingLastIndex + 1;
      continue;
    }

    const blockVisibility = maxVisibility(getActiveSectionVisibility(), boundaryFloor);
    if (THEMATIC_BREAK_RE.test(raw)) {
      pushBlock("prose", blockVisibility, false, line.start, line.contentEnd);
      i++;
      continue;
    }

    // 2. Fenced code block or tilde/backtick pedagogical fence (``` or ~~~)
    const fenceMatch = matchFenceOpening(raw);
    if (fenceMatch) {
      const opener = fenceMatch[1]!;
      const fenceChar = opener[0]!;
      const activeVis = blockVisibility;
      const infoRaw = fenceMatch[2]!;
      const infoMatch = /^[ \t]*\{?\.?([a-zA-Z][\w-]*)\}?([ \t].*)?$/.exec(infoRaw);
      const classified = infoMatch ? classifyLabel(infoMatch[1], activeVis, sealProofs) : null;
      const treatAsPedagogical =
        classified !== null &&
        (fenceChar === "~" || VISIBILITY_RANK[classified.visibility] > VISIBILITY_RANK[activeVis]);
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!.raw, opener)) j++;
      const closed = j < lines.length;
      const endLineIdx = closed ? j : lines.length - 1;
      const outerStart = line.start;
      const outerEnd = lines[endLineIdx]!.contentEnd;

      if (treatAsPedagogical && classified) {
        const restStr = infoMatch![2] ?? "";
        const headerRestStart = line.contentEnd - restStr.length;
        const bodyEnd = closed
          ? endLineIdx > i + 1
            ? lines[endLineIdx - 1]!.contentEnd
            : line.contentEnd
          : outerEnd;
        const fallbackLabel = infoMatch![1]!;
        if (classified.visibility !== "sealed" && bodyEnd > headerRestStart) {
          const innerBlocks = parseInnerSlice(headerRestStart, bodyEnd, classified.visibility, classified.kind);
          const higherBlocks = innerBlocks.filter(
            b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[classified.visibility],
          );
          const safeLabel = sanitizeHeaderLabel(
            text,
            headerRestStart,
            line.contentEnd,
            higherBlocks,
            fallbackLabel,
          );
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            outerStart,
            outerEnd,
            bodyEnd,
            safeLabel,
            false,
            innerBlocks,
          );
        } else {
          const label = restStr.trim() || fallbackLabel;
          pushBlock(classified.kind, classified.visibility, true, outerStart, outerEnd, { label });
        }
      } else {
        // A missing closer makes it ambiguous whether following protected Markdown is code.
        pushBlock("code", closed ? activeVis : "sealed", true, outerStart, outerEnd);
      }
      i = endLineIdx + 1;
      continue;
    }

    // 3. Fenced pedagogical container (:::theorem ... :::)
    const containerMatch = /^[ \t]{0,3}(:{3,})[ \t]*([a-zA-Z][\w-]*)(.*)$/.exec(raw);
    if (containerMatch) {
      const activeVis = blockVisibility;
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
        const fallbackLabel = containerMatch[2]!;
        const outerStart = line.start;
        const outerEnd = lines[endLineIdx]!.contentEnd;
        const headerRestStart = line.start + containerMatch[0].length - containerMatch[3]!.length;
        const bodyEnd = closed
          ? endLineIdx > i + 1
            ? lines[endLineIdx - 1]!.contentEnd
            : line.contentEnd
          : outerEnd;

        if (classified.visibility !== "sealed" && bodyEnd > headerRestStart) {
          const innerBlocks = parseInnerSlice(headerRestStart, bodyEnd, classified.visibility, classified.kind);
          const higherBlocks = innerBlocks.filter(
            b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[classified.visibility],
          );
          const safeLabel = sanitizeHeaderLabel(
            text,
            headerRestStart,
            line.contentEnd,
            higherBlocks,
            fallbackLabel,
          );
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            outerStart,
            outerEnd,
            bodyEnd,
            safeLabel,
            false,
            innerBlocks,
          );
        } else {
          const label = containerMatch[3]!.trim() || fallbackLabel;
          pushBlock(classified.kind, classified.visibility, true, outerStart, outerEnd, { label });
        }
        i = endLineIdx + 1;
        continue;
      }
    }

    const tableHeaderCells = pipeTableHeaderCells(line, lines[i + 1]?.raw);

    // 4. LaTeX environment (\begin{equation|align|theorem|lemma|proof|definition|solution}...)
    const envMatch = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(raw);
    if (envMatch && !tableHeaderCells) {
      const envName = envMatch[1]!;
      const activeVis = blockVisibility;
      const isMath = MATH_ENVS.has(envName);
      const classified = isMath
        ? { kind: "display_math" as const, visibility: activeVis }
        : classifyLabel(envName, activeVis, sealProofs);
      if (classified) {
        const leadingWs = envMatch[0].length - envMatch[0].trimStart().length;
        const envStart = line.start + leadingWs;
        const openEndOffset = line.start + envMatch[0].length;
        const math = isMath ? findMathEnvironment(text, envName, openEndOffset) : null;
        const { closeStart, closeEnd } = math ?? findMatchingLatexEnvBounds(text, envName, openEndOffset);
        const endLineIdx = lineIndexContaining(lines, Math.max(envStart, closeEnd - 1), i);
        const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
        const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
        const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

        if (!isMath && classified.visibility !== "sealed" && closeStart > openEndOffset) {
          const innerBlocks = parseInnerSlice(openEndOffset, closeStart, classified.visibility, classified.kind);
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
          const visibility = math?.closed === false ? "sealed" : classified.visibility;
          pushBlock(classified.kind, visibility, true, envStart, outerEnd, {
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

    // 4b. HTML <details> block (spoiler / hint / solution disclosure; fails closed if unclosed)
    const detailsOpenMatch = DETAILS_OPEN_RE.exec(raw.trimStart());
    if (detailsOpenMatch) {
      const activeVis = blockVisibility;
      const leadingWs = raw.length - raw.trimStart().length;
      const detailsStart = line.start + leadingWs;
      const openEndOffset = detailsStart + detailsOpenMatch[0].length;
      const bounds = findMatchingDetailsBounds(text, openEndOffset);
      const { closeStart, closeEnd } = bounds;
      const classified = classifyDetailsElement(text, openEndOffset, bounds, activeVis);
      const endLineIdx = lineIndexContaining(lines, Math.max(detailsStart, closeEnd - 1), i);
      const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
      const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
      const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

      if (classified.visibility !== "sealed" && closeStart > openEndOffset) {
        const innerBlocks = parseInnerSlice(openEndOffset, closeStart, classified.visibility, classified.kind);
        const higherBlocks = innerBlocks.filter(
          b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[classified.visibility],
        );
        const safeLabel =
          classified.summaryEndOffset != null &&
          higherBlocks.some(b => b.startOffset < classified.summaryEndOffset! && b.endOffset > openEndOffset)
            ? classified.kind
            : classified.label;
        emitContainerWithExtraction(
          classified.kind,
          classified.visibility,
          true,
          detailsStart,
          outerEnd,
          closeStart,
          safeLabel,
          false,
          innerBlocks,
        );
      } else {
        pushBlock(classified.kind, classified.visibility, true, detailsStart, outerEnd, {
          label: classified.label,
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

    // 5. Display math ($$...$$ or \[...\])
    const mathMatch = /^[ \t]*(\$\$|\\\[)/.exec(raw);
    if (mathMatch && !tableHeaderCells) {
      const leadingWs = mathMatch[0].length - mathMatch[1]!.length;
      const startOffset = line.start + leadingWs;
      const { end, closed } = findMathDelimiter(text, startOffset, mathMatch[1] === "$$" ? "$$" : "\\]");
      const endLineIdx = lineIndexContaining(lines, end - 1, i);
      const closeLine = lines[endLineIdx]!;
      const trailing = text.slice(end, closeLine.contentEnd);
      const hasTrailingContent = !/^[ \t]*$/.test(trailing);
      pushBlock(
        "display_math",
        closed ? blockVisibility : "sealed",
        true,
        startOffset,
        hasTrailingContent ? end : Math.max(end, closeLine.contentEnd),
      );
      if (hasTrailingContent) {
        lines[endLineIdx] = { ...closeLine, start: end, raw: trailing };
        i = endLineIdx;
      } else {
        i = endLineIdx + 1;
      }
      continue;
    }

    // 7. Markdown callout (> [!theorem], > [!proof], > [!solution], ...) and blockquotes
    if (i !== quoteContinuesAt) {
      quotedHeadings = [];
      quotedHeadingLevels = undefined;
    }
    const calloutMatch = CALLOUT_RE.exec(raw);
    if (calloutMatch) {
      const quotedHeading = quotedHeadings.at(-1);
      const intrinsic = classifyLabel(calloutMatch[1], blockVisibility, sealProofs);
      if (intrinsic) {
        const activeVis = maxVisibility(blockVisibility, quotedHeading?.visibility ?? "public");
        const classified = { ...intrinsic, visibility: maxVisibility(intrinsic.visibility, activeVis) };
        const inheritedSection = quotedHeading &&
          VISIBILITY_RANK[classified.visibility] > VISIBILITY_RANK[intrinsic.visibility] ? quotedHeading : undefined;
        if (inheritedSection && !quotedHeadingLevels) {
          // Only a heading at this quote depth can end the inherited section.
          const levels = new Map<number, number>();
          const quoteEnd = findBlockquoteEnd(lines, i, () => false);
          parsePrefixedInnerBlocks(
            lines, i, quoteEnd - 1, null, activeVis, false, sealProofs, captionRowStarts, boundaryFloors,
            quoted => ({
              length: CALLOUT_RE.test(quoted.raw) ? quoted.raw.length : BLOCKQUOTE_PREFIX_RE.exec(quoted.raw)?.[0].length ?? 0,
              padding: 0,
            }),
            { onHeading: (offset, level) => levels.set(offset, level) },
          );
          quotedHeadingLevels = levels;
        }
        let resetAt: number | undefined;
        const j = findBlockquoteEnd(lines, i, (candidate, index) => {
          const next = classifyLabel(CALLOUT_RE.exec(candidate)?.[1], blockVisibility, sealProofs);
          // A stronger explicit callout starts a new block even under an inherited floor.
          if (next && VISIBILITY_RANK[next.visibility] > VISIBILITY_RANK[intrinsic.visibility]) return true;
          const level = quotedHeadingLevels?.get(lines[index]!.start);
          if (inheritedSection && level !== undefined && level <= inheritedSection.level) {
            if (intrinsic.visibility === "public") return true;
            resetAt ??= index;
          }
          return false;
        });
        quoteContinuesAt = j;
        let endLineIdx = j - 1;
        while (endLineIdx > i && /^[ \t]*>[ \t]*$/.test(lines[endLineIdx]!.raw)) {
          endLineIdx--;
        }
        const fallbackLabel = calloutMatch[1]!;
        const outerStart = line.start;
        const outerEnd = lines[endLineIdx]!.contentEnd;

        if (resetAt !== undefined) {
          // The heading ends the inherited section while the explicit hint continues.
          const resetStart = lines[resetAt]!.start;
          pushBlock(classified.kind, classified.visibility, true, outerStart, lines[resetAt - 1]!.contentEnd);
          const innerBlocks = parsePrefixedInnerBlocks(
            lines, resetAt, endLineIdx, null, intrinsic.visibility, propagateSectionVisibility, sealProofs,
            captionRowStarts, boundaryFloors, undefined,
            { stack: quotedHeadings, baseVisibility: getActiveSectionVisibility() },
          );
          emitContainerWithExtraction(
            intrinsic.kind, intrinsic.visibility, true, resetStart, outerEnd, outerEnd, undefined, true, innerBlocks,
          );
        } else if (classified.visibility !== "sealed") {
          const headerRestStart = line.start + calloutMatch[0].length - calloutMatch[2]!.length;
          const innerBlocks = parsePrefixedInnerBlocks(
            lines,
            i,
            endLineIdx,
            headerRestStart,
            classified.visibility,
            propagateSectionVisibility,
            sealProofs || classified.kind === "exercise",
            captionRowStarts,
            boundaryFloors,
            undefined,
            { stack: quotedHeadings, baseVisibility: getActiveSectionVisibility(), firstHeadingIsLocal: true },
          );
          const higherBlocks = innerBlocks.filter(
            b => VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[classified.visibility],
          );
          const safeLabel = sanitizeHeaderLabel(
            text,
            headerRestStart,
            line.contentEnd,
            higherBlocks,
            fallbackLabel,
          );
          emitContainerWithExtraction(
            classified.kind,
            classified.visibility,
            true,
            outerStart,
            outerEnd,
            outerEnd,
            safeLabel,
            true,
            innerBlocks,
          );
        } else {
          const label = calloutMatch[2]!.trim() || fallbackLabel;
          pushBlock(classified.kind, classified.visibility, true, outerStart, outerEnd, { label });
        }
        i = j;
        continue;
      }
    }

    if (BLOCKQUOTE_PREFIX_RE.test(raw)) {
      const activeVis = getActiveSectionVisibility();
      const j = findBlockquoteEnd(lines, i, candidate =>
        classifyLabel(CALLOUT_RE.exec(candidate)?.[1], activeVis, sealProofs) !== null,
      );
      quoteContinuesAt = j;
      let endLineIdx = j - 1;
      while (endLineIdx > i && /^[ \t]*>[ \t]*$/.test(lines[endLineIdx]!.raw)) {
        endLineIdx--;
      }
      const outerStart = line.start;
      const outerEnd = lines[endLineIdx]!.contentEnd;

      if (activeVis !== "sealed") {
        const innerBlocks = parsePrefixedInnerBlocks(
          lines,
          i,
          endLineIdx,
          null,
          activeVis,
          propagateSectionVisibility,
          sealProofs,
          captionRowStarts,
          boundaryFloors,
          undefined,
          { stack: quotedHeadings, baseVisibility: activeVis },
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

    // Project the item with its indentation removed, including lazy lines
    // owned by a quoted paragraph inside the item.
    const listMatch = LIST_ITEM_RE.exec(raw);
    if (listMatch) {
      const contentIndent = listContentIndent(listMatch[1]!);
      const quote: QuoteParagraph = { open: false };
      const firstQuote = innermostQuoteBody(raw.slice(listMatch[0].length));
      if (firstQuote !== null) updateQuotedParagraph(quote, firstQuote);
      let endLineIdx = i;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j]!.raw;
        if (!candidate.trim()) {
          quote.open = false;
          quote.fence = undefined;
          continue;
        }
        const { length, padding } = listContinuationPrefix(candidate, contentIndent);
        const next = lines[j + 1]?.raw;
        if (!length) {
          if (!continuesLazyQuote(quote, candidate, next)) break;
        } else {
          const body = " ".repeat(padding) + candidate.slice(length);
          const quoted = innermostQuoteBody(body);
          if (quoted !== null) updateQuotedParagraph(quote, quoted);
          else if (!continuesLazyQuote(quote, body, next)) {
            quote.open = false;
            quote.fence = undefined;
          }
        }
        endLineIdx = j;
      }
      const activeVis = getActiveSectionVisibility();
      const innerBlocks = parsePrefixedInnerBlocks(
        lines,
        i,
        endLineIdx,
        null,
        activeVis,
        propagateSectionVisibility,
        sealProofs,
        captionRowStarts,
        boundaryFloors,
        (bodyLine, index) => index === i
          ? { length: listMatch[0].length, padding: 0 }
          : listContinuationPrefix(bodyLine.raw, contentIndent),
      );
      const end = lines[endLineIdx]!.contentEnd;
      emitContainerWithExtraction("prose", activeVis, false, line.start, end, end, undefined, false, innerBlocks);
      i = endLineIdx + 1;
      continue;
    }

    // 8. Markdown / pipe table (extracts inline sealed/hint constructs & sealed/hint columns)
    if (tableHeaderCells) {
      let j = i + 2;
      const columns = getTableColumnVisibilities(raw, tableHeaderCells, line.start);
      while (j < lines.length) {
        const row = lines[j]!;
        if (boundaryFloors?.has(row.start)) break;
        const isCaptionRow = captionRowStarts?.has(row.start);
        if (!isPipeTableBodyRow(row.raw) && !(isCaptionRow && isCaptionTableBodyRow(row.raw))) {
          // A pipe-separated heading can also carry values from the table it ends.
          if (ATX_HEADING_RE.test(row.raw) && parseTableRowCells(row).hasSeparator) {
            tableHeadingFloor = { offset: row.start, visibility: timedTableRowVisibility(row.raw, columns, false) };
          }
          break;
        }
        if (isCaptionRow && protectedCaptionUnderline) {
          const candidate = readMarkdownContainerLine(row.raw);
          if (protectedCaptionUnderline(j, candidate, columns, true) !== undefined) break;
        }
        j++;
      }
      const endLineIdx = j - 1;
      const activeVis = getActiveSectionVisibility();
      const tableStart = line.start;
      const tableEnd = lines[endLineIdx]!.contentEnd;

      const inlineSpans = findInlineConstructSpans(text, tableStart, tableEnd, activeVis, sealProofs, true);
      const extracted = extractProtectedBlocksFromSpans(inlineSpans, tableEnd, activeVis);

      extracted.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

      // Extract data cells belonging to sealed / hint-gated columns (e.g. Answer Key / Solution / Hint).
      const headerCells = activeVis === "sealed" ? [] : tableHeaderCells;
      const colPolicies = headerCells.map(cell => {
        const cellText = sanitizeHeaderLabel(text, cell.start, cell.end, extracted, "");
        const visibility = tableColumnVisibility(cellText);
        if (visibility === "sealed") {
          return { kind: "solution" as const, visibility: maxVisibility("sealed", activeVis), label: cellText };
        }
        if (visibility === "hint_gated") {
          const vis = maxVisibility("hint_gated", activeVis);
          return VISIBILITY_RANK[vis] > VISIBILITY_RANK[activeVis]
            ? { kind: "hint" as const, visibility: vis, label: cellText }
            : null;
        }
        return null;
      });

      if (colPolicies.some(Boolean)) {
        for (let rowIdx = i + 2; rowIdx <= endLineIdx; rowIdx++) {
          const row = lines[rowIdx]!;
          // A short caption row can start with the separator for an empty
          // first cell. Keep that position without altering document GFM rows.
          const { cells: rowCells, leadingEmptyCell } = parseTableBodyRowCells(
            row, headerCells.length, captionRowStarts?.has(row.start) === true, inlineSpans,
          );
          for (let colIdx = 0; colIdx < Math.min(colPolicies.length, rowCells.length); colIdx++) {
            const columnPolicy = colPolicies[colIdx];
            // An omitted edge pipe is ambiguous on a short caption row. Keep
            // the stronger policy if the ordinary GFM alignment also fits.
            const alternatePolicy = leadingEmptyCell ? colPolicies[colIdx - 1] : null;
            const policy = alternatePolicy &&
              (!columnPolicy || VISIBILITY_RANK[alternatePolicy.visibility] > VISIBILITY_RANK[columnPolicy.visibility])
              ? alternatePolicy
              : columnPolicy;
            if (!policy) continue;
            const bounds = trimWhitespaceBounds(text, rowCells[colIdx]!.start, rowCells[colIdx]!.end, false);
            if (!bounds) continue;
            const overlapping = extracted
              .filter(b => b.endOffset > bounds.start && b.startOffset < bounds.end)
              .sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
            if (overlapping.length === 0) {
              extracted.push({
                kind: policy.kind,
                visibility: policy.visibility,
                atomicConstruct: true,
                startOffset: bounds.start,
                endOffset: bounds.end,
                startMs: null,
                endMs: null,
                label: policy.label,
              });
            } else {
              let cCur = bounds.start;
              for (const ov of overlapping) {
                if (ov.startOffset > cCur) {
                  const pre = trimWhitespaceBounds(text, cCur, ov.startOffset, false);
                  if (pre) {
                    extracted.push({
                      kind: policy.kind,
                      visibility: policy.visibility,
                      atomicConstruct: true,
                      startOffset: pre.start,
                      endOffset: pre.end,
                      startMs: null,
                      endMs: null,
                      label: policy.label,
                    });
                  }
                }
                if (VISIBILITY_RANK[ov.visibility] < VISIBILITY_RANK[policy.visibility]) {
                  const idx = extracted.indexOf(ov);
                  if (idx !== -1) {
                    extracted[idx] = { ...ov, kind: policy.kind, visibility: policy.visibility };
                  }
                }
                cCur = Math.max(cCur, ov.endOffset);
              }
              if (cCur < bounds.end) {
                const suf = trimWhitespaceBounds(text, cCur, bounds.end, false);
                if (suf) {
                  extracted.push({
                    kind: policy.kind,
                    visibility: policy.visibility,
                    atomicConstruct: true,
                    startOffset: suf.start,
                    endOffset: suf.end,
                    startMs: null,
                    endMs: null,
                    label: policy.label,
                  });
                }
              }
            }
          }
        }
      }

      if (extracted.length === 0) {
        pushBlock("table", activeVis, true, tableStart, tableEnd);
        i = j;
        continue;
      }

      extracted.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

      const pushTableFragment = (fragStart: number, fragEnd: number) => {
        const trimmed = trimWhitespaceBounds(text, fragStart, fragEnd, false);
        if (!trimmed) return;
        const slice = text.slice(trimmed.start, trimmed.end);
        if (/^[|\s:-]+$/.test(slice)) return;
        pushBlock("table", activeVis, true, trimmed.start, trimmed.end);
      };

      let cursor = tableStart;
      for (const block of extracted) {
        if (block.startOffset > cursor) {
          pushTableFragment(cursor, block.startOffset);
        }
        pushBlock(block.kind, block.visibility, block.atomicConstruct, block.startOffset, block.endOffset, {
          startMs: block.startMs,
          endMs: block.endMs,
          ...(block.label ? { label: block.label } : {}),
        });
        cursor = Math.max(cursor, block.endOffset);
      }

      if (cursor > tableEnd) {
        const closeLineIdx = lineIndexContaining(lines, Math.max(tableStart, cursor - 1), i);
        const closeLine = lines[closeLineIdx]!;
        const trailingOnCloseLine = text.slice(cursor, closeLine.contentEnd);
        if (!/^[ \t]*$/.test(trailingOnCloseLine)) {
          lines[closeLineIdx] = {
            start: cursor,
            contentEnd: closeLine.contentEnd,
            end: closeLine.end,
            raw: trailingOnCloseLine,
          };
          i = closeLineIdx;
        } else {
          i = closeLineIdx + 1;
        }
        continue;
      }

      if (cursor < tableEnd) {
        pushTableFragment(cursor, tableEnd);
      }
      i = j;
      continue;
    }

    // 10. Prose paragraph (with embedded inline display-math & pedagogical-env protection)
    let j = i + 1;
    while (j < lines.length && !boundaryFloors?.has(lines[j]!.start) && !startsSpecialBlock(lines, j)) j++;
    const paraStart = line.start;
    const paraEnd = lines[j - 1]!.contentEnd;
    i = emitInlineConstructsRange(paraStart, paraEnd, blockVisibility, i, j);
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
    let paragraphCut: number | undefined;
    let latexCut: number | undefined;
    let lineCut: number | undefined;
    let previousBreakStart = -1;
    let previousBreakEnd = -1;
    for (const newline of windowText.matchAll(/\r\n?|\n/g)) {
      const offset = start + newline.index;
      const end = offset + newline[0].length;
      if (end === limit && text[end - 1] === "\r" && text[end] === "\n") break;
      if (offset === previousBreakEnd && previousBreakStart >= minBreak) paragraphCut = end;
      if (offset - 2 >= minBreak && text.slice(offset - 2, offset) === "\\\\") latexCut = end;
      if (offset >= minBreak) lineCut = end;
      previousBreakStart = offset;
      previousBreakEnd = end;
    }
    let cut = paragraphCut ?? latexCut ?? lineCut ?? -1;

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

    if (cut === -1) cut = limit;
    if (text[cut - 1] === "\r" && text[cut] === "\n") cut--;
    const safeCut = adjustAwayFromSurrogateAndLatex(text, start, cut);
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
  const cueStarts: number[] = [];
  const captionRowStarts = new Set<number>();
  const textParts: string[] = [];
  const boundaryLines: { cueIndex: number; offset: number; visibility: PedagogicalVisibility }[] = [];
  const cueSeparator = createTranscriptCueSeparator(input.cues.map(cue => cue.text), (cueIndex, offset, visibility) => {
    boundaryLines.push({ cueIndex, offset, visibility });
  });
  let virtualOffset = 0;
  for (const [index, cue] of input.cues.entries()) {
    cueStarts.push(virtualOffset);
    for (const { start } of splitLinesWithOffsets(cue.text)) captionRowStarts.add(virtualOffset + start);
    const separator = cueSeparator(index);
    textParts.push(cue.text, separator);
    virtualOffset += cue.text.length + separator.length;
  }
  const text = textParts.join("");
  const boundaryFloorByProjectedOffset = new Map<number, PedagogicalVisibility>();
  for (const boundary of boundaryLines) {
    const offset = cueStarts[boundary.cueIndex]! + boundary.offset;
    const existing = boundaryFloorByProjectedOffset.get(offset) ?? "public";
    boundaryFloorByProjectedOffset.set(offset, maxVisibility(existing, boundary.visibility));
  }
  const readRange = readAstRanges(parsePedagogicalAstInternal(
    text, { defaultVisibility }, false, captionRowStarts, boundaryFloorByProjectedOffset,
  ));
  const chunks: PedagogicalChunk[] = [];
  let seq = 0;
  let originalOffset = 0;

  for (const [cueIndex, cue] of input.cues.entries()) {
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs < cue.startMs
    ) {
      throw new RangeError(`Invalid transcript cue range [${cue.startMs}, ${cue.endMs}]`);
    }
    const start = cueStarts[cueIndex]!;
    const end = start + cue.text.length;
    const offsetAdjustment = start - originalOffset;
    originalOffset += cue.text.length + 1;
    if (!cue.text) continue;

    const visibilityFloor = maxVisibility(defaultVisibility, cue.visibility ?? defaultVisibility);
    const spans = splitCueVisibility(text, start, end, visibilityFloor, readRange);

    for (const span of spans) {
      const spanText = text.slice(span.start, span.end);
      const oversizedSplit = spanText.length > maxSealedChars;
      const parts = oversizedSplit
        ? safeSubsplitText(spanText, maxSealedChars)
        : [{ text: spanText, start: 0, end: spanText.length }];
      for (const part of parts) {
        chunks.push({
          id: `${input.sourceId}:v${input.sourceVersion}:m${seq++}`,
          sourceId: input.sourceId,
          sourceVersion: input.sourceVersion,
          ...(input.privacyEpoch !== undefined ? { privacyEpoch: input.privacyEpoch } : {}),
          kind: "transcript_cue",
          constructKinds: ["transcript_cue"],
          visibility: span.visibility,
          atomicConstruct: true,
          text: part.text,
          // Public offsets still use a single separator between cues.
          startOffset: span.start + part.start - offsetAdjustment,
          endOffset: span.start + part.end - offsetAdjustment,
          pageStart: null,
          pageEnd: null,
          startMs: cue.startMs,
          endMs: cue.endMs,
          keyframeChunkId: cue.keyframeChunkId ?? null,
          oversizedSplit,
          ...(cue.itemFamilyId ? { itemFamilyId: cue.itemFamilyId } : {}),
          ...(cue.conceptIds?.length ? { conceptIds: [...cue.conceptIds] } : {}),
          ...(cue.label && spans.length === 1 ? { label: cue.label } : {}),
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
