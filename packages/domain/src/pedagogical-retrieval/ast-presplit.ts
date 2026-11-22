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
const HTML_ATTRIBUTE_TOKEN_RE = /([^\t\n\f\r "'<>/=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]+)))?/g;
const HTML_TAG_TOKEN = /<(?<prefix>[!/?]?)(?<tag>[a-z][^\t\n\f\r />]*)(?=[\t\n\f\r />])/.source + HTML_TAG_ATTRIBUTES + ">";
const DETAILS_OPEN_RE = new RegExp(/^<details(?=[\t\n\f\r />])/.source + HTML_TAG_ATTRIBUTES + ">", "i");
const HTML_RAW_TEXT_TAGS = new Set(["textarea", "title", "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const SVG_NON_RENDERED_LABEL_TAGS = new Set([
  "metadata", "defs", "desc", "symbol", "clippath", "mask", "pattern", "marker", "lineargradient", "radialgradient",
  "filter", "view", "title", "script", "style", "cursor", "font",
]);
const SVG_TEXT_TAGS = new Set(["text", "tspan", "textpath", "tref", "altglyph"]);
const MATH_NON_RENDERED_LABEL_TAGS = new Set(["annotation", "annotation-xml", "mphantom", "none", "mprescripts"]);
const HTML_FOREIGN_BREAKOUT_TAG_RE =
  /^(?:b|big|blockquote|body|br|center|code|dd|div|dl|dt|em|embed|h[1-6]|head|hr|i|img|li|listing|menu|meta|nobr|ol|p|pre|ruby|s|small|span|strong|strike|sub|sup|table|tt|u|ul|var)$/;
const HTML_NON_RENDERED_LABEL_TAGS = new Set([
  "title", "script", "style", "iframe", "noembed", "noframes", "noscript", "template", "datalist",
]);
const HTML_VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
const HTML_OPTIONAL_END_TAGS = new Set([
  "html", "head", "body", "li", "dt", "dd", "p", "option", "optgroup", "colgroup", "thead", "tbody", "tfoot", "tr", "td", "th",
]);
const MARKDOWN_AUTOLINK = /(?<autolink><(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+)>)/.source;
const HTML_LABEL_BREAK_TAGS = new Set([
  "br", "hr", "div", "p", "li", "ul", "ol", "table", "tr", "td", "th",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section",
  "article", "header", "footer", "aside", "nav",
]);
const HTML_COMMENT_TAIL = /(?:-?>|[\s\S]*?(?:--!?>|$))/.source;
const HTML_COMMENT_RE = new RegExp("<!--" + HTML_COMMENT_TAIL, "g");
const HTML_OTHER_LITERAL = /(?<cdata><!\[CDATA\[[\s\S]*?(?:\]\]>|(?![\s\S])))|<!(?!--)[^>]*>?|<\?[^>]*>?/.source;
const HTML_MARKUP_TOKEN = [HTML_COMMENT_RE.source, HTML_OTHER_LITERAL, HTML_TAG_TOKEN].join("|");
const INVISIBLE_LABEL_TEXT = /\u00AD|\u200B|\u200C|\u200D|\u200E|\u200F|\u2060|\uFEFF/g;
const HTML_LABEL_REFERENCES = new Map(Object.entries({
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'",
  nbsp: "\u00A0", NonBreakingSpace: "\u00A0", shy: "\u00AD", Tab: "\t", NewLine: "\n",
  ZeroWidthSpace: "\u200B", NegativeVeryThinSpace: "\u200B", NegativeThinSpace: "\u200B",
  NegativeMediumSpace: "\u200B", NegativeThickSpace: "\u200B",
  ThinSpace: "\u2009", thinsp: "\u2009", VeryThinSpace: "\u200A", HairSpace: "\u200A", hairsp: "\u200A",
  ensp: "\u2002", emsp: "\u2003", emsp13: "\u2004", emsp14: "\u2005", numsp: "\u2007", puncsp: "\u2008",
  MediumSpace: "\u205F", ThickSpace: "\u205F\u200A", zwnj: "\u200C", zwj: "\u200D", lrm: "\u200E", rlm: "\u200F",
  NoBreak: "\u2060", WordJoiner: "\u2060", wj: "\u2060",
  sol: "/", bsol: "\\", colon: ":", semi: ";", equals: "=",
  lowbar: "_", UnderBar: "_", hyphen: "\u2010", dash: "\u2010", ndash: "\u2013", mdash: "\u2014",
  vert: "|", lsqb: "[", rsqb: "]", lpar: "(", rpar: ")", lcub: "{", rcub: "}",
  le: "\u2264", leq: "\u2264", ge: "\u2265", geq: "\u2265", ne: "\u2260", NotEqual: "\u2260",
  minus: "\u2212", times: "\u00D7", divide: "\u00F7", plus: "+", plusmn: "\u00B1",
  middot: "\u00B7", hellip: "\u2026",
}));
const HTML_LEGACY_LABEL_REFERENCE = /^(?:amp|AMP|lt|LT|gt|GT|quot|QUOT|nbsp|shy)/;
// HTML's numeric reference replacements for 0x80 through 0x9F.
const HTML_WINDOWS_1252 = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];
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

const LATEX_ENV_GAP = /[ \t]*(?:(?:%[^\r\n]*)?(?:\r\n|\r(?!\n)|\n)[ \t]*)?/.source;

function latexEnvironmentArgument(name: string): string {
  return LATEX_ENV_GAP + /\{[ \t\r\n]*/.source + name + /[ \t\r\n]*\}/.source;
}

const LATEX_ENV_ARGUMENT = latexEnvironmentArgument(/(?<name>[a-zA-Z][\w-]*\*?)/.source);
const LATEX_ENV_ARGUMENT_RE = new RegExp("^" + LATEX_ENV_ARGUMENT);
const LATEX_ENV_ARGUMENT_PREFIX_RE = new RegExp("^" + LATEX_ENV_GAP + /\{[ \t\r\n]*(?:[a-zA-Z][\w-]*\*?[ \t\r\n]*)?$/.source);
const LATEX_LITERAL_ENVIRONMENT = /(?:verbatim|lstlisting|minted|comment|filecontents)\*?/.source;
const LATEX_LITERAL_ENVIRONMENT_RE = new RegExp("^" + LATEX_LITERAL_ENVIRONMENT + "$");
const LATEX_BEGIN = /\\begin/.source + LATEX_ENV_ARGUMENT;
const LATEX_BEGIN_RE = new RegExp("^" + LATEX_BEGIN);
const LATEX_BLOCK_BEGIN_RE = new RegExp(/^[ \t]*/.source + LATEX_BEGIN);
const LATEX_BLOCK_END_RE = new RegExp(/^[ \t]*\\end/.source + LATEX_ENV_ARGUMENT);
const LATEX_LITERAL_TOKENS = /%|(?<verb>\\verb(?![a-zA-Z])[ \t]*\*?[ \t]*)|\\begin/.source +
  latexEnvironmentArgument("(?<literalEnvironment>" + LATEX_LITERAL_ENVIRONMENT + ")");

function findLatexLiteralEnd(text: string, environment: string, from: number) {
  const closing = new RegExp(/\\end/.source + latexEnvironmentArgument(environment.replace(/\*/g, "\\*")), "g");
  closing.lastIndex = from;
  const match = closing.exec(text);
  return match && { closeStart: match.index, closeEnd: closing.lastIndex };
}

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
        pattern.lastIndex = findLatexLiteralEnd(text, environment, pattern.lastIndex)?.closeEnd ?? text.length;
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

function classifyLatexEnvironment(
  name: string,
  visibility: PedagogicalVisibility,
  sealProofs = false,
) {
  if (MATH_ENVS.has(name)) return { kind: "display_math" as const, visibility };
  if (LATEX_LITERAL_ENVIRONMENT_RE.test(name)) return { kind: "code" as const, visibility };
  return classifyLabel(name, visibility, sealProofs);
}

function matchLatexBlockOpening(line: string, readContinuation?: () => string) {
  if (!/^[ \t]*\\begin(?=[ \t{%]|$)/.test(line)) return null;
  return LATEX_BLOCK_BEGIN_RE.exec(line) ??
    (readContinuation ? LATEX_BLOCK_BEGIN_RE.exec(readContinuation()) : null);
}

function readLatexCueCommand(line: string, readNext: (distance: number) => string | undefined, from = 0) {
  if (!line.includes("\\begin") && !line.includes("\\end")) return undefined;
  const command = /\\(begin|end)(?=[ \t{%]|$)/g;
  command.lastIndex = from;
  const comment = findUnescapedToken(line, "%", 0);
  for (let match = command.exec(line); match && (comment === -1 || match.index < comment); match = command.exec(line)) {
    if (isEscaped(line, match.index)) continue;
    let argument = line.slice(command.lastIndex);
    let endLine = 0;
    while (true) {
      const complete = LATEX_ENV_ARGUMENT_RE.exec(argument);
      if (complete) {
        return {
          directive: match[1], name: complete[1]!, start: match.index, endLine,
          nextColumn: command.lastIndex + complete[0].length,
          rest: argument.slice(complete[0].length),
        };
      }
      if (!(endLine === 0 && /^[ \t]*(?:%[^\r\n]*)?$/.test(argument)) &&
        !LATEX_ENV_ARGUMENT_PREFIX_RE.test(argument)) break;
      const next = readNext(++endLine);
      if (next === undefined) break;
      argument += "\n" + next;
    }
  }
  return undefined;
}

function tableDelimiterColumnCount(line: string): number {
  const trimmed = line.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!trimmed.includes("|") || !trimmed.includes("-")) return 0;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|");
  return cells.every(cell => /^[ \t]*:?-{3,}:?[ \t]*$/.test(cell)) ? cells.length : 0;
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
  const pattern = new RegExp(LATEX_LITERAL_TOKENS + "|" + /\\(?<directive>begin|end)/.source + LATEX_ENV_ARGUMENT, "g");
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
  const tail = new RegExp(HTML_COMMENT_TAIL, "y");
  tail.lastIndex = afterOpener;
  tail.exec(text);
  return tail.lastIndex;
}

function decodeHtmlLabelText(text: string): string {
  return text.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([A-Za-z][A-Za-z0-9]*);?/g,
    (reference, hex?: string, decimal?: string, name?: string) => {
      if (name !== undefined) {
        const named = reference.endsWith(";") ? HTML_LABEL_REFERENCES.get(name) : undefined;
        if (named !== undefined) return named;
        const legacy = HTML_LEGACY_LABEL_REFERENCE.exec(name)?.[0];
        return legacy ? HTML_LABEL_REFERENCES.get(legacy)! + reference.slice(legacy.length + 1) : reference;
      }
      const codePoint = hex === undefined ? Number.parseInt(decimal!, 10) : Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        return "\uFFFD";
      }
      return String.fromCodePoint(HTML_WINDOWS_1252[codePoint - 0x80] ?? codePoint);
    });
}

function findScriptEndTag(text: string, from: number, closer: RegExp) {
  // Script text inside an HTML comment can enter the double-escaped state.
  // The first </script> in that state returns to escaped text.
  const tokens = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  tokens.lastIndex = from;
  let state: "data" | "escaped" | "double-escaped" = "data";
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    switch (match[0].toLowerCase()) {
      case "<!--":
        if (state === "data") state = "escaped";
        break;
      case "-->":
        state = "data";
        break;
      case "<script":
        if (state === "escaped") state = "double-escaped";
        break;
      case "</script":
        if (state === "double-escaped") {
          state = "escaped";
        } else {
          closer.lastIndex = match.index;
          const closing = closer.exec(text);
          if (closing) return closing;
        }
    }
  }
  return null;
}

