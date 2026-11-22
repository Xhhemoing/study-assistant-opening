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
  /(?:^|\b)(?:answer[\s_-]*key|official[\s_-]*solution|proof[\s_-]*key|hidden[\s_-]*solution|solutions?|answers?|rubric|marking[\s_-]*scheme)(?:\b|$)|(?:^|[\s\p{P}\p{S}\d]|(?:第\s*[\d一二三四五六七八九十百千万]+\s*[章节篇部分课讲单元题问步]|习题|练习题?|思考题|测试题?|自测题|例题|真题|附加题|选做题|必做题|课后|参考|标准|官方|详细|完整|附))(?:答案|解答|题解)(?:$|[\s\p{P}\p{S}\d一二三四五六七八九十甲乙丙丁]|(?:部分|汇总|一览|汇编|速查|详解|解析|精析|要点|说明|附录|(?:与|及|和)(?:解析|详解|评分|点评|提示)))|参考答案|标准答案|习题答案|课后答案|官方答案|查看答案|展开答案|显示答案|公布答案|核对答案|答案与解析|答案及解析|答案解析|习题解答|标准解答|解答与评分|评分标准|评分细则/iu;
const HINT_HEADING_RE = /(?:^|\b)(?:hints?|scaffolds?)(?:\b|$)|(?:^|[\s\p{P}\p{S}\d]|(?:第\s*[\d一二三四五六七八九十百千万]+\s*[步题问]|解题|分步|思路|点拨|附))提示(?:$|[\s\p{P}\p{S}\d一二三四五六七八九十])|分步提示|解题提示|思路提示|查看提示|展开提示|显示提示/iu;
const HTML_TAG_ATTRIBUTES = /(?:"[^"]*"|'[^']*'|[^'"<>])*/.source;
const HTML_HEADING_START_RE = /<h[1-6](?=[\t\n\f\r />])/i;
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
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);
const MARKDOWN_AUTOLINK = /(?<autolink><(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+)>)/.source;
const HTML_BLOCK_DISPLAY_RE =
  /^(?:address|article|aside|blockquote|center|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|listing|main|menu|nav|ol|p|pre|search|section|ul)$/;
const HTML_DEFAULT_DISPLAY = new Map([
  ["li", "list-item"], ["summary", "list-item"], ["table", "table"], ["caption", "table-caption"],
  ["thead", "table-header-group"], ["tbody", "table-row-group"], ["tfoot", "table-footer-group"],
  ["tr", "table-row"], ["td", "table-cell"], ["th", "table-cell"], ["colgroup", "table-column-group"],
  ["col", "table-column"], ["ruby", "ruby"], ["rt", "ruby-text"],
  ["textarea", "inline-block"], ["select", "inline-block"], ["button", "inline-block"],
]);
const HTML_COMMENT_TAIL = /(?:-?>|[\s\S]*?(?:--!?>|$))/.source;
const HTML_COMMENT_RE = new RegExp("<!--" + HTML_COMMENT_TAIL, "g");
const HTML_OTHER_LITERAL = /(?<cdata><!\[CDATA\[[\s\S]*?(?:\]\]>|(?![\s\S])))|<!(?!--)[^>]*>?|<\?[^>]*>?/.source;
const HTML_MARKUP_TOKEN = [HTML_COMMENT_RE.source, HTML_OTHER_LITERAL, HTML_TAG_TOKEN].join("|");
const INVISIBLE_LABEL_TEXT = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
// HTML's numeric reference replacements for 0x80 through 0x9F.
const HTML_WINDOWS_1252 = [
  0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
  0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
];
const ATX_HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*$/;
const ATX_HEADING_START_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

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
  if (!Object.hasOwn(PEDAGOGICAL_LABELS, normalized)) return null;
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

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, char => String.fromCharCode(char.charCodeAt(0) | 0x20));
}

function decodeMarkdownCharacterReferences(text: string): string {
  return text.replace(/&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));|&([A-Za-z][A-Za-z0-9]{1,31});/g,
    (reference, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return HTML_NAMED_REFERENCES.get(name) ?? reference;
      const codePoint = hex === undefined ? Number.parseInt(decimal!, 10) : Number.parseInt(hex, 16);
      const lowWord = codePoint & 0xFFFF;
      return codePoint < 9 || codePoint === 11 || (codePoint > 13 && codePoint < 32) ||
        (codePoint >= 0x7F && codePoint <= 0x9F) || (codePoint >= 0xD800 && codePoint <= 0xDFFF) ||
        (codePoint >= 0xFDD0 && codePoint <= 0xFDEF) || lowWord >= 0xFFFE || codePoint > 0x10FFFF
        ? "\uFFFD" : String.fromCodePoint(codePoint);
    });
}

function decodeHtmlCharacterReferences(text: string, inAttribute = false): string {
  return text.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([A-Za-z][A-Za-z0-9]*);?/g,
    (reference, hex: string | undefined, decimal: string | undefined, name: string | undefined, offset: number) => {
      if (name !== undefined) {
        const named = reference.endsWith(";") ? HTML_NAMED_REFERENCES.get(name) : undefined;
        if (named !== undefined) return named;
        const legacy = HTML_LEGACY_REFERENCE.exec(name)?.[0];
        // HTML keeps a legacy reference literal in an attribute before ASCII alphanumerics or '='.
        if (legacy && inAttribute && /[=A-Za-z0-9]/.test(text[offset + legacy.length + 1] ?? "")) return reference;
        return legacy ? HTML_NAMED_REFERENCES.get(legacy)! + reference.slice(legacy.length + 1) : reference;
      }
      const codePoint = hex === undefined ? Number.parseInt(decimal!, 10) : Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        return "\uFFFD";
      }
      return String.fromCodePoint(HTML_WINDOWS_1252[codePoint - 0x80] ?? codePoint);
    });
}

function decodeHtmlAttributeValue(value: string): string {
  return decodeHtmlCharacterReferences(value.replace(/\r\n?/g, "\n").replaceAll("\0", "\uFFFD"), true);
}

function findScriptEndTag(text: string, from: number, closer: RegExp) {
  // Script text inside an HTML comment can enter the double-escaped state.
  // The first </script> in that state returns to escaped text.
  const tokens = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  tokens.lastIndex = from;
  let state: "data" | "escaped" | "double-escaped" = "data";
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    switch (asciiLower(match[0])) {
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
  const tag = asciiLower(opener.groups?.tag ?? "");
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
type OpenHtmlTag = { tag: string; namespace?: HtmlNamespace; htmlAnnotation?: boolean };
const MATH_TEXT_INTEGRATION_POINT_RE = /^(?:mi|mo|mn|ms|mtext)$/;
const SVG_HTML_INTEGRATION_POINT_RE = /^(?:desc|foreignobject|title)$/;

function exitsHtmlForeignContent(tag: string, prefix: string | undefined, markup: string): boolean {
  if (prefix === "/") return tag === "br" || tag === "p";
  return prefix === "" && (HTML_FOREIGN_BREAKOUT_TAG_RE.test(tag) ||
    (tag === "font" && ["color", "face", "size"].some(name => htmlAttributeValue(markup, tag, name) !== undefined)));
}

function htmlEncodedAnnotation(namespace: HtmlNamespace, tag: string, markup: string): boolean {
  return namespace === "math" && tag === "annotation-xml" &&
    /^(?:text\/html|application\/xhtml\+xml)$/i.test(htmlAttributeValue(markup, tag, "encoding") ?? "");
}

function htmlChildNamespace(parent: OpenHtmlTag | undefined, startTag?: string): HtmlNamespace {
  if (!parent?.namespace) return undefined;
  if (parent.namespace === "math") {
    if (parent.tag === "annotation-xml" && (parent.htmlAnnotation || startTag === "svg")) return undefined;
    if (MATH_TEXT_INTEGRATION_POINT_RE.test(parent.tag) && startTag !== "mglyph" && startTag !== "malignmark") {
      return undefined;
    }
  }
  if (parent.namespace === "svg" && SVG_HTML_INTEGRATION_POINT_RE.test(parent.tag)) return undefined;
  return parent.namespace;
}

function htmlStartTagNamespace(parentNamespace: HtmlNamespace, tag: string): HtmlNamespace {
  return parentNamespace ?? (tag === "svg" || tag === "math" ? tag : undefined);
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
  const elements = createHtmlElementStack();
  const root = elements.insertTag({ tag, namespace, htmlAnnotation, labelStyle: DEFAULT_LABEL_STYLE }, false);
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const { namespace, ignored } = elements.readTokenContext(match);
    if (ignored) continue;
    if (match.groups?.cdata && !isForeignCdata(elements.stack.at(-1), match)) {
      tokens.lastIndex = endOfBogusHtmlComment(text, match.index + 2);
    }
    const raw = namespace ? null : htmlRawTextBounds(text, match, tokens.lastIndex);
    if (raw) {
      tokens.lastIndex = raw.closeEnd;
      continue;
    }
    elements.applyToken(match, namespace);
    if (match.groups?.prefix === "/" && asciiLower(match.groups.tag ?? "") === tag && !elements.isOnStack(root)) {
      return tokens.lastIndex;
    }
  }
  return undefined;
}

function isForeignCdata(node: OpenHtmlTag | undefined, match: RegExpExecArray): boolean {
  // The tokenizer uses the adjusted current node's own namespace at integration points.
  return Boolean(node?.namespace && match[0].startsWith("<![CDATA["));
}

function isOpenableHtmlTag(namespace: HtmlNamespace, tag: string, markup: string): boolean {
  return namespace ? !hasSelfClosingFlag(markup, tag) : !HTML_VOID_TAGS.has(tag);
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
    if (asciiLower(match[1]!) === attribute) return decodeHtmlAttributeValue(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return undefined;
}

function readDetailsOpening(markup: string) {
  const open = htmlAttributeValue(markup, "details", "open") !== undefined;
  const name = open ? htmlAttributeValue(markup, "details", "name") : undefined;
  return { open, name };
}

function htmlContainerCrossingCodeEnd(
  text: string,
  start: number,
  end: number,
  openerLimit: number,
  elements: ReturnType<typeof createHtmlElementStack>,
  details: OpenStyledTag,
): number | undefined {
  if (!text.slice(start, openerLimit).includes("<")) return undefined;
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  tokens.lastIndex = start;
  for (let match = tokens.exec(text); match && match.index < openerLimit; match = tokens.exec(text)) {
    const { namespace, ignored } = elements.readTokenContext(match);
    const raw = namespace || ignored ? null : htmlRawTextBounds(text, match, tokens.lastIndex);
    const tag = asciiLower(match.groups?.tag ?? "");
    let closeEnd: number;
    if (match[0].startsWith("<!--")) {
      closeEnd = endOfHtmlComment(text, match.index + 4);
    } else if (match.groups?.cdata && isForeignCdata(elements.stack.at(-1), match)) {
      closeEnd = tokens.lastIndex;
    } else if (/^<[!?]/.test(match[0])) {
      closeEnd = endOfBogusHtmlComment(text, match.index + 2);
    } else if (raw || (!namespace && tag === "template" && match.groups?.prefix === "")) {
      closeEnd = raw?.closeEnd ?? htmlElementEnd(text, "template", tokens.lastIndex) ?? text.length;
    } else {
      closeEnd = tokens.lastIndex;
      if (!ignored) elements.applyToken(match, namespace, details);
    }
    if (closeEnd > end) return closeEnd;
    tokens.lastIndex = closeEnd;
  }
  return undefined;
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
          return { body, containers: block.containers, continuedDepth: block.containers.length, mode: "html" as const, atBoundary: false };
        }
        htmlBlock = undefined;
      }
      if (fence) {
        const { body, depth } = continueMarkdownContainers(raw, fence.containers);
        if (depth === fence.containers.length) {
          if (closesFence(body, fence.opener)) fence = undefined;
          return { body, containers, continuedDepth: depth, mode: "code" as const, atBoundary: false };
        }
        fence = undefined;
      }
      const next = readMarkdownContainerLine(raw, containers);
      const atBoundary = afterBlockBoundary || next.containers.length > next.continuedDepth;
      containers = next.containers;
      const { body, continuedDepth } = next;
      if (continuesInlineLiteral) return { body, containers, continuedDepth, mode: "text" as const, atBoundary: false };
      const htmlKind = startsMarkdownHtmlBlock(body, atBoundary);
      if (htmlKind) {
        if (!endsMarkdownHtmlBlockLine(htmlKind, body)) htmlBlock = { kind: htmlKind, containers };
        afterBlockBoundary = true;
        indented = false;
        return { body, containers, continuedDepth, mode: "html" as const, atBoundary };
      }
      const opener = matchFenceOpening(body)?.[1];
      if (opener) fence = { opener, containers };
      indented = INDENTED_CODE_RE.test(body) && (atBoundary || indented);
      afterBlockBoundary = Boolean(opener) || indented || isMarkdownBlankLine(body) || THEMATIC_BREAK_RE.test(body) ||
        ATX_HEADING_START_RE.test(body) || (!atBoundary && SETEXT_UNDERLINE_RE.test(body)) ||
        /^ {0,3}:{3,}[ \t]*[a-zA-Z]/.test(body) ||
        (containers.includes("quote") && CALLOUT_HEADER_RE.test(body));
      return { body, containers, continuedDepth, mode: opener || indented ? "code" as const : "text" as const, atBoundary };
    },
  };
}

function createMarkdownHtmlBlockLookup(text: string, inheritedContext = DEFAULT_LABEL_CONTEXT) {
  const scanner = createMarkdownBlockScanner();
  const activeAtLine = new Map<number, MarkdownHtmlBlock>();
  const htmlLines = new Map<number, number>();
  let cursor = 0;
  let projected: string | undefined;
  let scopeLookup: ReturnType<typeof createHtmlScopeLookup> | undefined;
  let hasForeignMarkup: boolean | undefined;
  let hasSelect: boolean | undefined;
  let hasStyles: boolean | undefined;
  let hasNamedDetails: boolean | undefined;
  const getScopeLookup = (definedLinkLabels: ReadonlySet<string>) => {
    if (!scopeLookup) {
      const blockLines: HtmlScopeLine[] = [];
      const html = projectDisclosureCommentMarkdown(text, [], definedLinkLabels, true, line => blockLines.push(line));
      scopeLookup = createHtmlScopeLookup(html, inheritedContext, blockLines);
    }
    return scopeLookup;
  };
  const scanThrough = (lineStart: number) => {
    while (cursor <= lineStart && cursor < text.length) {
      const newline = nextLineBreak(text, cursor);
      const state = scanner.scan(text.slice(cursor, newline?.index ?? text.length));
      if (state.mode === "html") htmlLines.set(cursor, state.containers.length);
      cursor = newline ? newline.index + newline[0].length : text.length;
      if (scanner.htmlBlock) activeAtLine.set(cursor, scanner.htmlBlock);
    }
  };
  const rawHtmlDepthAt = (offset: number) => {
    const lineStart = containingLineStart(text, offset);
    scanThrough(lineStart);
    return htmlLines.get(lineStart);
  };
  return {
    htmlHeadings(definedLinkLabels: ReadonlySet<string>) {
      return HTML_HEADING_START_RE.test(text) ? getScopeLookup(definedLinkLabels).htmlHeadings : [];
    },
    htmlBlockAt(lineStart: number) {
      scanThrough(lineStart - 1);
      return activeAtLine.get(lineStart);
    },
    rawHtmlDepthAt,
    isRawHtmlAt: (offset: number) => rawHtmlDepthAt(offset) !== undefined,
    maskedLiterals(definedLinkLabels: ReadonlySet<string>) {
      return projected ??= projectDisclosureCommentMarkdown(text, [], definedLinkLabels, false);
    },
    labelContextAt(offset: number, definedLinkLabels: ReadonlySet<string>) {
      hasStyles ??= /(?:\bstyle[ \t\r\n\f]*=|\bhidden(?=[ \t\r\n\f=/>])|<(?:datalist|dialog|svg|math)\b)/i.test(text);
      hasNamedDetails ??= /<details(?=[\t\n\f\r />])/i.test(text) && /\bname[\t\n\f\r ]*=/i.test(text);
      return hasStyles || hasNamedDetails ? getScopeLookup(definedLinkLabels).scopeAt(offset).context : inheritedContext;
    },
    pipeCellAt(offset: number, definedLinkLabels: ReadonlySet<string>) {
      return text.includes("|") ? getScopeLookup(definedLinkLabels).scopeAt(offset).pipeCell : undefined;
    },
    opensHtmlDetailsAt(offset: number, definedLinkLabels: ReadonlySet<string>) {
      hasForeignMarkup ??= /<(?:svg|math)(?=[\t\n\f\r />])/i.test(text);
      hasSelect ??= /<select(?=[\t\n\f\r />])/i.test(text);
      if (!hasForeignMarkup && !hasSelect) return true;
      const scope = getScopeLookup(definedLinkLabels);
      return scope.scopeAt(offset).namespace === undefined && !scope.ignoredDetailsStarts.has(offset);
    },
  };
}

type HtmlHeading = {
  start: number;
  end: number;
  level: number;
  depth: number;
  context: LabelContext;
  visibilityHidden: boolean;
  rawHtml: boolean;
};

function splitLinesAtHtmlHeadings(text: string, lines: readonly SourceLine[], headings: readonly HtmlHeading[]) {
  const offsets = headings.flatMap(({ start, end }) => [start, end]).sort((a, b) => a - b);
  const result: SourceLine[] = [];
  let index = 0;
  for (const line of lines) {
    let { start } = line;
    for (let cut = offsets[index]; cut !== undefined && cut < line.contentEnd; cut = offsets[++index]) {
      if (cut <= start) continue;
      result.push({ start, contentEnd: cut, end: cut, raw: text.slice(start, cut) });
      start = cut;
    }
    result.push(start === line.start ? line : { ...line, start, raw: text.slice(start, line.contentEnd) });
  }
  return result;
}

type MarkdownInlineScope = "#markdown-p" | "#markdown-heading";

type HtmlScopeLine = {
  offset: number;
  containerDepth: number;
  continuedDepth: number;
  endsInline: boolean;
  inlineScope?: MarkdownInlineScope;
  closesRawParagraph?: boolean;
  table?: "header" | "body" | "row" | "end";
  cell?: "th" | "td";
  rawHtml?: boolean;
};

function createHtmlScopeLineProjector(lines: readonly SourceLine[], emit: (line: HtmlScopeLine) => void) {
  let paragraphStart: HtmlScopeLine | undefined;
  let table: { depth: number; delimiterIndex: number } | undefined;
  return (index: number, state: ReturnType<ReturnType<typeof createMarkdownBlockScanner>["scan"]>, continuedLiteral: boolean) => {
    const line = lines[index]!;
    const { body, containers, continuedDepth, mode, atBoundary } = state;
    const depth = containers.length;
    const base = { offset: line.start, containerDepth: depth, continuedDepth };
    const text = mode === "text" && !continuedLiteral;
    const inTable = text && table?.depth === depth && continuedDepth === depth;
    if (inTable && index === table?.delimiterIndex) {
      emit({ ...base, endsInline: true, table: "body" });
      return;
    }
    const tableBody = inTable && isPipeTableBodyRow(body);
    const nextLine = lines[index + 1];
    const next = nextLine && continueMarkdownContainers(nextLine.raw, containers);
    const nextBody = next?.depth === depth ? next.body : undefined;
    const row = { raw: body, start: line.contentEnd - body.length };
    const header = text && !tableBody ? pipeTableHeaderCells(row, nextBody) : null;
    if (header || tableBody) {
      if (header) table = { depth, delimiterIndex: index + 1 };
      paragraphStart = undefined;
      emit({ ...base, endsInline: true, table: header ? "header" : "row" });
      for (const cell of header ?? parseTableRowCells(row).cells) {
        emit({
          offset: Math.max(line.start, cell.start), containerDepth: depth, continuedDepth: depth,
          endsInline: true, cell: header ? "th" : "td",
        });
      }
      return;
    }
    const afterTable = table !== undefined;
    table = undefined;

    const blank = isMarkdownBlankLine(body);
    const underline = text && !atBoundary && paragraphStart?.containerDepth === continuedDepth &&
      continuedDepth === depth && SETEXT_UNDERLINE_RE.test(body);
    if (underline && paragraphStart) paragraphStart.inlineScope = "#markdown-heading";
    const atx = text && ATX_HEADING_START_RE.test(body);
    const thematic = text && !underline && THEMATIC_BREAK_RE.test(body);
    const endsInline = !continuedLiteral && (mode !== "text" || blank || underline || atBoundary || afterTable ||
      startsMarkdownBlock(body, nextBody, true));
    const event: HtmlScopeLine = {
      ...base,
      endsInline,
      table: afterTable ? "end" : undefined,
      inlineScope: text && !blank && !underline && !thematic
        ? (atx ? "#markdown-heading" : "#markdown-p") : undefined,
      closesRawParagraph: !continuedLiteral && (mode === "code" || thematic || depth > continuedDepth),
      rawHtml: mode === "html",
    };
    if (endsInline) paragraphStart = undefined;
    if (event.inlineScope === "#markdown-p") paragraphStart ??= event;
    emit(event);
  };
}

