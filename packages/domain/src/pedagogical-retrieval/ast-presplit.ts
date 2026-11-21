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
const DETAILS_OPEN_RE = /^<details(?:\s[^>]*)?>/i;

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
  visibilityFloor?: PedagogicalVisibility;
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
  const tokenRe = /\\(begin|end)\{([a-zA-Z][\w-]*\*?)\}/g;
  tokenRe.lastIndex = searchFrom;
  const stack: string[] = [envName];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    if (tokenRe.lastIndex > limit) break;
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
  return { closeStart: limit, closeEnd: limit };
}

function lineIndexContaining(lines: readonly SourceLine[], offset: number, startHint: number): number {
  let idx = startHint;
  while (idx + 1 < lines.length && lines[idx]!.end <= offset) idx++;
  return idx;
}

function findMatchingDetailsBounds(
  text: string,
  searchFrom: number,
): { readonly closeStart: number; readonly closeEnd: number } {
  const tokenRe = /<(\/?)details(?:\s[^>]*)?>/gi;
  tokenRe.lastIndex = searchFrom;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match[1] === "/") {
      depth--;
      if (depth === 0) {
        return { closeStart: match.index, closeEnd: match.index + match[0].length };
      }
    } else {
      depth++;
    }
  }
  return { closeStart: text.length, closeEnd: text.length };
}