function htmlRawTextBounds(text: string, opener: RegExpExecArray, afterOpener: number) {
  const tag = opener.groups?.tag?.toLowerCase();
  if (!tag || opener.groups?.prefix) return null;
  if (tag === "plaintext") return { closeStart: text.length, closeEnd: text.length };
  if (!HTML_RAW_TEXT_TAGS.has(tag)) return null;
  // These elements are non-void. A trailing slash does not close them in HTML.
  const closer = new RegExp("</" + tag + /(?=[\t\n\f\r />])/.source + HTML_TAG_ATTRIBUTES + ">", tag === "script" ? "iy" : "gi");
  closer.lastIndex = afterOpener;
  const match = tag === "script" ? findScriptEndTag(text, afterOpener, closer) : closer.exec(text);
  return match ? { closeStart: match.index, closeEnd: closer.lastIndex } : { closeStart: text.length, closeEnd: text.length };
}

function endOfBogusHtmlComment(text: string, from: number): number {
  const end = text.indexOf(">", from);
  return end === -1 ? text.length : end + 1;
}

type HtmlNamespace = "svg" | "math" | undefined;
type OpenHtmlTag = { tag: string; childrenNamespace: HtmlNamespace };

function exitsHtmlForeignContent(tag: string, prefix: string | undefined, markup: string): boolean {
  if (prefix === "/") return tag === "br" || tag === "p";
  return prefix === "" && (HTML_FOREIGN_BREAKOUT_TAG_RE.test(tag) ||
    (tag === "font" && ["color", "face", "size"].some(name => htmlAttributeValue(markup, tag, name) !== undefined)));
}

function htmlEncodedAnnotation(namespace: HtmlNamespace, tag: string, markup: string): boolean {
  return namespace === "math" && tag === "annotation-xml" &&
    /^(?:text\/html|application\/xhtml\+xml)$/i.test(decodeHtmlLabelText(htmlAttributeValue(markup, tag, "encoding") ?? ""));
}

function htmlChildNamespace(namespace: HtmlNamespace, tag: string, htmlAnnotation: boolean): HtmlNamespace {
  const htmlChildren = htmlAnnotation || (namespace === "svg" && /^(?:desc|foreignobject|title)$/.test(tag)) ||
    (namespace === "math" && /^(?:mi|mo|mn|ms|mtext)$/.test(tag));
  return htmlChildren ? undefined : namespace;
}

function markupNamespace(openTags: OpenHtmlTag[], match: RegExpExecArray): HtmlNamespace {
  const tag = match.groups?.tag?.toLowerCase();
  const prefix = match.groups?.prefix;
  if (tag && openTags.at(-1)?.childrenNamespace && exitsHtmlForeignContent(tag, prefix, match[0])) {
    while (openTags.at(-1)?.childrenNamespace) openTags.pop();
  }
  const namespace = openTags.at(-1)?.childrenNamespace;
  if (!tag) return namespace;
  if (prefix === "" && !HTML_VOID_TAGS.has(tag)) {
    const current = namespace ?? (tag === "svg" || tag === "math" ? tag : undefined);
    if ((openTags.length || current) && !(current && hasSelfClosingFlag(match[0], tag))) {
      openTags.push({ tag, childrenNamespace: htmlChildNamespace(current, tag, htmlEncodedAnnotation(current, tag, match[0])) });
    }
  } else if (prefix === "/") {
    const index = lastOpenHtmlTagIndex(openTags, tag);
    if (index >= 0) openTags.length = index;
  }
  return namespace;
}

function htmlElementEnd(
  text: string,
  tag: string,
  from: number,
  namespace: HtmlNamespace = tag === "svg" || tag === "math" ? tag : undefined,
  htmlAnnotation = false,
): number | undefined {
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  tokens.lastIndex = from;
  const openTags: OpenHtmlTag[] = namespace ? [{ tag, childrenNamespace: htmlChildNamespace(namespace, tag, htmlAnnotation) }] : [];
  let depth = 1;
  let templateDepth = 0;
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const namespace = markupNamespace(openTags, match);
    if (match.groups?.cdata && (!namespace || !match[0].startsWith("<![CDATA["))) {
      tokens.lastIndex = endOfBogusHtmlComment(text, match.index);
    }
    const name = match.groups?.tag?.toLowerCase();
    const prefix = match.groups?.prefix;
    const raw = namespace ? null : htmlRawTextBounds(text, match, tokens.lastIndex);
    if (raw) {
      tokens.lastIndex = raw.closeEnd;
    } else if (!namespace && name === "template" && tag !== "template") {
      if (prefix === "") templateDepth++;
      else if (prefix === "/" && templateDepth > 0) templateDepth--;
    } else if (name === tag && templateDepth === 0) {
      if (prefix === "" && !(namespace && hasSelfClosingFlag(match[0], tag))) depth++;
      else if (prefix === "/" && --depth === 0) return tokens.lastIndex;
    }
  }
  return undefined;
}

function hasSelfClosingFlag(markup: string, tag: string): boolean {
  if (!markup.endsWith("/>")) return false;
  const attributes = markup.slice(tag.length + 1, -1);
  for (const match of attributes.matchAll(HTML_ATTRIBUTE_TOKEN_RE)) {
    if (match[4] && match.index + match[0].length === attributes.length) return false;
  }
  return true;
}

