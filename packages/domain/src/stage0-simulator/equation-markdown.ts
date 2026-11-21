export const mathSpanClosers = new Map([["$", "$"], ["$$", "$$"], ["\\(", "\\)"], ["\\[", "\\]"]]);

/** Index the first matching closer to the right. The forward scan consumes each span once. */
export function equationSpanEnds(parts: readonly string[]): Map<number, number> {
  const nextFence = new Map<string, number>();
  const spanEnds = new Map<number, number>();
  for (let i = parts.length - 2; i > 0; i -= 2) {
    const marker = parts[i]!;
    // A backslash escapes the first opening tick, but is literal inside code.
    const escapedTick = marker.startsWith("\\`");
    const fence = escapedTick ? marker.slice(1) : marker;
    const closer = fence.startsWith("`")
      ? (escapedTick ? fence.slice(1) : fence)
      : mathSpanClosers.get(marker);
    const end = closer ? nextFence.get(closer) : undefined;
    if (end !== undefined) spanEnds.set(i, end);
    nextFence.set(fence, i);
  }
  return spanEnds;
}

type Container = { kind: "quote" } | { kind: "list"; indent: number };

interface EquationLine {
  raw: string;
  containers: { scope: Container; end: number }[];
  content: string;
  trimmed: string;
  quote?: Container;
  fence?: { indent: number; run: string; canClose: boolean };
  paragraph?: number;
  cells?: string[];
  setext?: boolean;
  literalBlock?: boolean;
  literalStart?: number;
}

// A list item owns indented continuation lines. A task checkbox is content of the item
// and adds no indentation requirement. Each sibling item gets a distinct scope.
function markdownLines(rawLines: string[]): EquationLine[] {
  const lines: EquationLine[] = [];
  let activeContainers: EquationLine["containers"] = [];
  for (const raw of rawLines) {
    const previous = lines.at(-1);
    const containers: EquationLine["containers"] = [];
    let offset = 0;
    let quote: Container | undefined;
    for (const { scope } of activeContainers) {
      const rest = raw.slice(offset);
      if (scope.kind === "quote") {
        const prefix = /^ {0,3}>[ \t]?/.exec(rest);
        if (!prefix) break;
        offset += prefix[0].length;
        quote = scope;
      } else {
        const indent = continuationIndent(rest, scope.indent);
        if (indent === undefined) break;
        offset += indent;
      }
      containers.push({ scope, end: offset });
    }
    // A sibling list starts a new block. Within the same open paragraph, only a
    // nonempty bullet or an ordered item numbered exactly 1 can interrupt it.
    let paragraphOpen = previous?.paragraph !== undefined;
    let continuing = paragraphOpen && containers.length === activeContainers.length;
    let listCode = false;
    for (;;) {
      const rest = raw.slice(offset);
      if (isThematicBreak(rest) || (continuing && isSetextUnderline(rest))) break;
      const quotePrefix = /^ {0,3}>[ \t]?/.exec(rest);
      let scope: Container;
      if (quotePrefix) {
        scope = { kind: "quote" };
        quote = scope;
        offset += quotePrefix[0].length;
      } else {
        const item = listPrefix(rest);
        if (!item || (continuing && !item.interrupts)) break;
        scope = { kind: "list", indent: item.indent };
        listCode = item.code;
        offset += item.end;
      }
      containers.push({ scope, end: offset });
      continuing = false;
      paragraphOpen = false;
      if (listCode) break;
    }
    const content = raw.slice(offset);
    const trimmed = content.trim();
    const sameScope = activeContainers.at(-1)?.scope === containers.at(-1)?.scope;
    const setext = continuing && isSetextUnderline(content);
    const indented = listCode || (!paragraphOpen && /^(?: {4}| {0,3}\t)/u.test(content));
    const fence = indented ? undefined : readFence(content);
    const atx = /^ {0,3}#{1,6}(?:[ \t]|$)/u.test(content);
    const block = !trimmed || fence || setext || atx || isThematicBreak(content) || indented || startsHtmlBlock(content, paragraphOpen);
    const line: EquationLine = { raw, containers, content, trimmed, quote, fence, setext, literalBlock: indented };
    if (!block) {
      line.paragraph = paragraphOpen ? previous!.paragraph : lines.length;
    }
    if (sameScope && previous) {
      if (previous.cells && !block) {
        line.cells = gfmCells(content);
      } else if (previous.paragraph !== undefined && isTableDelimiter(content)) {
        const header = gfmCells(previous.content);
        if (header.length === gfmCells(content).length) {
          previous.cells = header;
          previous.paragraph = undefined;
          line.cells = []; // The delimiter row contains alignment syntax only.
        }
      }
    }
    if (line.cells) line.paragraph = undefined;
    // A lazy paragraph retains its container identity for later explicit prefixes.
    // Fence and math matching use only prefixes physically present on each line.
    if (!paragraphOpen || block || sameScope) activeContainers = containers;
    lines.push(line);
  }
  return lines;
}