function projectDisclosureCommentMarkdown(
  markdown: string,
  containers: readonly MarkdownContainer[],
  definedLinkLabels: ReadonlySet<string>,
  maskCode = true,
  onScopeLine?: (line: HtmlScopeLine) => void,
): string {
  const lines = splitLinesWithOffsets(markdown);
  const rawLines = lines.map(line => line.raw);
  const scanner = createMarkdownBlockScanner(containers);
  const projectScopeLine = onScopeLine && createHtmlScopeLineProjector(lines, onScopeLine);
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

  for (let index = 0; index < lines.length && (match || onScopeLine); index++) {
    const line = lines[index]!;
    const continuedLiteral = line.start < literalEnd;
    const state = scanner.scan(line.raw, continuedLiteral);
    projectScopeLine?.(index, state, continuedLiteral);
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
            maskedEnd = renderedMarkdownLinkEnd(markdown, match.index, opener.contentStart, definedLinkLabels, state.containers);
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
  const elements = createHtmlElementStack();
  const details = elements.insertTag({ tag: "details", labelStyle: DEFAULT_LABEL_STYLE }, false);
  let independent = false;
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    if (!independent && match.index >= firstClose.index) break;
    if (match[0] === "<!--") {
      tokens.lastIndex = endOfHtmlComment(html, tokens.lastIndex);
      independent ||= tokens.lastIndex === closeEnd;
      continue;
    }
    if (match[0].startsWith("--")) return markdownStart + closeEnd;
    const { namespace, ignored } = elements.readTokenContext(match);
    if (ignored) continue;
    const tag = asciiLower(match.groups?.tag ?? "");
    const prefix = match.groups?.prefix;
    if (match.groups?.cdata && !isForeignCdata(elements.stack.at(-1), match)) {
      tokens.lastIndex = endOfBogusHtmlComment(html, match.index + 2);
    }
    const raw = namespace ? null : htmlRawTextBounds(html, match, tokens.lastIndex);
    if (raw || (!namespace && tag === "template" && prefix === "")) {
      tokens.lastIndex = raw?.closeEnd ?? htmlElementEnd(html, "template", tokens.lastIndex) ?? html.length;
    } else if (elements.applyToken(match, namespace, independent ? undefined : details) === details && prefix === "/") {
      return markdownStart + closeEnd;
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
  const { style: inheritedStyle } = inheritsHtmlBlock.labelContextAt(openStart, definedLinkLabels);
  const elements = createHtmlElementStack(inheritedStyle);
  const cell = inheritsHtmlBlock.pipeCellAt(openStart, definedLinkLabels);
  if (cell) seedPipeTableCell(elements, cell);
  const details = elements.insertTag({ tag: "details", labelStyle: inheritedStyle }, false);
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
  const skipCodeBlock = (start: number, end: number) => {
    const openerLimit = htmlBlock ? htmlBlockEnd(end) : start;
    const htmlEnd = htmlContainerCrossingCodeEnd(text, start, end, openerLimit, elements, details);
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

  let summaryOpening: { openStart: number; openEnd: number; element: OpenStyledTag } | undefined;
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
    const { namespace, ignored } = elements.readTokenContext(match);
    if (ignored) {
      skipLiteralLines(tokenRe.lastIndex);
      continue;
    }
    if (match.groups?.cdata && !isForeignCdata(elements.stack.at(-1), match)) {
      tokenRe.lastIndex = endOfBogusHtmlComment(text, match.index + 2);
    }
    const rawText = namespace ? null : htmlRawTextBounds(text, match, tokenRe.lastIndex);
    if (rawText) {
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
      const insideSummary = summaryOpening !== undefined && elements.isOnStack(summaryOpening.element);
      const allowsCodeSpan = insideSummary ? !inheritsHtmlBlock.isRawHtmlAt(match.index) : allowsMarkdown;
      if (allowsCodeSpan && !isEscaped(text, match.index)) {
        const end = endOfBacktickSpan(text, match.index);
        if (end !== -1 && !crossesDetailsHtmlBoundary(text, match.index, end, containers)) {
          // Keep the legacy inline example consisting solely of an unmatched comment opener.
          let htmlEnd: number | undefined;
          if (htmlBlock) {
            if (/^\x60+[ \t]*<!--[ \t]*\x60+$/.test(text.slice(match.index, end))) {
              htmlEnd = findDisclosureCommentEnd(text, end, htmlBlockEnd(text.length), containers, definedLinkLabels);
            } else {
              htmlEnd = htmlContainerCrossingCodeEnd(text, match.index, end, htmlBlockEnd(end), elements, details);
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
    const tag = asciiLower(match.groups?.tag ?? "");
    const prefix = match.groups?.prefix;
    if (!namespace && tag === "template" && prefix === "") {
      tokenRe.lastIndex = htmlElementEnd(text, tag, tokenRe.lastIndex) ?? text.length;
      skipLiteralLines(tokenRe.lastIndex);
      continue;
    }
    const parent = elements.stack.at(-1);
    const element = elements.applyToken(match, namespace);
    if (tag === "summary" && element && !element.namespace) {
      if (prefix === "/" && element === summaryOpening?.element) {
        const end = nextLineBreak(text, tokenRe.lastIndex)?.index ?? text.length;
        if (isMarkdownBlankLine(text.slice(tokenRe.lastIndex, end))) afterBlockBoundary = true;
        summary = {
          openStart: summaryOpening.openStart, openEnd: summaryOpening.openEnd,
          closeStart: match.index, closeEnd: tokenRe.lastIndex, codeSpans: summaryCodeSpans,
        };
        const newline = nextLineBreak(text, summary.closeEnd);
        if (newline) markdownBodyStart = newline.index + newline[0].length;
      } else if (prefix === "" && parent === details && !summaryOpening) {
        summaryOpening = { openStart: match.index, openEnd: tokenRe.lastIndex, element };
      }
    }
    if (prefix === "/" && element === details) {
      return { closeStart: match.index, closeEnd: tokenRe.lastIndex, summary };
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

function readSummaryMarkup(
  text: string, summary: NonNullable<DetailsBounds["summary"]>,
  htmlContext: ReturnType<typeof createMarkdownHtmlBlockLookup>,
  definedLinkLabels: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  let markdown: string[] = [];
  const flushMarkdown = () => {
    if (!markdown.length) return;
    parts.push(renderMarkdownLabelMarkup(markdown.join(""), false, definedLinkLabels));
    markdown = [];
  };
  const appendMarkdown = (start: number, end: number) => {
    const markup = text.slice(start, end);
    if (!markup.includes("&")) {
      markdown.push(markup);
      return;
    }
    // Project Markdown text references into HTML without rewriting attributes.
    const tokens = new RegExp(HTML_MARKUP_TOKEN + /|(?<reference>&(?:(?:#[xX][0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?)?)/.source, "gi");
    let after = 0;
    for (const match of markup.matchAll(tokens)) {
      const reference = match.groups?.reference;
      if (!reference || isEscaped(text, start + match.index)) continue;
      const decoded = decodeMarkdownCharacterReferences(reference);
      const escaped = decoded === reference ? `&#38;${reference.slice(1)}` :
        Array.from(decoded, character => `&#${character.codePointAt(0)};`).join("");
      markdown.push(markup.slice(after, match.index), escaped);
      after = match.index + reference.length;
    }
    markdown.push(markup.slice(after));
  };
  const appendMarkup = (start: number, end: number) => {
    // A summary can cross a CommonMark HTML block boundary.
    for (let cursor = start; cursor < end;) {
      const raw = htmlContext.isRawHtmlAt(cursor);
      let limit = cursor;
      do {
        const newline = nextLineBreak(text, limit);
        limit = newline ? Math.min(end, newline.index + newline[0].length) : end;
      } while (limit < end && htmlContext.isRawHtmlAt(limit) === raw);
      if (raw) {
        flushMarkdown();
        parts.push(text.slice(cursor, limit));
      } else {
        appendMarkdown(cursor, limit);
      }
      cursor = limit;
    }
  };
  let cursor = summary.openEnd;
  // Only shield spans the disclosure scanner actually treated as Markdown.
  for (const { start, end } of summary.codeSpans) {
    appendMarkup(cursor, start);
    markdown.push(codeSpanLabelText(text.slice(start, end)));
    cursor = end;
  }
  appendMarkup(cursor, summary.closeStart);
  flushMarkdown();
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
  const title = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))[ \t\r\n]*\)/y;
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
  containers: readonly MarkdownContainer[] = [],
): number {
  const suffixStart = closeIndex + 1;
  const inlineEnd = markdownLabelLinkEnd(label, suffixStart);
  const respectsParagraph = (end: number) => {
    if (!/[\r\n]/.test(label.slice(contentStart, end))) return true;
    const lineEnd = nextLineBreak(label, end);
    const followingEnd = lineEnd && nextLineBreak(label, lineEnd.index + lineEnd[0].length);
    const start = containingLineStart(label, contentStart);
    const lines = splitLinesWithOffsets(label.slice(start, followingEnd?.index ?? label.length));
    const first = readMarkdownContainerLine(lines[0]!.raw, containers);
    const second = lines[1] && continueMarkdownContainers(lines[1]!.raw, first.containers);
    if (ATX_HEADING_START_RE.test(first.body) ||
      (second?.depth === first.containers.length && isPipeTableStart(first.body, second.body))) return false;
    for (let line = 1; line < lines.length && lines[line]!.start < end - start; line++) {
      const { body } = continueMarkdownContainers(lines[line]!.raw, containers);
      const next = lines[line + 1] && continueMarkdownContainers(lines[line + 1]!.raw, containers);
      const nextBody = next?.depth === containers.length ? next.body : undefined;
      if (startsMarkdownHtmlBlock(body, false) || startsMarkdownBlock(body, nextBody, true) ||
        SETEXT_UNDERLINE_RE.test(body)) return false;
    }
    return true;
  };
  if (inlineEnd !== -1) return respectsParagraph(inlineEnd) ? inlineEnd : -1;
  if (!definedLinkLabels.size) return -1;
  const suffix = readLinkReferenceLabel(label, suffixStart);
  const raw = suffix?.raw || label.slice(contentStart, closeIndex);
  const candidate = readLinkReferenceLabel("[" + raw + "]", 0);
  const end = suffix?.end ?? suffixStart;
  return candidate?.raw === raw && definedLinkLabels.has(normalizeLinkReferenceLabel(raw)) && respectsParagraph(end) ? end : -1;
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
    } else if (asciiLower(groups.tag ?? "") === "template" && groups.prefix === "") {
      tokens.lastIndex = htmlElementEnd(label, "template", tokens.lastIndex) ?? label.length;
    } else {
      const raw = htmlRawTextBounds(label, match, tokens.lastIndex);
      if (raw) tokens.lastIndex = raw.closeEnd;
    }
  }
  return parts.length ? parts.join("") + label.slice(cursor) : label;
}


const CSS_DISPLAY_OUTSIDE = new Set(["block", "inline"]);
const CSS_DISPLAY_INSIDE = new Set(["flow", "flow-root", "table", "flex", "grid", "ruby", "math"]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const CSS_DISPLAY_SINGLE = new Set([
  "none", "contents", "inline-block", "inline-table", "inline-flex", "inline-grid",
  "table-row-group", "table-header-group", "table-footer-group", "table-row", "table-cell", "table-column-group",
  "table-column", "table-caption", "ruby-base", "ruby-text", "ruby-base-container", "ruby-text-container",
  ...CSS_WIDE_KEYWORDS,
]);
const CSS_DISPLAY_ALIASES = new Map([
  ["-webkit-flex", "flex"], ["-webkit-inline-flex", "inline-flex"],
  ["-webkit-box", "flex"], ["-webkit-inline-box", "inline-flex"],
]);

type CssToken =
  | { kind: "ident" | "integer" | "punct" | "literal"; value: string }
  | { kind: "group"; name: string; tokens: CssToken[] };
type CssDeclaration = { name: string; value: readonly CssToken[]; important: boolean };
type CssCustomProperties = ReadonlyMap<string, readonly CssToken[]>;
const EMPTY_CUSTOM_PROPS: CssCustomProperties = new Map();
type LabelStyle = {
  customProps: CssCustomProperties;
  display: string;
  position: string;
  float: string;
  outOfFlow: boolean;
  flexOrGridItems: boolean;
  suppressedSubtree: boolean;
  visibilityHidden: boolean;
  contentVisibility: string;
  ownContentHidden: boolean;
  contentVisibilityHidden: boolean;
};
const DEFAULT_LABEL_STYLE: LabelStyle = {
  customProps: EMPTY_CUSTOM_PROPS, display: "inline", suppressedSubtree: false,
  position: "static", float: "none", outOfFlow: false, flexOrGridItems: false,
  visibilityHidden: false, contentVisibility: "visible", ownContentHidden: false, contentVisibilityHidden: false,
};
type LabelContext = {
  style: LabelStyle;
  hasOpenDetails?: (name: string) => boolean;
};
const DEFAULT_LABEL_CONTEXT: LabelContext = { style: DEFAULT_LABEL_STYLE };

function skipsLabelContents(style: LabelStyle) {
  return style.contentVisibilityHidden || style.ownContentHidden;
}

function supportsContentVisibility(display: string, namespace: HtmlNamespace, outerSvg: boolean) {
  // Size containment excludes non-atomic inline boxes, internal ruby/table boxes,
  // and boxes with table layout. Table captions are block containers.
  if (namespace === "svg" && !outerSvg) return false;
  if (/^(?:none|contents|inline-table|table-(?!caption$)\S+|ruby-\S+)$/.test(display)) return false;
  const types = display.split(" ");
  if (types.includes("table")) return false;
  if (types.includes("block") || outerSvg) return true;
  if (types.includes("ruby")) return false;
  return !types.includes("inline") || types.some(type => /^(?:flow-root|flex|grid)$/.test(type));
}

const CSS_ESCAPE = /\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\r\n\f])?|[^\r\n\f]|(?![\s\S]))/.source;
const CSS_NAME_START = "(?:[_a-zA-Z\\u0080-\\uFFFF]|" + CSS_ESCAPE + ")";
const CSS_IDENT = "(?:--|-?" + CSS_NAME_START + ")(?:[-_a-zA-Z0-9\\u0080-\\uFFFF]|" + CSS_ESCAPE + ")*";
const CSS_NUMBER = /[+-]?(?:[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?/.source;
const CSS_COMPONENT = [
  /(?<trivia>[ \t\r\n\f]+|\/\*[\s\S]*?(?:\*\/|$))/.source,
  /(?<string>"(?:\\[\s\S]|[^"\\\r\n\f])*(?:"|(?=[\r\n\f])|\\?(?![\s\S]))|'(?:\\[\s\S]|[^'\\\r\n\f])*(?:'|(?=[\r\n\f])|\\?(?![\s\S])))/.source,
  "(?<number>" + CSS_NUMBER + ")(?:" + CSS_IDENT + "|%)?",
  "(?<ident>" + CSS_IDENT + ")(?<call>\\()?",
  /(?<punct>[()[\]{},;:!])|[\s\S]/.source,
].join("|");

function cssValueTokens(text: string): CssToken[] {
  const root: CssToken[] = [];
  const stack: { group: Extract<CssToken, { kind: "group" }>; closer: string }[] = [];
  let separated = false;
  for (const match of text.matchAll(new RegExp(CSS_COMPONENT, "g"))) {
    const { trivia, number, ident, call, punct } = match.groups!;
    // Comments separate adjacent tokens, including identifiers such as no/**/ne.
    if (trivia) {
      separated = true;
      continue;
    }
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
      const integer = separated && number === value && /^(?:\+?\d+|-0+)$/.test(value);
      tokens.push({ kind: ident !== undefined ? "ident" : integer ? "integer" : punct ? "punct" : "literal", value });
    }
    separated = false;
  }
  // CSS closes open component values at EOF. Their contents are already in the group.
  return root;
}

function unescapeCssDisplay(text: string): string {
  return text.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f])|(?![\s\S]))/gi, (_, hex?: string, literal?: string) => {
    if (!hex) return literal ?? "\ufffd";
    const code = Number.parseInt(hex, 16);
    return code && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

function cssDisplayKeyword(tokens: readonly CssToken[], all: boolean): string | undefined {
  if (!tokens.length || tokens.length > 3) return undefined;
  const words: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "ident") return undefined;
    words.push(asciiLower(token.value));
  }
  const first = words[0]!;
  if (all) return words.length === 1 && CSS_WIDE_KEYWORDS.has(first) ? first : undefined;
  if (words.length === 1) {
    if (CSS_DISPLAY_SINGLE.has(first)) return first;
    const alias = CSS_DISPLAY_ALIASES.get(first);
    if (alias) return alias;
  }
  if (new Set(words).size !== words.length) return undefined;
  const outside = words.filter(word => CSS_DISPLAY_OUTSIDE.has(word));
  const inside = words.filter(word => CSS_DISPLAY_INSIDE.has(word));
  const listItem = words.includes("list-item");
  if (outside.length > 1 || inside.length > 1 || outside.length + inside.length + Number(listItem) !== words.length) return;
  const inner = inside[0] ?? "flow";
  const outer = outside[0] ?? (inner === "ruby" ? "inline" : "block");
  if (listItem) {
    if (inner !== "flow" && inner !== "flow-root") return;
    if (outer === "block") return "list-item";
    return inner === "flow" ? `${outer} list-item` : `${outer} flow-root list-item`;
  }
  if (inner === "flow") return outer;
  if (outer === "block") return inner === "ruby" ? "block ruby" : inner;
  if (outer === "inline") {
    if (inner === "flow-root") return "inline-block";
    if (inner === "table" || inner === "flex" || inner === "grid") return `inline-${inner}`;
    if (inner === "ruby") return inner;
  }
  return `${outer} ${inner}`;
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
      const important = end >= start + 4 && last?.kind === "ident" && asciiLower(last.value) === "important" &&
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

const CSS_ZERO_LENGTH_ENVIRONMENT = new Set([
  "safe-area-inset-top", "safe-area-inset-right", "safe-area-inset-bottom", "safe-area-inset-left",
  "safe-area-max-inset-top", "safe-area-max-inset-right", "safe-area-max-inset-bottom", "safe-area-max-inset-left",
  "titlebar-area-x", "titlebar-area-y", "titlebar-area-width", "titlebar-area-height",
  "keyboard-inset-top", "keyboard-inset-right", "keyboard-inset-bottom", "keyboard-inset-left",
  "keyboard-inset-width", "keyboard-inset-height",
]);
// The document-only model uses neutral scalar values and an unsegmented viewport.
const CSS_ZERO_LENGTH: readonly CssToken[] = [{ kind: "literal", value: "0px" }];
const CSS_DEFAULT_TEXT_SCALE: readonly CssToken[] = [{ kind: "integer", value: "1" }];

function cssEnvironmentCall(group: Extract<CssToken, { kind: "group" }>) {
  const [name] = group.tokens;
  if (name?.kind !== "ident" || CSS_WIDE_KEYWORDS.has(asciiLower(name.value)) || asciiLower(name.value) === "default") {
    return undefined;
  }
  let end = 1;
  while (group.tokens[end]?.kind === "integer") end++;
  if (end < group.tokens.length && !isCssPunct(group.tokens[end], ",")) return undefined;
  const fallback = end < group.tokens.length ? group.tokens.slice(end + 1) : undefined;
  if (fallback?.some(token => token.kind === "punct" && /[!;\])}]/.test(token.value))) return undefined;
  let value: readonly CssToken[] | undefined;
  if (end === 1) {
    if (name.value === "preferred-text-scale") value = CSS_DEFAULT_TEXT_SCALE;
    if (CSS_ZERO_LENGTH_ENVIRONMENT.has(name.value)) value = CSS_ZERO_LENGTH;
  }
  return { value, fallback };
}

function cssSubstitutions(tokens: readonly CssToken[]) {
  const dependencies = new Set<string>();
  let required = false;
  const groups = tokens.filter(token => token.kind === "group");
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    const name = asciiLower(group.name);
    if (name === "var") {
      const call = cssVariableCall(group);
      if (!call) return undefined;
      dependencies.add(call.name);
      required = true;
    } else if (name === "env") {
      if (!cssEnvironmentCall(group)) return undefined;
      required = true;
    }
    for (const token of group.tokens) if (token.kind === "group") groups.push(token);
  }
  return { dependencies, required };
}

function createCssVariableResolver(custom: ReadonlyMap<string, CssDeclaration>, inherited: CssCustomProperties) {
  const dependencies = new Map(
    Array.from(custom, ([name, declaration]) => [name, cssSubstitutions(declaration.value)]),
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
    const edges = dependencies.get(name)?.dependencies;
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
      const functionName = asciiLower(token.name);
      let replacement: readonly CssToken[] | undefined;
      if (functionName === "var") {
        const call = cssVariableCall(token);
        if (!call) return undefined;
        replacement = resolve(call.name) ?? (call.fallback && substitute(call.fallback));
      } else if (functionName === "env") {
        const call = cssEnvironmentCall(token);
        if (!call) return undefined;
        replacement = call.value ?? (call.fallback && substitute(call.fallback));
      } else {
        const children = substitute(token.tokens);
        if (children === undefined) return undefined;
        if (result.length < 4) result.push({ ...token, tokens: [...children] });
        continue;
      }
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
    const keyword = value.length === 1 && first?.kind === "ident" ? asciiLower(first.value) : "";
    const resolved = CSS_WIDE_KEYWORDS.has(keyword)
      ? keyword === "initial" ? undefined : inherited.get(name)
      : !cyclic.has(name) && dependencies.get(name) ? substitute(value) : undefined;
    computed.set(name, resolved);
    return resolved;
  };
  return { substitute, resolve };
}

function cssVisibilityKeyword(tokens: readonly CssToken[]): string | undefined {
  const [token] = tokens;
  if (tokens.length !== 1 || token?.kind !== "ident") return undefined;
  const word = asciiLower(token.value);
  return word === "visible" || word === "hidden" || word === "collapse" || CSS_WIDE_KEYWORDS.has(word)
    ? word : undefined;
}

function cssContentVisibilityKeyword(tokens: readonly CssToken[]): string | undefined {
  const visibility = cssVisibilityKeyword(tokens);
  if (visibility !== "collapse" && visibility !== undefined) return visibility;
  if (tokens.length === 1 && tokens[0]?.kind === "ident" && asciiLower(tokens[0].value) === "auto") return "auto";
}

function cssLayoutKeyword(tokens: readonly CssToken[], allowed: RegExp): string | undefined {
  const [token] = tokens;
  if (tokens.length !== 1 || token?.kind !== "ident") return undefined;
  const word = asciiLower(token.value);
  return allowed.test(word) || CSS_WIDE_KEYWORDS.has(word) ? word : undefined;
}

const LABEL_STYLE_PROPERTIES = {
  display: (tokens: readonly CssToken[]) => cssDisplayKeyword(tokens, false),
  position: (tokens: readonly CssToken[]) => cssLayoutKeyword(tokens, /^(?:static|relative|absolute|fixed|sticky)$/),
  float: (tokens: readonly CssToken[]) => cssLayoutKeyword(tokens, /^(?:none|left|right|inline-start|inline-end)$/),
  visibility: cssVisibilityKeyword,
  "content-visibility": cssContentVisibilityKeyword,
};
type LabelStyleProperty = keyof typeof LABEL_STYLE_PROPERTIES;
const LABEL_STYLE_PROPERTY_NAMES = Object.keys(LABEL_STYLE_PROPERTIES) as LabelStyleProperty[];

const FLEX_OR_GRID_DISPLAY_RE = /(?:^| )(?:inline-)?(?:flex|grid)(?: |$)/;

function blockifyLabelDisplay(display: string): string {
  if (display === "none" || display === "contents") return display;
  if (/^inline-(?:flex|grid|table)$/.test(display)) return display.slice("inline-".length);
  if (/^(?:table-|ruby(?:-|$))/.test(display)) return "block";
  const types = display.split(" ");
  if (types.includes("inline")) {
    const inner = types.find(type => type === "flex" || type === "grid" || type === "table");
    return inner ?? (types.includes("list-item") ? "list-item" : "block");
  }
  return display === "inline-block" ? "block" : display;
}

function resolveElementStyle(
  tag: string,
  parent: LabelStyle,
  markup?: string,
  namespace?: HtmlNamespace,
  outerSvg = false,
): LabelStyle {
  const attribute = (name: string) => markup === undefined ? undefined : htmlAttributeValue(markup, tag, name);
  const styleAttr = attribute("style");
  const hidden = namespace ? undefined : attribute("hidden");
  const untilFound = asciiLower(hidden ?? "") === "until-found";
  const hiddenByDefault = (hidden !== undefined && !untilFound) || HTML_NON_RENDERED_LABEL_TAGS.has(tag) ||
    tag === "head" || (tag === "dialog" && attribute("open") === undefined);
  const displayDefault = namespace ? "inline" : hiddenByDefault ? "none" :
    HTML_DEFAULT_DISPLAY.get(tag) ?? (HTML_BLOCK_DISPLAY_RE.test(tag) ? "block" : "inline");
  const ancestorContentHidden = skipsLabelContents(parent);
  if (!styleAttr && namespace !== "svg") {
    const display = parent.flexOrGridItems ? blockifyLabelDisplay(displayDefault) : displayDefault;
    const flexOrGridItems = display === "contents" ? parent.flexOrGridItems : FLEX_OR_GRID_DISPLAY_RE.test(display);
    const contentVisibility = untilFound ? "hidden" : "visible";
    const ownContentHidden = untilFound && supportsContentVisibility(display, namespace, outerSvg);
    const suppressedSubtree = parent.suppressedSubtree || display === "none";
    if (display === parent.display && contentVisibility === parent.contentVisibility &&
      parent.position === "static" && parent.float === "none" && flexOrGridItems === parent.flexOrGridItems &&
      ownContentHidden === parent.ownContentHidden &&
      suppressedSubtree === parent.suppressedSubtree && ancestorContentHidden === parent.contentVisibilityHidden) return parent;
    return {
      customProps: parent.customProps, display, position: "static", float: "none", outOfFlow: false, flexOrGridItems,
      contentVisibility, ownContentHidden, suppressedSubtree,
      visibilityHidden: parent.visibilityHidden, contentVisibilityHidden: ancestorContentHidden,
    };
  }
  const custom = new Map<string, CssDeclaration>();
  const declarations = new Map<LabelStyleProperty, CssDeclaration>();
  for (const declaration of styleAttr ? cssStyleDeclarations(styleAttr) : []) {
    const { name, value, important } = declaration;
    if (name.startsWith("--")) {
      if ((!custom.get(name)?.important || important) && cssSubstitutions(value)) custom.set(name, declaration);
      continue;
    }
    const property = asciiLower(name);
    const all = property === "all";
    if (!all && !Object.hasOwn(LABEL_STYLE_PROPERTIES, property)) continue;
    const variables = cssSubstitutions(value);
    if (!variables) continue;
    for (const target of all ? LABEL_STYLE_PROPERTY_NAMES : [property as LabelStyleProperty]) {
      if ((!declarations.get(target)?.important || important) &&
        (variables.required || (all ? cssDisplayKeyword(value, true) : LABEL_STYLE_PROPERTIES[target](value)))) {
        declarations.set(target, declaration);
      }
    }
  }
  let resolver: ReturnType<typeof createCssVariableResolver> | undefined;
  const variables = () => resolver ??= createCssVariableResolver(custom, parent.customProps);
  let customProps = parent.customProps;
  if (custom.size) {
    const computed = new Map(customProps);
    for (const name of custom.keys()) {
      const tokens = variables().resolve(name);
      if (tokens === undefined) computed.delete(name);
      else computed.set(name, tokens);
    }
    customProps = computed;
  }
  const keyword = (property: LabelStyleProperty) => {
    const declaration = declarations.get(property);
    const presentation = namespace === "svg" && (property === "display" || property === "visibility")
      ? attribute(property) : undefined;
    const parse = LABEL_STYLE_PROPERTIES[property];
    if (declaration) {
      const value = cssSubstitutions(declaration.value)?.required
        ? variables().substitute(declaration.value) : declaration.value;
      // Invalid at computed-value time resets the property without consulting lower declarations.
      return (value && (asciiLower(declaration.name) === "all" ? cssDisplayKeyword(value, true) : parse(value))) ?? "unset";
    }
    if (presentation !== undefined) {
      const tokens = cssValueTokens(presentation);
      if (cssSubstitutions(tokens)?.required) {
        const value = variables().substitute(tokens);
        return (value && parse(value)) ?? "unset";
      }
      return parse(tokens);
    }
  };
  const compute = (property: LabelStyleProperty, initial: string, inherited: string, fallback: string) => {
    const value = keyword(property);
    if (value === "inherit") return inherited;
    if (value === "initial") return initial;
    if (value === "unset") return property === "visibility" ? inherited : initial;
    return value === undefined || value === "revert" || value === "revert-layer" ? fallback : value;
  };
  const inheritedVisibility = parent.visibilityHidden ? "hidden" : "visible";
  const position = compute("position", "static", parent.position, "static");
  const positioned = position === "absolute" || position === "fixed";
  const float = positioned ? "none" : compute("float", "none", parent.float, "none");
  const specifiedDisplay = compute("display", "inline", parent.display, displayDefault);
  const blockifies = positioned || float !== "none" || parent.flexOrGridItems;
  const display = blockifies ? blockifyLabelDisplay(specifiedDisplay) : specifiedDisplay;
  const outOfFlow = display !== "none" && display !== "contents" &&
    (positioned || (float !== "none" && !parent.flexOrGridItems));
  const flexOrGridItems = display === "contents" ? parent.flexOrGridItems : FLEX_OR_GRID_DISPLAY_RE.test(display);
  const contentVisibility = compute("content-visibility", "visible", parent.contentVisibility, untilFound ? "hidden" : "visible");
  return {
    customProps, display, position, float, outOfFlow, flexOrGridItems, contentVisibility,
    ownContentHidden: contentVisibility === "hidden" && supportsContentVisibility(display, namespace, outerSvg),
    suppressedSubtree: parent.suppressedSubtree || display === "none",
    visibilityHidden: compute("visibility", "visible", inheritedVisibility, inheritedVisibility) !== "visible",
    contentVisibilityHidden: ancestorContentHidden,
  };
}

const HTML_CLOSES_PARAGRAPH_RE =
  /^(?:address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|li|main|menu|nav|ol|p|pre|search|section|table|ul)$/;

const HTML_SCOPE_TAGS = "applet|caption|html|marquee|object|select|table|td|th|template";
const HTML_ELEMENT_SCOPE_RE = new RegExp("^(?:" + HTML_SCOPE_TAGS + ")$");
const HTML_BUTTON_SCOPE_RE = new RegExp("^(?:button|" + HTML_SCOPE_TAGS + ")$");
const HTML_FORMATTING_SCOPE_RE = /^(?:applet|caption|marquee|object|td|th|template)$/;
const HTML_NESTED_TABLE_SCOPE_RE = /^(?:caption|html|td|th|template)$/;
const HTML_TABLE_SCOPE_RE = /^(?:html|template)$/;
const HTML_TABLE_ELEMENT_BOUNDARY_RE = /^(?:html|table|template)$/;
const HTML_TABLE_INSERTION_RE = /^(?:table|thead|tbody|tfoot|tr)$/;
const HTML_TABLE_STRUCTURE_RE = /^(?:caption|colgroup|col|thead|tbody|tfoot|tr|td|th)$/;
const HTML_SELECT_TABLE_RE = /^(?:caption|table|tbody|tfoot|thead|tr|td|th)$/;
const HTML_FRAGMENT_START_IGNORED_RE = /^(?:html|body|head|frame|frameset)$/;
const HTML_FRAGMENT_END_IGNORED_RE = /^(?:html|body|head)$/;
const HTML_TABLE_SECTION_RE = /^(?:thead|tbody|tfoot)$/;
const HTML_HEADING_SCOPE_RE = /^(?:h[1-6]|#markdown-heading)$/;
const HTML_FORMATTING_TAG_RE = /^(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)$/;
const HTML_TABLE_CELL_RE = /^(?:td|th)$/;
const HTML_SPECIAL_TAG_RE =
  /^(?:address|applet|area|article|aside|base|basefont|bgsound|blockquote|body|br|button|caption|center|col|colgroup|dd|details|dir|div|dl|dt|embed|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hgroup|hr|html|iframe|img|input|li|link|listing|main|marquee|menu|meta|nav|noembed|noframes|noscript|object|ol|p|param|plaintext|pre|script|search|section|select|source|style|summary|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|track|ul|wbr|xmp|#markdown-heading|#markdown-p)$/;
const HTML_LIST_ITEM_SCOPE_RE = new RegExp("^(?:ol|ul|" + HTML_SCOPE_TAGS + ")$");
const HTML_IMPLIED_END_TAG_RE = /^(?:dd|dt|li|optgroup|option|p|rb|rp|rt|rtc|#markdown-p)$/;
const HTML_NON_RECONSTRUCTING_START_RE =
  /^(?:base|basefont|bgsound|body|center|dir|form|frame|frameset|head|html|iframe|link|listing|meta|noembed|noframes|noscript|param|plaintext|rb|rp|rt|rtc|script|source|style|template|textarea|title|track)$/;

function isSpecialHtmlElement({ tag, namespace }: { tag: string; namespace?: HtmlNamespace }): boolean {
  if (namespace === "svg") return SVG_HTML_INTEGRATION_POINT_RE.test(tag);
  if (namespace === "math") return tag === "annotation-xml" || MATH_TEXT_INTEGRATION_POINT_RE.test(tag);
  return HTML_SPECIAL_TAG_RE.test(tag);
}

// Search back to the matching parsing scope even if inline elements are still open.
const HTML_IMPLIED_SIBLING_ENDS: ReadonlyArray<readonly [RegExp, RegExp, RegExp]> = [
  [/^option$/, /^option$/, /^(?:optgroup|select|datalist|template)$/],
  [/^optgroup$/, /^(?:option|optgroup)$/, /^(?:select|datalist|template)$/],
  [/^(?:rt|rp)$/, /^(?:rb|rt|rp)$/, /^(?:rtc|ruby|template)$/],
  [/^(?:rb|rtc)$/, /^(?:rb|rt|rp|rtc)$/, /^(?:ruby|template)$/],
  [/^button$/, /^button$/, HTML_ELEMENT_SCOPE_RE],
];

type LabelDisclosure = { open: boolean; summary?: OpenStyledTag };

type OpenStyledTag = OpenHtmlTag & {
  labelStyle: LabelStyle;
  containerDepth: number;
  markup?: string;
  outerSvg?: boolean;
  preserveUnclosedLabel?: boolean;
  disclosure?: LabelDisclosure;
  formattingMarker?: number;
  stackIndex: number;
  svgText?: boolean;
};

function styleForOpenTag(
  element: OpenHtmlTag & { markup?: string; preserveUnclosedLabel?: boolean; outerSvg?: boolean }, parent: LabelStyle,
  style = resolveElementStyle(element.tag, parent, element.markup, element.namespace, element.outerSvg),
): LabelStyle {
  const { tag, namespace, htmlAnnotation, preserveUnclosedLabel } = element;
  const inert = (namespace === "svg" && SVG_NON_RENDERED_LABEL_TAGS.has(tag)) ||
    (namespace === "math" && MATH_NON_RENDERED_LABEL_TAGS.has(tag) && !htmlAnnotation) ||
    (!namespace && tag === "template");
  if (inert) return { ...style, suppressedSubtree: true };
  if (preserveUnclosedLabel) {
    return {
      ...style, suppressedSubtree: parent.suppressedSubtree, ownContentHidden: false,
    };
  }
  return style;
}

function createHtmlElementStack(
  inheritedStyle = DEFAULT_LABEL_STYLE,
  onReconstruct?: (entry: OpenStyledTag, parent: OpenStyledTag | undefined, before: OpenStyledTag | undefined) => void,
) {
  const stack: OpenStyledTag[] = [];
  const activeFormatting: (OpenStyledTag | null)[] = [];
  let containerDepth = 0;
  let formElement: OpenStyledTag | undefined;
  const getStyle = () => stack.at(-1)?.labelStyle ?? inheritedStyle;
  const inTableInsertionContext = (entry = stack.at(-1)) =>
    !entry?.namespace && HTML_TABLE_INSERTION_RE.test(entry?.tag ?? "");
  const fosterTable = (parentIndex = stack.length - 1) => {
    if (parentIndex >= 0 && inTableInsertionContext(stack[parentIndex])) {
      // Foster parenting inserts before the nearest table, in the table's parent.
      for (let index = parentIndex; index >= 0; index--) {
        const entry = stack[index]!;
        if (entry.namespace) continue;
        if (entry.tag === "template") return;
        if (entry.tag === "table") return entry;
      }
    }
  };
  const insertionParent = (parentIndex = stack.length - 1) => {
    const table = fosterTable(parentIndex);
    return table ? stack[table.stackIndex - 1] : stack[parentIndex];
  };
  const insertionStyle = () => insertionParent()?.labelStyle ?? inheritedStyle;
  const pushTag = (element: Omit<OpenStyledTag, "containerDepth" | "stackIndex" | "formattingMarker">) => {
    const entry: OpenStyledTag = { ...element, containerDepth, stackIndex: stack.length };
    if (!entry.namespace && HTML_FORMATTING_SCOPE_RE.test(entry.tag)) {
      entry.formattingMarker = activeFormatting.length;
      activeFormatting.push(null);
    }
    stack.push(entry);
    return entry;
  };
  const popTo = (length: number) => {
    while (stack.length > length) {
      const { formattingMarker } = stack.pop()!;
      if (formattingMarker !== undefined) activeFormatting.length = formattingMarker;
    }
  };
  const leaveForeignContent = () => {
    while (htmlChildNamespace(stack.at(-1))) popTo(stack.length - 1);
  };
  const isScopeBoundary = (entry: OpenStyledTag, boundary: RegExp) => {
    if (!entry.namespace) return boundary.test(entry.tag);
    return (boundary === HTML_ELEMENT_SCOPE_RE || boundary === HTML_BUTTON_SCOPE_RE ||
      boundary === HTML_LIST_ITEM_SCOPE_RE) && isSpecialHtmlElement(entry);
  };
  const findInScope = (tags: RegExp, boundary?: RegExp, outermost = false) => {
    let found = -1;
    for (let index = stack.length - 1; index >= 0; index--) {
      const entry = stack[index]!;
      if (boundary && isScopeBoundary(entry, boundary)) break;
      if (!entry.namespace && tags.test(entry.tag)) {
        found = index;
        if (!outermost) break;
      }
    }
    return found;
  };
  const isInScope = (index: number, boundary: RegExp) => {
    for (let above = stack.length - 1; above > index; above--) {
      if (isScopeBoundary(stack[above]!, boundary)) return false;
    }
    return true;
  };
  const closeForm = () => {
    const form = formElement;
    formElement = undefined;
    if (!form || stack[form.stackIndex] !== form || !isInScope(form.stackIndex, HTML_ELEMENT_SCOPE_RE)) return;
    while (stack.length > form.stackIndex + 1) {
      const top = stack.at(-1)!;
      if (top.namespace || !HTML_IMPLIED_END_TAG_RE.test(top.tag)) break;
      popTo(stack.length - 1);
    }
    // Removing the form from the open stack leaves its existing DOM children in place.
    stack.splice(form.stackIndex, 1);
    for (let index = form.stackIndex; index < stack.length; index++) stack[index]!.stackIndex = index;
    return form;
  };
  const closeOtherEndTag = (tag: string, protectedElement?: OpenStyledTag) => {
    if (tag === "template") {
      const index = findInScope(/^template$/);
      if (index >= 0) {
        const entry = stack[index]!;
        popTo(index);
        return entry;
      }
      return;
    }
    if (tag === "form") {
      if (findInScope(/^template$/) >= 0) {
        const index = findInScope(/^form$/, HTML_ELEMENT_SCOPE_RE);
        if (index >= 0) {
          const entry = stack[index]!;
          popTo(index);
          return entry;
        }
        return;
      }
      return closeForm();
    }
    const boundary = tag === "li" ? HTML_LIST_ITEM_SCOPE_RE : tag === "table" ? HTML_TABLE_SCOPE_RE :
      HTML_TABLE_STRUCTURE_RE.test(tag) ? HTML_TABLE_ELEMENT_BOUNDARY_RE :
      HTML_CLOSES_PARAGRAPH_RE.test(tag) || HTML_FORMATTING_SCOPE_RE.test(tag) ||
        /^(?:button|center|dir|listing|select|summary)$/.test(tag) ? HTML_ELEMENT_SCOPE_RE : undefined;
    for (let index = stack.length - 1; index >= 0; index--) {
      const entry = stack[index]!;
      if (!entry.namespace && entry.tag === tag) {
        if (entry === protectedElement) return;
        popTo(index);
        return entry;
      }
      if (boundary ? isScopeBoundary(entry, boundary) : isSpecialHtmlElement(entry)) return;
    }
  };
  const closeListItem = (tag: string) => {
    const siblings = tag === "li" ? /^li$/ : /^(?:dd|dt)$/;
    for (let index = stack.length - 1; index >= 0; index--) {
      const entry = stack[index]!;
      if (!entry.namespace && siblings.test(entry.tag)) {
        popTo(index);
        return;
      }
      if (isSpecialHtmlElement(entry) && !/^(?:address|div|p|#markdown-p)$/.test(entry.tag)) return;
    }
  };
  const closeRawParagraph = () => {
    const index = findInScope(/^p$/, HTML_BUTTON_SCOPE_RE);
    if (index >= 0) {
      const paragraph = stack[index]!;
      popTo(index);
      return paragraph;
    }
  };
  const closeCurrentHeading = () => {
    if (HTML_HEADING_SCOPE_RE.test(stack.at(-1)?.tag ?? "")) popTo(stack.length - 1);
  };
  const closeTableForNewTable = () => {
    const index = findInScope(/^table$/, HTML_NESTED_TABLE_SCOPE_RE);
    if (index >= 0) popTo(index);
  };
  const isOnStack = (entry: OpenStyledTag) => stack[entry.stackIndex] === entry;
  const reconstructFormatting = () => {
    let index = activeFormatting.length;
    while (index > 0) {
      const entry = activeFormatting[index - 1]!;
      if (entry === null || isOnStack(entry)) break;
      index--;
    }
    for (; index < activeFormatting.length; index++) {
      const entry = activeFormatting[index]!;
      const parent = insertionParent();
      const before = fosterTable();
      const style = styleForOpenTag(entry, parent?.labelStyle ?? inheritedStyle);
      const copy = pushTag({
        tag: entry.tag, markup: entry.markup, preserveUnclosedLabel: entry.preserveUnclosedLabel,
        labelStyle: parent?.disclosure?.open === false ? { ...style, suppressedSubtree: true } : style,
      });
      activeFormatting[index] = copy;
      onReconstruct?.(copy, parent, before);
    }
  };
  const activeFormattingIndex = (tag: string) => {
    for (let index = activeFormatting.length - 1; index >= 0; index--) {
      const entry = activeFormatting[index]!;
      if (entry === null) break;
      if (entry.tag === tag) return index;
    }
    return -1;
  };
  const closeFormatting = (tag: string) => {
    // Adoption agency steps affecting the open stack and inherited styles.
    let closed: OpenStyledTag | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const activeIndex = activeFormattingIndex(tag);
      if (activeIndex < 0) return closeOtherEndTag(tag) ?? closed;
      const entry = activeFormatting[activeIndex]!;
      const index = entry.stackIndex;
      if (!isOnStack(entry)) {
        activeFormatting.splice(activeIndex, 1);
        return closed;
      }
      if (!isInScope(index, HTML_ELEMENT_SCOPE_RE)) return closed;
      closed ??= entry;
      let block = index + 1;
      while (block < stack.length && !isSpecialHtmlElement(stack[block]!)) block++;
      if (block === stack.length) {
        activeFormatting.splice(activeIndex, 1);
        popTo(index);
        return closed;
      }

      // Reparent the first special element. The three nearest active formatting
      // ancestors may be retained as wrappers, with their original declarations.
      const wrappers = stack.slice(Math.max(index + 1, block - 3), block)
        .filter(candidate => activeFormatting.includes(candidate));
      const bookmark = wrappers.at(-1);
      for (let active = activeFormatting.length - 1; active >= 0; active--) {
        const candidate = activeFormatting[active]!;
        if (candidate === null) break;
        if (isOnStack(candidate) && candidate.stackIndex > index && candidate.stackIndex < block - 3) {
          activeFormatting.splice(active, 1);
        }
      }
      const replacement = { ...entry };
      const entryIndex = activeFormatting.indexOf(entry);
      if (bookmark) {
        activeFormatting.splice(entryIndex, 1);
        activeFormatting.splice(activeFormatting.indexOf(bookmark) + 1, 0, replacement);
      } else activeFormatting[entryIndex] = replacement;
      stack.splice(index, block - index, ...wrappers);
      stack.splice(index + wrappers.length + 1, 0, replacement);
      for (let changed = index; changed < stack.length; changed++) {
        const candidate = stack[changed]!;
        candidate.stackIndex = changed;
        const parent = insertionParent(changed - 1);
        const style = styleForOpenTag(candidate, parent?.labelStyle ?? inheritedStyle);
        candidate.labelStyle = parent?.disclosure?.open === false && parent.disclosure.summary !== candidate
          ? { ...style, suppressedSubtree: true } : style;
      }
    }
    return closed;
  };
  const pushImplicitTableTag = (tag: string) => {
    return pushTag({ tag, labelStyle: resolveElementStyle(tag, getStyle()) });
  };
  const prepareTableStructure = (tag: string) => {
    const table = findInScope(/^table$/, HTML_TABLE_SCOPE_RE);
    // Table-only start tags in the body do not create an inheritance scope.
    if (table < 0) return false;
    if (tag === "col") {
      const group = findInScope(/^colgroup$/, HTML_TABLE_ELEMENT_BOUNDARY_RE);
      popTo((group < 0 ? table : group) + 1);
      if (group < 0) pushImplicitTableTag("colgroup");
    } else if (tag === "tr" || tag === "td" || tag === "th") {
      const row = tag === "tr" ? -1 : findInScope(/^tr$/, HTML_TABLE_ELEMENT_BOUNDARY_RE);
      if (row >= 0) popTo(row + 1);
      else {
        const section = findInScope(HTML_TABLE_SECTION_RE, HTML_TABLE_ELEMENT_BOUNDARY_RE);
        popTo((section < 0 ? table : section) + 1);
        if (section < 0) pushImplicitTableTag("tbody");
        if (tag !== "tr") pushImplicitTableTag("tr");
      }
    } else popTo(table + 1);
    return true;
  };
  const selectIndex = () => findInScope(/^select$/, /^template$/);
  const prepareText = (text: string) => {
    const nonWhitespace = /[^\t\n\f\r ]/.test(text);
    if (stack.at(-1)?.tag === "colgroup" && nonWhitespace) popTo(stack.length - 1);
    const inTable = inTableInsertionContext();
    const foster = inTable && nonWhitespace;
    if ((!inTable || foster) && !htmlChildNamespace(stack.at(-1)) && activeFormatting.length && selectIndex() < 0) {
      reconstructFormatting();
    }
    const before = foster ? fosterTable() : undefined;
    return { parent: before ? insertionParent() : stack.at(-1), before };
  };
  const ignoreSelectToken = (tag: string, prefix: string, index: number) => {
    if (HTML_SELECT_TABLE_RE.test(tag) && findInScope(/^table$/, HTML_TABLE_SCOPE_RE) >= 0) {
      if (prefix === "/" && findInScope(new RegExp("^" + tag + "$"), HTML_TABLE_SCOPE_RE) < 0) return true;
      popTo(index);
      return false;
    }
    if (prefix === "") {
      if (tag === "select" || /^(?:input|keygen|textarea)$/.test(tag)) {
        popTo(index);
        return tag === "select";
      }
      if (tag === "hr") {
        while (/^(?:option|optgroup)$/.test(stack.at(-1)?.tag ?? "")) popTo(stack.length - 1);
        return false;
      }
      return !/^(?:option|optgroup|script|template)$/.test(tag);
    }
    return !/^(?:option|optgroup|select|template)$/.test(tag);
  };
  const readTokenContext = (match: RegExpExecArray) => {
    const prefix = match.groups?.prefix;
    const tag = asciiLower(match.groups?.tag ?? "");
    const startTag = prefix === "" ? tag : undefined;
    if (tag && htmlChildNamespace(stack.at(-1), startTag) && exitsHtmlForeignContent(tag, prefix, match[0])) {
      leaveForeignContent();
    }
    const namespace = htmlChildNamespace(stack.at(-1), startTag);
    if (namespace || !tag || (prefix !== "" && prefix !== "/")) return { namespace, ignored: false };
    const rootTag = (prefix === "" ? HTML_FRAGMENT_START_IGNORED_RE : HTML_FRAGMENT_END_IGNORED_RE).test(tag);
    if (rootTag) return { namespace, ignored: true };
    const select = selectIndex();
    // Match the select insertion modes used by the HTML fragment parser.
    return { namespace, ignored: select >= 0 && ignoreSelectToken(tag, prefix, select) };
  };
  const prepareStart = (tag: string, namespace: HtmlNamespace) => {
    if (namespace) return { tableStructure: false, tableForm: false };
    const tableStructure = HTML_TABLE_STRUCTURE_RE.test(tag);
    const htmlForm = tag === "form";
    const hasTemplate = htmlForm && findInScope(/^template$/) >= 0;
    if ((tableStructure && !prepareTableStructure(tag)) || (htmlForm && !hasTemplate && formElement)) return null;
    const tableForm = htmlForm && !hasTemplate &&
      findInScope(HTML_TABLE_INSERTION_RE, /^(?:caption|td|th|template)$/) >= 0;
    if (!tableStructure && tag !== "template" && stack.at(-1)?.tag === "colgroup") {
      popTo(stack.length - 1);
    }
    if (tag === "table") closeTableForNewTable();
    if (tag === "li" || tag === "dd" || tag === "dt") closeListItem(tag);
    if (!tableForm && HTML_CLOSES_PARAGRAPH_RE.test(tag)) {
      const index = findInScope(/^#markdown-p$/, HTML_BUTTON_SCOPE_RE);
      if (index >= 0) popTo(index);
      closeRawParagraph();
    }
    if (HTML_HEADING_SCOPE_RE.test(tag)) closeCurrentHeading();
    const sibling = HTML_IMPLIED_SIBLING_ENDS.find(([open]) => open.test(tag));
    if (sibling) {
      const index = findInScope(sibling[1], sibling[2], true);
      if (index >= 0) popTo(index);
    }
    if (!tableStructure && !HTML_CLOSES_PARAGRAPH_RE.test(tag) && !HTML_NON_RECONSTRUCTING_START_RE.test(tag)) {
      if (tag === "a" || tag === "nobr") closeFormatting(tag);
      reconstructFormatting();
    }
    return { tableStructure, tableForm };
  };
  const insertTag = (element: Parameters<typeof pushTag>[0], tableForm: boolean) => {
    const entry = pushTag(element);
    if (!entry.namespace && entry.tag === "form" && findInScope(/^template$/) < 0) {
      formElement = entry;
      if (tableForm) popTo(stack.length - 1);
    }
    if (!entry.namespace && HTML_FORMATTING_TAG_RE.test(entry.tag)) activeFormatting.push(entry);
    return entry;
  };
  const closeTag = (tag: string, protectedElement?: OpenStyledTag) => {
    // Foreign end tags fall back to the HTML rules at the first HTML ancestor.
    for (let index = stack.length - 1; stack[index]?.namespace; index--) {
      const entry = stack[index]!;
      if (entry.tag === tag) {
        popTo(index);
        return entry;
      }
    }
    if (tag === "p") {
      const index = findInScope(/^#markdown-p$/, HTML_BUTTON_SCOPE_RE);
      if (index >= 0) {
        const paragraph = stack[index]!;
        popTo(index);
        return paragraph;
      }
      return closeRawParagraph();
    } else if (HTML_HEADING_SCOPE_RE.test(tag)) {
      const index = findInScope(HTML_HEADING_SCOPE_RE, HTML_ELEMENT_SCOPE_RE);
      if (index >= 0) {
        const heading = stack[index]!;
        popTo(index);
        return heading;
      }
    } else if (HTML_FORMATTING_TAG_RE.test(tag)) {
      return closeFormatting(tag);
    } else {
      return closeOtherEndTag(tag, protectedElement);
    }
  };
  const applyToken = (match: RegExpExecArray, namespace: HtmlNamespace, protectedElement?: OpenStyledTag) => {
    const tag = asciiLower(match.groups?.tag ?? "");
    if (!tag) return;
    const prefix = match.groups?.prefix;
    if (prefix === "/") return closeTag(tag, protectedElement);
    if (prefix !== "") return;
    const start = prepareStart(tag, namespace);
    if (!start) return;
    const current = htmlStartTagNamespace(namespace, tag);
    if (!isOpenableHtmlTag(current, tag, match[0])) return;
    return insertTag({
      tag, namespace: current, htmlAnnotation: htmlEncodedAnnotation(current, tag, match[0]),
      labelStyle: getStyle(),
    }, start.tableForm);
  };
  return {
    stack, getStyle, insertionParent, insertionStyle, fosterTable, pushTag, popTo, leaveForeignContent, findInScope,
    closeRawParagraph, closeCurrentHeading, closeTableForNewTable, reconstructFormatting,
    selectIndex, readTokenContext, prepareText, prepareStart, insertTag, closeTag, applyToken, isOnStack, pushImplicitTableTag,
    setContainerDepth(depth: number) { containerDepth = depth; },
  };
}

function createHtmlScopeLookup(
  html: string,
  inheritedContext: LabelContext,
  blockLines: readonly HtmlScopeLine[],
) {
  const { style: inheritedStyle } = inheritedContext;
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  const elements = createHtmlElementStack(inheritedStyle);
  const { stack, getStyle, insertionStyle, pushTag, popTo, leaveForeignContent, findInScope,
    closeRawParagraph, closeCurrentHeading, closeTableForNewTable, reconstructFormatting, pushImplicitTableTag, isOnStack } = elements;
  const ignoredDetailsStarts = new Set<number>();
  // Keep an insertion count per scope so lookups only see groups already open there.
  const openDetailsOrder = new Map<string, number>();
  const positions = [0];
  const scopes: { context: LabelContext; openDetailsCount: number; namespace: HtmlNamespace; pipeCell?: "th" | "td" }[] = [
    { context: inheritedContext, openDetailsCount: 0, namespace: undefined },
  ];
  let lineIndex = 0;
  let generatedHeading = false;
  let generatedTable: OpenStyledTag | undefined;
  let generatedSection: OpenStyledTag | undefined;
  let generatedRow: OpenStyledTag | undefined;
  let cursor = 0;
  let rawHtml = false;
  const htmlHeadings: HtmlHeading[] = [];
  const openHeadings: { entry: OpenStyledTag; heading: HtmlHeading }[] = [];
  const finishHeadings = (offset: number, closing?: OpenStyledTag, closeEnd = offset, endOfBlock = false) => {
    while (openHeadings.length) {
      const { entry, heading } = openHeadings.at(-1)!;
      if (!endOfBlock && isOnStack(entry)) break;
      heading.end = entry === closing ? closeEnd : offset;
      openHeadings.pop();
    }
  };
  const recordScope = (offset: number, style = getStyle()) => {
    const namespace = htmlChildNamespace(stack.at(-1));
    let pipeCell: "th" | "td" | undefined;
    if (generatedTable && isOnStack(generatedTable)) {
      const index = findInScope(HTML_TABLE_CELL_RE, /^(?:html|template)$/);
      if (index > generatedTable.stackIndex) pipeCell = stack[index]!.tag === "th" ? "th" : "td";
    }
    const previous = scopes.at(-1)!;
    const openDetailsCount = openDetailsOrder.size;
    if (style !== previous.context.style || namespace !== previous.namespace || pipeCell !== previous.pipeCell ||
      openDetailsCount !== previous.openDetailsCount) {
      const hasOpenDetails = openDetailsCount === previous.openDetailsCount ? previous.context.hasOpenDetails :
        (name: string) => (openDetailsOrder.get(name) ?? Infinity) <= openDetailsCount || inheritedContext.hasOpenDetails?.(name) === true;
      const context = style === previous.context.style && hasOpenDetails === previous.context.hasOpenDetails
        ? previous.context : { style, hasOpenDetails };
      positions.push(offset);
      scopes.push({ context, openDetailsCount, namespace, pipeCell });
    }
  };
  const readText = (end: number) => {
    if (end <= cursor) return;
    const segment = html.slice(cursor, end);
    const { parent } = elements.prepareText(rawHtml ? decodeHtmlCharacterReferences(segment) : decodeMarkdownCharacterReferences(segment));
    recordScope(cursor, parent?.labelStyle ?? inheritedStyle);
    cursor = end;
  };
  const advanceLines = (offset: number) => {
    for (let line = blockLines[lineIndex]; line && line.offset <= offset; line = blockLines[++lineIndex]) {
      readText(line.offset);
      if (rawHtml && !line.rawHtml) {
        finishHeadings(precedingLineBreakStart(html, line.offset), undefined, undefined, true);
      }
      rawHtml = line.rawHtml ?? false;
      const select = elements.selectIndex();
      if (select >= 0) {
        const endsCell = (line.cell || line.table) && generatedTable && isOnStack(generatedTable);
        const startsTableInTable = line.table === "header" && findInScope(/^table$/, HTML_TABLE_SCOPE_RE) >= 0;
        if (!endsCell && !startsTableInTable) continue;
        popTo(select);
      }
      if (line.endsInline) {
        // An inline HTML heading can replace the generated heading on the open-element stack.
        const index = generatedHeading ? findInScope(HTML_HEADING_SCOPE_RE, HTML_ELEMENT_SCOPE_RE) :
          findInScope(/^#markdown-p$/);
        if (index >= 0) popTo(index);
        generatedHeading = false;
      }
      // Generated Markdown container closing tags also close their raw HTML descendants.
      while (stack.length && stack.at(-1)!.containerDepth > line.continuedDepth) popTo(stack.length - 1);
      elements.setContainerDepth(line.containerDepth);
      if (line.inlineScope || line.table || line.cell || line.closesRawParagraph) leaveForeignContent();
      if (line.table === "header") {
        closeTableForNewTable();
        closeRawParagraph();
        generatedTable = pushTag({ tag: "table", labelStyle: resolveElementStyle("table", insertionStyle()) });
        generatedSection = pushImplicitTableTag("thead");
        generatedRow = pushImplicitTableTag("tr");
      } else if (line.table === "end") {
        if (generatedTable && isOnStack(generatedTable)) popTo(generatedTable.stackIndex);
        generatedTable = generatedSection = generatedRow = undefined;
      } else if (generatedTable && isOnStack(generatedTable)) {
        if (line.table === "body") {
          popTo(generatedTable.stackIndex + 1);
          generatedSection = pushImplicitTableTag("tbody");
          generatedRow = undefined;
        } else if (line.table === "row") {
          if (generatedSection && isOnStack(generatedSection)) popTo(generatedSection.stackIndex + 1);
          generatedRow = pushImplicitTableTag("tr");
        } else if (line.cell && generatedRow && isOnStack(generatedRow)) {
          popTo(generatedRow.stackIndex + 1);
          pushImplicitTableTag(line.cell);
        }
      }
      if (line.closesRawParagraph) closeRawParagraph();
      if (line.inlineScope === "#markdown-heading") {
        closeRawParagraph();
        closeCurrentHeading();
        generatedHeading = true;
      }
      if (line.inlineScope && (line.inlineScope === "#markdown-heading" ||
        (!generatedHeading && findInScope(/^#markdown-p$/) < 0))) {
        if (line.inlineScope === "#markdown-p") closeRawParagraph();
        if (stack.at(-1)?.tag === "colgroup") popTo(stack.length - 1);
        pushTag({ tag: line.inlineScope, labelStyle: resolveElementStyle(
          line.inlineScope === "#markdown-heading" ? "h2" : "p", insertionStyle(),
        ) });
        reconstructFormatting();
      }
      recordScope(line.offset);
      finishHeadings(line.offset);
    }
  };
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    advanceLines(match.index);
    readText(match.index);
    const prefix = match.groups?.prefix;
    const tag = asciiLower(match.groups?.tag ?? "");
    const headingTag = /^h[1-6]$/.test(tag);
    if (headingTag && !rawHtml && !STANDALONE_HTML_TAG_RE.test(match[0])) continue;
    const { namespace, ignored } = elements.readTokenContext(match);
    if (match.groups?.cdata && !isForeignCdata(stack.at(-1), match)) {
      tokens.lastIndex = endOfBogusHtmlComment(html, match.index + 2);
    }
    const start = !ignored && tag && prefix === "" ? elements.prepareStart(tag, namespace) : null;
    finishHeadings(match.index);
    if (start) recordScope(match.index, namespace || start.tableStructure ? getStyle() : insertionStyle());
    const raw = namespace || ignored ? null : htmlRawTextBounds(html, match, tokens.lastIndex);
    if (ignored) {
      if (tag === "details" && prefix === "") ignoredDetailsStarts.add(match.index);
    } else if (raw || (!namespace && tag === "template" && prefix === "")) {
      tokens.lastIndex = raw?.closeEnd ?? htmlElementEnd(html, "template", tokens.lastIndex) ?? html.length;
    } else if (tag && start) {
      const current = htmlStartTagNamespace(namespace, tag);
      if (isOpenableHtmlTag(current, tag, match[0])) {
        const element = {
          tag, namespace: current, markup: match[0], htmlAnnotation: htmlEncodedAnnotation(current, tag, match[0]),
          outerSvg: current === "svg" && tag === "svg" && namespace !== "svg",
        };
        const parent = namespace || start.tableStructure ? stack.at(-1) : elements.insertionParent();
        const labelStyle = styleForOpenTag(element, parent?.labelStyle ?? inheritedStyle);
        const entry = elements.insertTag({ ...element, labelStyle }, start.tableForm);
        if (!current && tag === "details") {
          const { open, name } = readDetailsOpening(match[0]);
          const alreadyOpen = name && (openDetailsOrder.has(name) || inheritedContext.hasOpenDetails?.(name));
          entry.disclosure = { open: open && !alreadyOpen };
          if (name && entry.disclosure.open) {
            openDetailsOrder.set(name, openDetailsOrder.size + 1);
          }
        }
        if (!current && tag === "summary" && parent?.disclosure && !parent.disclosure.summary) {
          parent.disclosure.summary = entry;
        }
        // Markdown headings and table cells classify their own inline labels.
        const sectionHeading = rawHtml || (!generatedHeading && !(generatedTable && isOnStack(generatedTable)));
        if (headingTag && sectionHeading && !current &&
          !labelStyle.suppressedSubtree && !skipsLabelContents(labelStyle) &&
          !stack.some((ancestor, index) => ancestor.disclosure?.open === false &&
            ancestor.disclosure.summary !== stack[index + 1])) {
          const heading = {
            start: match.index, end: tokens.lastIndex, rawHtml,
            level: Number(tag[1]), depth: entry.containerDepth,
            context: scopes.at(-1)!.context, visibilityHidden: labelStyle.visibilityHidden,
          };
          htmlHeadings.push(heading);
          openHeadings.push({ entry, heading });
        }
      }
    } else if (tag && prefix === "/") {
      const closed = elements.closeTag(tag);
      finishHeadings(match.index, closed, headingTag ? tokens.lastIndex : match.index);
    }
    // Multi-line HTML tokens and raw text consume the intervening source lines.
    while (blockLines[lineIndex] && blockLines[lineIndex]!.offset < tokens.lastIndex) lineIndex++;
    cursor = tokens.lastIndex;
    recordScope(tokens.lastIndex);
  }
  advanceLines(html.length);
  finishHeadings(html.length, undefined, undefined, true);
  const scopeAt = (offset: number) => {
    let low = 0;
    let high = positions.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (positions[middle]! <= offset) low = middle;
      else high = middle;
    }
    return scopes[low]!;
  };
  return { scopeAt, ignoredDetailsStarts, htmlHeadings };
}

function seedPipeTableCell(elements: ReturnType<typeof createHtmlElementStack>, cell: "th" | "td") {
  for (const tag of ["table", cell === "th" ? "thead" : "tbody", "tr", cell]) elements.pushImplicitTableTag(tag);
}

type LabelOutput = { parts: (string | boolean | LabelBoxOutput | LabelDetailsLegend)[]; hasText: boolean };
type LabelBoxOutput = { parent: LabelOutput; before?: LabelOutput; inside: LabelOutput; block: boolean };
type LabelDetailsLegend = { disclosure: LabelDisclosure; parent: LabelOutput; visibilityHidden: boolean };

function htmlLabelTextVariants(
  label: string, context: LabelContext, pipeCell?: "th" | "td", rawHtml = false,
  decodeText = rawHtml ? decodeHtmlCharacterReferences : decodeMarkdownCharacterReferences,
) {
  const { style: inheritedStyle } = context;
  const tokens = new RegExp(HTML_MARKUP_TOKEN, "gi");
  const root: LabelOutput = { parts: [], hasText: false };
  const openDetails = new Set<string>();
  const boxBuffers: LabelBoxOutput[] = [];
  const detailsLegends: LabelDetailsLegend[] = [];
  const tableOutputs = new WeakMap<OpenStyledTag, LabelBoxOutput>();
  const entryOutputs = new WeakMap<OpenStyledTag, LabelOutput>();
  const rendersBox = (style: LabelStyle) => !style.suppressedSubtree && !style.contentVisibilityHidden && style.display !== "contents";
  const bufferBox = (parent: LabelOutput, block: boolean, before?: LabelOutput) => {
    const box: LabelBoxOutput = { parent, before, inside: { parts: [], hasText: false }, block };
    boxBuffers.push(box);
    parent.parts.push(box);
    return box;
  };
  const bufferOutOfFlow = (output: LabelOutput, style: LabelStyle) =>
    style.outOfFlow && rendersBox(style) ? bufferBox(output, true).inside : output;
  const outputAt = (parent: OpenStyledTag | undefined, before?: OpenStyledTag) => {
    if (before) {
      const fostered = tableOutputs.get(before)?.before;
      if (fostered) return fostered;
    }
    for (let entry = parent; entry; entry = stack[entry.stackIndex - 1]) {
      const output = entryOutputs.get(entry);
      if (output) return output;
    }
    return root;
  };
  const elements = createHtmlElementStack(inheritedStyle, (entry, parent, before) => {
    entryOutputs.set(entry, bufferOutOfFlow(outputAt(parent, before), entry.labelStyle));
  });
  const { stack } = elements;
  if (pipeCell) seedPipeTableCell(elements, pipeCell);
  const appendText = (output: LabelOutput, text: string) => {
    output.parts.push(text);
    output.hasText ||= /\S/.test(text.replace(INVISIBLE_LABEL_TEXT, ""));
  };
  const breaksLine = (display: string) => /(?:^| )block(?: |$)/.test(display) ||
    !/(?:^| )(?:inline(?:-\S+)?|ruby(?:-\S+)?)(?: |$)/.test(display);
  const rendersText = (current: OpenStyledTag | undefined) => {
    const style = current?.labelStyle ?? inheritedStyle;
    return current?.disclosure?.open !== false && !style.suppressedSubtree && !skipsLabelContents(style) && !style.visibilityHidden &&
      (htmlChildNamespace(current) !== "svg" || current?.svgText === true);
  };
  const appendData = (start: number, end: number) => {
    if (start >= end) return;
    // References cannot continue into the next HTML text node.
    const text = decodeText(label.slice(start, end));
    const { parent, before } = elements.prepareText(text);
    if (rendersText(parent)) appendText(outputAt(parent, before), text);
  };
  let cursor = 0;
  let hasDetails = false;
  for (let match = tokens.exec(label); match; match = tokens.exec(label)) {
    appendData(cursor, match.index);
    cursor = tokens.lastIndex;
    if (match.groups?.cdata) {
      if (isForeignCdata(stack.at(-1), match)) {
        const current = stack.at(-1);
        if (rendersText(current)) appendText(outputAt(current), label.slice(match.index + 9, match[0].endsWith("]]>") ? cursor - 3 : cursor));
      } else {
        tokens.lastIndex = cursor = endOfBogusHtmlComment(label, match.index + 2);
      }
      continue;
    }
    const tag = asciiLower(match.groups?.tag ?? "");
    const prefix = match.groups?.prefix;
    if (!tag || (prefix !== "" && prefix !== "/")) continue;
    if (!rawHtml && !/^[a-z][a-z0-9-]*$/.test(tag)) {
      appendData(match.index, cursor);
      continue;
    }
    const { namespace: parentNamespace, ignored } = elements.readTokenContext(match);
    if (ignored) continue;
    if (prefix === "") {
      const start = elements.prepareStart(tag, parentNamespace);
      if (!start) continue;
      const namespace = htmlStartTagNamespace(parentNamespace, tag);
      const htmlAnnotation = htmlEncodedAnnotation(namespace, tag, match[0]);
      const parent = parentNamespace || start.tableStructure ? stack.at(-1) : elements.insertionParent();
      const before = parentNamespace || start.tableStructure ? undefined : elements.fosterTable();
      const output = outputAt(parent, before);
      const parentStyle = parent?.labelStyle ?? inheritedStyle;
      const rubyAnnotation = !namespace && (tag === "rt" || tag === "rp") && elements.findInScope(/^ruby$/) >= 0;
      const canOpen = isOpenableHtmlTag(namespace, tag, match[0]);
      const markup = match[0];
      const outerSvg = namespace === "svg" && tag === "svg" && parentNamespace !== "svg";
      const element = { tag, namespace, htmlAnnotation, markup, outerSvg };
      let style = styleForOpenTag(element, parentStyle);
      const raw = namespace ? null : htmlRawTextBounds(label, match, cursor);
      const inertTag = !namespace && (tag === "template" || (HTML_NON_RENDERED_LABEL_TAGS.has(tag) && style.display === "none"));
      const mayNeedClose = canOpen && !start.tableStructure && tag !== "table" &&
        ((!namespace && (style.display === "none" || style.ownContentHidden)) || inertTag);
      const hiddenEnd = mayNeedClose && (raw
        ? (raw.closeStart < label.length || inertTag ? raw.closeEnd : undefined)
        : htmlElementEnd(label, tag, cursor, namespace, htmlAnnotation));
      // Datalist descendants still participate in document-scoped details groups.
      if (inertTag && tag !== "datalist" && (hiddenEnd || tag === "template")) {
        tokens.lastIndex = cursor = hiddenEnd || label.length;
        continue;
      }
      // The label alone cannot prove the extent of an unclosed hidden HTML tag.
      const preserveUnclosedLabel = mayNeedClose && !hiddenEnd && !inertTag;
      if (preserveUnclosedLabel) style = styleForOpenTag({ ...element, preserveUnclosedLabel }, parentStyle, style);
      const disclosure = parent?.disclosure;
      const firstSummary = disclosure && !disclosure.summary && !namespace && tag === "summary";
      if (rubyAnnotation || (disclosure?.open === false && !firstSummary)) style = { ...style, suppressedSubtree: true };
      if (raw) {
        if (!style.suppressedSubtree && !skipsLabelContents(style) && !style.visibilityHidden) {
          const text = label.slice(cursor, raw.closeStart);
          appendText(bufferOutOfFlow(output, style), tag === "textarea" ? decodeText(text) : text);
        }
        tokens.lastIndex = cursor = raw.closeEnd;
        continue;
      }
      if (rendersBox(style) && parentNamespace !== "svg") {
        if (!namespace && tag === "details") hasDetails = true;
        if (!style.outOfFlow && (namespace || tag !== "table")) {
          const block = tag === "br" || breaksLine(style.display);
          if (block || (tag !== "svg" && tag !== "ruby")) output.parts.push(block);
        }
      }
      if (canOpen) {
        let ownDisclosure: LabelDisclosure | undefined;
        if (!namespace && tag === "details") {
          const { open, name } = readDetailsOpening(markup);
          const alreadyOpen = name && (openDetails.has(name) || context.hasOpenDetails?.(name));
          ownDisclosure = { open: open && !alreadyOpen };
          if (name && ownDisclosure.open) openDetails.add(name);
        }
        const opened = elements.insertTag({
          ...element, labelStyle: style, preserveUnclosedLabel,
          disclosure: ownDisclosure,
          svgText: namespace === "svg" && (SVG_TEXT_TAGS.has(tag) || (tag !== "svg" && parent?.svgText === true)),
        }, start.tableForm);
        if (firstSummary) disclosure.summary = opened;
        if (!namespace && tag === "table") {
          // The table's position is fixed at insertion. Later fostered siblings still go before it.
          const block = rendersBox(style) && (style.outOfFlow || breaksLine(style.display));
          const table = bufferBox(output, block, { parts: [], hasText: false });
          tableOutputs.set(opened, table);
          entryOutputs.set(opened, table.inside);
          continue;
        }
        const contents = bufferOutOfFlow(output, style);
        entryOutputs.set(opened, contents);
        if (opened.disclosure && !style.suppressedSubtree && !skipsLabelContents(style)) {
          const legend = { disclosure: opened.disclosure, parent: contents, visibilityHidden: style.visibilityHidden };
          detailsLegends.push(legend);
          contents.parts.push(legend);
        }
      }
    } else {
      const parent = elements.insertionParent();
      const before = elements.fosterTable();
      const closed = elements.closeTag(tag);
      if (tag === "table" || (parentNamespace === "svg" &&
        (tag !== "svg" || htmlChildNamespace(stack.at(-1)) === "svg"))) continue;
      if (closed && !closed.labelStyle.outOfFlow && rendersBox(closed.labelStyle)) {
        const block = breaksLine(closed.labelStyle.display);
        if (block || (tag !== "svg" && tag !== "ruby")) {
          (entryOutputs.get(closed) ?? outputAt(stack.at(-1))).parts.push(block);
        }
      } else if (!closed && !parentNamespace && (tag === "br" || tag === "p") &&
        rendersBox(parent?.labelStyle ?? inheritedStyle)) {
        outputAt(parent, before).parts.push(true);
      }
    }
  }
  appendData(cursor, label.length);
  for (const { disclosure, parent, visibilityHidden } of detailsLegends) {
    if (!disclosure.summary && !visibilityHidden) parent.hasText = true;
  }
  // Measure child buffers before their parents, then emit in tree order without recursion.
  for (let index = boxBuffers.length - 1; index >= 0; index--) {
    const { parent, before, inside } = boxBuffers[index]!;
    parent.hasText ||= (before?.hasText ?? false) || inside.hasText;
  }
  const inline: string[] = [];
  const spaced: string[] = [];
  const pending = [root.parts[Symbol.iterator]()];
  while (pending.length) {
    const next = pending.at(-1)!.next();
    if (next.done) {
      pending.pop();
    } else if (typeof next.value === "string") {
      inline.push(next.value);
      spaced.push(next.value);
    } else if (typeof next.value === "boolean") {
      if (next.value) inline.push(" ");
      spaced.push(" ");
    } else if ("disclosure" in next.value) {
      const { disclosure, visibilityHidden } = next.value;
      if (!disclosure.summary) {
        const legend = visibilityHidden ? " " : " Details ";
        inline.push(legend);
        spaced.push(legend);
      }
    } else {
      const { before, inside, block } = next.value;
      if (inside.hasText) {
        if (block) pending.push([true][Symbol.iterator]());
        pending.push(inside.parts[Symbol.iterator]());
        if (block) pending.push([true][Symbol.iterator]());
      }
      if (before) pending.push(before.parts[Symbol.iterator]());
    }
  }
  const normalize = (parts: readonly string[]) => parts.join("").replace(INVISIBLE_LABEL_TEXT, "").replace(/\s+/g, " ").trim();
  return { inline: normalize(inline), spaced: normalize(spaced), hasDetails };
}

function classifyDetailsElement(
  text: string,
  openStart: number,
  openEnd: number,
  { summary }: DetailsBounds,
  activeVisibility: PedagogicalVisibility,
  definedLinkLabels: ReadonlySet<string>,
  htmlContext: ReturnType<typeof createMarkdownHtmlBlockLookup>,
): {
  readonly kind: PedagogicalBlockKind;
  readonly visibility: PedagogicalVisibility;
  readonly label: string;
  readonly summaryEndOffset: number | null;
} {
  if (summary && !text.slice(openEnd, summary.openStart).replace(HTML_COMMENT_RE, "").trim()) {
    const detailsStyle = resolveElementStyle(
      "details", htmlContext.labelContextAt(openStart, definedLinkLabels).style, text.slice(openStart, openEnd),
    );
    const summaryStyle = resolveElementStyle("summary", detailsStyle, text.slice(summary.openStart, summary.openEnd));
    const rawHtml = htmlContext.isRawHtmlAt(summary.openStart);
    const summaryContents = readSummaryMarkup(text, summary, htmlContext, definedLinkLabels);
    const summaryContext = htmlContext.labelContextAt(summary.openEnd, definedLinkLabels);
    const { inline: summaryText, spaced, hasDetails } = htmlLabelTextVariants(summaryContents, { ...summaryContext, style: summaryStyle },
      htmlContext.pipeCellAt(openStart, definedLinkLabels), rawHtml, decodeHtmlCharacterReferences);
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
  /^ {0,3}(?:<\/[a-z][a-z0-9-]*[ \t\r\n]*>|<[a-z][a-z0-9-]*(?:[ \t\r\n]+[a-z_:][\w.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:"[^"]*"|'[^']*'|[^ \t\r\n"'=<>\x60]+))?)*[ \t\r\n]*\/?>)[ \t]*$/i;

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

function tableColumnVisibility(
  label: string, definedLinkLabels = EMPTY_LINK_LABELS, context = DEFAULT_LABEL_CONTEXT,
  pipeCell?: "th" | "td", rawHtml = false,
): PedagogicalVisibility {
  const { style: inheritedStyle } = context;
  if (inheritedStyle.suppressedSubtree || skipsLabelContents(inheritedStyle)) return "public";
  if (!rawHtml && /[<\\*_[~\x60]/.test(label)) label = renderMarkdownLabelMarkup(label, true, definedLinkLabels);
  const { inline, spaced } = /[<&]/.test(label) ? htmlLabelTextVariants(label, context, pipeCell, rawHtml)
    : { inline: inheritedStyle.visibilityHidden ? "" : label.replace(INVISIBLE_LABEL_TEXT, ""), spaced: "" };
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
  header: string, cells: readonly { start: number; end: number }[], definedLinkLabels: ReadonlySet<string>,
  start = 0, labelContextAt = (_offset: number) => DEFAULT_LABEL_CONTEXT,
) {
  return cells.map(cell => tableColumnVisibility(
    header.slice(cell.start - start, cell.end - start), definedLinkLabels, labelContextAt(cell.start), "th",
  ));
}

type ReadMarkdownLine = (index: number) => string | undefined;

function createCueLabelContextLookup(
  lines: readonly string[], definedLinkLabels: ReadonlySet<string>, inheritedContext: LabelContext,
) {
  let offset = 0;
  const offsets = lines.map(line => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  const html = createMarkdownHtmlBlockLookup(lines.join("\n"), inheritedContext);
  return (index: number, column = 0) => html.labelContextAt((offsets[index] ?? 0) + column, definedLinkLabels);
}

function createProtectedSetextLookup(
  readRaw: ReadMarkdownLine, definedLinkLabels: ReadonlySet<string>, labelContextAt = (_index: number) => DEFAULT_LABEL_CONTEXT,
) {
  let checkedBefore = -1;
  let checkedContainers: readonly MarkdownContainer[] = [];
  let checkedColumns: readonly PedagogicalVisibility[] | undefined;
  let checkedCaptionRow = false;
  let checkedContext: LabelContext | undefined;
  return (
    start: number,
    { body, containers }: ReturnType<typeof readMarkdownContainerLine>,
    columns?: readonly PedagogicalVisibility[],
    captionRow = false,
  ): number | undefined => {
    // A suffix of a checked, unprotected paragraph cannot introduce a protected title.
    const activeContext = labelContextAt(start);
    if (start < checkedBefore && columns === checkedColumns && captionRow === checkedCaptionRow && activeContext === checkedContext &&
      containers.length === checkedContainers.length &&
      containers.every((container, index) => container === checkedContainers[index])) return undefined;

    let firstProtectedTitleLine = Infinity;
    const readLine: ReadMarkdownLine = index => {
      const raw = readRaw(index);
      if (raw === undefined) return undefined;
      const line = continueMarkdownContainers(raw, containers);
      if (index !== start && line.depth !== containers.length) return undefined;
      const titleLine = index === start ? body : line.body;
      if (columns && tableColumnVisibility(titleLine, definedLinkLabels, labelContextAt(index)) !== "public") {
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
      if (tableColumnVisibility(title.join("\n"), definedLinkLabels, activeContext) !== "public") return paragraph.index;
    }
    checkedBefore = paragraph.index;
    checkedContainers = containers;
    checkedColumns = columns;
    checkedCaptionRow = captionRow;
    checkedContext = activeContext;
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
  inheritedContext = DEFAULT_LABEL_CONTEXT,
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
  const htmlContinuations = new Set<number>();
  const rawHtmlLines = new Set<number>();
  const htmlScanner = createMarkdownBlockScanner();
  for (const [cueIndex, start] of cueLineStarts.entries()) {
    const end = cueLineStarts[cueIndex + 1] ?? lines.length;
    const previousStart = cueLineStarts[cueIndex - 1];
    // Multiline cues can contain their own blocks. Preserve soft HTML breaks
    // across adjacent one-line cues and explicit HTML terminators across all cues.
    if (previousStart !== undefined && (start - previousStart > 1 || end - start > 1)) htmlScanner.scan("");
    for (let index = start; index < end; index++) {
      const line = lines[index]!;
      const block = htmlScanner.htmlBlock;
      if (block && markdownHtmlContinuation(line, block) !== undefined) htmlContinuations.add(index);
      if (htmlScanner.scan(line).mode === "html") rawHtmlLines.add(index);
    }
  }
  if (lines.some(line => /<h[1-6](?:$|[\t\f />])/i.test(line))) {
    const headingText = lines.join("\n");
    const headingLines = splitLinesWithOffsets(headingText);
    const htmlContext = createMarkdownHtmlBlockLookup(headingText, inheritedContext);
    let index = 0;
    for (const heading of htmlContext.htmlHeadings(definedLinkLabels)) {
      while (headingLines[index] && headingLines[index]!.start <= heading.start) index++;
      while (headingLines[index] && headingLines[index]!.start < heading.end) {
        htmlContinuations.add(index++);
      }
    }
  }
  let containers: MarkdownContainer[] = [];
  let previousBody = "";
  let tableColumns: PedagogicalVisibility[] | undefined;
  let setextThrough = -1;
  let latexArgumentThrough = -1;
  let literalEnvironment: string | undefined;
  const mathEnvironments: string[] = [];
  const labelContextAt = createCueLabelContextLookup(lines, definedLinkLabels, inheritedContext);
  const protectedUnderline = createProtectedSetextLookup(index => lines[index], definedLinkLabels, labelContextAt);
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
      if (rawHtmlLines.has(index)) {
        containers = current.containers;
        previousBody = "";
        tableColumns = undefined;
        continue;
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
      tableColumns = headerCells ? getTableColumnVisibilities(
        previousBody, headerCells, definedLinkLabels, 0,
        offset => labelContextAt(index - 1, lines[index - 1]!.length - previousBody.length + offset),
      ) : undefined;
      containers = current.containers;
      previousBody = current.body;
    }
    const nextLine = lines[end];
    if (!joinNext || nextLine === undefined) return "";
    if (htmlContinuations.has(end)) return newline;
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
  // Indented code cannot interrupt a paragraph, even if its content resembles a block opener.
  if (interruptsParagraph && INDENTED_CODE_RE.test(raw)) return false;
  if (matchFenceOpening(raw)) return true;
  if (/^ {0,3}:{3,}[ \t]*[a-zA-Z]/.test(raw)) return true;
  if (DETAILS_OPEN_RE.test(raw.replace(/^ {0,3}/, ""))) return true;
  if (/^ {0,3}>/.test(raw)) return true;
  if (ATX_HEADING_START_RE.test(raw)) return true;
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
  const mathFence = /^ {0,3}\$\$[ \t]*$/.test(rawBody);
  if (state.fence) {
    if (state.fence === "$$" ? mathFence : closesFence(rawBody, state.fence)) state.fence = undefined;
    return;
  }
  state.fence = matchFenceOpening(rawBody)?.[1] ?? (mathFence ? "$$" : undefined);
  state.open = !startsSpecialLine(rawBody);
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

function isCompleteHtmlDisclosure(span: InlineConstructSpan, end: number): boolean {
  return span.summaryEndOffset !== undefined && span.closeStart !== undefined && span.closeStart < span.end && span.end <= end;
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
    if (text.charCodeAt(i) === 60 && asciiLower(text.slice(i, i + 8)) === "<details") {
      const m = DETAILS_OPEN_RE.exec(text.slice(i));
      if (m && inheritsHtmlBlock.opensHtmlDetailsAt(i, definedLinkLabels)) {
        const openEnd = i + m[0].length;
        const bounds = findMatchingDetailsBounds(text, i, openEnd, inheritsHtmlBlock, definedLinkLabels);
        const classified = classifyDetailsElement(text, i, openEnd, bounds, activeVisibility, definedLinkLabels, inheritsHtmlBlock);
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
  inheritedContext = DEFAULT_LABEL_CONTEXT,
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
    inheritedContext,
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
  inheritedContext = DEFAULT_LABEL_CONTEXT,
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
  const labelContextAt = createCueLabelContextLookup(lines.map((_, index) => readCueBody(index)!),
    definedLinkLabels, inheritedContext);
  const protectedUnderline = createProtectedSetextLookup(readCueBody, definedLinkLabels, labelContextAt);
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
        columns: getTableColumnVisibilities(header.body, cells, definedLinkLabels, 0,
          offset => labelContextAt(index, readCueBody(index)!.length - header.body.length + offset)),
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
  inheritedContext = DEFAULT_LABEL_CONTEXT,
): PedagogicalAstBlock[] {
  const parts: string[] = [];
  const regions: TranscriptRegion[] = [];
  const timedRows = new Set<number>();
  const boundaryFloorByProjectedOffset = new Map<number, PedagogicalVisibility>();
  const observeHeading = headingContext?.onHeading;
  const projectedLineOrigins = observeHeading && new Map<number, number>();
  const bodies = lines.map((line, index) => line.raw.slice(timings[index]?.prefixLength ?? 0));
  const cueSeparator = createTranscriptCueSeparator(bodies, definedLinkLabels, undefined, inheritedContext);
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
  } : headingContext, definedLinkLabels, inheritedContext));
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
  inheritedContext = DEFAULT_LABEL_CONTEXT,
): PedagogicalAstBlock[] {
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  let lines = splitLinesWithOffsets(text);
  const initialTimings = scanInlineCueTimings(lines, captionRowStarts, boundaryFloors, inheritedLinkLabels, inheritedContext);
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
    ? scanInlineCueTimings(lines, captionRowStarts, boundaryFloors, definedLinkLabels, inheritedContext)
    : initialTimings;
  if (timings.some(Boolean)) {
    return parseInlineCuedDocument(text, lines, timings, tableBreakVisibilities,
      options, sealProofs, definedLinkLabels, captionRowStarts, boundaryFloors, headingContext, inheritedContext);
  }
  const inheritsHtmlBlock = createMarkdownHtmlBlockLookup(text, inheritedContext);
  const htmlHeadings = inheritsHtmlBlock.htmlHeadings(definedLinkLabels).filter(heading => {
    if (heading.depth !== 0) return false;
    if (!heading.visibilityHidden) return true;
    const source = text.slice(heading.start, heading.end);
    const label = heading.rawHtml ? source : renderMarkdownLabelMarkup(source, true, definedLinkLabels);
    const { inline } = htmlLabelTextVariants(label, heading.context, undefined, heading.rawHtml);
    return inline.length > 0;
  });
  const htmlHeadingAt = new Map(htmlHeadings.map((heading, index) => {
    const end = Math.min(heading.end, htmlHeadings[index + 1]?.start ?? text.length);
    return [heading.start, { ...heading, end }] as const;
  }));
  const htmlHeadingSpans = [...htmlHeadingAt.values()];
  const htmlHeadingEnds = new Set(htmlHeadingSpans.map(heading => heading.end));
  if (htmlHeadingSpans.length) lines = splitLinesAtHtmlHeadings(text, lines, htmlHeadingSpans);
  const readMarkdownLine = (index: number) => {
    const line = lines[index];
    if (line && !htmlHeadingAt.has(line.start) && !htmlHeadingEnds.has(line.start) &&
      !inheritsHtmlBlock.isRawHtmlAt(line.start)) return line.raw;
  };
  const labelContextAt = (offset: number) => inheritsHtmlBlock.labelContextAt(offset, definedLinkLabels);
  const protectedCaptionUnderline = captionRowStarts && createProtectedSetextLookup(
    index => lines[index]?.raw, definedLinkLabels, index => labelContextAt(lines[index]?.start ?? 0),
  );
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
    summaryEnd?: number | null,
  ): MappedInnerBlock[] => {
    let slice = text.slice(start, end);
    const bodyStart = summaryEnd != null && start < summaryEnd && summaryEnd < end ? summaryEnd - start : undefined;
    if (bodyStart !== undefined) {
      // A disclosure body starts a pedagogical Markdown block after the summary.
      // Keep a single input so protected constructs can cross that boundary.
      slice = slice.slice(0, bodyStart) + "\n\n" + slice.slice(bodyStart);
    }
    const sourceOffset = (offset: number) =>
      start + offset - (bodyStart === undefined ? 0 : Math.min(2, Math.max(0, offset - bodyStart)));
    const rebasedCaptions = captionRowStarts && new Set<number>();
    const rebasedFloors = boundaryFloors && new Map<number, PedagogicalVisibility>();
    if (rebasedCaptions || rebasedFloors) {
      for (const line of splitLinesWithOffsets(slice)) {
        const offset = sourceOffset(line.start);
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
      labelContextAt(start),
    ).map(block => ({
      ...block,
      startOffset: sourceOffset(block.startOffset),
      endOffset: sourceOffset(block.endOffset),
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
        const innerBlocks = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind, span.summaryEndOffset);
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

    const inner = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind, span.summaryEndOffset);
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
        const inner = parseInnerSlice(span.openEnd, span.closeStart, span.visibility, span.kind, span.summaryEndOffset);
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
    const markdownLine = readMarkdownLine(i);
    const headingMatch = markdownLine === undefined ? null : ATX_HEADING_RE.exec(markdownLine);
    const htmlHeading = htmlHeadingAt.get(line.start);
    const setext = headingMatch || markdownLine === undefined ? null : readSetextParagraph(readMarkdownLine, i);
    const level = headingMatch?.[1]?.length ?? htmlHeading?.level ?? setext?.level;
    const boundaryFloor = boundaryFloors?.get(line.start) ??
      (tableHeadingFloor?.offset === line.start ? tableHeadingFloor.visibility : "public");
    if (level !== undefined) {
      const headingLastIndex = htmlHeading
        ? lineIndexContaining(lines, htmlHeading.end - 1, i)
        : setext?.index ?? i;
      const headingEnd = lines[headingLastIndex]!.contentEnd;
      const headingTextStart = headingMatch
        ? line.start + raw.indexOf(headingMatch[2]!, raw.indexOf(headingMatch[1]!) + level)
        : line.start;
      const headingTextEnd = headingMatch
        ? headingTextStart + headingMatch[2]!.length
        : htmlHeading ? headingEnd : lines[headingLastIndex - 1]!.contentEnd;
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
      // Render the visible part of a complete disclosure when classifying the
      // heading. Its source text is still extracted as a protected construct.
      const maskedLabelSpans = rawInlineSpans.filter(s => s.kind !== "display_math" && !isCompleteHtmlDisclosure(s, inlineEnd));
      const cleanHeadingTitle =
        maskedLabelSpans.length > 0
          ? sanitizeHeaderLabel(
              text,
              headingTextStart,
              headingTextEnd,
              maskedLabelSpans.map(s => ({ startOffset: s.start, endOffset: s.end })),
              "",
            )
          : headingText;
      const isSectionHeading = line.start > 0 || !headingContext?.firstHeadingIsLocal;
      if (isSectionHeading) headingContext?.onHeading?.(line.start, level);
      if (propagateSectionVisibility) {
        const titleVisibility = tableColumnVisibility(
          cleanHeadingTitle, definedLinkLabels, htmlHeading?.context ?? labelContextAt(headingTextStart),
          undefined, htmlHeading?.rawHtml,
        );
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

    const tableHeaderCells = markdownLine === undefined ? null : pipeTableHeaderCells(line, readMarkdownLine(i + 1));

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
    const trimmedRaw = raw.trimStart();
    const detailsOpenMatch = DETAILS_OPEN_RE.exec(trimmedRaw);
    const detailsStart = line.start + raw.length - trimmedRaw.length;
    if (detailsOpenMatch && inheritsHtmlBlock.opensHtmlDetailsAt(detailsStart, definedLinkLabels)) {
      const activeVis = blockVisibility;
      const openEndOffset = detailsStart + detailsOpenMatch[0].length;
      const bounds = findMatchingDetailsBounds(text, detailsStart, openEndOffset, inheritsHtmlBlock, definedLinkLabels);
      const { closeStart, closeEnd } = bounds;
      const classified = classifyDetailsElement(text, detailsStart, openEndOffset, bounds, activeVis, definedLinkLabels, inheritsHtmlBlock);
      const endLineIdx = lineIndexContaining(lines, Math.max(detailsStart, closeEnd - 1), i);
      const trailingOnCloseLine = text.slice(closeEnd, lines[endLineIdx]!.contentEnd);
      const hasTrailingContent = !/^[ \t]*$/.test(trailingOnCloseLine);
      const outerEnd = hasTrailingContent ? closeEnd : Math.max(closeEnd, lines[endLineIdx]!.contentEnd);

      if (classified.visibility !== "sealed" && closeStart > openEndOffset) {
        const innerBlocks = parseInnerSlice(openEndOffset, closeStart, classified.visibility, classified.kind, classified.summaryEndOffset);
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
            labelContextAt(line.start),
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
            labelContextAt(resetStart),
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
            labelContextAt(headerRestStart),
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

    const permitsMarkdownContainers = !htmlHeadingEnds.has(line.start) && inheritsHtmlBlock.rawHtmlDepthAt(line.start) !== 0;
    if (permitsMarkdownContainers && BLOCKQUOTE_PREFIX_RE.test(raw)) {
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
          labelContextAt(line.start),
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
    const listMatch = permitsMarkdownContainers ? LIST_ITEM_RE.exec(raw) : null;
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
        undefined,
        labelContextAt(line.start),
      );
      const end = lines[endLineIdx]!.contentEnd;
      emitContainerWithExtraction("prose", activeVis, false, line.start, end, end, undefined, false, innerBlocks);
      i = endLineIdx + 1;
      continue;
    }

    // 8. Markdown / pipe table (extracts inline sealed/hint constructs & sealed/hint columns)
    if (tableHeaderCells) {
      let j = i + 2;
      const columns = getTableColumnVisibilities(raw, tableHeaderCells, definedLinkLabels, line.start, labelContextAt);
      while (j < lines.length) {
        const row = lines[j]!;
        if (htmlHeadingAt.has(row.start) || inheritsHtmlBlock.isRawHtmlAt(row.start) || boundaryFloors?.has(row.start)) break;
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
      const headerDisclosures = inlineSpans.filter(span => isCompleteHtmlDisclosure(span, line.contentEnd) &&
        headerCells.some(cell => cell.start <= span.start && span.end <= cell.end));
      const maskedLabelBlocks = headerDisclosures.length === 0 ? extracted : extracted.filter(block =>
        !headerDisclosures.some(span => block.startOffset >= span.start && block.endOffset <= span.end));
      const colPolicies = headerCells.map(cell => {
        const cellText = sanitizeHeaderLabel(text, cell.start, cell.end, extracted, "");
        const renderedLabelSource = maskedLabelBlocks === extracted ? cellText :
          sanitizeHeaderLabel(text, cell.start, cell.end, maskedLabelBlocks, "");
        const visibility = tableColumnVisibility(renderedLabelSource, definedLinkLabels, labelContextAt(cell.start), "th");
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
      htmlHeadingAt.has(lines[index]!.start) || boundaryFloors?.has(lines[index]!.start) ||
      startsMarkdownBlock(lines[index]!.raw, lines[index + 1]?.raw);
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
      ...(input.itemFamilyId !== undefined ? { itemFamilyId: input.itemFamilyId } : {}),
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
          ...(cue.itemFamilyId !== undefined ? { itemFamilyId: cue.itemFamilyId } : {}),
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

// Named character references from https://html.spec.whatwg.org/entities.json.
const HTML_NAMED_REFERENCES = new Map(Object.entries({
  AElig: "\u{C6}", AMP: "\u{26}", Aacute: "\u{C1}", Abreve: "\u{102}", Acirc: "\u{C2}", Acy: "\u{410}",
  Afr: "\u{1D504}", Agrave: "\u{C0}", Alpha: "\u{391}", Amacr: "\u{100}", And: "\u{2A53}", Aogon: "\u{104}",
  Aopf: "\u{1D538}", ApplyFunction: "\u{2061}", Aring: "\u{C5}", Ascr: "\u{1D49C}", Assign: "\u{2254}",
  Atilde: "\u{C3}", Auml: "\u{C4}", Backslash: "\u{2216}", Barv: "\u{2AE7}", Barwed: "\u{2306}", Bcy: "\u{411}",
  Because: "\u{2235}", Bernoullis: "\u{212C}", Beta: "\u{392}", Bfr: "\u{1D505}", Bopf: "\u{1D539}",
  Breve: "\u{2D8}", Bscr: "\u{212C}", Bumpeq: "\u{224E}", CHcy: "\u{427}", COPY: "\u{A9}", Cacute: "\u{106}",
  Cap: "\u{22D2}", CapitalDifferentialD: "\u{2145}", Cayleys: "\u{212D}", Ccaron: "\u{10C}", Ccedil: "\u{C7}",
  Ccirc: "\u{108}", Cconint: "\u{2230}", Cdot: "\u{10A}", Cedilla: "\u{B8}", CenterDot: "\u{B7}", Cfr: "\u{212D}",
  Chi: "\u{3A7}", CircleDot: "\u{2299}", CircleMinus: "\u{2296}", CirclePlus: "\u{2295}", CircleTimes: "\u{2297}",
  ClockwiseContourIntegral: "\u{2232}", CloseCurlyDoubleQuote: "\u{201D}", CloseCurlyQuote: "\u{2019}",
  Colon: "\u{2237}", Colone: "\u{2A74}", Congruent: "\u{2261}", Conint: "\u{222F}", ContourIntegral: "\u{222E}",
  Copf: "\u{2102}", Coproduct: "\u{2210}", CounterClockwiseContourIntegral: "\u{2233}", Cross: "\u{2A2F}",
  Cscr: "\u{1D49E}", Cup: "\u{22D3}", CupCap: "\u{224D}", DD: "\u{2145}", DDotrahd: "\u{2911}", DJcy: "\u{402}",
  DScy: "\u{405}", DZcy: "\u{40F}", Dagger: "\u{2021}", Darr: "\u{21A1}", Dashv: "\u{2AE4}", Dcaron: "\u{10E}",
  Dcy: "\u{414}", Del: "\u{2207}", Delta: "\u{394}", Dfr: "\u{1D507}", DiacriticalAcute: "\u{B4}",
  DiacriticalDot: "\u{2D9}", DiacriticalDoubleAcute: "\u{2DD}", DiacriticalGrave: "\u{60}",
  DiacriticalTilde: "\u{2DC}", Diamond: "\u{22C4}", DifferentialD: "\u{2146}", Dopf: "\u{1D53B}", Dot: "\u{A8}",
  DotDot: "\u{20DC}", DotEqual: "\u{2250}", DoubleContourIntegral: "\u{222F}", DoubleDot: "\u{A8}",
  DoubleDownArrow: "\u{21D3}", DoubleLeftArrow: "\u{21D0}", DoubleLeftRightArrow: "\u{21D4}",
  DoubleLeftTee: "\u{2AE4}", DoubleLongLeftArrow: "\u{27F8}", DoubleLongLeftRightArrow: "\u{27FA}",
  DoubleLongRightArrow: "\u{27F9}", DoubleRightArrow: "\u{21D2}", DoubleRightTee: "\u{22A8}",
  DoubleUpArrow: "\u{21D1}", DoubleUpDownArrow: "\u{21D5}", DoubleVerticalBar: "\u{2225}", DownArrow: "\u{2193}",
  DownArrowBar: "\u{2913}", DownArrowUpArrow: "\u{21F5}", DownBreve: "\u{311}", DownLeftRightVector: "\u{2950}",
  DownLeftTeeVector: "\u{295E}", DownLeftVector: "\u{21BD}", DownLeftVectorBar: "\u{2956}",
  DownRightTeeVector: "\u{295F}", DownRightVector: "\u{21C1}", DownRightVectorBar: "\u{2957}", DownTee: "\u{22A4}",
  DownTeeArrow: "\u{21A7}", Downarrow: "\u{21D3}", Dscr: "\u{1D49F}", Dstrok: "\u{110}", ENG: "\u{14A}",
  ETH: "\u{D0}", Eacute: "\u{C9}", Ecaron: "\u{11A}", Ecirc: "\u{CA}", Ecy: "\u{42D}", Edot: "\u{116}",
  Efr: "\u{1D508}", Egrave: "\u{C8}", Element: "\u{2208}", Emacr: "\u{112}", EmptySmallSquare: "\u{25FB}",
  EmptyVerySmallSquare: "\u{25AB}", Eogon: "\u{118}", Eopf: "\u{1D53C}", Epsilon: "\u{395}", Equal: "\u{2A75}",
  EqualTilde: "\u{2242}", Equilibrium: "\u{21CC}", Escr: "\u{2130}", Esim: "\u{2A73}", Eta: "\u{397}",
  Euml: "\u{CB}", Exists: "\u{2203}", ExponentialE: "\u{2147}", Fcy: "\u{424}", Ffr: "\u{1D509}",
  FilledSmallSquare: "\u{25FC}", FilledVerySmallSquare: "\u{25AA}", Fopf: "\u{1D53D}", ForAll: "\u{2200}",
  Fouriertrf: "\u{2131}", Fscr: "\u{2131}", GJcy: "\u{403}", GT: "\u{3E}", Gamma: "\u{393}", Gammad: "\u{3DC}",
  Gbreve: "\u{11E}", Gcedil: "\u{122}", Gcirc: "\u{11C}", Gcy: "\u{413}", Gdot: "\u{120}", Gfr: "\u{1D50A}",
  Gg: "\u{22D9}", Gopf: "\u{1D53E}", GreaterEqual: "\u{2265}", GreaterEqualLess: "\u{22DB}",
  GreaterFullEqual: "\u{2267}", GreaterGreater: "\u{2AA2}", GreaterLess: "\u{2277}", GreaterSlantEqual: "\u{2A7E}",
  GreaterTilde: "\u{2273}", Gscr: "\u{1D4A2}", Gt: "\u{226B}", HARDcy: "\u{42A}", Hacek: "\u{2C7}", Hat: "\u{5E}",
  Hcirc: "\u{124}", Hfr: "\u{210C}", HilbertSpace: "\u{210B}", Hopf: "\u{210D}", HorizontalLine: "\u{2500}",
  Hscr: "\u{210B}", Hstrok: "\u{126}", HumpDownHump: "\u{224E}", HumpEqual: "\u{224F}", IEcy: "\u{415}",
  IJlig: "\u{132}", IOcy: "\u{401}", Iacute: "\u{CD}", Icirc: "\u{CE}", Icy: "\u{418}", Idot: "\u{130}",
  Ifr: "\u{2111}", Igrave: "\u{CC}", Im: "\u{2111}", Imacr: "\u{12A}", ImaginaryI: "\u{2148}", Implies: "\u{21D2}",
  Int: "\u{222C}", Integral: "\u{222B}", Intersection: "\u{22C2}", InvisibleComma: "\u{2063}",
  InvisibleTimes: "\u{2062}", Iogon: "\u{12E}", Iopf: "\u{1D540}", Iota: "\u{399}", Iscr: "\u{2110}",
  Itilde: "\u{128}", Iukcy: "\u{406}", Iuml: "\u{CF}", Jcirc: "\u{134}", Jcy: "\u{419}", Jfr: "\u{1D50D}",
  Jopf: "\u{1D541}", Jscr: "\u{1D4A5}", Jsercy: "\u{408}", Jukcy: "\u{404}", KHcy: "\u{425}", KJcy: "\u{40C}",
  Kappa: "\u{39A}", Kcedil: "\u{136}", Kcy: "\u{41A}", Kfr: "\u{1D50E}", Kopf: "\u{1D542}", Kscr: "\u{1D4A6}",
  LJcy: "\u{409}", LT: "\u{3C}", Lacute: "\u{139}", Lambda: "\u{39B}", Lang: "\u{27EA}", Laplacetrf: "\u{2112}",
  Larr: "\u{219E}", Lcaron: "\u{13D}", Lcedil: "\u{13B}", Lcy: "\u{41B}", LeftAngleBracket: "\u{27E8}",
  LeftArrow: "\u{2190}", LeftArrowBar: "\u{21E4}", LeftArrowRightArrow: "\u{21C6}", LeftCeiling: "\u{2308}",
  LeftDoubleBracket: "\u{27E6}", LeftDownTeeVector: "\u{2961}", LeftDownVector: "\u{21C3}",
  LeftDownVectorBar: "\u{2959}", LeftFloor: "\u{230A}", LeftRightArrow: "\u{2194}", LeftRightVector: "\u{294E}",
  LeftTee: "\u{22A3}", LeftTeeArrow: "\u{21A4}", LeftTeeVector: "\u{295A}", LeftTriangle: "\u{22B2}",
  LeftTriangleBar: "\u{29CF}", LeftTriangleEqual: "\u{22B4}", LeftUpDownVector: "\u{2951}",
  LeftUpTeeVector: "\u{2960}", LeftUpVector: "\u{21BF}", LeftUpVectorBar: "\u{2958}", LeftVector: "\u{21BC}",
  LeftVectorBar: "\u{2952}", Leftarrow: "\u{21D0}", Leftrightarrow: "\u{21D4}", LessEqualGreater: "\u{22DA}",
  LessFullEqual: "\u{2266}", LessGreater: "\u{2276}", LessLess: "\u{2AA1}", LessSlantEqual: "\u{2A7D}",
  LessTilde: "\u{2272}", Lfr: "\u{1D50F}", Ll: "\u{22D8}", Lleftarrow: "\u{21DA}", Lmidot: "\u{13F}",
  LongLeftArrow: "\u{27F5}", LongLeftRightArrow: "\u{27F7}", LongRightArrow: "\u{27F6}", Longleftarrow: "\u{27F8}",
  Longleftrightarrow: "\u{27FA}", Longrightarrow: "\u{27F9}", Lopf: "\u{1D543}", LowerLeftArrow: "\u{2199}",
  LowerRightArrow: "\u{2198}", Lscr: "\u{2112}", Lsh: "\u{21B0}", Lstrok: "\u{141}", Lt: "\u{226A}",
  Map: "\u{2905}", Mcy: "\u{41C}", MediumSpace: "\u{205F}", Mellintrf: "\u{2133}", Mfr: "\u{1D510}",
  MinusPlus: "\u{2213}", Mopf: "\u{1D544}", Mscr: "\u{2133}", Mu: "\u{39C}", NJcy: "\u{40A}", Nacute: "\u{143}",
  Ncaron: "\u{147}", Ncedil: "\u{145}", Ncy: "\u{41D}", NegativeMediumSpace: "\u{200B}",
  NegativeThickSpace: "\u{200B}", NegativeThinSpace: "\u{200B}", NegativeVeryThinSpace: "\u{200B}",
  NestedGreaterGreater: "\u{226B}", NestedLessLess: "\u{226A}", NewLine: "\u{A}", Nfr: "\u{1D511}",
  NoBreak: "\u{2060}", NonBreakingSpace: "\u{A0}", Nopf: "\u{2115}", Not: "\u{2AEC}", NotCongruent: "\u{2262}",
  NotCupCap: "\u{226D}", NotDoubleVerticalBar: "\u{2226}", NotElement: "\u{2209}", NotEqual: "\u{2260}",
  NotEqualTilde: "\u{2242}\u{338}", NotExists: "\u{2204}", NotGreater: "\u{226F}", NotGreaterEqual: "\u{2271}",
  NotGreaterFullEqual: "\u{2267}\u{338}", NotGreaterGreater: "\u{226B}\u{338}", NotGreaterLess: "\u{2279}",
  NotGreaterSlantEqual: "\u{2A7E}\u{338}", NotGreaterTilde: "\u{2275}", NotHumpDownHump: "\u{224E}\u{338}",
  NotHumpEqual: "\u{224F}\u{338}", NotLeftTriangle: "\u{22EA}", NotLeftTriangleBar: "\u{29CF}\u{338}",
  NotLeftTriangleEqual: "\u{22EC}", NotLess: "\u{226E}", NotLessEqual: "\u{2270}", NotLessGreater: "\u{2278}",
  NotLessLess: "\u{226A}\u{338}", NotLessSlantEqual: "\u{2A7D}\u{338}", NotLessTilde: "\u{2274}",
  NotNestedGreaterGreater: "\u{2AA2}\u{338}", NotNestedLessLess: "\u{2AA1}\u{338}", NotPrecedes: "\u{2280}",
  NotPrecedesEqual: "\u{2AAF}\u{338}", NotPrecedesSlantEqual: "\u{22E0}", NotReverseElement: "\u{220C}",
  NotRightTriangle: "\u{22EB}", NotRightTriangleBar: "\u{29D0}\u{338}", NotRightTriangleEqual: "\u{22ED}",
  NotSquareSubset: "\u{228F}\u{338}", NotSquareSubsetEqual: "\u{22E2}", NotSquareSuperset: "\u{2290}\u{338}",
  NotSquareSupersetEqual: "\u{22E3}", NotSubset: "\u{2282}\u{20D2}", NotSubsetEqual: "\u{2288}",
  NotSucceeds: "\u{2281}", NotSucceedsEqual: "\u{2AB0}\u{338}", NotSucceedsSlantEqual: "\u{22E1}",
  NotSucceedsTilde: "\u{227F}\u{338}", NotSuperset: "\u{2283}\u{20D2}", NotSupersetEqual: "\u{2289}",
  NotTilde: "\u{2241}", NotTildeEqual: "\u{2244}", NotTildeFullEqual: "\u{2247}", NotTildeTilde: "\u{2249}",
  NotVerticalBar: "\u{2224}", Nscr: "\u{1D4A9}", Ntilde: "\u{D1}", Nu: "\u{39D}", OElig: "\u{152}",
  Oacute: "\u{D3}", Ocirc: "\u{D4}", Ocy: "\u{41E}", Odblac: "\u{150}", Ofr: "\u{1D512}", Ograve: "\u{D2}",
  Omacr: "\u{14C}", Omega: "\u{3A9}", Omicron: "\u{39F}", Oopf: "\u{1D546}", OpenCurlyDoubleQuote: "\u{201C}",
  OpenCurlyQuote: "\u{2018}", Or: "\u{2A54}", Oscr: "\u{1D4AA}", Oslash: "\u{D8}", Otilde: "\u{D5}",
  Otimes: "\u{2A37}", Ouml: "\u{D6}", OverBar: "\u{203E}", OverBrace: "\u{23DE}", OverBracket: "\u{23B4}",
  OverParenthesis: "\u{23DC}", PartialD: "\u{2202}", Pcy: "\u{41F}", Pfr: "\u{1D513}", Phi: "\u{3A6}",
  Pi: "\u{3A0}", PlusMinus: "\u{B1}", Poincareplane: "\u{210C}", Popf: "\u{2119}", Pr: "\u{2ABB}",
  Precedes: "\u{227A}", PrecedesEqual: "\u{2AAF}", PrecedesSlantEqual: "\u{227C}", PrecedesTilde: "\u{227E}",
  Prime: "\u{2033}", Product: "\u{220F}", Proportion: "\u{2237}", Proportional: "\u{221D}", Pscr: "\u{1D4AB}",
  Psi: "\u{3A8}", QUOT: "\u{22}", Qfr: "\u{1D514}", Qopf: "\u{211A}", Qscr: "\u{1D4AC}", RBarr: "\u{2910}",
  REG: "\u{AE}", Racute: "\u{154}", Rang: "\u{27EB}", Rarr: "\u{21A0}", Rarrtl: "\u{2916}", Rcaron: "\u{158}",
  Rcedil: "\u{156}", Rcy: "\u{420}", Re: "\u{211C}", ReverseElement: "\u{220B}", ReverseEquilibrium: "\u{21CB}",
  ReverseUpEquilibrium: "\u{296F}", Rfr: "\u{211C}", Rho: "\u{3A1}", RightAngleBracket: "\u{27E9}",
  RightArrow: "\u{2192}", RightArrowBar: "\u{21E5}", RightArrowLeftArrow: "\u{21C4}", RightCeiling: "\u{2309}",
  RightDoubleBracket: "\u{27E7}", RightDownTeeVector: "\u{295D}", RightDownVector: "\u{21C2}",
  RightDownVectorBar: "\u{2955}", RightFloor: "\u{230B}", RightTee: "\u{22A2}", RightTeeArrow: "\u{21A6}",
  RightTeeVector: "\u{295B}", RightTriangle: "\u{22B3}", RightTriangleBar: "\u{29D0}",
  RightTriangleEqual: "\u{22B5}", RightUpDownVector: "\u{294F}", RightUpTeeVector: "\u{295C}",
  RightUpVector: "\u{21BE}", RightUpVectorBar: "\u{2954}", RightVector: "\u{21C0}", RightVectorBar: "\u{2953}",
  Rightarrow: "\u{21D2}", Ropf: "\u{211D}", RoundImplies: "\u{2970}", Rrightarrow: "\u{21DB}", Rscr: "\u{211B}",
  Rsh: "\u{21B1}", RuleDelayed: "\u{29F4}", SHCHcy: "\u{429}", SHcy: "\u{428}", SOFTcy: "\u{42C}",
  Sacute: "\u{15A}", Sc: "\u{2ABC}", Scaron: "\u{160}", Scedil: "\u{15E}", Scirc: "\u{15C}", Scy: "\u{421}",
  Sfr: "\u{1D516}", ShortDownArrow: "\u{2193}", ShortLeftArrow: "\u{2190}", ShortRightArrow: "\u{2192}",
  ShortUpArrow: "\u{2191}", Sigma: "\u{3A3}", SmallCircle: "\u{2218}", Sopf: "\u{1D54A}", Sqrt: "\u{221A}",
  Square: "\u{25A1}", SquareIntersection: "\u{2293}", SquareSubset: "\u{228F}", SquareSubsetEqual: "\u{2291}",
  SquareSuperset: "\u{2290}", SquareSupersetEqual: "\u{2292}", SquareUnion: "\u{2294}", Sscr: "\u{1D4AE}",
  Star: "\u{22C6}", Sub: "\u{22D0}", Subset: "\u{22D0}", SubsetEqual: "\u{2286}", Succeeds: "\u{227B}",
  SucceedsEqual: "\u{2AB0}", SucceedsSlantEqual: "\u{227D}", SucceedsTilde: "\u{227F}", SuchThat: "\u{220B}",
  Sum: "\u{2211}", Sup: "\u{22D1}", Superset: "\u{2283}", SupersetEqual: "\u{2287}", Supset: "\u{22D1}",
  THORN: "\u{DE}", TRADE: "\u{2122}", TSHcy: "\u{40B}", TScy: "\u{426}", Tab: "\u{9}", Tau: "\u{3A4}",
  Tcaron: "\u{164}", Tcedil: "\u{162}", Tcy: "\u{422}", Tfr: "\u{1D517}", Therefore: "\u{2234}", Theta: "\u{398}",
  ThickSpace: "\u{205F}\u{200A}", ThinSpace: "\u{2009}", Tilde: "\u{223C}", TildeEqual: "\u{2243}",
  TildeFullEqual: "\u{2245}", TildeTilde: "\u{2248}", Topf: "\u{1D54B}", TripleDot: "\u{20DB}", Tscr: "\u{1D4AF}",
  Tstrok: "\u{166}", Uacute: "\u{DA}", Uarr: "\u{219F}", Uarrocir: "\u{2949}", Ubrcy: "\u{40E}", Ubreve: "\u{16C}",
  Ucirc: "\u{DB}", Ucy: "\u{423}", Udblac: "\u{170}", Ufr: "\u{1D518}", Ugrave: "\u{D9}", Umacr: "\u{16A}",
  UnderBar: "\u{5F}", UnderBrace: "\u{23DF}", UnderBracket: "\u{23B5}", UnderParenthesis: "\u{23DD}",
  Union: "\u{22C3}", UnionPlus: "\u{228E}", Uogon: "\u{172}", Uopf: "\u{1D54C}", UpArrow: "\u{2191}",
  UpArrowBar: "\u{2912}", UpArrowDownArrow: "\u{21C5}", UpDownArrow: "\u{2195}", UpEquilibrium: "\u{296E}",
  UpTee: "\u{22A5}", UpTeeArrow: "\u{21A5}", Uparrow: "\u{21D1}", Updownarrow: "\u{21D5}",
  UpperLeftArrow: "\u{2196}", UpperRightArrow: "\u{2197}", Upsi: "\u{3D2}", Upsilon: "\u{3A5}", Uring: "\u{16E}",
  Uscr: "\u{1D4B0}", Utilde: "\u{168}", Uuml: "\u{DC}", VDash: "\u{22AB}", Vbar: "\u{2AEB}", Vcy: "\u{412}",
  Vdash: "\u{22A9}", Vdashl: "\u{2AE6}", Vee: "\u{22C1}", Verbar: "\u{2016}", Vert: "\u{2016}",
  VerticalBar: "\u{2223}", VerticalLine: "\u{7C}", VerticalSeparator: "\u{2758}", VerticalTilde: "\u{2240}",
  VeryThinSpace: "\u{200A}", Vfr: "\u{1D519}", Vopf: "\u{1D54D}", Vscr: "\u{1D4B1}", Vvdash: "\u{22AA}",
  Wcirc: "\u{174}", Wedge: "\u{22C0}", Wfr: "\u{1D51A}", Wopf: "\u{1D54E}", Wscr: "\u{1D4B2}", Xfr: "\u{1D51B}",
  Xi: "\u{39E}", Xopf: "\u{1D54F}", Xscr: "\u{1D4B3}", YAcy: "\u{42F}", YIcy: "\u{407}", YUcy: "\u{42E}",
  Yacute: "\u{DD}", Ycirc: "\u{176}", Ycy: "\u{42B}", Yfr: "\u{1D51C}", Yopf: "\u{1D550}", Yscr: "\u{1D4B4}",
  Yuml: "\u{178}", ZHcy: "\u{416}", Zacute: "\u{179}", Zcaron: "\u{17D}", Zcy: "\u{417}", Zdot: "\u{17B}",
  ZeroWidthSpace: "\u{200B}", Zeta: "\u{396}", Zfr: "\u{2128}", Zopf: "\u{2124}", Zscr: "\u{1D4B5}",
  aacute: "\u{E1}", abreve: "\u{103}", ac: "\u{223E}", acE: "\u{223E}\u{333}", acd: "\u{223F}", acirc: "\u{E2}",
  acute: "\u{B4}", acy: "\u{430}", aelig: "\u{E6}", af: "\u{2061}", afr: "\u{1D51E}", agrave: "\u{E0}",
  alefsym: "\u{2135}", aleph: "\u{2135}", alpha: "\u{3B1}", amacr: "\u{101}", amalg: "\u{2A3F}", amp: "\u{26}",
  and: "\u{2227}", andand: "\u{2A55}", andd: "\u{2A5C}", andslope: "\u{2A58}", andv: "\u{2A5A}", ang: "\u{2220}",
  ange: "\u{29A4}", angle: "\u{2220}", angmsd: "\u{2221}", angmsdaa: "\u{29A8}", angmsdab: "\u{29A9}",
  angmsdac: "\u{29AA}", angmsdad: "\u{29AB}", angmsdae: "\u{29AC}", angmsdaf: "\u{29AD}", angmsdag: "\u{29AE}",
  angmsdah: "\u{29AF}", angrt: "\u{221F}", angrtvb: "\u{22BE}", angrtvbd: "\u{299D}", angsph: "\u{2222}",
  angst: "\u{C5}", angzarr: "\u{237C}", aogon: "\u{105}", aopf: "\u{1D552}", ap: "\u{2248}", apE: "\u{2A70}",
  apacir: "\u{2A6F}", ape: "\u{224A}", apid: "\u{224B}", apos: "\u{27}", approx: "\u{2248}", approxeq: "\u{224A}",
  aring: "\u{E5}", ascr: "\u{1D4B6}", ast: "\u{2A}", asymp: "\u{2248}", asympeq: "\u{224D}", atilde: "\u{E3}",
  auml: "\u{E4}", awconint: "\u{2233}", awint: "\u{2A11}", bNot: "\u{2AED}", backcong: "\u{224C}",
  backepsilon: "\u{3F6}", backprime: "\u{2035}", backsim: "\u{223D}", backsimeq: "\u{22CD}", barvee: "\u{22BD}",
  barwed: "\u{2305}", barwedge: "\u{2305}", bbrk: "\u{23B5}", bbrktbrk: "\u{23B6}", bcong: "\u{224C}",
  bcy: "\u{431}", bdquo: "\u{201E}", becaus: "\u{2235}", because: "\u{2235}", bemptyv: "\u{29B0}",
  bepsi: "\u{3F6}", bernou: "\u{212C}", beta: "\u{3B2}", beth: "\u{2136}", between: "\u{226C}", bfr: "\u{1D51F}",
  bigcap: "\u{22C2}", bigcirc: "\u{25EF}", bigcup: "\u{22C3}", bigodot: "\u{2A00}", bigoplus: "\u{2A01}",
  bigotimes: "\u{2A02}", bigsqcup: "\u{2A06}", bigstar: "\u{2605}", bigtriangledown: "\u{25BD}",
  bigtriangleup: "\u{25B3}", biguplus: "\u{2A04}", bigvee: "\u{22C1}", bigwedge: "\u{22C0}", bkarow: "\u{290D}",
  blacklozenge: "\u{29EB}", blacksquare: "\u{25AA}", blacktriangle: "\u{25B4}", blacktriangledown: "\u{25BE}",
  blacktriangleleft: "\u{25C2}", blacktriangleright: "\u{25B8}", blank: "\u{2423}", blk12: "\u{2592}",
  blk14: "\u{2591}", blk34: "\u{2593}", block: "\u{2588}", bne: "\u{3D}\u{20E5}", bnequiv: "\u{2261}\u{20E5}",
  bnot: "\u{2310}", bopf: "\u{1D553}", bot: "\u{22A5}", bottom: "\u{22A5}", bowtie: "\u{22C8}", boxDL: "\u{2557}",
  boxDR: "\u{2554}", boxDl: "\u{2556}", boxDr: "\u{2553}", boxH: "\u{2550}", boxHD: "\u{2566}", boxHU: "\u{2569}",
  boxHd: "\u{2564}", boxHu: "\u{2567}", boxUL: "\u{255D}", boxUR: "\u{255A}", boxUl: "\u{255C}", boxUr: "\u{2559}",
  boxV: "\u{2551}", boxVH: "\u{256C}", boxVL: "\u{2563}", boxVR: "\u{2560}", boxVh: "\u{256B}", boxVl: "\u{2562}",
  boxVr: "\u{255F}", boxbox: "\u{29C9}", boxdL: "\u{2555}", boxdR: "\u{2552}", boxdl: "\u{2510}",
  boxdr: "\u{250C}", boxh: "\u{2500}", boxhD: "\u{2565}", boxhU: "\u{2568}", boxhd: "\u{252C}", boxhu: "\u{2534}",
  boxminus: "\u{229F}", boxplus: "\u{229E}", boxtimes: "\u{22A0}", boxuL: "\u{255B}", boxuR: "\u{2558}",
  boxul: "\u{2518}", boxur: "\u{2514}", boxv: "\u{2502}", boxvH: "\u{256A}", boxvL: "\u{2561}", boxvR: "\u{255E}",
  boxvh: "\u{253C}", boxvl: "\u{2524}", boxvr: "\u{251C}", bprime: "\u{2035}", breve: "\u{2D8}", brvbar: "\u{A6}",
  bscr: "\u{1D4B7}", bsemi: "\u{204F}", bsim: "\u{223D}", bsime: "\u{22CD}", bsol: "\u{5C}", bsolb: "\u{29C5}",
  bsolhsub: "\u{27C8}", bull: "\u{2022}", bullet: "\u{2022}", bump: "\u{224E}", bumpE: "\u{2AAE}",
  bumpe: "\u{224F}", bumpeq: "\u{224F}", cacute: "\u{107}", cap: "\u{2229}", capand: "\u{2A44}",
  capbrcup: "\u{2A49}", capcap: "\u{2A4B}", capcup: "\u{2A47}", capdot: "\u{2A40}", caps: "\u{2229}\u{FE00}",
  caret: "\u{2041}", caron: "\u{2C7}", ccaps: "\u{2A4D}", ccaron: "\u{10D}", ccedil: "\u{E7}", ccirc: "\u{109}",
  ccups: "\u{2A4C}", ccupssm: "\u{2A50}", cdot: "\u{10B}", cedil: "\u{B8}", cemptyv: "\u{29B2}", cent: "\u{A2}",
  centerdot: "\u{B7}", cfr: "\u{1D520}", chcy: "\u{447}", check: "\u{2713}", checkmark: "\u{2713}", chi: "\u{3C7}",
  cir: "\u{25CB}", cirE: "\u{29C3}", circ: "\u{2C6}", circeq: "\u{2257}", circlearrowleft: "\u{21BA}",
  circlearrowright: "\u{21BB}", circledR: "\u{AE}", circledS: "\u{24C8}", circledast: "\u{229B}",
  circledcirc: "\u{229A}", circleddash: "\u{229D}", cire: "\u{2257}", cirfnint: "\u{2A10}", cirmid: "\u{2AEF}",
  cirscir: "\u{29C2}", clubs: "\u{2663}", clubsuit: "\u{2663}", colon: "\u{3A}", colone: "\u{2254}",
  coloneq: "\u{2254}", comma: "\u{2C}", commat: "\u{40}", comp: "\u{2201}", compfn: "\u{2218}",
  complement: "\u{2201}", complexes: "\u{2102}", cong: "\u{2245}", congdot: "\u{2A6D}", conint: "\u{222E}",
  copf: "\u{1D554}", coprod: "\u{2210}", copy: "\u{A9}", copysr: "\u{2117}", crarr: "\u{21B5}", cross: "\u{2717}",
  cscr: "\u{1D4B8}", csub: "\u{2ACF}", csube: "\u{2AD1}", csup: "\u{2AD0}", csupe: "\u{2AD2}", ctdot: "\u{22EF}",
  cudarrl: "\u{2938}", cudarrr: "\u{2935}", cuepr: "\u{22DE}", cuesc: "\u{22DF}", cularr: "\u{21B6}",
  cularrp: "\u{293D}", cup: "\u{222A}", cupbrcap: "\u{2A48}", cupcap: "\u{2A46}", cupcup: "\u{2A4A}",
  cupdot: "\u{228D}", cupor: "\u{2A45}", cups: "\u{222A}\u{FE00}", curarr: "\u{21B7}", curarrm: "\u{293C}",
  curlyeqprec: "\u{22DE}", curlyeqsucc: "\u{22DF}", curlyvee: "\u{22CE}", curlywedge: "\u{22CF}", curren: "\u{A4}",
  curvearrowleft: "\u{21B6}", curvearrowright: "\u{21B7}", cuvee: "\u{22CE}", cuwed: "\u{22CF}",
  cwconint: "\u{2232}", cwint: "\u{2231}", cylcty: "\u{232D}", dArr: "\u{21D3}", dHar: "\u{2965}",
  dagger: "\u{2020}", daleth: "\u{2138}", darr: "\u{2193}", dash: "\u{2010}", dashv: "\u{22A3}",
  dbkarow: "\u{290F}", dblac: "\u{2DD}", dcaron: "\u{10F}", dcy: "\u{434}", dd: "\u{2146}", ddagger: "\u{2021}",
  ddarr: "\u{21CA}", ddotseq: "\u{2A77}", deg: "\u{B0}", delta: "\u{3B4}", demptyv: "\u{29B1}", dfisht: "\u{297F}",
  dfr: "\u{1D521}", dharl: "\u{21C3}", dharr: "\u{21C2}", diam: "\u{22C4}", diamond: "\u{22C4}",
  diamondsuit: "\u{2666}", diams: "\u{2666}", die: "\u{A8}", digamma: "\u{3DD}", disin: "\u{22F2}", div: "\u{F7}",
  divide: "\u{F7}", divideontimes: "\u{22C7}", divonx: "\u{22C7}", djcy: "\u{452}", dlcorn: "\u{231E}",
  dlcrop: "\u{230D}", dollar: "\u{24}", dopf: "\u{1D555}", dot: "\u{2D9}", doteq: "\u{2250}", doteqdot: "\u{2251}",
  dotminus: "\u{2238}", dotplus: "\u{2214}", dotsquare: "\u{22A1}", doublebarwedge: "\u{2306}",
  downarrow: "\u{2193}", downdownarrows: "\u{21CA}", downharpoonleft: "\u{21C3}", downharpoonright: "\u{21C2}",
  drbkarow: "\u{2910}", drcorn: "\u{231F}", drcrop: "\u{230C}", dscr: "\u{1D4B9}", dscy: "\u{455}",
  dsol: "\u{29F6}", dstrok: "\u{111}", dtdot: "\u{22F1}", dtri: "\u{25BF}", dtrif: "\u{25BE}", duarr: "\u{21F5}",
  duhar: "\u{296F}", dwangle: "\u{29A6}", dzcy: "\u{45F}", dzigrarr: "\u{27FF}", eDDot: "\u{2A77}",
  eDot: "\u{2251}", eacute: "\u{E9}", easter: "\u{2A6E}", ecaron: "\u{11B}", ecir: "\u{2256}", ecirc: "\u{EA}",
  ecolon: "\u{2255}", ecy: "\u{44D}", edot: "\u{117}", ee: "\u{2147}", efDot: "\u{2252}", efr: "\u{1D522}",
  eg: "\u{2A9A}", egrave: "\u{E8}", egs: "\u{2A96}", egsdot: "\u{2A98}", el: "\u{2A99}", elinters: "\u{23E7}",
  ell: "\u{2113}", els: "\u{2A95}", elsdot: "\u{2A97}", emacr: "\u{113}", empty: "\u{2205}", emptyset: "\u{2205}",
  emptyv: "\u{2205}", emsp13: "\u{2004}", emsp14: "\u{2005}", emsp: "\u{2003}", eng: "\u{14B}", ensp: "\u{2002}",
  eogon: "\u{119}", eopf: "\u{1D556}", epar: "\u{22D5}", eparsl: "\u{29E3}", eplus: "\u{2A71}", epsi: "\u{3B5}",
  epsilon: "\u{3B5}", epsiv: "\u{3F5}", eqcirc: "\u{2256}", eqcolon: "\u{2255}", eqsim: "\u{2242}",
  eqslantgtr: "\u{2A96}", eqslantless: "\u{2A95}", equals: "\u{3D}", equest: "\u{225F}", equiv: "\u{2261}",
  equivDD: "\u{2A78}", eqvparsl: "\u{29E5}", erDot: "\u{2253}", erarr: "\u{2971}", escr: "\u{212F}",
  esdot: "\u{2250}", esim: "\u{2242}", eta: "\u{3B7}", eth: "\u{F0}", euml: "\u{EB}", euro: "\u{20AC}",
  excl: "\u{21}", exist: "\u{2203}", expectation: "\u{2130}", exponentiale: "\u{2147}", fallingdotseq: "\u{2252}",
  fcy: "\u{444}", female: "\u{2640}", ffilig: "\u{FB03}", fflig: "\u{FB00}", ffllig: "\u{FB04}", ffr: "\u{1D523}",
  filig: "\u{FB01}", fjlig: "\u{66}\u{6A}", flat: "\u{266D}", fllig: "\u{FB02}", fltns: "\u{25B1}",
  fnof: "\u{192}", fopf: "\u{1D557}", forall: "\u{2200}", fork: "\u{22D4}", forkv: "\u{2AD9}",
  fpartint: "\u{2A0D}", frac12: "\u{BD}", frac13: "\u{2153}", frac14: "\u{BC}", frac15: "\u{2155}",
  frac16: "\u{2159}", frac18: "\u{215B}", frac23: "\u{2154}", frac25: "\u{2156}", frac34: "\u{BE}",
  frac35: "\u{2157}", frac38: "\u{215C}", frac45: "\u{2158}", frac56: "\u{215A}", frac58: "\u{215D}",
  frac78: "\u{215E}", frasl: "\u{2044}", frown: "\u{2322}", fscr: "\u{1D4BB}", gE: "\u{2267}", gEl: "\u{2A8C}",
  gacute: "\u{1F5}", gamma: "\u{3B3}", gammad: "\u{3DD}", gap: "\u{2A86}", gbreve: "\u{11F}", gcirc: "\u{11D}",
  gcy: "\u{433}", gdot: "\u{121}", ge: "\u{2265}", gel: "\u{22DB}", geq: "\u{2265}", geqq: "\u{2267}",
  geqslant: "\u{2A7E}", ges: "\u{2A7E}", gescc: "\u{2AA9}", gesdot: "\u{2A80}", gesdoto: "\u{2A82}",
  gesdotol: "\u{2A84}", gesl: "\u{22DB}\u{FE00}", gesles: "\u{2A94}", gfr: "\u{1D524}", gg: "\u{226B}",
  ggg: "\u{22D9}", gimel: "\u{2137}", gjcy: "\u{453}", gl: "\u{2277}", glE: "\u{2A92}", gla: "\u{2AA5}",
  glj: "\u{2AA4}", gnE: "\u{2269}", gnap: "\u{2A8A}", gnapprox: "\u{2A8A}", gne: "\u{2A88}", gneq: "\u{2A88}",
  gneqq: "\u{2269}", gnsim: "\u{22E7}", gopf: "\u{1D558}", grave: "\u{60}", gscr: "\u{210A}", gsim: "\u{2273}",
  gsime: "\u{2A8E}", gsiml: "\u{2A90}", gt: "\u{3E}", gtcc: "\u{2AA7}", gtcir: "\u{2A7A}", gtdot: "\u{22D7}",
  gtlPar: "\u{2995}", gtquest: "\u{2A7C}", gtrapprox: "\u{2A86}", gtrarr: "\u{2978}", gtrdot: "\u{22D7}",
  gtreqless: "\u{22DB}", gtreqqless: "\u{2A8C}", gtrless: "\u{2277}", gtrsim: "\u{2273}",
  gvertneqq: "\u{2269}\u{FE00}", gvnE: "\u{2269}\u{FE00}", hArr: "\u{21D4}", hairsp: "\u{200A}", half: "\u{BD}",
  hamilt: "\u{210B}", hardcy: "\u{44A}", harr: "\u{2194}", harrcir: "\u{2948}", harrw: "\u{21AD}",
  hbar: "\u{210F}", hcirc: "\u{125}", hearts: "\u{2665}", heartsuit: "\u{2665}", hellip: "\u{2026}",
  hercon: "\u{22B9}", hfr: "\u{1D525}", hksearow: "\u{2925}", hkswarow: "\u{2926}", hoarr: "\u{21FF}",
  homtht: "\u{223B}", hookleftarrow: "\u{21A9}", hookrightarrow: "\u{21AA}", hopf: "\u{1D559}", horbar: "\u{2015}",
  hscr: "\u{1D4BD}", hslash: "\u{210F}", hstrok: "\u{127}", hybull: "\u{2043}", hyphen: "\u{2010}",
  iacute: "\u{ED}", ic: "\u{2063}", icirc: "\u{EE}", icy: "\u{438}", iecy: "\u{435}", iexcl: "\u{A1}",
  iff: "\u{21D4}", ifr: "\u{1D526}", igrave: "\u{EC}", ii: "\u{2148}", iiiint: "\u{2A0C}", iiint: "\u{222D}",
  iinfin: "\u{29DC}", iiota: "\u{2129}", ijlig: "\u{133}", imacr: "\u{12B}", image: "\u{2111}",
  imagline: "\u{2110}", imagpart: "\u{2111}", imath: "\u{131}", imof: "\u{22B7}", imped: "\u{1B5}", in: "\u{2208}",
  incare: "\u{2105}", infin: "\u{221E}", infintie: "\u{29DD}", inodot: "\u{131}", int: "\u{222B}",
  intcal: "\u{22BA}", integers: "\u{2124}", intercal: "\u{22BA}", intlarhk: "\u{2A17}", intprod: "\u{2A3C}",
  iocy: "\u{451}", iogon: "\u{12F}", iopf: "\u{1D55A}", iota: "\u{3B9}", iprod: "\u{2A3C}", iquest: "\u{BF}",
  iscr: "\u{1D4BE}", isin: "\u{2208}", isinE: "\u{22F9}", isindot: "\u{22F5}", isins: "\u{22F4}",
  isinsv: "\u{22F3}", isinv: "\u{2208}", it: "\u{2062}", itilde: "\u{129}", iukcy: "\u{456}", iuml: "\u{EF}",
  jcirc: "\u{135}", jcy: "\u{439}", jfr: "\u{1D527}", jmath: "\u{237}", jopf: "\u{1D55B}", jscr: "\u{1D4BF}",
  jsercy: "\u{458}", jukcy: "\u{454}", kappa: "\u{3BA}", kappav: "\u{3F0}", kcedil: "\u{137}", kcy: "\u{43A}",
  kfr: "\u{1D528}", kgreen: "\u{138}", khcy: "\u{445}", kjcy: "\u{45C}", kopf: "\u{1D55C}", kscr: "\u{1D4C0}",
  lAarr: "\u{21DA}", lArr: "\u{21D0}", lAtail: "\u{291B}", lBarr: "\u{290E}", lE: "\u{2266}", lEg: "\u{2A8B}",
  lHar: "\u{2962}", lacute: "\u{13A}", laemptyv: "\u{29B4}", lagran: "\u{2112}", lambda: "\u{3BB}",
  lang: "\u{27E8}", langd: "\u{2991}", langle: "\u{27E8}", lap: "\u{2A85}", laquo: "\u{AB}", larr: "\u{2190}",
  larrb: "\u{21E4}", larrbfs: "\u{291F}", larrfs: "\u{291D}", larrhk: "\u{21A9}", larrlp: "\u{21AB}",
  larrpl: "\u{2939}", larrsim: "\u{2973}", larrtl: "\u{21A2}", lat: "\u{2AAB}", latail: "\u{2919}",
  late: "\u{2AAD}", lates: "\u{2AAD}\u{FE00}", lbarr: "\u{290C}", lbbrk: "\u{2772}", lbrace: "\u{7B}",
  lbrack: "\u{5B}", lbrke: "\u{298B}", lbrksld: "\u{298F}", lbrkslu: "\u{298D}", lcaron: "\u{13E}",
  lcedil: "\u{13C}", lceil: "\u{2308}", lcub: "\u{7B}", lcy: "\u{43B}", ldca: "\u{2936}", ldquo: "\u{201C}",
  ldquor: "\u{201E}", ldrdhar: "\u{2967}", ldrushar: "\u{294B}", ldsh: "\u{21B2}", le: "\u{2264}",
  leftarrow: "\u{2190}", leftarrowtail: "\u{21A2}", leftharpoondown: "\u{21BD}", leftharpoonup: "\u{21BC}",
  leftleftarrows: "\u{21C7}", leftrightarrow: "\u{2194}", leftrightarrows: "\u{21C6}",
  leftrightharpoons: "\u{21CB}", leftrightsquigarrow: "\u{21AD}", leftthreetimes: "\u{22CB}", leg: "\u{22DA}",
  leq: "\u{2264}", leqq: "\u{2266}", leqslant: "\u{2A7D}", les: "\u{2A7D}", lescc: "\u{2AA8}", lesdot: "\u{2A7F}",
  lesdoto: "\u{2A81}", lesdotor: "\u{2A83}", lesg: "\u{22DA}\u{FE00}", lesges: "\u{2A93}", lessapprox: "\u{2A85}",
  lessdot: "\u{22D6}", lesseqgtr: "\u{22DA}", lesseqqgtr: "\u{2A8B}", lessgtr: "\u{2276}", lesssim: "\u{2272}",
  lfisht: "\u{297C}", lfloor: "\u{230A}", lfr: "\u{1D529}", lg: "\u{2276}", lgE: "\u{2A91}", lhard: "\u{21BD}",
  lharu: "\u{21BC}", lharul: "\u{296A}", lhblk: "\u{2584}", ljcy: "\u{459}", ll: "\u{226A}", llarr: "\u{21C7}",
  llcorner: "\u{231E}", llhard: "\u{296B}", lltri: "\u{25FA}", lmidot: "\u{140}", lmoust: "\u{23B0}",
  lmoustache: "\u{23B0}", lnE: "\u{2268}", lnap: "\u{2A89}", lnapprox: "\u{2A89}", lne: "\u{2A87}",
  lneq: "\u{2A87}", lneqq: "\u{2268}", lnsim: "\u{22E6}", loang: "\u{27EC}", loarr: "\u{21FD}", lobrk: "\u{27E6}",
  longleftarrow: "\u{27F5}", longleftrightarrow: "\u{27F7}", longmapsto: "\u{27FC}", longrightarrow: "\u{27F6}",
  looparrowleft: "\u{21AB}", looparrowright: "\u{21AC}", lopar: "\u{2985}", lopf: "\u{1D55D}", loplus: "\u{2A2D}",
  lotimes: "\u{2A34}", lowast: "\u{2217}", lowbar: "\u{5F}", loz: "\u{25CA}", lozenge: "\u{25CA}",
  lozf: "\u{29EB}", lpar: "\u{28}", lparlt: "\u{2993}", lrarr: "\u{21C6}", lrcorner: "\u{231F}", lrhar: "\u{21CB}",
  lrhard: "\u{296D}", lrm: "\u{200E}", lrtri: "\u{22BF}", lsaquo: "\u{2039}", lscr: "\u{1D4C1}", lsh: "\u{21B0}",
  lsim: "\u{2272}", lsime: "\u{2A8D}", lsimg: "\u{2A8F}", lsqb: "\u{5B}", lsquo: "\u{2018}", lsquor: "\u{201A}",
  lstrok: "\u{142}", lt: "\u{3C}", ltcc: "\u{2AA6}", ltcir: "\u{2A79}", ltdot: "\u{22D6}", lthree: "\u{22CB}",
  ltimes: "\u{22C9}", ltlarr: "\u{2976}", ltquest: "\u{2A7B}", ltrPar: "\u{2996}", ltri: "\u{25C3}",
  ltrie: "\u{22B4}", ltrif: "\u{25C2}", lurdshar: "\u{294A}", luruhar: "\u{2966}", lvertneqq: "\u{2268}\u{FE00}",
  lvnE: "\u{2268}\u{FE00}", mDDot: "\u{223A}", macr: "\u{AF}", male: "\u{2642}", malt: "\u{2720}",
  maltese: "\u{2720}", map: "\u{21A6}", mapsto: "\u{21A6}", mapstodown: "\u{21A7}", mapstoleft: "\u{21A4}",
  mapstoup: "\u{21A5}", marker: "\u{25AE}", mcomma: "\u{2A29}", mcy: "\u{43C}", mdash: "\u{2014}",
  measuredangle: "\u{2221}", mfr: "\u{1D52A}", mho: "\u{2127}", micro: "\u{B5}", mid: "\u{2223}", midast: "\u{2A}",
  midcir: "\u{2AF0}", middot: "\u{B7}", minus: "\u{2212}", minusb: "\u{229F}", minusd: "\u{2238}",
  minusdu: "\u{2A2A}", mlcp: "\u{2ADB}", mldr: "\u{2026}", mnplus: "\u{2213}", models: "\u{22A7}",
  mopf: "\u{1D55E}", mp: "\u{2213}", mscr: "\u{1D4C2}", mstpos: "\u{223E}", mu: "\u{3BC}", multimap: "\u{22B8}",
  mumap: "\u{22B8}", nGg: "\u{22D9}\u{338}", nGt: "\u{226B}\u{20D2}", nGtv: "\u{226B}\u{338}",
  nLeftarrow: "\u{21CD}", nLeftrightarrow: "\u{21CE}", nLl: "\u{22D8}\u{338}", nLt: "\u{226A}\u{20D2}",
  nLtv: "\u{226A}\u{338}", nRightarrow: "\u{21CF}", nVDash: "\u{22AF}", nVdash: "\u{22AE}", nabla: "\u{2207}",
  nacute: "\u{144}", nang: "\u{2220}\u{20D2}", nap: "\u{2249}", napE: "\u{2A70}\u{338}", napid: "\u{224B}\u{338}",
  napos: "\u{149}", napprox: "\u{2249}", natur: "\u{266E}", natural: "\u{266E}", naturals: "\u{2115}",
  nbsp: "\u{A0}", nbump: "\u{224E}\u{338}", nbumpe: "\u{224F}\u{338}", ncap: "\u{2A43}", ncaron: "\u{148}",
  ncedil: "\u{146}", ncong: "\u{2247}", ncongdot: "\u{2A6D}\u{338}", ncup: "\u{2A42}", ncy: "\u{43D}",
  ndash: "\u{2013}", ne: "\u{2260}", neArr: "\u{21D7}", nearhk: "\u{2924}", nearr: "\u{2197}", nearrow: "\u{2197}",
  nedot: "\u{2250}\u{338}", nequiv: "\u{2262}", nesear: "\u{2928}", nesim: "\u{2242}\u{338}", nexist: "\u{2204}",
  nexists: "\u{2204}", nfr: "\u{1D52B}", ngE: "\u{2267}\u{338}", nge: "\u{2271}", ngeq: "\u{2271}",
  ngeqq: "\u{2267}\u{338}", ngeqslant: "\u{2A7E}\u{338}", nges: "\u{2A7E}\u{338}", ngsim: "\u{2275}",
  ngt: "\u{226F}", ngtr: "\u{226F}", nhArr: "\u{21CE}", nharr: "\u{21AE}", nhpar: "\u{2AF2}", ni: "\u{220B}",
  nis: "\u{22FC}", nisd: "\u{22FA}", niv: "\u{220B}", njcy: "\u{45A}", nlArr: "\u{21CD}", nlE: "\u{2266}\u{338}",
  nlarr: "\u{219A}", nldr: "\u{2025}", nle: "\u{2270}", nleftarrow: "\u{219A}", nleftrightarrow: "\u{21AE}",
  nleq: "\u{2270}", nleqq: "\u{2266}\u{338}", nleqslant: "\u{2A7D}\u{338}", nles: "\u{2A7D}\u{338}",
  nless: "\u{226E}", nlsim: "\u{2274}", nlt: "\u{226E}", nltri: "\u{22EA}", nltrie: "\u{22EC}", nmid: "\u{2224}",
  nopf: "\u{1D55F}", not: "\u{AC}", notin: "\u{2209}", notinE: "\u{22F9}\u{338}", notindot: "\u{22F5}\u{338}",
  notinva: "\u{2209}", notinvb: "\u{22F7}", notinvc: "\u{22F6}", notni: "\u{220C}", notniva: "\u{220C}",
  notnivb: "\u{22FE}", notnivc: "\u{22FD}", npar: "\u{2226}", nparallel: "\u{2226}", nparsl: "\u{2AFD}\u{20E5}",
  npart: "\u{2202}\u{338}", npolint: "\u{2A14}", npr: "\u{2280}", nprcue: "\u{22E0}", npre: "\u{2AAF}\u{338}",
  nprec: "\u{2280}", npreceq: "\u{2AAF}\u{338}", nrArr: "\u{21CF}", nrarr: "\u{219B}", nrarrc: "\u{2933}\u{338}",
  nrarrw: "\u{219D}\u{338}", nrightarrow: "\u{219B}", nrtri: "\u{22EB}", nrtrie: "\u{22ED}", nsc: "\u{2281}",
  nsccue: "\u{22E1}", nsce: "\u{2AB0}\u{338}", nscr: "\u{1D4C3}", nshortmid: "\u{2224}",
  nshortparallel: "\u{2226}", nsim: "\u{2241}", nsime: "\u{2244}", nsimeq: "\u{2244}", nsmid: "\u{2224}",
  nspar: "\u{2226}", nsqsube: "\u{22E2}", nsqsupe: "\u{22E3}", nsub: "\u{2284}", nsubE: "\u{2AC5}\u{338}",
  nsube: "\u{2288}", nsubset: "\u{2282}\u{20D2}", nsubseteq: "\u{2288}", nsubseteqq: "\u{2AC5}\u{338}",
  nsucc: "\u{2281}", nsucceq: "\u{2AB0}\u{338}", nsup: "\u{2285}", nsupE: "\u{2AC6}\u{338}", nsupe: "\u{2289}",
  nsupset: "\u{2283}\u{20D2}", nsupseteq: "\u{2289}", nsupseteqq: "\u{2AC6}\u{338}", ntgl: "\u{2279}",
  ntilde: "\u{F1}", ntlg: "\u{2278}", ntriangleleft: "\u{22EA}", ntrianglelefteq: "\u{22EC}",
  ntriangleright: "\u{22EB}", ntrianglerighteq: "\u{22ED}", nu: "\u{3BD}", num: "\u{23}", numero: "\u{2116}",
  numsp: "\u{2007}", nvDash: "\u{22AD}", nvHarr: "\u{2904}", nvap: "\u{224D}\u{20D2}", nvdash: "\u{22AC}",
  nvge: "\u{2265}\u{20D2}", nvgt: "\u{3E}\u{20D2}", nvinfin: "\u{29DE}", nvlArr: "\u{2902}",
  nvle: "\u{2264}\u{20D2}", nvlt: "\u{3C}\u{20D2}", nvltrie: "\u{22B4}\u{20D2}", nvrArr: "\u{2903}",
  nvrtrie: "\u{22B5}\u{20D2}", nvsim: "\u{223C}\u{20D2}", nwArr: "\u{21D6}", nwarhk: "\u{2923}", nwarr: "\u{2196}",
  nwarrow: "\u{2196}", nwnear: "\u{2927}", oS: "\u{24C8}", oacute: "\u{F3}", oast: "\u{229B}", ocir: "\u{229A}",
  ocirc: "\u{F4}", ocy: "\u{43E}", odash: "\u{229D}", odblac: "\u{151}", odiv: "\u{2A38}", odot: "\u{2299}",
  odsold: "\u{29BC}", oelig: "\u{153}", ofcir: "\u{29BF}", ofr: "\u{1D52C}", ogon: "\u{2DB}", ograve: "\u{F2}",
  ogt: "\u{29C1}", ohbar: "\u{29B5}", ohm: "\u{3A9}", oint: "\u{222E}", olarr: "\u{21BA}", olcir: "\u{29BE}",
  olcross: "\u{29BB}", oline: "\u{203E}", olt: "\u{29C0}", omacr: "\u{14D}", omega: "\u{3C9}", omicron: "\u{3BF}",
  omid: "\u{29B6}", ominus: "\u{2296}", oopf: "\u{1D560}", opar: "\u{29B7}", operp: "\u{29B9}", oplus: "\u{2295}",
  or: "\u{2228}", orarr: "\u{21BB}", ord: "\u{2A5D}", order: "\u{2134}", orderof: "\u{2134}", ordf: "\u{AA}",
  ordm: "\u{BA}", origof: "\u{22B6}", oror: "\u{2A56}", orslope: "\u{2A57}", orv: "\u{2A5B}", oscr: "\u{2134}",
  oslash: "\u{F8}", osol: "\u{2298}", otilde: "\u{F5}", otimes: "\u{2297}", otimesas: "\u{2A36}", ouml: "\u{F6}",
  ovbar: "\u{233D}", par: "\u{2225}", para: "\u{B6}", parallel: "\u{2225}", parsim: "\u{2AF3}", parsl: "\u{2AFD}",
  part: "\u{2202}", pcy: "\u{43F}", percnt: "\u{25}", period: "\u{2E}", permil: "\u{2030}", perp: "\u{22A5}",
  pertenk: "\u{2031}", pfr: "\u{1D52D}", phi: "\u{3C6}", phiv: "\u{3D5}", phmmat: "\u{2133}", phone: "\u{260E}",
  pi: "\u{3C0}", pitchfork: "\u{22D4}", piv: "\u{3D6}", planck: "\u{210F}", planckh: "\u{210E}",
  plankv: "\u{210F}", plus: "\u{2B}", plusacir: "\u{2A23}", plusb: "\u{229E}", pluscir: "\u{2A22}",
  plusdo: "\u{2214}", plusdu: "\u{2A25}", pluse: "\u{2A72}", plusmn: "\u{B1}", plussim: "\u{2A26}",
  plustwo: "\u{2A27}", pm: "\u{B1}", pointint: "\u{2A15}", popf: "\u{1D561}", pound: "\u{A3}", pr: "\u{227A}",
  prE: "\u{2AB3}", prap: "\u{2AB7}", prcue: "\u{227C}", pre: "\u{2AAF}", prec: "\u{227A}", precapprox: "\u{2AB7}",
  preccurlyeq: "\u{227C}", preceq: "\u{2AAF}", precnapprox: "\u{2AB9}", precneqq: "\u{2AB5}", precnsim: "\u{22E8}",
  precsim: "\u{227E}", prime: "\u{2032}", primes: "\u{2119}", prnE: "\u{2AB5}", prnap: "\u{2AB9}",
  prnsim: "\u{22E8}", prod: "\u{220F}", profalar: "\u{232E}", profline: "\u{2312}", profsurf: "\u{2313}",
  prop: "\u{221D}", propto: "\u{221D}", prsim: "\u{227E}", prurel: "\u{22B0}", pscr: "\u{1D4C5}", psi: "\u{3C8}",
  puncsp: "\u{2008}", qfr: "\u{1D52E}", qint: "\u{2A0C}", qopf: "\u{1D562}", qprime: "\u{2057}", qscr: "\u{1D4C6}",
  quaternions: "\u{210D}", quatint: "\u{2A16}", quest: "\u{3F}", questeq: "\u{225F}", quot: "\u{22}",
  rAarr: "\u{21DB}", rArr: "\u{21D2}", rAtail: "\u{291C}", rBarr: "\u{290F}", rHar: "\u{2964}",
  race: "\u{223D}\u{331}", racute: "\u{155}", radic: "\u{221A}", raemptyv: "\u{29B3}", rang: "\u{27E9}",
  rangd: "\u{2992}", range: "\u{29A5}", rangle: "\u{27E9}", raquo: "\u{BB}", rarr: "\u{2192}", rarrap: "\u{2975}",
  rarrb: "\u{21E5}", rarrbfs: "\u{2920}", rarrc: "\u{2933}", rarrfs: "\u{291E}", rarrhk: "\u{21AA}",
  rarrlp: "\u{21AC}", rarrpl: "\u{2945}", rarrsim: "\u{2974}", rarrtl: "\u{21A3}", rarrw: "\u{219D}",
  ratail: "\u{291A}", ratio: "\u{2236}", rationals: "\u{211A}", rbarr: "\u{290D}", rbbrk: "\u{2773}",
  rbrace: "\u{7D}", rbrack: "\u{5D}", rbrke: "\u{298C}", rbrksld: "\u{298E}", rbrkslu: "\u{2990}",
  rcaron: "\u{159}", rcedil: "\u{157}", rceil: "\u{2309}", rcub: "\u{7D}", rcy: "\u{440}", rdca: "\u{2937}",
  rdldhar: "\u{2969}", rdquo: "\u{201D}", rdquor: "\u{201D}", rdsh: "\u{21B3}", real: "\u{211C}",
  realine: "\u{211B}", realpart: "\u{211C}", reals: "\u{211D}", rect: "\u{25AD}", reg: "\u{AE}",
  rfisht: "\u{297D}", rfloor: "\u{230B}", rfr: "\u{1D52F}", rhard: "\u{21C1}", rharu: "\u{21C0}",
  rharul: "\u{296C}", rho: "\u{3C1}", rhov: "\u{3F1}", rightarrow: "\u{2192}", rightarrowtail: "\u{21A3}",
  rightharpoondown: "\u{21C1}", rightharpoonup: "\u{21C0}", rightleftarrows: "\u{21C4}",
  rightleftharpoons: "\u{21CC}", rightrightarrows: "\u{21C9}", rightsquigarrow: "\u{219D}",
  rightthreetimes: "\u{22CC}", ring: "\u{2DA}", risingdotseq: "\u{2253}", rlarr: "\u{21C4}", rlhar: "\u{21CC}",
  rlm: "\u{200F}", rmoust: "\u{23B1}", rmoustache: "\u{23B1}", rnmid: "\u{2AEE}", roang: "\u{27ED}",
  roarr: "\u{21FE}", robrk: "\u{27E7}", ropar: "\u{2986}", ropf: "\u{1D563}", roplus: "\u{2A2E}",
  rotimes: "\u{2A35}", rpar: "\u{29}", rpargt: "\u{2994}", rppolint: "\u{2A12}", rrarr: "\u{21C9}",
  rsaquo: "\u{203A}", rscr: "\u{1D4C7}", rsh: "\u{21B1}", rsqb: "\u{5D}", rsquo: "\u{2019}", rsquor: "\u{2019}",
  rthree: "\u{22CC}", rtimes: "\u{22CA}", rtri: "\u{25B9}", rtrie: "\u{22B5}", rtrif: "\u{25B8}",
  rtriltri: "\u{29CE}", ruluhar: "\u{2968}", rx: "\u{211E}", sacute: "\u{15B}", sbquo: "\u{201A}", sc: "\u{227B}",
  scE: "\u{2AB4}", scap: "\u{2AB8}", scaron: "\u{161}", sccue: "\u{227D}", sce: "\u{2AB0}", scedil: "\u{15F}",
  scirc: "\u{15D}", scnE: "\u{2AB6}", scnap: "\u{2ABA}", scnsim: "\u{22E9}", scpolint: "\u{2A13}",
  scsim: "\u{227F}", scy: "\u{441}", sdot: "\u{22C5}", sdotb: "\u{22A1}", sdote: "\u{2A66}", seArr: "\u{21D8}",
  searhk: "\u{2925}", searr: "\u{2198}", searrow: "\u{2198}", sect: "\u{A7}", semi: "\u{3B}", seswar: "\u{2929}",
  setminus: "\u{2216}", setmn: "\u{2216}", sext: "\u{2736}", sfr: "\u{1D530}", sfrown: "\u{2322}",
  sharp: "\u{266F}", shchcy: "\u{449}", shcy: "\u{448}", shortmid: "\u{2223}", shortparallel: "\u{2225}",
  shy: "\u{AD}", sigma: "\u{3C3}", sigmaf: "\u{3C2}", sigmav: "\u{3C2}", sim: "\u{223C}", simdot: "\u{2A6A}",
  sime: "\u{2243}", simeq: "\u{2243}", simg: "\u{2A9E}", simgE: "\u{2AA0}", siml: "\u{2A9D}", simlE: "\u{2A9F}",
  simne: "\u{2246}", simplus: "\u{2A24}", simrarr: "\u{2972}", slarr: "\u{2190}", smallsetminus: "\u{2216}",
  smashp: "\u{2A33}", smeparsl: "\u{29E4}", smid: "\u{2223}", smile: "\u{2323}", smt: "\u{2AAA}", smte: "\u{2AAC}",
  smtes: "\u{2AAC}\u{FE00}", softcy: "\u{44C}", sol: "\u{2F}", solb: "\u{29C4}", solbar: "\u{233F}",
  sopf: "\u{1D564}", spades: "\u{2660}", spadesuit: "\u{2660}", spar: "\u{2225}", sqcap: "\u{2293}",
  sqcaps: "\u{2293}\u{FE00}", sqcup: "\u{2294}", sqcups: "\u{2294}\u{FE00}", sqsub: "\u{228F}", sqsube: "\u{2291}",
  sqsubset: "\u{228F}", sqsubseteq: "\u{2291}", sqsup: "\u{2290}", sqsupe: "\u{2292}", sqsupset: "\u{2290}",
  sqsupseteq: "\u{2292}", squ: "\u{25A1}", square: "\u{25A1}", squarf: "\u{25AA}", squf: "\u{25AA}",
  srarr: "\u{2192}", sscr: "\u{1D4C8}", ssetmn: "\u{2216}", ssmile: "\u{2323}", sstarf: "\u{22C6}",
  star: "\u{2606}", starf: "\u{2605}", straightepsilon: "\u{3F5}", straightphi: "\u{3D5}", strns: "\u{AF}",
  sub: "\u{2282}", subE: "\u{2AC5}", subdot: "\u{2ABD}", sube: "\u{2286}", subedot: "\u{2AC3}",
  submult: "\u{2AC1}", subnE: "\u{2ACB}", subne: "\u{228A}", subplus: "\u{2ABF}", subrarr: "\u{2979}",
  subset: "\u{2282}", subseteq: "\u{2286}", subseteqq: "\u{2AC5}", subsetneq: "\u{228A}", subsetneqq: "\u{2ACB}",
  subsim: "\u{2AC7}", subsub: "\u{2AD5}", subsup: "\u{2AD3}", succ: "\u{227B}", succapprox: "\u{2AB8}",
  succcurlyeq: "\u{227D}", succeq: "\u{2AB0}", succnapprox: "\u{2ABA}", succneqq: "\u{2AB6}", succnsim: "\u{22E9}",
  succsim: "\u{227F}", sum: "\u{2211}", sung: "\u{266A}", sup1: "\u{B9}", sup2: "\u{B2}", sup3: "\u{B3}",
  sup: "\u{2283}", supE: "\u{2AC6}", supdot: "\u{2ABE}", supdsub: "\u{2AD8}", supe: "\u{2287}",
  supedot: "\u{2AC4}", suphsol: "\u{27C9}", suphsub: "\u{2AD7}", suplarr: "\u{297B}", supmult: "\u{2AC2}",
  supnE: "\u{2ACC}", supne: "\u{228B}", supplus: "\u{2AC0}", supset: "\u{2283}", supseteq: "\u{2287}",
  supseteqq: "\u{2AC6}", supsetneq: "\u{228B}", supsetneqq: "\u{2ACC}", supsim: "\u{2AC8}", supsub: "\u{2AD4}",
  supsup: "\u{2AD6}", swArr: "\u{21D9}", swarhk: "\u{2926}", swarr: "\u{2199}", swarrow: "\u{2199}",
  swnwar: "\u{292A}", szlig: "\u{DF}", target: "\u{2316}", tau: "\u{3C4}", tbrk: "\u{23B4}", tcaron: "\u{165}",
  tcedil: "\u{163}", tcy: "\u{442}", tdot: "\u{20DB}", telrec: "\u{2315}", tfr: "\u{1D531}", there4: "\u{2234}",
  therefore: "\u{2234}", theta: "\u{3B8}", thetasym: "\u{3D1}", thetav: "\u{3D1}", thickapprox: "\u{2248}",
  thicksim: "\u{223C}", thinsp: "\u{2009}", thkap: "\u{2248}", thksim: "\u{223C}", thorn: "\u{FE}",
  tilde: "\u{2DC}", times: "\u{D7}", timesb: "\u{22A0}", timesbar: "\u{2A31}", timesd: "\u{2A30}",
  tint: "\u{222D}", toea: "\u{2928}", top: "\u{22A4}", topbot: "\u{2336}", topcir: "\u{2AF1}", topf: "\u{1D565}",
  topfork: "\u{2ADA}", tosa: "\u{2929}", tprime: "\u{2034}", trade: "\u{2122}", triangle: "\u{25B5}",
  triangledown: "\u{25BF}", triangleleft: "\u{25C3}", trianglelefteq: "\u{22B4}", triangleq: "\u{225C}",
  triangleright: "\u{25B9}", trianglerighteq: "\u{22B5}", tridot: "\u{25EC}", trie: "\u{225C}",
  triminus: "\u{2A3A}", triplus: "\u{2A39}", trisb: "\u{29CD}", tritime: "\u{2A3B}", trpezium: "\u{23E2}",
  tscr: "\u{1D4C9}", tscy: "\u{446}", tshcy: "\u{45B}", tstrok: "\u{167}", twixt: "\u{226C}",
  twoheadleftarrow: "\u{219E}", twoheadrightarrow: "\u{21A0}", uArr: "\u{21D1}", uHar: "\u{2963}",
  uacute: "\u{FA}", uarr: "\u{2191}", ubrcy: "\u{45E}", ubreve: "\u{16D}", ucirc: "\u{FB}", ucy: "\u{443}",
  udarr: "\u{21C5}", udblac: "\u{171}", udhar: "\u{296E}", ufisht: "\u{297E}", ufr: "\u{1D532}", ugrave: "\u{F9}",
  uharl: "\u{21BF}", uharr: "\u{21BE}", uhblk: "\u{2580}", ulcorn: "\u{231C}", ulcorner: "\u{231C}",
  ulcrop: "\u{230F}", ultri: "\u{25F8}", umacr: "\u{16B}", uml: "\u{A8}", uogon: "\u{173}", uopf: "\u{1D566}",
  uparrow: "\u{2191}", updownarrow: "\u{2195}", upharpoonleft: "\u{21BF}", upharpoonright: "\u{21BE}",
  uplus: "\u{228E}", upsi: "\u{3C5}", upsih: "\u{3D2}", upsilon: "\u{3C5}", upuparrows: "\u{21C8}",
  urcorn: "\u{231D}", urcorner: "\u{231D}", urcrop: "\u{230E}", uring: "\u{16F}", urtri: "\u{25F9}",
  uscr: "\u{1D4CA}", utdot: "\u{22F0}", utilde: "\u{169}", utri: "\u{25B5}", utrif: "\u{25B4}", uuarr: "\u{21C8}",
  uuml: "\u{FC}", uwangle: "\u{29A7}", vArr: "\u{21D5}", vBar: "\u{2AE8}", vBarv: "\u{2AE9}", vDash: "\u{22A8}",
  vangrt: "\u{299C}", varepsilon: "\u{3F5}", varkappa: "\u{3F0}", varnothing: "\u{2205}", varphi: "\u{3D5}",
  varpi: "\u{3D6}", varpropto: "\u{221D}", varr: "\u{2195}", varrho: "\u{3F1}", varsigma: "\u{3C2}",
  varsubsetneq: "\u{228A}\u{FE00}", varsubsetneqq: "\u{2ACB}\u{FE00}", varsupsetneq: "\u{228B}\u{FE00}",
  varsupsetneqq: "\u{2ACC}\u{FE00}", vartheta: "\u{3D1}", vartriangleleft: "\u{22B2}",
  vartriangleright: "\u{22B3}", vcy: "\u{432}", vdash: "\u{22A2}", vee: "\u{2228}", veebar: "\u{22BB}",
  veeeq: "\u{225A}", vellip: "\u{22EE}", verbar: "\u{7C}", vert: "\u{7C}", vfr: "\u{1D533}", vltri: "\u{22B2}",
  vnsub: "\u{2282}\u{20D2}", vnsup: "\u{2283}\u{20D2}", vopf: "\u{1D567}", vprop: "\u{221D}", vrtri: "\u{22B3}",
  vscr: "\u{1D4CB}", vsubnE: "\u{2ACB}\u{FE00}", vsubne: "\u{228A}\u{FE00}", vsupnE: "\u{2ACC}\u{FE00}",
  vsupne: "\u{228B}\u{FE00}", vzigzag: "\u{299A}", wcirc: "\u{175}", wedbar: "\u{2A5F}", wedge: "\u{2227}",
  wedgeq: "\u{2259}", weierp: "\u{2118}", wfr: "\u{1D534}", wopf: "\u{1D568}", wp: "\u{2118}", wr: "\u{2240}",
  wreath: "\u{2240}", wscr: "\u{1D4CC}", xcap: "\u{22C2}", xcirc: "\u{25EF}", xcup: "\u{22C3}", xdtri: "\u{25BD}",
  xfr: "\u{1D535}", xhArr: "\u{27FA}", xharr: "\u{27F7}", xi: "\u{3BE}", xlArr: "\u{27F8}", xlarr: "\u{27F5}",
  xmap: "\u{27FC}", xnis: "\u{22FB}", xodot: "\u{2A00}", xopf: "\u{1D569}", xoplus: "\u{2A01}", xotime: "\u{2A02}",
  xrArr: "\u{27F9}", xrarr: "\u{27F6}", xscr: "\u{1D4CD}", xsqcup: "\u{2A06}", xuplus: "\u{2A04}",
  xutri: "\u{25B3}", xvee: "\u{22C1}", xwedge: "\u{22C0}", yacute: "\u{FD}", yacy: "\u{44F}", ycirc: "\u{177}",
  ycy: "\u{44B}", yen: "\u{A5}", yfr: "\u{1D536}", yicy: "\u{457}", yopf: "\u{1D56A}", yscr: "\u{1D4CE}",
  yucy: "\u{44E}", yuml: "\u{FF}", zacute: "\u{17A}", zcaron: "\u{17E}", zcy: "\u{437}", zdot: "\u{17C}",
  zeetrf: "\u{2128}", zeta: "\u{3B6}", zfr: "\u{1D537}", zhcy: "\u{436}", zigrarr: "\u{21DD}", zopf: "\u{1D56B}",
  zscr: "\u{1D4CF}", zwj: "\u{200D}", zwnj: "\u{200C}",
}));
// Longest first, so a shorter legacy name cannot consume the start of a longer one.
const HTML_LEGACY_REFERENCE = new RegExp("^(?:" + [
  "aacute|Aacute|agrave|Agrave|atilde|Atilde|brvbar|ccedil|Ccedil|curren",
  "divide|eacute|Eacute|egrave|Egrave|frac12|frac14|frac34|iacute|Iacute",
  "igrave|Igrave|iquest|middot|ntilde|Ntilde|oacute|Oacute|ograve|Ograve",
  "oslash|Oslash|otilde|Otilde|plusmn|uacute|Uacute|ugrave|Ugrave|yacute",
  "Yacute|acirc|Acirc|acute|aelig|AElig|aring|Aring|cedil|ecirc",
  "Ecirc|icirc|Icirc|iexcl|laquo|micro|ocirc|Ocirc|pound|raquo",
  "szlig|thorn|THORN|times|ucirc|Ucirc|auml|Auml|cent|copy",
  "COPY|euml|Euml|iuml|Iuml|macr|nbsp|ordf|ordm|ouml",
  "Ouml|para|quot|QUOT|sect|sup1|sup2|sup3|uuml|Uuml",
  "yuml|amp|AMP|deg|eth|ETH|not|reg|REG|shy",
  "uml|yen|gt|GT|lt|LT",
].join("|") + ")");