function htmlAttributeValue(opener: string, tag: string, attribute: string): string | undefined {
  const attributes = opener.slice(tag.length + 1, -1);
  for (const match of attributes.matchAll(HTML_ATTRIBUTE_TOKEN_RE)) {
    if (match[1]!.toLowerCase() === attribute) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return undefined;
}

function htmlContainerCrossingCodeEnd(
  text: string,
  start: number,
  end: number,
  openerLimit: number,
  liveTags: OpenHtmlTag[],
  currentDepth: number,
): { closeEnd?: number; nextDepth: number } {
  if (!text.slice(start, openerLimit).includes("<")) return { nextDepth: currentDepth };
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  const openTags = [...liveTags];
  let nextDepth = currentDepth;
  tokens.lastIndex = start;
  for (let match = tokens.exec(text); match && match.index < openerLimit; match = tokens.exec(text)) {
    const oldCount = openTags.length;
    const namespace = markupNamespace(openTags, match);
    const raw = namespace ? null : htmlRawTextBounds(text, match, tokens.lastIndex);
    const tag = match.groups?.tag?.toLowerCase();
    let closeEnd: number;
    if (match[0].startsWith("<!--")) {
      closeEnd = endOfHtmlComment(text, match.index + 4);
    } else if (match.groups?.cdata && namespace && match[0].startsWith("<![CDATA[")) {
      closeEnd = tokens.lastIndex;
    } else if (/^<[!?]/.test(match[0])) {
      closeEnd = endOfBogusHtmlComment(text, match.index + 2);
    } else if (raw || (!namespace && tag === "template" && match.groups?.prefix === "")) {
      closeEnd = raw?.closeEnd ?? htmlElementEnd(text, "template", tokens.lastIndex) ?? text.length;
      openTags.length = Math.min(openTags.length, oldCount);
    } else {
      closeEnd = tokens.lastIndex;
      if (!namespace && tag === "details") {
        if (match.groups?.prefix === "") nextDepth++;
        else if (match.groups?.prefix === "/" && nextDepth > 1) nextDepth--;
      }
    }
    if (closeEnd > end) {
      liveTags.splice(0, liveTags.length, ...openTags);
      return { closeEnd, nextDepth };
    }
    tokens.lastIndex = closeEnd;
  }
  liveTags.splice(0, liveTags.length, ...openTags);
  return { nextDepth };
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

function isMarkdownBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

const INDENTED_CODE_RE = /^(?: {4}| {0,3}\t)/;

function endOfDetailsIndentedCode(text: string, start: number, containers: readonly MarkdownContainer[]): number {
  while (start < text.length) {
    const newline = nextLineBreak(text, start);
    const { depth, body } = continueMarkdownContainers(text.slice(start, newline?.index ?? text.length), containers);
    if (depth !== containers.length || (!isMarkdownBlankLine(body) && !INDENTED_CODE_RE.test(body))) break;
    start = newline ? newline.index + newline[0].length : text.length;
  }
  return start;
}

interface DetailsBounds {
  readonly closeStart: number;
  readonly closeEnd: number;
  readonly summary?: {
    readonly openStart: number;
    readonly openEnd: number;
    readonly closeStart: number;
    readonly closeEnd: number;
    readonly codeSpans: readonly { start: number; end: number }[];
  };
}

function crossesDetailsHtmlBoundary(
  text: string,
  start: number,
  end: number,
  initialContainers: readonly MarkdownContainer[],
): boolean {
  let containers = initialContainers;
  for (const { raw } of splitLinesWithOffsets(text.slice(start, end)).slice(1)) {
    const next = readMarkdownContainerLine(raw, containers);
    containers = next.containers;
    if (!startsMarkdownHtmlBlock(next.body, false)) continue;
    // Keep an unmatched backtick from absorbing a standalone disclosure
    // closer and pairing with code in a following public paragraph.
    if (!next.body.trimStart().startsWith("</") ||
      /^ {0,3}<\/(?:details|summary)[ \t]*>[ \t]*$/i.test(next.body)) return true;
  }
  return false;
}

type MarkdownHtmlBlockKind = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type MarkdownHtmlBlock = { kind: MarkdownHtmlBlockKind; containers: readonly MarkdownContainer[] };

function startsMarkdownHtmlBlock(body: string, afterBlockBoundary: boolean): MarkdownHtmlBlockKind | undefined {
  if (/^ {0,3}<(?:pre|script|style|textarea)(?=[ \t>]|$)/i.test(body)) return 1;
  if (/^ {0,3}<!--/.test(body)) return 2;
  if (/^ {0,3}<\?/.test(body)) return 3;
  if (/^ {0,3}<![A-Z]/.test(body)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(body)) return 5;
  if (HTML_TYPE_6_BLOCK_START_RE.test(body)) return 6;
  if (afterBlockBoundary && STANDALONE_HTML_TAG_RE.test(body)) return 7;
  return undefined;
}

function endsMarkdownHtmlBlockLine(kind: MarkdownHtmlBlockKind, body: string): boolean {
  switch (kind) {
    case 1: return /<\/(?:pre|script|style|textarea)>/i.test(body);
    case 2: return body.includes("-->");
    case 3: return body.includes("?>");
    case 4: return body.includes(">");
    case 5: return body.includes("]]>");
    default: return false;
  }
}

function markdownHtmlContinuation(raw: string, block: MarkdownHtmlBlock): string | undefined {
  const { body, depth } = continueMarkdownContainers(raw, block.containers);
  return depth === block.containers.length && (block.kind <= 5 || !isMarkdownBlankLine(body)) ? body : undefined;
}

function createMarkdownBlockScanner(initialContainers: readonly MarkdownContainer[] = []) {
  let containers = [...initialContainers];
  let htmlBlock: MarkdownHtmlBlock | undefined;
  let fence: { opener: string; containers: readonly MarkdownContainer[] } | undefined;
  let afterBlockBoundary = true;
  let indented = false;
  return {
    get htmlBlock() { return htmlBlock; },
    breakParagraph() { afterBlockBoundary = true; },
    scan(raw: string, continuesInlineLiteral = false) {
      if (htmlBlock) {
        const body = markdownHtmlContinuation(raw, htmlBlock);
        if (body !== undefined) {
          const block = htmlBlock;
          if (endsMarkdownHtmlBlockLine(block.kind, body)) htmlBlock = undefined;
          return { body, containers: block.containers, mode: "html" as const, atBoundary: false };
        }
        htmlBlock = undefined;
      }
      if (fence) {
        const { body, depth } = continueMarkdownContainers(raw, fence.containers);
        if (depth === fence.containers.length) {
          if (closesFence(body, fence.opener)) fence = undefined;
          return { body, containers, mode: "code" as const, atBoundary: false };
        }
        fence = undefined;
      }
      const next = readMarkdownContainerLine(raw, containers);
      const atBoundary = afterBlockBoundary || next.containers.length > next.continuedDepth;
      containers = next.containers;
      const { body } = next;
      if (continuesInlineLiteral) return { body, containers, mode: "text" as const, atBoundary: false };
      const htmlKind = startsMarkdownHtmlBlock(body, atBoundary);
      if (htmlKind) {
        if (!endsMarkdownHtmlBlockLine(htmlKind, body)) htmlBlock = { kind: htmlKind, containers };
        afterBlockBoundary = true;
        indented = false;
        return { body, containers, mode: "html" as const, atBoundary };
      }
      const opener = matchFenceOpening(body)?.[1];
      if (opener) fence = { opener, containers };
      indented = INDENTED_CODE_RE.test(body) && (atBoundary || indented);
      afterBlockBoundary = Boolean(opener) || indented || isMarkdownBlankLine(body) || THEMATIC_BREAK_RE.test(body) ||
        /^[ ]{0,3}#{1,6}(?:[ \t]|$)/.test(body) || (!atBoundary && SETEXT_UNDERLINE_RE.test(body)) ||
        /^[ \t]{0,3}:{3,}[ \t]*[a-zA-Z]/.test(body) ||
        (containers.includes("quote") && CALLOUT_HEADER_RE.test(body));
      return { body, containers, mode: opener || indented ? "code" as const : "text" as const, atBoundary };
    },
  };
}

function createMarkdownHtmlBlockLookup(text: string) {
  const scanner = createMarkdownBlockScanner();
  const activeAtLine = new Map<number, MarkdownHtmlBlock>();
  let cursor = 0;
  let projected: string | undefined;
  return {
    htmlBlockAt(lineStart: number) {
      while (cursor < lineStart) {
        const newline = nextLineBreak(text, cursor);
        scanner.scan(text.slice(cursor, newline?.index ?? text.length));
        cursor = newline ? newline.index + newline[0].length : text.length;
        if (scanner.htmlBlock) activeAtLine.set(cursor, scanner.htmlBlock);
      }
      return activeAtLine.get(lineStart);
    },
    maskedLiterals(definedLinkLabels: ReadonlySet<string>) {
      return projected ??= projectDisclosureCommentMarkdown(text, [], definedLinkLabels, false);
    },
  };
}

function projectDisclosureCommentMarkdown(
  markdown: string,
  containers: readonly MarkdownContainer[],
  definedLinkLabels: ReadonlySet<string>,
  maskCode = true,
): string {
  const lines = splitLinesWithOffsets(markdown);
  const rawLines = lines.map(line => line.raw);
  const scanner = createMarkdownBlockScanner(containers);
  const escapes = "\\\\(?<escape>" + ASCII_PUNCTUATION.source + ")";
  const inline = /(?<ticks>\x60+)|(?<bracket>!?\[|\])|--!?>/.source;
  const tokens = new RegExp([escapes, MARKDOWN_AUTOLINK, inline, HTML_MARKUP_TOKEN].join("|"), "gi");
  const brackets: { start: number; contentStart: number; image: boolean; active: boolean }[] = [];
  const masks: { start: number; end: number }[] = [];
  let literalEnd = -1;
  let match = tokens.exec(markdown);
  const mask = (start: number, end: number) => {
    // A resolved image can cover masks already recorded inside its alt text.
    while (masks.length && masks.at(-1)!.end >= start) {
      const prior = masks.pop()!;
      start = Math.min(start, prior.start);
      end = Math.max(end, prior.end);
    }
    masks.push({ start, end });
    skipTo(end);
  };
  const skipTo = (end: number) => {
    if (match && match.index < end) {
      tokens.lastIndex = end;
      match = tokens.exec(markdown);
    }
  };

  for (let index = 0; index < lines.length && match; index++) {
    const line = lines[index]!;
    const continuedLiteral = line.start < literalEnd;
    const state = scanner.scan(line.raw, continuedLiteral);
    if (state.mode !== "text" || state.atBoundary) brackets.length = 0;
    if (state.mode === "code") {
      if (maskCode) mask(line.start, line.end);
      else skipTo(line.end);
      continue;
    }
    if (state.mode === "text" && state.atBoundary) {
      const definition = readLinkReferenceDefinition(rawLines, index, state);
      if (definition) {
        index = definition.lastLine;
        mask(line.start, lines[index]!.end);
        scanner.breakParagraph();
        continue;
      }
    }
    while (match && match.index < line.contentEnd) {
      const groups = match.groups!;
      let maskedStart = match.index;
      let maskedEnd = -1;
      if (state.mode === "text") {
        if (groups.escape || groups.autolink) {
          maskedEnd = tokens.lastIndex;
        } else if (groups.ticks) {
          const end = endOfBacktickSpan(markdown, match.index);
          if (end !== -1 && !crossesDetailsHtmlBoundary(markdown, match.index, end, state.containers)) {
            if (maskCode) maskedEnd = end;
            else {
              literalEnd = end;
              skipTo(end);
              continue;
            }
          }
        } else if (groups.bracket === "]") {
          const opener = brackets.pop();
          if (opener?.active) {
            maskedEnd = renderedMarkdownLinkEnd(markdown, match.index, opener.contentStart, definedLinkLabels);
            if (maskedEnd !== -1) {
              if (opener.image) maskedStart = opener.start;
              else for (const previous of brackets) if (!previous.image) previous.active = false;
            }
          }
        } else if (groups.bracket) {
          brackets.push({
            start: match.index, contentStart: tokens.lastIndex, image: groups.bracket.startsWith("!"), active: true,
          });
        }
      }
      if (maskedEnd !== -1) {
        literalEnd = maskedEnd;
        mask(maskedStart, maskedEnd);
      } else {
        if (groups.escape && state.mode === "html") tokens.lastIndex = match.index + 1;
        literalEnd = tokens.lastIndex;
        match = tokens.exec(markdown);
      }
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of masks) {
    // The disclosure scanner still uses the original UTF-16 offsets.
    parts.push(markdown.slice(cursor, start), markdown.slice(start, end).replace(/[^\r\n]/g, " "));
    cursor = end;
  }
  return parts.join("") + markdown.slice(cursor);
}

function findDisclosureCommentEnd(
  text: string,
  start: number,
  htmlEnd: number,
  containers: readonly MarkdownContainer[],
  definedLinkLabels: ReadonlySet<string>,
): number | undefined {
  const terminator = /--!?>/;
  const direct = terminator.exec(text.slice(start, htmlEnd));
  if (direct) return start + direct.index + direct[0].length;
  const markdownStart = Math.max(start, htmlEnd);
  const html = projectDisclosureCommentMarkdown(text.slice(markdownStart), containers, definedLinkLabels);
  const firstClose = terminator.exec(html);
  if (!firstClose) return undefined;

  // In comment state, the terminator counts even inside text that looks like a tag.
  // A later, independent comment can own it instead if it opens in HTML data state.
  const closeEnd = firstClose.index + firstClose[0].length;
  const tokens = new RegExp(/<!--|--!?>/.source + "|" + HTML_OTHER_LITERAL + "|" + HTML_TAG_TOKEN, "gi");
  const openTags: OpenHtmlTag[] = [];
  let independent = false;
  let detailsDepth = 0;
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    if (!independent && match.index >= firstClose.index) break;
    if (match[0] === "<!--") {
      tokens.lastIndex = endOfHtmlComment(html, tokens.lastIndex);
      independent ||= tokens.lastIndex === closeEnd;
      continue;
    }
    if (match[0].startsWith("--")) return markdownStart + closeEnd;
    const oldCount = openTags.length;
    const namespace = markupNamespace(openTags, match);
    const tag = match.groups?.tag?.toLowerCase();
    const prefix = match.groups?.prefix;
    if (match.groups?.cdata && (!namespace || !match[0].startsWith("<![CDATA["))) {
      tokens.lastIndex = endOfBogusHtmlComment(html, match.index + 2);
    }
    const raw = namespace ? null : htmlRawTextBounds(html, match, tokens.lastIndex);
    if (raw || (!namespace && tag === "template" && prefix === "")) {
      openTags.length = Math.min(openTags.length, oldCount);
      tokens.lastIndex = raw?.closeEnd ?? htmlElementEnd(html, "template", tokens.lastIndex) ?? html.length;
    } else if (!namespace && tag === "details") {
      if (prefix === "") detailsDepth++;
      else if (prefix === "/") {
        if (detailsDepth > 0) detailsDepth--;
        else if (independent) return markdownStart + closeEnd;
      }
    }
  }
  return independent ? undefined : markdownStart + closeEnd;
}

function findMatchingDetailsBounds(
  text: string,
  openStart: number,
  searchFrom: number,
  inheritsHtmlBlock: ReturnType<typeof createMarkdownHtmlBlockLookup>,
  definedLinkLabels: ReadonlySet<string>,
): DetailsBounds {
  const literals =
    /<!--|(?<fence>^[ \t]*(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)*(?:\x60{3,}[^\x60\r\n]*|~{3,}[^\r\n]*)(?=\r|\n|$))|(?<ticks>\x60+)/.source;
  const tokenRe = new RegExp(literals + "|" + HTML_OTHER_LITERAL + "|" + HTML_TAG_TOKEN, "gim");
  tokenRe.lastIndex = searchFrom;
  let containers: MarkdownContainer[] = [];
  let nextLineStart = containingLineStart(text, searchFrom);
  let contiguousHtml = /^ {0,3}$/.test(text.slice(containingLineStart(text, openStart), openStart));
  let htmlBlock = inheritsHtmlBlock.htmlBlockAt(nextLineStart);
  let htmlBlockEndsHere = false;
  const openTags: OpenHtmlTag[] = [];
  let htmlStartedInBody = false;
  let markdownBodyStart = Infinity;
  let body = "";
  let inIndentedCode = false;
  let afterBlockBoundary = true;
  const readThroughLine = (offset: number) => {
    while (nextLineStart <= offset && nextLineStart < text.length) {
      const lineStart = nextLineStart;
      const newline = nextLineBreak(text, lineStart);
      const line = text.slice(lineStart, newline?.index ?? text.length);
      nextLineStart = newline ? newline.index + newline[0].length : text.length;
      if (htmlBlockEndsHere) htmlBlock = undefined;
      const htmlContinuation = htmlBlock && markdownHtmlContinuation(line, htmlBlock);
      if (htmlContinuation === undefined) htmlBlock = undefined;
      htmlBlockEndsHere = htmlBlock !== undefined && endsMarkdownHtmlBlockLine(htmlBlock.kind, htmlContinuation!);
      if (contiguousHtml && htmlBlock && (lineStart < markdownBodyStart || htmlStartedInBody)) {
        const continued = continueMarkdownContainers(line, containers);
        if (continued.depth === containers.length && !isMarkdownBlankLine(continued.body)) {
          body = continued.body;
          inIndentedCode = false;
          afterBlockBoundary = false;
          continue;
        }
      }
      const current = readMarkdownContainerLine(line, containers);
      const sameContainer = current.continuedDepth === containers.length &&
        current.containers.length === containers.length;
      containers = current.containers;
      body = current.body;
      const htmlKind = startsMarkdownHtmlBlock(body, afterBlockBoundary || !sameContainer);
      const startsNewHtmlBlock = htmlBlock === undefined && htmlKind !== undefined;
      if (startsNewHtmlBlock) {
        htmlBlock = { kind: htmlKind, containers };
        htmlBlockEndsHere = endsMarkdownHtmlBlockLine(htmlKind, body);
      }
      htmlStartedInBody = htmlBlock !== undefined && ((htmlStartedInBody && htmlContinuation !== undefined) ||
        (lineStart >= markdownBodyStart && (startsNewHtmlBlock || htmlKind === 6) && !body.trimStart().startsWith("</")));
      contiguousHtml = htmlBlock !== undefined;
      const endsSetext = sameContainer && !afterBlockBoundary && !inIndentedCode && SETEXT_UNDERLINE_RE.test(body);
      inIndentedCode = INDENTED_CODE_RE.test(body) &&
        (afterBlockBoundary || !sameContainer || inIndentedCode);
      afterBlockBoundary = isMarkdownBlankLine(body) || endsSetext || /^[ ]{0,3}#{1,6}(?:[ \t]|$)/.test(body) ||
        THEMATIC_BREAK_RE.test(body);
    }
  };
  const htmlBlockEnd = (limit: number) => {
    if (!htmlBlock || htmlBlockEndsHere) return Math.min(nextLineStart, limit);
    for (let start = nextLineStart; start < limit;) {
      const newline = nextLineBreak(text, start);
      const body = markdownHtmlContinuation(text.slice(start, newline?.index ?? text.length), htmlBlock);
      if (body === undefined) return start;
      start = newline ? newline.index + newline[0].length : text.length;
      if (endsMarkdownHtmlBlockLine(htmlBlock.kind, body)) return Math.min(start, limit);
    }
    return limit;
  };
  const skipLiteralLines = (end: number) => {
    if (end < nextLineStart) return;
    if (htmlBlock && htmlBlockEnd(end + 1) <= end) {
      htmlBlock = undefined;
      contiguousHtml = false;
      htmlStartedInBody = false;
    }
    const newline = nextLineBreak(text, end);
    nextLineStart = newline ? newline.index + newline[0].length : text.length;
  };
  let depth = 1;
  const skipCodeBlock = (start: number, end: number) => {
    const openerLimit = htmlBlock ? htmlBlockEnd(end) : start;
    const crossing = openerLimit > start ? htmlContainerCrossingCodeEnd(text, start, end, openerLimit, openTags, depth) : undefined;
    const htmlEnd = crossing?.closeEnd;
    depth = crossing?.nextDepth ?? depth;
    tokenRe.lastIndex = htmlEnd ?? end;
    if (htmlEnd !== undefined) skipLiteralLines(htmlEnd);
    else {
      if (openerLimit < end) {
        htmlBlock = undefined;
        contiguousHtml = false;
        htmlStartedInBody = false;
      }
      nextLineStart = end;
    }
    inIndentedCode = false;
    afterBlockBoundary = true;
  };

  let summaryOpening: { openStart: number; openEnd: number } | undefined;
  let summary: DetailsBounds["summary"];
  const summaryCodeSpans: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    readThroughLine(match.index);
    const markdownBody = match.index >= markdownBodyStart;
    const allowsMarkdown = !contiguousHtml || (markdownBody && !htmlStartedInBody);
    if (allowsMarkdown && inIndentedCode) {
      const end = endOfDetailsIndentedCode(text, nextLineStart, containers);
      skipCodeBlock(containingLineStart(text, match.index), end);
      continue;
    }
    if (allowsMarkdown && !htmlBlock && inheritsHtmlBlock.maskedLiterals(definedLinkLabels)[match.index] !== text[match.index]) {
      tokenRe.lastIndex = match.index + 1;
      continue;
    }
    const previousTagCount = openTags.length;
    const namespace = markupNamespace(openTags, match);
    if (match.groups?.cdata && (!namespace || !match[0].startsWith("<![CDATA["))) {
      tokenRe.lastIndex = endOfBogusHtmlComment(text, match.index + 2);
    }
    const rawText = namespace ? null : htmlRawTextBounds(text, match, tokenRe.lastIndex);
    if (rawText) {
      openTags.length = Math.min(openTags.length, previousTagCount);
      tokenRe.lastIndex = rawText.closeEnd;
      skipLiteralLines(tokenRe.lastIndex);
      continue;
    }
    if (match[0] === "<!--") {
      tokenRe.lastIndex = endOfHtmlComment(text, tokenRe.lastIndex);
      skipLiteralLines(tokenRe.lastIndex);
      if (body.trimStart().startsWith("<!--")) {
        const end = nextLineBreak(text, tokenRe.lastIndex)?.index ?? text.length;
        if (isMarkdownBlankLine(text.slice(tokenRe.lastIndex, end))) afterBlockBoundary = true;
      }
      continue;
    }
    if (match.groups?.ticks) {
      const insideSummary = depth === 1 && summaryOpening !== undefined && summary === undefined;
      if ((allowsMarkdown || insideSummary) && !isEscaped(text, match.index)) {
        const end = endOfBacktickSpan(text, match.index);
        if (end !== -1 && !crossesDetailsHtmlBoundary(text, match.index, end, containers)) {
          // Keep the legacy inline example consisting solely of an unmatched comment opener.
          let htmlEnd: number | undefined;
          if (htmlBlock) {
            if (/^\x60+[ \t]*<!--[ \t]*\x60+$/.test(text.slice(match.index, end))) {
              htmlEnd = findDisclosureCommentEnd(text, end, htmlBlockEnd(text.length), containers, definedLinkLabels);
            } else {
              const crossing = htmlContainerCrossingCodeEnd(text, match.index, end, htmlBlockEnd(end), openTags, depth);
              htmlEnd = crossing.closeEnd;
              depth = crossing.nextDepth;
            }
          }
          if (insideSummary && htmlEnd === undefined) summaryCodeSpans.push({ start: match.index, end });
          tokenRe.lastIndex = htmlEnd ?? end;
          skipLiteralLines(tokenRe.lastIndex);
        }
      }
      continue;
    }
    if (match.groups?.fence) {
      const fence = allowsMarkdown ? matchFenceOpening(body)?.[1] : undefined;
      if (fence) {
        const end = endOfDetailsCodeFence(text, tokenRe.lastIndex, fence, containers);
        skipCodeBlock(match.index, end);
      } else {
        tokenRe.lastIndex = match.index + 1;
      }
      continue;
    }
    skipLiteralLines(tokenRe.lastIndex);
    const tag = match.groups?.tag?.toLowerCase();
    const prefix = match.groups?.prefix;
    if (!namespace && tag === "template" && prefix === "") {
      openTags.length = Math.min(openTags.length, previousTagCount);
      tokenRe.lastIndex = htmlElementEnd(text, tag, tokenRe.lastIndex) ?? text.length;
      skipLiteralLines(tokenRe.lastIndex);
      continue;
    }
    if (!namespace && tag === "summary") {
      if (prefix === "/") {
        const end = nextLineBreak(text, tokenRe.lastIndex)?.index ?? text.length;
        if (isMarkdownBlankLine(text.slice(tokenRe.lastIndex, end))) afterBlockBoundary = true;
        if (depth === 1 && summaryOpening && !summary) {
          summary = { ...summaryOpening, closeStart: match.index, closeEnd: tokenRe.lastIndex, codeSpans: summaryCodeSpans };
          const newline = nextLineBreak(text, summary.closeEnd);
          if (newline) markdownBodyStart = newline.index + newline[0].length;
        }
      } else if (!prefix && depth === 1 && !summaryOpening) {
        summaryOpening = { openStart: match.index, openEnd: tokenRe.lastIndex };
      }
    }
    if (namespace || tag !== "details") continue;
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

const ASCII_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;

function encodeLiteralLabelText(text: string): string {
  return text.replace(new RegExp(ASCII_PUNCTUATION.source, "g"), character => `&#${character.charCodeAt(0)};`);
}

function codeSpanLabelText(span: string): string {
  const ticks = /^\x60+/.exec(span)![0].length;
  const text = span.slice(ticks, -ticks).replace(/\r\n|[\r\n]/g, " ");
  return encodeLiteralLabelText(/^ .* $/.test(text) && /[^ ]/.test(text) ? text.slice(1, -1) : text);
}

function readSummaryMarkup(text: string, summary: NonNullable<DetailsBounds["summary"]>): string {
  const parts: string[] = [];
  let cursor = summary.openEnd;
  // Only shield spans the disclosure scanner actually treated as Markdown.
  for (const { start, end } of summary.codeSpans) {
    parts.push(text.slice(cursor, start), codeSpanLabelText(text.slice(start, end)));
    cursor = end;
  }
  parts.push(text.slice(cursor, summary.closeStart));
  return parts.join("");
}

function markdownLabelLinkEnd(label: string, start: number): number {
  if (label[start] !== "(") return -1;
  let cursor = start + 1;
  while (/[ \t\r\n]/.test(label[cursor] ?? "")) cursor++;
  if (label[cursor] === ")") return cursor + 1;
  if (label[cursor] === "<") {
    const destination = /<(?:\\[<>]|[^<>\r\n])*>/y;
    destination.lastIndex = cursor;
    if (!destination.exec(label)) return -1;
    cursor = destination.lastIndex;
  } else {
    const destinationStart = cursor;
    let depth = 0;
    for (; cursor < label.length; cursor++) {
      const code = label.charCodeAt(cursor);
      if (code <= 32 || code === 127) break;
      const character = label[cursor]!;
      if (character === "\\" && ASCII_PUNCTUATION.test(label[cursor + 1] ?? "")) cursor++;
      else if (character === "(") depth++;
      else if (character === ")" && depth === 0) return cursor + 1;
      else if (character === ")") depth--;
    }
    if (cursor === destinationStart || depth !== 0) return -1;
  }
  const whitespaceStart = cursor;
  while (/[ \t\r\n]/.test(label[cursor] ?? "")) cursor++;
  if (label[cursor] === ")") return cursor + 1;
  if (cursor === whitespaceStart) return -1;
  const title = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))[ \t\r\n]*\)/y;
  title.lastIndex = cursor;
  return title.exec(label) ? title.lastIndex : -1;
}