function listPrefix(text: string) {
  const match = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/u.exec(text);
  if (!match) return undefined;
  const [, leading, marker, padding] = match;
  const markerEnd = leading!.length + marker!.length;
  let indent = markerEnd;
  for (const char of padding!) indent += char === "\t" ? 4 - indent % 4 : 1;
  const content = text.slice(match[0].length);
  const code = !!content && indent - markerEnd > 4;
  const interrupts = !!content && (marker!.length === 1 || /^1[.)]$/.test(marker!));
  // Empty items and items starting with indented code have one column of list padding.
  if (!content || code) indent = markerEnd + 1;
  const checkbox = /^\[[ xX]\][ \t]+/.exec(content);
  const end = code ? markerEnd + 1 : match[0].length + (checkbox?.[0].length ?? 0);
  return { indent, end, interrupts, code };
}

function isSetextUnderline(text: string): boolean {
  return /^ {0,3}(?:=+|-+)[ \t]*$/u.test(text);
}

function isThematicBreak(text: string): boolean {
  return /^ {0,3}([_*-])(?:[ \t]*\1){2,}[ \t]*$/u.test(text);
}

/** GFM splits an unescaped pipe even inside a code span. Only the backslash
 * escaping a pipe is consumed here; the remaining text still has inline syntax. */
function gfmCells(text: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let cell = "";
  for (let pipe = text.indexOf("|"); pipe >= 0; pipe = text.indexOf("|", start)) {
    let before = pipe;
    while (before > start && text[before - 1] === "\\") before--;
    if ((pipe - before) % 2) {
      cell += text.slice(start, pipe - 1) + "|";
    } else {
      cells.push((cell + text.slice(start, pipe)).trim());
      cell = "";
    }
    start = pipe + 1;
  }
  cells.push((cell + text.slice(start)).trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
}

function isTableDelimiter(text: string): boolean {
  if (!/^ {0,3}[:|-][ \t:|-]*$/u.test(text) || !/[:|]/u.test(text)) return false;
  const cells = gfmCells(text);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell));
}

// CommonMark HTML block starts 1–6 can interrupt a paragraph. A complete
// generic tag (type 7) can start an HTML block only between paragraphs.
const blockTags = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog " +
  "dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe " +
  "legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));