function classifyDetailsElement(
  text: string,
  openEnd: number,
  closeStart: number,
  activeVisibility: PedagogicalVisibility,
): {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label: string;
  readonly summaryEndOffset: number | null;
} {
  const inner = text.slice(openEnd, closeStart);
  const summaryMatch = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i.exec(inner);
  if (summaryMatch) {
    const summaryText = summaryMatch[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const summaryEndOffset = openEnd + summaryMatch[0].length;
    if (
      !SEALED_HEADING_RE.test(summaryText) &&
      !/\bspoiler\b/i.test(summaryText) &&
      !/<details\b/i.test(summaryMatch[1]!) &&
      HINT_HEADING_RE.test(summaryText)
    ) {
      return {
        kind: "hint",
        visibility: maxVisibility("hint_gated", activeVisibility),
        label: summaryText || "hint",
        summaryEndOffset,
      };
    }
    return {
      kind: "solution",
      visibility: maxVisibility("sealed", activeVisibility),
      label: summaryText || "solution",
      summaryEndOffset,
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

function timedTableRowVisibility(raw: string, columns: readonly PedagogicalVisibility[]): PedagogicalVisibility {
  if (columns.every(visibility => visibility === "public")) return "public";
  const { cells, hasSeparator } = parseTableRowCells({ raw, start: 0 });
  if (!hasSeparator) return "public";
  let visibility: PedagogicalVisibility = "public";
  for (const [index, cell] of cells.entries()) {
    const column = columns[index];
    if (column && raw.slice(cell.start, cell.end).trim()) visibility = maxVisibility(visibility, column);
  }
  return visibility;
}

function matchFenceOpening(line: string): RegExpExecArray | null {
  const match = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return match && !(match[1]![0] === "`" && match[2]!.includes("`")) ? match : null;
}

function closesFence(line: string, opener: string): boolean {
  const match = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return match !== undefined && match[0] === opener[0] && match.length >= opener.length;
}

function createTranscriptCueSeparator() {
  let containers: MarkdownContainer[] = [];
  let previousBody = "";
  let inTable = false;
  return (text: string, next?: string): string => {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const current = readMarkdownContainerLine(line, containers);
      const sameContainer = current.continuedDepth === containers.length &&
        current.continuedDepth === current.containers.length;
      inTable = sameContainer && (
        (inTable && isPipeTableBodyRow(current.body)) || isPipeTableStart(previousBody, current.body)
      );
      containers = current.containers;
      previousBody = current.body;
    }
    if (next === undefined) return "";
    const nextLine = next.split(/\r?\n/, 1)[0]!;
    const continued = continueMarkdownContainers(nextLine, containers);
    const continuesTable = continued.depth === containers.length && (
      (inTable && isPipeTableBodyRow(continued.body)) || isPipeTableStart(previousBody, continued.body)
    );
    const continuesQuote = innermostQuoteBody(lines.at(-1)!) !== null && innermostQuoteBody(nextLine) !== null;
    const continuesSetext = continued.depth === containers.length && SETEXT_UNDERLINE_RE.test(continued.body);
    const continuesPipeParagraph = continued.depth === containers.length &&
      isPipeParagraphLine(previousBody) && isPipeParagraphLine(continued.body);
    if (continuesTable || continuesQuote || continuesSetext || continuesPipeParagraph) return "\n";

    // The synthetic paragraph break also ends any table.
    previousBody = "";
    inTable = false;
    return "\n\n";
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
  let newline = text.indexOf("\n", afterOpen);
  while (newline >= 0 && newline < through) {
    const lineStart = newline + 1;
    const nextNewline = text.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const nextLineEnd = nextNewline === -1 ? -1 : text.indexOf("\n", nextNewline + 1);
    const nextLine = nextNewline === -1 ? "" : text.slice(nextNewline + 1, nextLineEnd === -1 ? text.length : nextLineEnd).replace(/\r$/, "");
    const current = readMarkdownContainerLine(line, containers);
    if (current.continuedDepth !== containers.length || current.continuedDepth !== current.containers.length) {
      paragraphStart = undefined;
    }
    containers = current.containers;
    const body = current.body.trimStart();
    const latex = /^\\begin\{([a-zA-Z][\w-]*\*?)\}/.exec(body);
    const beforeLine = text[newline - 1] === "\r" ? newline - 1 : newline;
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
  const inline = /<details(?=[\s>])|\\begin\{([a-zA-Z][\w-]*\*?)\}/gi;
  const inlineText = text.slice(afterOpen, Math.min(boundary, through));
  for (const match of inlineText.matchAll(inline)) {
    const start = afterOpen + match.index;
    if (!match[1]) return start;
    const classified = classifyLabel(match[1], "public");
    if (classified && classified.visibility !== "public" && !isEscaped(text, start)) return start;
  }
  return boundary;
}

function findMathDelimiter(text: string, start: number, token: "$$" | "\\]") {
  const afterOpen = start + 2;
  const close = findUnescapedToken(text, token, afterOpen);
  const boundary = findMathBoundary(text, afterOpen, close < 0 ? text.length : close);
  if (close === -1 || close >= boundary) return { end: boundary, closed: false };

  if (token === "$$") {
    const openerLineStart = text.lastIndexOf("\n", start - 1) + 1;
    const closerLineStart = text.lastIndexOf("\n", close - 1) + 1;
    const closerNewline = text.indexOf("\n", close + 2);
    const closerLineEnd = closerNewline === -1 ? text.length : closerNewline;
    const openerNewline = text.indexOf("\n", afterOpen);
    const flowOpener = closerLineStart > openerLineStart
      && !text.slice(openerLineStart, start).trim()
      && !text.slice(afterOpen, openerNewline).trim();
    const standaloneCloser = !text.slice(closerLineStart, close).trim()
      && !text.slice(close + 2, closerLineEnd).trim();
    const startsLaterFormula = closerLineStart > openerLineStart
      && !text.slice(closerLineStart, close).trim()
      && !standaloneCloser;
    if ((flowOpener && !standaloneCloser) || startsLaterFormula) {
      const newline = closerLineStart - 1;
      const end = text[newline - 1] === "\r" ? newline - 1 : newline;
      return { end, closed: false };
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
  interruptsQuote: (line: string) => boolean,
): number {
  const state: QuoteParagraph = { open: false };
  for (let index = start; index < lines.length; index++) {
    const raw = lines[index]!.raw;
    if (BLOCKQUOTE_PREFIX_RE.test(raw)) {
      if (!state.fence && index > start && interruptsQuote(raw)) return index;
      updateQuotedParagraph(state, innermostQuoteBody(raw)!);
    } else if (!continuesLazyQuote(state, raw, lines[index + 1]?.raw)) {
      return index;
    }
  }
  return lines.length;
}

function findSetextUnderline(lines: readonly SourceLine[], firstLine: number) {
  const titleStart = lines[firstLine]!.raw;
  if (
    startsSpecialBlock(lines, firstLine) ||
    /^(?: {4}| {0,3}\t)/.test(titleStart)
  ) return null;

  for (let index = firstLine + 1; index < lines.length; index++) {
    const raw = lines[index]!.raw;
    const underline = SETEXT_UNDERLINE_RE.exec(raw);
    if (underline) return { index, level: underline[1]![0] === "=" ? 1 : 2 };
    if (startsSpecialBlock(lines, index)) break;
  }
  return null;
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
  const newline = text.indexOf("\n", start);
  const lineEnd = newline === -1 ? end : Math.min(end, newline);
  if (marker === "\x60") {
    const runs = /\x60+/g;
    runs.lastIndex = start;
    const length = runs.exec(text)![0].length;
    for (let next = runs.exec(text); next && runs.lastIndex <= lineEnd; next = runs.exec(text)) {
      if (next[0].length === length) return runs.lastIndex;
    }
    return -1;
  }

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
        const classified = classifyDetailsElement(text, openEnd, bounds.closeStart, activeVisibility);
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

function parsePrefixedInnerBlocks(
  lines: readonly SourceLine[],
  startLineIdx: number,
  endLineIdx: number,
  firstLineSliceStart: number | null,
  outerVisibility: PedagogicalVisibility,
  propagateSectionVisibility: boolean,
  innerSealProofs: boolean,
  readPrefix = (line: SourceLine, _index: number) => ({
    length: BLOCKQUOTE_PREFIX_RE.exec(line.raw)?.[0].length ?? 0, padding: 0,
  }),
): MappedInnerBlock[] {
  const bodyParts: string[] = [];
  const charOrigStart: number[] = [];
  const charOrigEnd: number[] = [];
  const vLineToOrigLine = new Map<number, SourceLine>();
  let vCursor = 0;

  for (let idx = startLineIdx; idx <= endLineIdx; idx++) {
    const curLine = lines[idx]!;
    const { length, padding } = idx === startLineIdx && firstLineSliceStart !== null
      ? { length: firstLineSliceStart - curLine.start, padding: 0 }
      : readPrefix(curLine, idx);
    const stripped = curLine.raw.slice(length);
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

function scanInlineCueTimings(lines: readonly SourceLine[]): Array<InlineCueTiming | null> {
  let containers: MarkdownContainer[] = [];
  let fence: { opener: string; literal: boolean } | undefined;
  let tableColumns: PedagogicalVisibility[] | undefined;
  return lines.map(({ raw }, index) => {
    if (fence) {
      const timing = fence.literal ? null : parseInlineTranscriptCue(raw);
      const continuation = continueMarkdownContainers(raw.slice(timing?.prefixLength ?? 0), containers);
      if (continuation.depth === containers.length) {
        if (closesFence(continuation.body, fence.opener)) fence = undefined;
        return timing;
      }
      // A fenced block ends with its list or quote even without a closing marker.
      fence = undefined;
    }
    const timing = parseInlineTranscriptCue(raw);
    const cueBody = timing ? raw.slice(timing.prefixLength) : "";
    const latex = /^[ \t]*\\begin\{([a-zA-Z][\w-]*\*?)\}[ \t]*$/.exec(cueBody);
    const timedBlock = interruptsPipeTable(cueBody) ||
      (latex !== null && (MATH_ENVS.has(latex[1]!) || classifyLabel(latex[1], "public") !== null));
    let visibilityFloor: PedagogicalVisibility = "public";
    if (tableColumns) {
      const continuation = continueMarkdownContainers(raw, containers);
      if (continuation.depth === containers.length && isPipeTableBodyRow(continuation.body)) {
        if (!timedBlock) return null;
        // A timed block can also look like a literal pipe-separated row.
        // Retain its existing column protection when using the timed interpretation.
        visibilityFloor = timedTableRowVisibility(continuation.body, tableColumns);
      }
      tableColumns = undefined;
    }

    const documentLine = readMarkdownContainerLine(raw, containers);
    const next = lines[index + 1];
    const delimiter = next && continueMarkdownContainers(next.raw, documentLine.containers);
    const headerCells = !timedBlock && delimiter?.depth === documentLine.containers.length
      ? pipeTableHeaderCells({ raw: documentLine.body, start: 0 }, delimiter.body)
      : null;
    if (headerCells) {
      containers = documentLine.containers;
      tableColumns = headerCells.map(cell => tableColumnVisibility(documentLine.body.slice(cell.start, cell.end)));
      return null;
    }

    const line = timing ? readMarkdownContainerLine(cueBody, containers) : documentLine;
    containers = line.containers;
    const opener = matchFenceOpening(line.body)?.[1];
    if (opener) fence = { opener, literal: !timing };
    return timing && visibilityFloor !== "public" ? { ...timing, visibilityFloor } : timing;
  });
}

function parseInlineCuedDocument(
  source: string,
  lines: readonly SourceLine[],
  timings: readonly (InlineCueTiming | null)[],
  options: AstParseOptions,
  sealProofs: boolean,
  captionRowStarts?: ReadonlySet<number>,
): PedagogicalAstBlock[] {
  const parts: string[] = [];
  const regions: TranscriptRegion[] = [];
  const timedRows = new Set<number>();
  const cueSeparator = createTranscriptCueSeparator();
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const timing = timings[index];
    const next = timings[index + 1];
    const body = line.raw.slice(timing?.prefixLength ?? 0);
    const separator = cueSeparator(body, timing && next ? lines[index + 1]!.raw.slice(next.prefixLength) : undefined);
    if (timing || captionRowStarts?.has(line.start)) timedRows.add(offset);
    if (timing) {
      const lineEnding = next ? separator : source.slice(line.contentEnd, line.end);
      regions.push({
        start: offset, end: offset + body.length, sourceStart: line.start + timing.prefixLength,
        cue: { timing, lineStart: line.start },
      });
      parts.push(body, lineEnding);
      offset += body.length + lineEnding.length;
    } else {
      const previous = regions.at(-1);
      const end = offset + line.end - line.start;
      if (previous && !previous.cue) previous.end = end;
      else regions.push({ start: offset, end, sourceStart: line.start });
      parts.push(source.slice(line.start, line.end));
      offset = end;
    }
  }

  const markdown = parts.join("");
  const readRange = readAstRanges(parsePedagogicalAstInternal(markdown, {
    defaultVisibility: options.defaultVisibility,
    propagateSectionVisibility: options.propagateSectionVisibility,
  }, sealProofs, timedRows));
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

    const visibilityFloor = maxVisibility(options.defaultVisibility ?? "public", cue.timing.visibilityFloor ?? "public");
    const spans = start === end
      ? [{ start, end, visibility: "sealed" } satisfies CueSpan]
      : splitCueVisibility(markdown, start, end, visibilityFloor, readRange, true);
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
): PedagogicalAstBlock[] {
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  const lines = splitLinesWithOffsets(text);
  const timings = scanInlineCueTimings(lines);
  if (timings.some(Boolean)) return parseInlineCuedDocument(text, lines, timings, options, sealProofs, captionRowStarts);
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

    const inner = parsePedagogicalAstInternal(
      text.slice(span.openEnd, span.closeStart),
      { defaultVisibility: span.visibility, propagateSectionVisibility },
      span.kind === "exercise",
    ).map(b => ({
      ...b,
      startOffset: span.openEnd! + b.startOffset,
      endOffset: span.openEnd! + b.endOffset,
    }));
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
        const inner = parsePedagogicalAstInternal(
          text.slice(span.openEnd, span.closeStart),
          { defaultVisibility: span.visibility, propagateSectionVisibility },
          span.kind === "exercise",
        );
        for (const b of inner) {
          if (VISIBILITY_RANK[b.visibility] > VISIBILITY_RANK[activeVis]) {
            extracted.push({
              kind: b.kind,
              visibility: b.visibility,
              atomicConstruct: b.atomicConstruct,
              startOffset: span.openEnd + b.startOffset,
              endOffset: span.openEnd + b.endOffset,
              startMs: b.startMs,
              endMs: b.endMs,
              ...(b.label ? { label: b.label } : {}),
            });
          }
        }
      }
    }
    return extracted;
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
    const setext = headingMatch ? null : findSetextUnderline(lines, i);
    if (headingMatch || setext) {
      const level = headingMatch ? headingMatch[1]!.length : setext!.level;
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
      if (propagateSectionVisibility) {
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop();
        }
        const parentVisibility =
          headingStack.length > 0 ? headingStack[headingStack.length - 1]!.visibility : defaultVisibility;
        const ownVisibility: PedagogicalVisibility = SEALED_HEADING_RE.test(cleanHeadingTitle)
          ? "sealed"
          : HINT_HEADING_RE.test(cleanHeadingTitle)
            ? "hint_gated"
            : defaultVisibility;
        headingStack.push({
          level,
          visibility: maxVisibility(parentVisibility, ownVisibility),
        });
      }
      const activeVis = getActiveSectionVisibility();
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

    if (THEMATIC_BREAK_RE.test(raw)) {
      pushBlock("prose", getActiveSectionVisibility(), false, line.start, line.contentEnd);
      i++;
      continue;
    }

    // 2. Fenced code block or tilde/backtick pedagogical fence (``` or ~~~)
    const fenceMatch = matchFenceOpening(raw);
    if (fenceMatch) {
      const opener = fenceMatch[1]!;
      const fenceChar = opener[0]!;
      const activeVis = getActiveSectionVisibility();
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
      const activeVis = getActiveSectionVisibility();
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
    const detailsOpenMatch = /^[ \t]*(<details(?:\s[^>]*)?>)/i.exec(raw);
    if (detailsOpenMatch) {
      const activeVis = getActiveSectionVisibility();
      const leadingWs = detailsOpenMatch[0].length - detailsOpenMatch[1]!.length;
      const detailsStart = line.start + leadingWs;
      const openEndOffset = line.start + detailsOpenMatch[0].length;
      const { closeStart, closeEnd } = findMatchingDetailsBounds(text, openEndOffset);
      const classified = classifyDetailsElement(text, openEndOffset, closeStart, activeVis);
      const endLineIdx = lineIndexContaining(lines, Math.max(detailsStart, closeEnd - 1), i);
      const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
      const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
      const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

      if (classified.visibility !== "sealed" && closeStart > openEndOffset) {
        const innerBlocks = parsePedagogicalAstInternal(
          text.slice(openEndOffset, closeStart),
          {
            defaultVisibility: classified.visibility,
            propagateSectionVisibility,
          },
          false,
        ).map(b => ({
          ...b,
          startOffset: openEndOffset + b.startOffset,
          endOffset: openEndOffset + b.endOffset,
        }));
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
        closed ? getActiveSectionVisibility() : "sealed",
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
    const calloutMatch = CALLOUT_RE.exec(raw);
    if (calloutMatch) {
      const activeVis = getActiveSectionVisibility();
      const classified = classifyLabel(calloutMatch[1], activeVis, sealProofs);
      if (classified) {
        const j = findBlockquoteEnd(lines, i, candidate => {
          const next = classifyLabel(CALLOUT_RE.exec(candidate)?.[1], activeVis, sealProofs);
          return next !== null && VISIBILITY_RANK[next.visibility] > VISIBILITY_RANK[classified.visibility];
        });
        let endLineIdx = j - 1;
        while (endLineIdx > i && /^[ \t]*>[ \t]*$/.test(lines[endLineIdx]!.raw)) {
          endLineIdx--;
        }
        const fallbackLabel = calloutMatch[1]!;
        const outerStart = line.start;
        const outerEnd = lines[endLineIdx]!.contentEnd;

        if (classified.visibility !== "sealed") {
          const headerRestStart = line.start + calloutMatch[0].length - calloutMatch[2]!.length;
          const innerBlocks = parsePrefixedInnerBlocks(
            lines,
            i,
            endLineIdx,
            headerRestStart,
            classified.visibility,
            propagateSectionVisibility,
            classified.kind === "exercise",
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
      while (j < lines.length && isPipeTableBodyRow(lines[j]!.raw)) j++;
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
          let { cells: rowCells } = parseTableRowCells(row, inlineSpans);
          // A short caption row can start with the separator for an empty
          // first cell. Keep that position without altering document GFM rows.
          const leadingEmptyCell =
            captionRowStarts?.has(row.start) && rowCells.length < headerCells.length &&
            row.raw.trimStart().startsWith("|") && !row.raw.trimEnd().endsWith("|");
          if (leadingEmptyCell) rowCells = parseTableRowCells(row, inlineSpans, true).cells;
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
  const cueStarts: number[] = [];
  const captionRowStarts = new Set<number>();
  const textParts: string[] = [];
  const cueSeparator = createTranscriptCueSeparator();
  let virtualOffset = 0;
  for (const [index, cue] of input.cues.entries()) {
    cueStarts.push(virtualOffset);
    for (const { start } of splitLinesWithOffsets(cue.text)) captionRowStarts.add(virtualOffset + start);
    const separator = cueSeparator(cue.text, input.cues[index + 1]?.text);
    textParts.push(cue.text, separator);
    virtualOffset += cue.text.length + separator.length;
  }
  const text = textParts.join("");
  const readRange = readAstRanges(parsePedagogicalAstInternal(
    text, { defaultVisibility }, false, captionRowStarts,
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