const LINK_REFERENCE_LABEL_RE = /\[((?:\\[^\r\n]|\\(?=[\r\n]|$)|[^\\[\]]){0,999})\]/y;
const LINK_REFERENCE_TITLE_RE = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))[ \t]*$/;
const EMPTY_LINK_LABELS: ReadonlySet<string> = new Set<string>();

function readLinkReferenceLabel(text: string, start: number) {
  LINK_REFERENCE_LABEL_RE.lastIndex = start;
  const match = LINK_REFERENCE_LABEL_RE.exec(text);
  return match && match[1]!.length <= 999 ? { raw: match[1]!, end: LINK_REFERENCE_LABEL_RE.lastIndex } : undefined;
}

function normalizeLinkReferenceLabel(raw: string): string {
  return raw.replace(/[ \t\r\n]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase().toLowerCase();
}

function linkReferenceDestinationEnd(line: string): number {
  if (line.startsWith("<")) return /^<(?:\\[<>]|[^<>\r\n])*>/.exec(line)?.[0].length ?? -1;
  let depth = 0;
  let index = 0;
  for (; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code <= 32 || code === 127) break;
    const character = line[index];
    if (character === "\\" && ASCII_PUNCTUATION.test(line[index + 1] ?? "")) index++;
    else if (character === "(") depth++;
    else if (character === ")" && --depth < 0) return -1;

  }
  return index && depth === 0 ? index : -1;
}

function linkReferenceTitleDelimiter(title: string, from: number): number {
  const opensWithParenthesis = title[0] === "(";
  const closer = opensWithParenthesis ? ")" : title[0];
  for (let index = from; index < title.length; index++) {
    const character = title[index];
    if (character === "\\") index++;
    else if (character === closer || (opensWithParenthesis && character === "(")) return index;
  }
  return -1;
}