function startsHtmlBlock(text: string, paragraphOpen: boolean): boolean {
  if (/^ {0,3}<(?:!--|\?|!\[CDATA\[|![A-Z]|(?:pre|script|style|textarea)(?=[ \t>]|$))/iu.test(text)) return true;
  const tag = /^ {0,3}<\/?([a-z][\w-]*)(?=[ \t>]|\/>|$)/iu.exec(text);
  if (!tag) return false;
  if (blockTags.has(tag[1]!.toLowerCase())) return true;
  return !paragraphOpen && /^ {0,3}<\/?[a-z][\w-]*(?:[ \t]+[a-z_:][\w.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|\x27[^\x27]*\x27|[^\s"\x27=<>`]+))?)*[ \t]*\/?>[ \t]*$/iu.test(text);
}

function continuationIndent(text: string, width: number): number | undefined {
  let columns = 0;
  let count = 0;
  while (columns < width && count < text.length) {
    const char = text[count];
    if (char !== " " && char !== "\t") return undefined;
    columns += char === "\t" ? 4 - columns % 4 : 1;
    count++;
  }
  return count;
}

/** Formal table rows expose independent inline cells; other blocks retain their physical lines. */
export function equationMarkdownLines(text: string): (string | string[])[] {
  const rawLines = text.split(/\r\n|[\r\n\u2028\u2029]/u);
  if (rawLines.length === 1 && !/^[ \t>+*#\d-]/u.test(text)) return [text];
  const lines = markdownLines(rawLines);
  const fences = matchedFences(lines);
  let proseStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = fences.get(i);
    if (end === undefined) continue;
    markMathLines(lines.slice(proseStart, i));
    const depth = lines[i]!.containers.length;
    for (let j = i + 1; j < end; j++) lines[j]!.literalStart = lines[j]!.containers[depth - 1]?.end ?? 0;
    i = end;
    proseStart = end + 1;
  }
  markMathLines(lines.slice(proseStart));
  return lines.map(({ raw, literalStart, content, cells, literalBlock }) => {
    if (literalStart !== undefined) return raw.slice(literalStart);
    if (cells) return cells;
    return literalBlock ? content : content.replace(/^ {0,3}#{1,6}[ \t]+/, "");
  });
}

function readFence(content: string): EquationLine["fence"] {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(content);
  if (!match) return undefined;
  const run = match[2]!;
  const info = match[3]!;
  if (run[0] === "`" && info.includes("`")) return undefined;
  return { indent: match[1]!.length, run, canClose: /^[ \t]*$/.test(info) };
}

function matchedFences(lines: EquationLine[]): Map<number, number> {
  const ends = new Map<number, number>();
  type FenceWidths = { ticks: Map<number, number>; tildes: Map<number, number> };
  const scopes = new Map<Container | undefined, FenceWidths>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const { raw, content, containers, fence } = lines[i]!;
    if (!fence) continue;
    const run = fence.run;
    const kind = run[0] === "`" ? "ticks" : "tildes";
    const end = scopes.get(containers.at(-1)?.scope)?.[kind].get(run.length);
    if (end !== undefined) ends.set(i, end);
    if (!fence.canClose) continue;

    // Inside an open fence an apparent nested list is literal. Index the closer
    // for each enclosing container where at most three spaces precede the run.
    const markerStart = raw.length - content.length + fence.indent;
    for (let depth = containers.length; depth >= 0; depth--) {
      const parent = containers[depth - 1];
      if (!/^ {0,3}$/.test(raw.slice(parent?.end ?? 0, markerStart))) break;
      const widths = scopes.get(parent?.scope) ?? { ticks: new Map(), tildes: new Map() };
      scopes.set(parent?.scope, widths);
      for (let width = 3; width <= run.length; width++) widths[kind].set(width, i);
    }
  }
  return ends;
}

interface MathMarker {
  line: number;
  part: number;
  text: string;
  canOpen: boolean;
  canClose: boolean;
}

/** Pair code spans within a paragraph before indexing its math markers. The audit
 * still reads the original lines, including the contents of those code spans. */
function mathMarkers(lines: EquationLine[]): MathMarker[][] {
  const markers = lines.map((): MathMarker[] => []);
  let start = 0;
  while (start < lines.length) {
    let stop = start + 1;
    const first = lines[start]!;
    if (first.cells || first.literalBlock) {
      start++;
      continue;
    }
    while (first.paragraph !== undefined && stop < lines.length && lines[stop]!.paragraph === first.paragraph) {
      stop++;
    }
    const paragraph = lines.slice(start, stop).map((line) => line.content).join("\n");
    const parts = paragraph.split(/(\\?`+|\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\.|\$+|\n)/u);
    const spanEnds = equationSpanEnds(parts);
    let codeEnd = -1;
    let lineIndex = start;
    for (let i = 1; i < parts.length; i += 2) {
      const marker = parts[i]!;
      if (marker === "\n") {
        lineIndex++;
        continue;
      }
      if (i <= codeEnd) continue;
      if (marker.endsWith("`")) {
        codeEnd = spanEnds.get(i) ?? i;
        continue;
      }
      if (!/^(?:\${1,2}$|\\[()[\]]$|\\(?:begin|end)\{)/u.test(marker)) continue;
      const before = parts[i - 1]!.at(-1) ?? parts[i - 2]?.at(-1);
      const after = parts[i + 1]![0] ?? parts[i + 2]?.[0];
      const loneDollar = lines[lineIndex]!.trimmed === "$";
      const canOpen = marker !== "$" || loneDollar || !after || after === "\n" || !/\s/u.test(after);
      const canClose = marker !== "$" || loneDollar || (before && before !== "\n"
        ? !/\s/u.test(before) : !/[\p{L}\p{N}]/u.test(after ?? ""));
      markers[lineIndex]!.push({ line: lineIndex, part: i, text: marker, canOpen, canClose });
    }
    start = stop;
  }
  return markers;
}

function markMathLines(lines: EquationLine[]): void {
  const pairs: { open: MathMarker; close: MathMarker }[] = [];
  const scopes = new Map<Container | undefined, Map<string, MathMarker[]>>();
  const markers = mathMarkers(lines);
  for (let i = lines.length - 1; i >= 0; i--) {
    const { quote, trimmed, containers, cells, setext } = lines[i]!;
    if (cells || setext) {
      scopes.clear();
      continue;
    }
    const scope = scopes.get(quote) ?? new Map<string, MathMarker[]>();
    scopes.set(quote, scope);
    if (!trimmed) scope.delete("$");
    for (const token of markers[i]!.reverse()) {
      const marker = token.text;
      if (marker === "$" || marker === "$$") {
        const close = scope.get(marker)?.[0];
        if (token.canOpen && close && staysInContainer(containers, lines[close.line]!)) {
          pairs.push({ open: token, close });
        }
        if (token.canClose) scope.set(marker, [token]);
        else scope.delete(marker);
      } else if (marker === "\\]" || marker === "\\)" || marker.startsWith("\\end")) {
        const stack = scope.get(marker) ?? [];
        stack.push(token);
        scope.set(marker, stack);
      } else {
        const closer = mathSpanClosers.get(marker) ?? marker.replace("\\begin", "\\end");
        const stack = scope.get(closer);
        const close = stack?.at(-1);
        if (close && staysInContainer(containers, lines[close.line]!)) {
          stack!.pop();
          pairs.push({ open: token, close });
        }
      }
    }
  }
  // Consume complete spans left to right. Delimiters inside an earlier span are literal.
  let lastClose: MathMarker | undefined;
  for (const { open, close } of pairs.reverse()) {
    if (lastClose && (open.line < lastClose.line || (open.line === lastClose.line && open.part <= lastClose.part))) {
      continue;
    }
    lastClose = close;
    const depth = lines[open.line]!.containers.length;
    for (let i = open.line + 1; i <= close.line; i++) {
      lines[i]!.literalStart = lines[i]!.containers[depth - 1]?.end ?? 0;
    }
  }
}

function staysInContainer(open: EquationLine["containers"], close: EquationLine): boolean {
  return !open.length || open.at(-1)!.scope === close.containers[open.length - 1]?.scope;
}