function readLinkReferenceDefinition(
  lines: readonly string[],
  index: number,
  { body, containers }: { body: string; containers: readonly MarkdownContainer[] },
) {
  if (!/^ {0,3}\[/.test(body)) return undefined;
  const continuation = (lineIndex: number) => {
    if (lineIndex >= lines.length) return undefined;
    const next = continueMarkdownContainers(lines[lineIndex]!, containers);
    return next.depth === containers.length && !isMarkdownBlankLine(next.body) ? next.body : undefined;
  };
  if (body.includes("|") && isPipeTableStart(body, continuation(index + 1))) return undefined;
  let header = body.replace(/^[ \t]+/, "");
  let lastLine = index;
  let reference = readLinkReferenceLabel(header, 0);
  while (!reference && header.length <= 999 && !/[[\]]/.test(header.slice(1).replace(/\\[^\r\n]/g, ""))) {
    const next = continuation(lastLine + 1);
    if (next === undefined) break;
    header += "\n" + next;
    lastLine++;
    reference = readLinkReferenceLabel(header, 0);
  }
  if (!reference || header[reference.end] !== ":") return undefined;
  const name = normalizeLinkReferenceLabel(reference.raw);
  if (!name) return undefined;
  let destination = header.slice(reference.end + 1).replace(/^[ \t]+/, "");
  if (!destination) destination = continuation(++lastLine)?.replace(/^[ \t]+/, "") ?? "";
  const destinationEnd = linkReferenceDestinationEnd(destination);
  if (destinationEnd < 0) return undefined;
  const remainder = destination.slice(destinationEnd);
  if (remainder && !/^[ \t]/.test(remainder)) return undefined;
  const inlineTitle = remainder.replace(/^[ \t]+/, "");
  let titleLine = inlineTitle ? lastLine : lastLine + 1;
  let title = inlineTitle || continuation(titleLine)?.replace(/^[ \t]+/, "") || "";
  if (/^["'(]/.test(title)) {
    let scannedThrough = 1;
    while (linkReferenceTitleDelimiter(title, scannedThrough) === -1) {
      const next = continuation(titleLine + 1);
      if (next === undefined) break;
      scannedThrough = title.length;
      title += "\n" + next;
      titleLine++;
    }
    if (LINK_REFERENCE_TITLE_RE.test(title)) lastLine = titleLine;
    else if (inlineTitle) return undefined;
  } else if (inlineTitle) {
    return undefined;
  }
  return { name, lastLine };
}

function collectLinkReferenceLabels(lines: readonly string[]): ReadonlySet<string> {
  const scanner = createMarkdownBlockScanner();
  const labels = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const state = scanner.scan(lines[index]!);
    if (state.mode !== "text" || !state.atBoundary) continue;
    const definition = readLinkReferenceDefinition(lines, index, state);
    if (!definition) continue;
    labels.add(definition.name);
    index = definition.lastLine;
    scanner.breakParagraph();
  }
  return labels;
}


function renderedMarkdownLinkEnd(
  label: string, closeIndex: number, contentStart: number, definedLinkLabels: ReadonlySet<string>,
): number {
  const suffixStart = closeIndex + 1;
  const inlineEnd = markdownLabelLinkEnd(label, suffixStart);
  if (inlineEnd !== -1 || !definedLinkLabels.size) return inlineEnd;
  const suffix = readLinkReferenceLabel(label, suffixStart);
  const raw = suffix?.raw || label.slice(contentStart, closeIndex);
  const candidate = readLinkReferenceLabel("[" + raw + "]", 0);
  return candidate?.raw === raw && definedLinkLabels.has(normalizeLinkReferenceLabel(raw))
    ? suffix?.end ?? suffixStart
    : -1;
}

function renderMarkdownLabelMarkup(
  label: string,
  readCodeSpans = true,
  definedLinkLabels = EMPTY_LINK_LABELS,
): string {
  const escapes = "\\\\(?<escape>" + ASCII_PUNCTUATION.source + ")";
  const punctuation = /(?<ticks>\x60+)|(?<bracket>!?\[|\])|(?<emphasis>\*+|_+|~+)/.source;
  const tokens = new RegExp([escapes, MARKDOWN_AUTOLINK, punctuation, HTML_MARKUP_TOKEN].join("|"), "gi");
  const parts: string[] = [];
  const brackets: { part: number; contentStart: number; image: boolean; active: boolean }[] = [];
  const delimiters = new Map<string, { part: number; length: number; remaining: number; canClose: boolean }[]>();
  let cursor = 0;
  const replace = (start: number, end: number, replacement: string) => {
    parts.push(label.slice(cursor, start), replacement);
    cursor = end;
    return parts.length - 1;
  };
  for (let match = tokens.exec(label); match; match = tokens.exec(label)) {
    const groups = match.groups!;
    const unterminatedComment = match[0].startsWith("<!--") && !/^<!--(?:-?>|[\s\S]*--!?>)$/.test(match[0]);
    const unterminatedDeclaration = !groups.cdata && /^<[!?]/.test(match[0]) && !match[0].endsWith(">");
    if (groups.escape) {
      replace(match.index, tokens.lastIndex, encodeLiteralLabelText(groups.escape));
    } else if (unterminatedComment || unterminatedDeclaration) {
      tokens.lastIndex = match.index + 1;
      replace(match.index, tokens.lastIndex, "&#60;");
    } else if (groups.autolink) {
      replace(match.index, tokens.lastIndex, " " + match[0].slice(1, -1) + " ");
    } else if (groups.ticks && readCodeSpans) {
      const end = endOfBacktickSpan(label, match.index);
      if (end !== -1) {
        replace(match.index, end, codeSpanLabelText(label.slice(match.index, end)));
        tokens.lastIndex = end;
      }
    } else if (groups.bracket === "]") {
      const opener = brackets.pop();
      if (!opener?.active) continue;
      const end = renderedMarkdownLinkEnd(label, match.index, opener.contentStart, definedLinkLabels);
      if (end !== -1) {
        parts[opener.part] = "";
        replace(match.index, end, "");
        tokens.lastIndex = end;
        if (!opener.image) {
          for (const previous of brackets) if (!previous.image) previous.active = false;
        }
      }
    } else if (groups.bracket) {
      brackets.push({
        part: replace(match.index, tokens.lastIndex, match[0]),
        contentStart: tokens.lastIndex,
        image: match[0].startsWith("!"),
        active: true,
      });
    } else if (groups.emphasis) {
      const marker = groups.emphasis;
      const symbol = marker[0]!;
      if (symbol === "~" && marker.length > 2) continue;
      const before = label[match.index - 1] ?? " ";
      const after = label[tokens.lastIndex] ?? " ";
      const punctuation = /[\p{P}\p{S}]/u;
      const left = !/\s/.test(after) && (!punctuation.test(after) || /\s/.test(before) || punctuation.test(before));
      const right = !/\s/.test(before) && (!punctuation.test(before) || /\s/.test(after) || punctuation.test(after));
      const canOpen = left && (symbol !== "_" || !right || punctuation.test(before));
      const canClose = right && (symbol !== "_" || !left || punctuation.test(after));
      const openers = delimiters.get(symbol) ?? [];
      let remaining = marker.length;
      if (canClose) {
        for (let index = openers.length - 1; index >= 0 && remaining > 0;) {
          const opener = openers[index]!;
          // CommonMark's rule of three applies to a run that can also face the other way.
          if (symbol !== "~" && (opener.canClose || canOpen) && (opener.length + marker.length) % 3 === 0 &&
            (opener.length % 3 !== 0 || marker.length % 3 !== 0)) {
            index--;
            continue;
          }
          if (symbol === "~" && (opener.length !== marker.length || opener.remaining !== remaining)) {
            index--;
            continue;
          }
          const length = symbol === "~" ? remaining : opener.remaining >= 2 && remaining >= 2 ? 2 : 1;
          opener.remaining -= length;
          remaining -= length;
          parts[opener.part] = symbol.repeat(opener.remaining);
          if (opener.remaining === 0) openers.splice(index--, 1);
        }
      }
      if (remaining !== marker.length || canOpen) {
        const part = replace(match.index, tokens.lastIndex, symbol.repeat(remaining));
        if (canOpen && remaining) {
          openers.push({ part, length: marker.length, remaining, canClose });
          delimiters.set(symbol, openers);
        }
      }
    } else if (groups.tag?.toLowerCase() === "template" && groups.prefix === "") {
      tokens.lastIndex = htmlElementEnd(label, "template", tokens.lastIndex) ?? label.length;
    } else {
      const raw = htmlRawTextBounds(label, match, tokens.lastIndex);
      if (raw) tokens.lastIndex = raw.closeEnd;
    }
  }
  return parts.length ? parts.join("") + label.slice(cursor) : label;
}

type OpenLabelTag = OpenHtmlTag & {
  suppressedSubtree: boolean;
  svgText: boolean;
  readonly customProps: CssCustomProperties;
};

function lastOpenHtmlTagIndex(openTags: readonly OpenHtmlTag[], tag: string): number {
  for (let index = openTags.length - 1; index >= 0; index--) {
    if (openTags[index]!.tag === tag) return index;
  }
  return -1;
}

const CSS_DISPLAY_OUTSIDE = new Set(["block", "inline", "run-in"]);
const CSS_DISPLAY_INSIDE = new Set(["flow", "flow-root", "table", "flex", "grid", "ruby", "math"]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const CSS_DISPLAY_SINGLE = new Set([
  "none", "contents", "inline-block", "inline-table", "inline-flex", "inline-grid", "-webkit-box", "-webkit-inline-box",
  "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-cell", "table-column-group",
  "table-column", "table-caption", "ruby-base", "ruby-text", "ruby-base-container", "ruby-text-container",
  ...CSS_WIDE_KEYWORDS,
]);

type CssToken =
  | { kind: "ident" | "punct" | "literal"; value: string }
  | { kind: "group"; name: string; tokens: CssToken[] };
type CssDeclaration = { name: string; value: readonly CssToken[]; important: boolean };
type CssCustomProperties = ReadonlyMap<string, readonly CssToken[]>;
const EMPTY_CUSTOM_PROPS: CssCustomProperties = new Map();

const CSS_ESCAPE = /\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f])/.source;
const CSS_IDENT = "(?:[-_a-zA-Z0-9\\u0080-\\uFFFF]|" + CSS_ESCAPE + ")+";
const CSS_COMPONENT = [
  /(?<trivia>[ \t\r\n\f]+|\/\*[\s\S]*?(?:\*\/|$))/.source,
  /(?<string>"(?:\\[\s\S]|[^"\\\r\n\f])*(?:"|(?=[\r\n\f])|\\?(?![\s\S]))|'(?:\\[\s\S]|[^'\\\r\n\f])*(?:'|(?=[\r\n\f])|\\?(?![\s\S])))/.source,
  "(?<ident>" + CSS_IDENT + ")(?<call>\\()?",
  /(?<punct>[()[\]{},;:!])|[\s\S]/.source,
].join("|");

function cssValueTokens(text: string): CssToken[] {
  const root: CssToken[] = [];
  const stack: { group: Extract<CssToken, { kind: "group" }>; closer: string }[] = [];
  for (const match of text.matchAll(new RegExp(CSS_COMPONENT, "g"))) {
    const { trivia, ident, call, punct } = match.groups!;
    // Comments separate adjacent tokens, including identifiers such as no/**/ne.
    if (trivia) continue;
    const current = stack.at(-1);
    const tokens = current?.group.tokens ?? root;
    const value = ident === undefined ? match[0] : unescapeCssDisplay(ident);
    const closer = call || punct === "(" ? ")" : punct === "[" ? "]" : punct === "{" ? "}" : undefined;
    if (closer) {
      const group = { kind: "group" as const, name: value, tokens: [] };
      tokens.push(group);
      stack.push({ group, closer });
    } else if (current && punct === current.closer) {
      stack.pop();
    } else {
      tokens.push({ kind: ident !== undefined ? "ident" : punct ? "punct" : "literal", value });
    }
  }
  // CSS closes open component values at EOF. Their contents are already in the group.
  return root;
}

function unescapeCssDisplay(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/gi, (_, hex?: string, literal?: string) => {
    if (!hex) return literal ?? "";
    const code = Number.parseInt(hex, 16);
    return code && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

function cssDisplayKeyword(tokens: readonly CssToken[], all: boolean): string | undefined {
  if (!tokens.length || tokens.length > 3) return undefined;
  const words: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "ident") return undefined;
    words.push(token.value.toLowerCase());
  }
  const first = words[0]!;
  if (all) return words.length === 1 && CSS_WIDE_KEYWORDS.has(first) ? first : undefined;
  if (words.length === 1 && CSS_DISPLAY_SINGLE.has(first)) return first;
  if (new Set(words).size !== words.length) return undefined;
  const outside = words.filter(word => CSS_DISPLAY_OUTSIDE.has(word));
  const inside = words.filter(word => CSS_DISPLAY_INSIDE.has(word));
  const listItem = words.includes("list-item");
  return outside.length <= 1 && inside.length <= 1 &&
    outside.length + inside.length + Number(listItem) === words.length &&
    (!listItem || !inside.length || inside[0] === "flow" || inside[0] === "flow-root") ? words.join(" ") : undefined;
}

function isCssPunct(token: CssToken | undefined, value: string): boolean {
  return token?.kind === "punct" && token.value === value;
}

function cssStyleDeclarations(text: string): CssDeclaration[] {
  const tokens = cssValueTokens(text);
  const declarations: CssDeclaration[] = [];
  let start = 0;
  for (let end = 0; end <= tokens.length; end++) {
    if (end < tokens.length && !isCssPunct(tokens[end], ";")) continue;
    const name = tokens[start];
    if (name?.kind === "ident" && isCssPunct(tokens[start + 1], ":")) {
      const last = tokens[end - 1];
      const important = end >= start + 4 && last?.kind === "ident" && last.value.toLowerCase() === "important" &&
        isCssPunct(tokens[end - 2], "!");
      declarations.push({ name: name.value, value: tokens.slice(start + 2, important ? end - 2 : end), important });
    }
    start = end + 1;
  }
  return declarations;
}

function cssVariableCall(group: Extract<CssToken, { kind: "group" }>) {
  const [name, comma] = group.tokens;
  if (name?.kind !== "ident" || !name.value.startsWith("--") || name.value.length <= 2 ||
    (comma && !isCssPunct(comma, ","))) return undefined;
  return { name: name.value, fallback: comma ? group.tokens.slice(2) : undefined };
}

function cssVariableDependencies(tokens: readonly CssToken[]): Set<string> | undefined {
  const dependencies = new Set<string>();
  const groups = tokens.filter(token => token.kind === "group");
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.name.toLowerCase() === "var") {
      const call = cssVariableCall(group);
      if (!call) return undefined;
      dependencies.add(call.name);
    }
    for (const token of group.tokens) if (token.kind === "group") groups.push(token);
  }
  return dependencies;
}

function createCssVariableResolver(custom: ReadonlyMap<string, CssDeclaration>, inherited: CssCustomProperties) {
  const dependencies = new Map(
    Array.from(custom, ([name, declaration]) => [name, cssVariableDependencies(declaration.value)]),
  );
  const indices = new Map<string, number>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  // Each strongly connected component is a cycle, except a lone property without a self-reference.
  const visit = (name: string): number => {
    const index = indices.size;
    let low = index;
    indices.set(name, index);
    active.add(name);
    stack.push(name);
    const edges = dependencies.get(name);
    for (const dependency of edges ?? []) {
      if (!dependencies.has(dependency)) continue;
      const existing = indices.get(dependency);
      if (existing === undefined) low = Math.min(low, visit(dependency));
      else if (active.has(dependency)) low = Math.min(low, existing);
    }
    if (low === index) {
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        members.push(member);
      } while (member !== name);
      if (members.length > 1 || edges?.has(name)) {
        for (const member of members) cyclic.add(member);
      }
    }
    return low;
  };
  for (const name of custom.keys()) if (!indices.has(name)) visit(name);

  const computed = new Map<string, readonly CssToken[] | undefined>();
  const substitute = (tokens: readonly CssToken[]): readonly CssToken[] | undefined => {
    const result: CssToken[] = [];
    for (const token of tokens) {
      if (token.kind !== "group") {
        if (result.length < 4) result.push(token);
        continue;
      }
      if (token.name.toLowerCase() !== "var") {
        const children = substitute(token.tokens);
        if (children === undefined) return undefined;
        if (result.length < 4) result.push({ ...token, tokens: [...children] });
        continue;
      }
      const call = cssVariableCall(token);
      if (!call) return undefined;
      const replacement = resolve(call.name) ?? (call.fallback && substitute(call.fallback));
      if (replacement === undefined) return undefined;
      // Display has at most three tokens. Keep one extra to distinguish an invalid value.
      result.push(...replacement.slice(0, 4 - result.length));
    }
    return result;
  };
  const resolve = (name: string) => {
    const declaration = custom.get(name);
    if (!declaration) return inherited.get(name);
    if (computed.has(name)) return computed.get(name);
    const { value } = declaration;
    const first = value[0];
    const keyword = value.length === 1 && first?.kind === "ident" ? first.value.toLowerCase() : "";
    const resolved = CSS_WIDE_KEYWORDS.has(keyword)
      ? keyword === "initial" ? undefined : inherited.get(name)
      : !cyclic.has(name) && dependencies.get(name) ? substitute(value) : undefined;
    computed.set(name, resolved);
    return resolved;
  };
  return { substitute, resolve };
}

function resolveElementStyle(
  styleAttr: string | undefined,
  presentationAttr: string | undefined,
  inheritedProps: CssCustomProperties,
): { readonly displayIsNone: boolean; readonly customProps: CssCustomProperties } {
  if (!styleAttr && !presentationAttr) return { displayIsNone: false, customProps: inheritedProps };
  const custom = new Map<string, CssDeclaration>();
  let winner: CssDeclaration | undefined;
  for (const declaration of cssStyleDeclarations(decodeHtmlLabelText(styleAttr ?? ""))) {
    const { name, value, important } = declaration;
    if (name.startsWith("--")) {
      if ((!custom.get(name)?.important || important) && cssVariableDependencies(value)) custom.set(name, declaration);
      continue;
    }
    const property = name.toLowerCase();
    if ((property !== "display" && property !== "all") || (winner?.important && !important)) continue;
    const variables = cssVariableDependencies(value);
    if (variables && (variables.size || cssDisplayKeyword(value, property === "all"))) winner = declaration;
  }
  const value = winner?.value ?? cssValueTokens(decodeHtmlLabelText(presentationAttr ?? ""));
  const deps = cssVariableDependencies(value);
  const resolver = custom.size || deps?.size ? createCssVariableResolver(custom, inheritedProps) : undefined;
  let customProps = inheritedProps;
  if (custom.size) {
    const computed = new Map(inheritedProps);
    for (const name of custom.keys()) {
      const tokens = resolver!.resolve(name);
      if (tokens === undefined) computed.delete(name);
      else computed.set(name, tokens);
    }
    customProps = computed;
  }
  // The all shorthand participates in the display cascade and excludes custom properties.
  // A winning but unresolved variable computes to unset, including when display was set earlier.
  const effective = !deps ? undefined : deps.size ? resolver!.substitute(value) : value;
  return {
    displayIsNone: effective !== undefined && cssDisplayKeyword(effective, winner?.name.toLowerCase() === "all") === "none",
    customProps,
  };
}

function htmlLabelTextVariants(label: string) {
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  const inline: string[] = [];
  const spaced: string[] = [];
  const appendText = (start: number, end?: number, decodeReferences = true) => {
    // References cannot continue into the next HTML text node.
    const raw = label.slice(start, end);
    const text = decodeReferences ? decodeHtmlLabelText(raw) : raw;
    inline.push(text);
    spaced.push(text);
  };
  let cursor = 0;
  const openTags: OpenLabelTag[] = [];
  let annotationIndex: number | undefined;
  let hasDetails = false;
  const rendersText = () => {
    const parent = openTags.at(-1);
    return annotationIndex === undefined && !parent?.suppressedSubtree &&
      (parent?.childrenNamespace !== "svg" || parent.svgText);
  };
  for (let match = tokens.exec(label); match; match = tokens.exec(label)) {
    let visibleTag = !openTags.at(-1)?.suppressedSubtree;
    if (rendersText()) appendText(cursor, match.index);
    cursor = tokens.lastIndex;
    if (match.groups?.cdata) {
      if (openTags.at(-1)?.childrenNamespace && match[0].startsWith("<![CDATA[")) {
        if (rendersText()) {
          appendText(match.index + 9, match[0].endsWith("]]>") ? cursor - 3 : cursor, false);
        }
      } else {
        tokens.lastIndex = cursor = endOfBogusHtmlComment(label, match.index);
      }
      continue;
    }
    const tag = match.groups?.tag?.toLowerCase();
    const prefix = match.groups?.prefix;
    if (tag && openTags.at(-1)?.childrenNamespace && exitsHtmlForeignContent(tag, prefix, match[0])) {
      while (openTags.at(-1)?.childrenNamespace) openTags.pop();
      if (annotationIndex !== undefined && annotationIndex >= openTags.length) annotationIndex = undefined;
      visibleTag = !openTags.at(-1)?.suppressedSubtree;
    }
    if (tag === "head") continue;
    const parent = openTags.at(-1);
    const rubyTextTag = tag === "rt" || tag === "rp";
    const rubyIndex = rubyTextTag || tag === "rb" ? lastOpenHtmlTagIndex(openTags, "ruby") : -1;
    const rubyAnnotation = rubyTextTag && rubyIndex >= 0;
    if (tag && prefix === "") {
      const namespace = openTags.at(-1)?.childrenNamespace ?? (tag === "svg" || tag === "math" ? tag : undefined);
      const htmlAnnotation = htmlEncodedAnnotation(namespace, tag, match[0]);
      const foreignHidden = (namespace === "svg" && SVG_NON_RENDERED_LABEL_TAGS.has(tag)) ||
        (namespace === "math" && MATH_NON_RENDERED_LABEL_TAGS.has(tag) && !htmlAnnotation);
      const selfClosingForeignTag = namespace !== undefined && hasSelfClosingFlag(match[0], tag);
      const styleParent = rubyIndex >= 0 && annotationIndex !== undefined && annotationIndex > rubyIndex
        ? openTags[annotationIndex - 1] : parent;
      const { displayIsNone, customProps } = resolveElementStyle(
        htmlAttributeValue(match[0], tag, "style"),
        namespace ? htmlAttributeValue(match[0], tag, "display") : undefined,
        styleParent?.customProps ?? EMPTY_CUSTOM_PROPS,
      );
      // Browsers can close these elements implicitly before the next visible sibling.
      const hidden = !HTML_OPTIONAL_END_TAGS.has(tag) &&
        (htmlAttributeValue(match[0], tag, "hidden") !== undefined || displayIsNone);
      const raw = namespace === undefined ? htmlRawTextBounds(label, match, cursor) : null;
      const inertTag = HTML_NON_RENDERED_LABEL_TAGS.has(tag);
      if (!foreignHidden && (hidden || inertTag)) {
        // When an end tag is omitted, keep potentially visible text available for protection.
        const hiddenEnd = HTML_VOID_TAGS.has(tag) || selfClosingForeignTag ? cursor :
          raw ? (raw.closeStart < label.length || inertTag ? raw.closeEnd : undefined) :
          htmlElementEnd(label, tag, cursor, namespace, htmlAnnotation);
        if (hiddenEnd !== undefined || tag === "template") {
          tokens.lastIndex = cursor = hiddenEnd ?? label.length;
          continue;
        }
      }
      if (raw) {
        if (annotationIndex === undefined && visibleTag) appendText(cursor, raw.closeStart, tag === "textarea");
        tokens.lastIndex = cursor = raw.closeEnd;
        continue;
      }
      if (rubyIndex >= 0 && annotationIndex !== undefined && annotationIndex > rubyIndex) {
        openTags.length = annotationIndex;
        annotationIndex = undefined;
      }
      if (rubyAnnotation && annotationIndex === undefined) annotationIndex = openTags.length;
      visibleTag = visibleTag && !foreignHidden;
      if (!HTML_VOID_TAGS.has(tag) && !selfClosingForeignTag) {
        openTags.push({
          tag,
          childrenNamespace: htmlChildNamespace(namespace, tag, htmlAnnotation),
          suppressedSubtree: !visibleTag,
          customProps,
          svgText: namespace === "svg" && (SVG_TEXT_TAGS.has(tag) || (tag !== "svg" && parent?.svgText === true)),
        });
      }
    } else if (tag && prefix === "/") {
      const index = lastOpenHtmlTagIndex(openTags, tag);
      if (index >= 0) {
        openTags.length = index;
        if (annotationIndex !== undefined && index <= annotationIndex) annotationIndex = undefined;
      }
    }
    if (visibleTag && tag && tag !== "svg" && tag !== "ruby" && parent?.childrenNamespace !== "svg" &&
      !rubyAnnotation && annotationIndex === undefined) {
      if (tag === "details" && prefix === "") hasDetails = true;
      if (HTML_LABEL_BREAK_TAGS.has(tag)) inline.push(" ");
      spaced.push(" ");
    }
  }
  if (rendersText()) appendText(cursor);
  const normalize = (parts: readonly string[]) => parts.join("").replace(INVISIBLE_LABEL_TEXT, "").replace(/\s+/g, " ").trim();
  return { inline: normalize(inline), spaced: normalize(spaced), hasDetails };
}

function classifyDetailsElement(
  text: string,
  openEnd: number,
  { summary }: DetailsBounds,
  activeVisibility: PedagogicalVisibility,
  definedLinkLabels: ReadonlySet<string>,
): {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label: string;
  readonly summaryEndOffset: number | null;
} {
  if (summary && !text.slice(openEnd, summary.openStart).replace(HTML_COMMENT_RE, "").trim()) {
    const summaryContents = renderMarkdownLabelMarkup(readSummaryMarkup(text, summary), false, definedLinkLabels);
    const { inline: summaryText, spaced, hasDetails } = htmlLabelTextVariants(summaryContents);
    if (
      ![summaryText, spaced].some(label => SEALED_HEADING_RE.test(label) || /\bspoiler\b/i.test(label)) &&
      !hasDetails &&
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
      if (!length && !isMarkdownBlankLine(body)) break;
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

const HTML_TYPE_6_BLOCK_START_RE =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[ \t/>]|$)/i;
const HTML_OTHER_BLOCK_START_RE = /^ {0,3}<(?:\?|!(?:--|\[CDATA\[|[A-Z])|\/?(?:pre|script|style|textarea)(?=[ \t/>]|$))/i;
const STANDALONE_HTML_TAG_RE =
  /^ {0,3}(?:<\/[a-z][a-z0-9-]*[ \t]*>|<[a-z][a-z0-9-]*(?:[ \t]+[a-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^ \t"'=<>\x60]+))?)*[ \t]*\/?>)[ \t]*$/i;

function interruptsPipeTable(line: string): boolean {
  return matchFenceOpening(line) !== null || /^[ \t]{0,3}(?::{3,}|#{1,6}(?:[ \t]|$)|>)/.test(line) ||
    THEMATIC_BREAK_RE.test(line) || LIST_ITEM_RE.test(line) ||
    HTML_TYPE_6_BLOCK_START_RE.test(line) || HTML_OTHER_BLOCK_START_RE.test(line) || STANDALONE_HTML_TAG_RE.test(line);
}

function isPipeTableBodyRow(line: string): boolean {
  return !isMarkdownBlankLine(line) && !interruptsPipeTable(line);
}

function isPipeParagraphLine(line: string): boolean {
  return line.includes("|") && isPipeTableBodyRow(line) &&
    !/^(?:\$\$|\\\[)/.test(line.trimStart()) && !LATEX_BEGIN_RE.test(line.trimStart());
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

function tableColumnVisibility(label: string, definedLinkLabels = EMPTY_LINK_LABELS): PedagogicalVisibility {
  if (/[<\\*_[~\x60]/.test(label)) label = renderMarkdownLabelMarkup(label, true, definedLinkLabels);
  const { inline, spaced } = /[<&]|\p{Cf}/u.test(label) ? htmlLabelTextVariants(label) : { inline: label, spaced: label };
  if (SEALED_HEADING_RE.test(inline) || SEALED_HEADING_RE.test(spaced)) return "sealed";
  if (HINT_HEADING_RE.test(inline) || HINT_HEADING_RE.test(spaced)) return "hint_gated";
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
    if (isMarkdownBlankLine(raw.slice(cell.start, cell.end))) continue;
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

function getTableColumnVisibilities(
  header: string, cells: readonly { start: number; end: number }[], definedLinkLabels: ReadonlySet<string>, start = 0,
) {
  return cells.map(cell => tableColumnVisibility(header.slice(cell.start - start, cell.end - start), definedLinkLabels));
}

type ReadMarkdownLine = (index: number) => string | undefined;

function createProtectedSetextLookup(readRaw: ReadMarkdownLine, definedLinkLabels: ReadonlySet<string>) {
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
      if (columns && tableColumnVisibility(titleLine, definedLinkLabels) !== "public") {
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
      if (tableColumnVisibility(title.join("\n"), definedLinkLabels) !== "public") return paragraph.index;
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
  readNext: (distance: number) => string | undefined = () => undefined,
): boolean {
  if (interruptsPipeTable(body) || (tableActive && containers.includes("quote", continuedDepth))) return true;
  if (containers.at(-1) === "quote" && CALLOUT_HEADER_RE.test(body.trimStart())) return true;
  const latex = readLatexCueCommand(body, readNext);
  return latex?.directive === "begin" && !body.slice(0, latex.start).trim() &&
    !latex.rest.trim() && classifyLatexEnvironment(latex.name, "public") !== null;
}

function nextBodyInContainer(raw: string | undefined, containers: readonly MarkdownContainer[]): string | undefined {
  if (raw === undefined) return undefined;
  const continued = continueMarkdownContainers(raw, containers);
  return continued.depth === containers.length ? continued.body : undefined;
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
  definedLinkLabels: ReadonlySet<string>,
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
  let latexArgumentThrough = -1;
  let literalEnvironment: string | undefined;
  const mathEnvironments: string[] = [];
  const protectedUnderline = createProtectedSetextLookup(index => lines[index], definedLinkLabels);
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
      literalEnvironment = undefined;
      mathEnvironments.length = 0;
      latexArgumentThrough = -1;
      const underline = protectedUnderline(start, readMarkdownContainerLine(lines[start]!, containers));
      if (underline !== undefined) setextThrough = underline;
    }
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      const continuation = continueMarkdownContainers(line, containers);
      const current = readMarkdownContainerLine(line, containers);
      const readNext = (distance: number) => nextBodyInContainer(lines[index + distance], current.containers);
      let latex = readLatexCueCommand(current.body, readNext);
      while (latex) {
        const { directive, name, endLine, nextColumn } = latex;
        if (endLine > 0) latexArgumentThrough = Math.max(latexArgumentThrough, index + endLine);
        if (literalEnvironment !== undefined) {
          if (directive === "end" && name === literalEnvironment) literalEnvironment = undefined;
        } else if (directive === "begin" && LATEX_LITERAL_ENVIRONMENT_RE.test(name)) {
          literalEnvironment = name;
        } else if (MATH_ENVS.has(name)) {
          if (directive === "begin") mathEnvironments.push(name);
          else if (mathEnvironments.at(-1) === name) mathEnvironments.pop();
        }
        if (endLine > 0) break;
        latex = readLatexCueCommand(current.body, readNext, nextColumn);
      }
      if (tableColumns && continuation.depth === containers.length) {
        const explicitBoundary = startsTimedTableBoundary(current, true, readNext);
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
      tableColumns = headerCells ? getTableColumnVisibilities(previousBody, headerCells, definedLinkLabels) : undefined;
      containers = current.containers;
      previousBody = current.body;
    }
    const nextLine = lines[end];
    if (!joinNext || nextLine === undefined) return "";
    const continued = continueMarkdownContainers(nextLine, containers);
    if (end <= latexArgumentThrough) return newline;
    if (tableColumns && continued.depth === containers.length) {
      const next = readMarkdownContainerLine(nextLine, containers);
      const explicitBoundary = startsTimedTableBoundary(
        next, true, distance => nextBodyInContainer(lines[end + distance], next.containers),
      );
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
    const continuesLatexEnvironment = continued.depth === containers.length &&
      (mathEnvironments.length > 0 || literalEnvironment !== undefined);
    if (continuesTable || continuesQuote || continuesSetext || continuesPipeParagraph || continuesLatexEnvironment) return newline;

    // The synthetic paragraph break also ends any table.
    previousBody = "";
    tableColumns = undefined;
    return newline.repeat(2);
  };
}

function collectCueLinkReferenceLabels(
  bodies: readonly string[],
  joinsNext: (index: number) => boolean = () => true,
  breaksBefore: (index: number) => boolean = () => false,
): ReadonlySet<string> {
  if (!bodies.some(body => body.includes("]:"))) return EMPTY_LINK_LABELS;
  const separator = createTranscriptCueSeparator(bodies, EMPTY_LINK_LABELS);
  const projected = bodies.map((body, index) => {
    const joinNext = joinsNext(index);
    const boundary = separator(index, joinNext, breaksBefore(index));
    return body + (joinNext ? boundary : "\n");
  }).join("");
  return collectLinkReferenceLabels(splitLinesWithOffsets(projected).map(line => line.raw));
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
    const body = stripLatexComment(current.body).replace(/^[ \t]+/, "");
    const latex = matchLatexBlockOpening(current.body, () => text.slice(lineStart));
    if (/^[ \t]*\\end(?=[ \t{%]|$)/.test(current.body)) {
      const closing = LATEX_BLOCK_END_RE.exec(text.slice(lineStart));
      if (closing) {
        paragraphStart = undefined;
        newline = nextLineBreak(text, lineStart + closing[0].length);
        continue;
      }
    }
    if (latex && LATEX_LITERAL_ENVIRONMENT_RE.test(latex[1]!)) {
      const closing = findLatexLiteralEnd(text, latex[1]!, lineStart + latex[0].length);
      paragraphStart = undefined;
      newline = closing ? nextLineBreak(text, closing.closeEnd) : null;
      continue;
    }
    const beforeLine = newline.index;
    if (
      isMarkdownBlankLine(current.body) ||
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
    if (!isMarkdownBlankLine(body) && !/^(?:\$\$|\\\[|\\\])/.test(body) && !/^(?: {4}| {0,3}\t)/.test(current.body)) {
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
    /<details(?=[\t\n\f\r />])/.source + "|" + LATEX_BEGIN, "gi");
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
      && isMarkdownBlankLine(text.slice(openerLineStart, start))
      && isMarkdownBlankLine(stripLatexComment(text.slice(afterOpen, openerLineEnd)));
    const standaloneCloser = isMarkdownBlankLine(text.slice(closerLineStart, close))
      && isMarkdownBlankLine(stripLatexComment(text.slice(close + 2, closerLineEnd)));
    const startsLaterFormula = closerLineStart > openerLineStart
      && isMarkdownBlankLine(text.slice(closerLineStart, close))
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

function startsLatexBlock(raw: string, readContinuation?: () => string): boolean {
  const latexEnv = matchLatexBlockOpening(raw, readContinuation);
  if (latexEnv && classifyLatexEnvironment(latexEnv[1]!, "public") !== null) return true;
  if (/^[ \t]*\$\$/.test(raw) && !isEscaped(raw, raw.indexOf("$$"))) return true;
  return /^[ \t]*\\\[/.test(raw);
}

function startsMarkdownBlock(raw: string, next?: string, interruptsParagraph = false): boolean {
  if (isMarkdownBlankLine(raw)) return true;
  if (/^[ \t]{0,3}(\x60{3,}|~{3,})/.test(raw)) return true;
  if (/^[ \t]{0,3}:{3,}[ \t]*[a-zA-Z]/.test(raw)) return true;
  if (DETAILS_OPEN_RE.test(raw.trimStart())) return true;
  if (/^[ \t]*>/.test(raw)) return true;
  if (/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(raw)) return true;
  if (THEMATIC_BREAK_RE.test(raw)) return true;
  const list = LIST_ITEM_RE.exec(raw);
  if (list && (!interruptsParagraph ||
    (!isMarkdownBlankLine(raw.slice(list[1]!.length)) && /^(?:[-+*]|1[.)])/.test(list[1]!.trimStart())))) return true;
  if (isPipeTableStart(raw, next)) return true;
  if (parseInlineTranscriptCue(raw) !== null) return true;
  return false;
}

function startsSpecialLine(raw: string, next?: string, interruptsParagraph = false): boolean {
  return startsLatexBlock(raw, next === undefined ? undefined : () => raw + "\n" + next) ||
    startsMarkdownBlock(raw, next, interruptsParagraph);
}

interface QuoteParagraph {
  open: boolean;
  fence?: string;
}

function updateQuotedParagraph(state: QuoteParagraph, rawBody: string) {
  const body = rawBody.replace(/^[ \t]+/, "");
  const fence = /^(\x60{3,}|~{3,}|\$\$(?=[ \t]*$))(.*)$/.exec(body);
  if (state.fence) {
    if (fence && fence[1]![0] === state.fence[0] && fence[1]!.length >= state.fence.length && isMarkdownBlankLine(fence[2]!)) {
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

function findInlineLiteralEnd(text: string, start: number, end: number, tableLiterals: boolean): number {
  const marker = text[start]!;
  if (isEscaped(text, start) || (text[start - 1] === marker && !isEscaped(text, start - 1))) return -1;
  const limit = tableLiterals ? Math.min(end, nextLineBreak(text, start)?.index ?? end) : end;
  if (marker === "\x60") return endOfBacktickSpan(text, start, limit);

  const first = text[start + 1];
  if (!first || first === "$" || /\s/.test(first)) return -1;
  let close = findUnescapedToken(text, "$", start + 1);
  while (close !== -1 && close < limit) {
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
  includeInlineCode = false,
  definedLinkLabels = EMPTY_LINK_LABELS,
  inheritsHtmlBlock = createMarkdownHtmlBlockLookup(text),
): InlineConstructSpan[] {
  const spans: InlineConstructSpan[] = [];
  let i = rangeStart;
  while (i < rangeEnd) {
    if (text[i] === "\x60" || (tableLiterals && text[i] === "$")) {
      const end = findInlineLiteralEnd(text, i, rangeEnd, tableLiterals);
      if (end !== -1) {
        if (tableLiterals || includeInlineCode) {
          const kind = text[i] === "\x60" ? "code" : "display_math";
          spans.push({ start: i, end, kind, visibility: activeVisibility });
        }
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
    if (text.startsWith("\\begin", i) && !isEscaped(text, i)) {
      const m = LATEX_BEGIN_RE.exec(text.slice(i));
      if (m) {
        const envName = m[1]!;
        const classified = classifyLatexEnvironment(envName, activeVisibility, sealProofs);
        if (classified) {
          const openEnd = i + m[0].length;
          const isMath = classified.kind === "display_math";
          const isLiteral = classified.kind === "code";
          const math = isMath ? findMathEnvironment(text, envName, openEnd) : null;
          const bounds = math ?? (isLiteral
            ? findLatexLiteralEnd(text, envName, openEnd) ?? { closeStart: text.length, closeEnd: text.length }
            : findMatchingLatexEnvBounds(text, envName, openEnd));
          spans.push({
            start: i,
            end: bounds.closeEnd,
            kind: classified.kind,
            visibility: math?.closed === false || (isLiteral && bounds.closeStart === text.length)
              ? "sealed" : classified.visibility,
            label: envName,
            ...(isMath || isLiteral ? {} : { openEnd, closeStart: bounds.closeStart }),
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
        const bounds = findMatchingDetailsBounds(text, i, openEnd, inheritsHtmlBlock, definedLinkLabels);
        const classified = classifyDetailsElement(text, openEnd, bounds, activeVisibility, definedLinkLabels);
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
  definedLinkLabels: ReadonlySet<string>,
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
    definedLinkLabels,
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
  definedLinkLabels: ReadonlySet<string> = EMPTY_LINK_LABELS,
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
  const protectedUnderline = createProtectedSetextLookup(readCueBody, definedLinkLabels);
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
    const readNext = (distance: number, activeContainers: readonly MarkdownContainer[]) => {
      const offset = index + distance;
      const nextCueBody = lines[offset]?.raw.slice(cueTimings[offset]?.prefixLength ?? 0);
      return nextBodyInContainer(nextCueBody, activeContainers);
    };
    const markedBoundary = boundaryFloors?.has(start);
    let explicitBoundary = markedBoundary || (cueLine !== null && startsTimedTableBoundary(
      cueLine, table !== undefined, distance => readNext(distance, cueLine.containers),
    ));
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
        explicitBoundary ||= table.timed && startsTimedTableBoundary(
          candidate, true, distance => readNext(distance, candidate.containers),
        );
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
        columns: getTableColumnVisibilities(header.body, cells, definedLinkLabels),
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
  definedLinkLabels: ReadonlySet<string>,
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
  const cueSeparator = createTranscriptCueSeparator(bodies, definedLinkLabels);
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
  } : headingContext, definedLinkLabels));
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
  inheritedLinkLabels?: ReadonlySet<string>,
): PedagogicalAstBlock[] {
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  const lines = splitLinesWithOffsets(text);
  const initialTimings = scanInlineCueTimings(lines, captionRowStarts, boundaryFloors, inheritedLinkLabels);
  const hasCueTimings = initialTimings.timings.some(Boolean);
  const boundaryBefore = (index: number) => initialTimings.tableBreakVisibilities.has(index) ||
    boundaryFloors?.has(lines[index]?.start ?? -1) === true;
  const definedLinkLabels = inheritedLinkLabels ?? (text.includes("]:")
    ? hasCueTimings
      ? collectCueLinkReferenceLabels(
          lines.map(({ raw }, index) => raw.slice(initialTimings.timings[index]?.prefixLength ?? 0)),
          index => Boolean(initialTimings.timings[index] && initialTimings.timings[index + 1] && !boundaryBefore(index + 1)),
          boundaryBefore,
        )
      : collectLinkReferenceLabels(lines.map(line => line.raw))
    : EMPTY_LINK_LABELS);
  const { timings, tableBreakVisibilities } = hasCueTimings && !inheritedLinkLabels && definedLinkLabels.size
    ? scanInlineCueTimings(lines, captionRowStarts, boundaryFloors, definedLinkLabels)
    : initialTimings;
  if (timings.some(Boolean)) {
    return parseInlineCuedDocument(text, lines, timings, tableBreakVisibilities,
      options, sealProofs, definedLinkLabels, captionRowStarts, boundaryFloors, headingContext);
  }
  const protectedCaptionUnderline = captionRowStarts && createProtectedSetextLookup(index => lines[index]?.raw, definedLinkLabels);
  const blocks: PedagogicalAstBlock[] = [];
  const inheritsHtmlBlock = createMarkdownHtmlBlockLookup(text);
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
      undefined,
      definedLinkLabels,
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
    const inlineSpans = findInlineConstructSpans(text, rangeStart, rangeEnd, activeVis, sealProofs, false, false, definedLinkLabels, inheritsHtmlBlock);
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

    if (isMarkdownBlankLine(raw)) {
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
        false,
        false,
        definedLinkLabels,
        inheritsHtmlBlock,
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
        const titleVisibility = tableColumnVisibility(cleanHeadingTitle, definedLinkLabels);
        const ownVisibility = titleVisibility === "public" ? sectionBaseVisibility : titleVisibility;
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
          ? findInlineConstructSpans(text, line.start, inlineEnd, activeVis, sealProofs, false, false, definedLinkLabels, inheritsHtmlBlock)
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
    const envMatch = matchLatexBlockOpening(raw, () => text.slice(line.start));
    if (envMatch && !tableHeaderCells) {
      const envName = envMatch[1]!;
      const activeVis = blockVisibility;
      const classified = classifyLatexEnvironment(envName, activeVis, sealProofs);
      if (classified) {
        const leadingWs = envMatch[0].length - envMatch[0].trimStart().length;
        const envStart = line.start + leadingWs;
        const openEndOffset = line.start + envMatch[0].length;
        const isMath = classified.kind === "display_math";
        const isLiteral = classified.kind === "code";
        const math = isMath ? findMathEnvironment(text, envName, openEndOffset) : null;
        const { closeStart, closeEnd } = math ?? (isLiteral
          ? findLatexLiteralEnd(text, envName, openEndOffset) ?? { closeStart: text.length, closeEnd: text.length }
          : findMatchingLatexEnvBounds(text, envName, openEndOffset));
        const endLineIdx = lineIndexContaining(lines, Math.max(envStart, closeEnd - 1), i);
        const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
        const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
        const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

        if (!isMath && !isLiteral && classified.visibility !== "sealed" && closeStart > openEndOffset) {
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
          const visibility = math?.closed === false || (isLiteral && closeStart === text.length)
            ? "sealed" : classified.visibility;
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
      const bounds = findMatchingDetailsBounds(text, detailsStart, openEndOffset, inheritsHtmlBlock, definedLinkLabels);
      const { closeStart, closeEnd } = bounds;
      const classified = classifyDetailsElement(text, openEndOffset, bounds, activeVis, definedLinkLabels);
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
            lines, i, quoteEnd - 1, null, activeVis, false, sealProofs, definedLinkLabels, captionRowStarts, boundaryFloors,
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
            definedLinkLabels, captionRowStarts, boundaryFloors, undefined,
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
            definedLinkLabels,
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
          definedLinkLabels,
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
        if (isMarkdownBlankLine(candidate)) {
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
        definedLinkLabels,
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
      const columns = getTableColumnVisibilities(raw, tableHeaderCells, definedLinkLabels, line.start);
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

      const inlineSpans = findInlineConstructSpans(text, tableStart, tableEnd, activeVis, sealProofs, true, false, definedLinkLabels, inheritsHtmlBlock);
      const extracted = extractProtectedBlocksFromSpans(inlineSpans, tableEnd, activeVis);

      extracted.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);

      // Extract data cells belonging to sealed / hint-gated columns (e.g. Answer Key / Solution / Hint).
      const headerCells = activeVis === "sealed" ? [] : tableHeaderCells;
      const colPolicies = headerCells.map(cell => {
        const cellText = sanitizeHeaderLabel(text, cell.start, cell.end, extracted, "");
        const visibility = tableColumnVisibility(cellText, definedLinkLabels);
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
    const endsParagraph = (index: number) =>
      boundaryFloors?.has(lines[index]!.start) || startsMarkdownBlock(lines[index]!.raw, lines[index + 1]?.raw);
    let inlineSpans: readonly InlineConstructSpan[] | undefined;
    let spanIndex = 0;
    let j = i + 1;
    while (j < lines.length && !endsParagraph(j)) {
      const continuation = lines[j]!;
      if (startsLatexBlock(continuation.raw, () => text.slice(continuation.start))) {
        if (!inlineSpans) {
          // A LaTeX-looking line may occur inside an inline code span, but a
          // Markdown block boundary still ends the search for a closing backtick.
          if (!text.slice(line.start, continuation.start).includes("\x60")) break;
          let limit = j + 1;
          while (limit < lines.length && !endsParagraph(limit)) limit++;
          inlineSpans = findInlineConstructSpans(
            text, line.start, lines[limit - 1]!.contentEnd, blockVisibility, sealProofs, false, true, definedLinkLabels, inheritsHtmlBlock,
          );
        }
        let span = inlineSpans[spanIndex];
        while (span && span.end <= continuation.start) span = inlineSpans[++spanIndex];
        if (span?.kind !== "code" || span.start >= continuation.start) break;
      }
      j++;
    }
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
  const cueTexts = input.cues.map(cue => cue.text);
  const definedLinkLabels = collectCueLinkReferenceLabels(cueTexts);
  const cueSeparator = createTranscriptCueSeparator(cueTexts, definedLinkLabels, (cueIndex, offset, visibility) => {
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
    text, { defaultVisibility }, false, captionRowStarts, boundaryFloorByProjectedOffset, undefined, definedLinkLabels,
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
