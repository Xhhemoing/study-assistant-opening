export const mathSpanClosers = new Map([["$", "$"], ["$$", "$$"], ["\\(", "\\)"], ["\\[", "\\]"]]);

interface TexMarker {
  text: string;
  index: number;
}

interface PendingCloser<T> {
  token: T;
  next?: PendingCloser<T>;
}
type TexClosers<T> = Map<string, PendingCloser<T> | undefined>;

/** Index one physical line from the right. An opener after a prose percent can
 * still use later closers. Its matches cannot change the stack for math that
 * was already open when the percent began a comment. */
function matchTexLine<T extends TexMarker>(
  markers: T[], closers: TexClosers<T>, pair: (open: T, close: T) => void,
): void {
  const firstComment = markers.findIndex((token) => token.text === "%");
  const suffix: TexClosers<T> | undefined = firstComment < 0 ? undefined : new Map();
  for (let i = markers.length - 1; i >= 0; i--) {
    const token = markers[i]!;
    const marker = token.text;
    if (marker === "%") {
      suffix!.clear();
      continue;
    }
    const target = mathSpanClosers.get(marker) ??
      (marker.startsWith("\\begin{") ? marker.replace("\\begin", "\\end") : undefined);
    if (!target && marker !== "\\]" && marker !== "\\)" && !marker.startsWith("\\end{")) continue;
    const key = target ?? marker;
    const pending = suffix && i > firstComment ? suffix : closers;
    const head = pending.has(key) ? pending.get(key) : closers.get(key);
    if (target && head) pair(token, head.token);
    if (marker === key) {
      pending.set(key, { token, next: target ? undefined : head });
    } else if (head) {
      pending.set(key, head.next);
    }
  }
}

/** Index the first matching closer to the right. The forward scan consumes each span once. */
export function equationSpanEnds(parts: readonly string[]): Map<number, number> {
  const nextFence = new Map<string, number>();
  const closers: TexClosers<TexMarker> = new Map();
  const spanEnds = new Map<number, number>();
  const line: TexMarker[] = [];
  const finishLine = () => {
    matchTexLine(line.reverse(), closers, (open, close) => spanEnds.set(open.index, close.index));
    line.length = 0;
  };
  for (let i = parts.length - 2; i > 0; i -= 2) {
    const marker = parts[i]!;
    if (marker === "\n" || parts[i + 1]!.includes("\n")) finishLine();
    if (!marker.endsWith("`")) {
      if (marker === "%" || marker.startsWith("$") || marker.startsWith("\\")) line.push({ text: marker, index: i });
      continue;
    }
    // A backslash escapes the first opening tick, but is literal inside code.
    const escapedTick = marker.startsWith("\\`");
    const fence = escapedTick ? marker.slice(1) : marker;
    const closer = escapedTick ? fence.slice(1) : fence;
    const end = closer ? nextFence.get(closer) : undefined;
    if (end !== undefined) spanEnds.set(i, end);
    nextFence.set(fence, i);
  }
  finishLine();
  return spanEnds;
}

type Container = { kind: "quote" } | { kind: "list"; indent: number; delimiter: string };
type ContainerPrefix = { scope: Container; end: number };

interface EquationLine {
  raw: string;
  containers: ContainerPrefix[];
  scope: ContainerPrefix[];
  content: string;
  fence?: { indent: number; run: string; canClose: boolean };
  display?: DisplayPair;
  paragraph?: number;
  cells?: string[];
  literalBlock?: boolean;
}

function continuedContainers(raw: string, activeContainers: ContainerPrefix[]) {
  const containers: ContainerPrefix[] = [];
  let offset = 0;
  for (const { scope } of activeContainers) {
    const rest = raw.slice(offset);
    if (scope.kind === "quote") {
      const prefix = /^ {0,3}>[ \t]?/.exec(rest);
      if (!prefix) break;
      offset += prefix[0].length;
    } else {
      const indent = continuationIndent(rest, scope.indent);
      if (indent === undefined) break;
      offset += indent;
    }
    containers.push({ scope, end: offset });
  }
  return containers;
}

// Task checkboxes belong to the item content. Each sibling item opens a new scope.
function markdownLine(raw: string, index: number, previous?: EquationLine): EquationLine {
  const activeContainers = previous?.scope ?? [];
  const containers = continuedContainers(raw, activeContainers);
  let offset = containers.at(-1)?.end ?? 0;
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
      offset += quotePrefix[0].length;
    } else {
      const item = listPrefix(rest);
      if (!item) break;
      const outer = activeContainers[containers.length]?.scope;
      const sibling = outer?.kind === "list" && outer.delimiter === item.delimiter;
      if (paragraphOpen && !item.interrupts && !sibling) break;
      scope = { kind: "list", indent: item.indent, delimiter: item.delimiter };
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
  const line: EquationLine = { raw, containers, scope: containers, content, fence, literalBlock: indented };
  if (!block) {
    line.paragraph = paragraphOpen ? previous!.paragraph : index;
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

  if (paragraphOpen && !block && !sameScope) line.scope = activeContainers;
  return line;
}

/** Read the rest of one paragraph before deciding whether an earlier inline span owns a possible
 * display opener. A following table delimiter may turn the last line into a header. */
function paragraphMathMarkers(rawLines: string[], parsed: EquationLine[], first: number, column: number): Set<number>[] | undefined {
  const paragraph = parsed.slice(first);
  // The first display candidate is visible if no earlier inline span can own it.
  if (!paragraph.some((line, i) => /[`$\\]/u.test(
    i === paragraph.length - 1 ? line.content.slice(0, column) : line.content,
  ))) return undefined;
  // Lookahead may classify its previous line as a header. Keep the real parser state intact.
  paragraph[paragraph.length - 1] = { ...paragraph.at(-1)! };
  for (let j = parsed.length; j < rawLines.length; j++) {
    const previous = paragraph.at(-1)!;
    const next = markdownLine(rawLines[j]!, j, previous);
    if (previous.paragraph !== first) paragraph.pop();
    if (next.paragraph !== first) break;
    paragraph.push(next);
  }
  return mathMarkers(paragraph);
}

interface DisplayCloser {
  line: number;
  column: number;
  length: number;
}

interface DisplayPair {
  column: number;
  opener: string;
  close: DisplayCloser;
}

function markdownLines(rawLines: string[], fences?: Map<number, number>, displays?: Map<number, DisplayPair[]>): EquationLine[] {
  const lines: EquationLine[] = [];
  let checkedParagraph: number | undefined;
  let visibleMath: Set<number>[] | undefined;
  for (let i = 0; i < rawLines.length; i++) {
    const line = markdownLine(rawLines[i]!, i, lines.at(-1));
    lines.push(line);
    let end = fences?.get(i);
    const candidates = displays?.get(i);
    if ((end === undefined && !candidates) || line.cells || line.literalBlock) continue;
    if (line.content.includes("|") && i + 1 < rawLines.length) {
      const header = { ...line };
      markdownLine(rawLines[i + 1]!, i + 1, header);
      if (header.cells) continue;
    }
    if (end === undefined) {
      const first = line.paragraph;
      if (first === undefined) continue;
      if (first !== checkedParagraph) {
        visibleMath = paragraphMathMarkers(rawLines, lines, first, candidates![0]!.column);
        checkedParagraph = first;
      }
      const display = candidates?.find(({ column }) => !visibleMath || visibleMath[i - first]?.has(column));
      if (!display) continue;
      line.display = display;
      end = display.close.line;
    }
    // A closed display or fence owns its body. Only the enclosing quote/list
    // prefixes are structural there, including on its closing line.
    line.literalBlock = true;
    line.paragraph = undefined;
    line.scope = line.containers;
    while (i < end) {
      const raw = rawLines[++i]!;
      const containers = continuedContainers(raw, line.scope);
      const content = raw.slice(containers.at(-1)?.end ?? 0);
      lines.push({ raw, content, containers, scope: line.scope, literalBlock: true });
    }
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
  return { indent, end, interrupts, code, delimiter: marker!.at(-1)! };
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

type EquationBlock = string | string[] | { math: string };

/** Keep paragraphs, GFM cells and TeX displays intact for their respective inline scans. */
export function equationMarkdownBlocks(text: string): EquationBlock[] {
  const rawLines = text.split(/\r\n|[\r\n\u2028\u2029]/u);
  if (rawLines.length === 1 && !/^[ \t>+*#\d-]/u.test(text)) return [text];
  const initial = markdownLines(rawLines);
  const fences = matchedFences(initial);
  const displays = matchedDisplays(initial);
  const lines = fences.size || displays.size ? markdownLines(rawLines, fences, displays) : initial;
  const blocks: EquationBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.display) {
      const { column, opener, close } = line.display;
      const afterOpener = line.content.slice(column + opener.length);
      const prefix = opener === "$$" ? afterOpener : line.content.slice(0, column);
      if (prefix.trim()) blocks.push(prefix); // Fence metadata or prose before a TeX display.
      const body = [opener === "$$" ? "" : afterOpener];
      while (++i < close.line) body.push(lines[i]!.content);
      const last = lines[i]!;
      body.push(last.raw.slice(last.raw.length - last.content.length, close.column));
      blocks.push({ math: body.join("\n") });
      const suffix = last.raw.slice(close.column + close.length);
      if (suffix.trim()) blocks.push(suffix);
    } else if (line.paragraph !== undefined) {
      const parts = [line.content];
      while (i + 1 < lines.length && lines[i + 1]!.paragraph === line.paragraph) {
        parts.push(lines[++i]!.content);
      }
      blocks.push(parts.join("\n"));
    } else {
      blocks.push(line.cells ?? (line.literalBlock ? line.content : line.content.replace(/^ {0,3}#{1,6}[ \t]+/, "")));
    }
  }
  return blocks;
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

/** Inside a paragraph, an earlier closed code or math span owns its delimiters. */
function mathMarkers(lines: EquationLine[]): Set<number>[] {
  const columns = lines.map(() => new Set<number>());
  const paragraph = lines.map((line) => line.content).join("\n");
  const parts = paragraph.split(/(\\?`+|\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\.|\$+|%|\n)/u);
  const spanEnds = equationSpanEnds(parts);
  let spanEnd = -1;
  let line = 0;
  let column = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i]!;
    const start = column + parts[i - 1]!.length;
    column = start + marker.length;
    if (marker === "\n") {
      line++;
      column = 0;
    } else if (i > spanEnd) {
      if (marker === "$$" || marker === "\\[" || marker.startsWith("\\begin{")) columns[line]!.add(start);
      spanEnd = spanEnds.get(i) ?? i;
    }
  }
  return columns;
}

/** Index possible display closers even in table- or list-looking text. The forward
 * Markdown pass gives ownership to the first actual opener and skips its body. */
function matchedDisplays(lines: EquationLine[]): Map<number, DisplayPair[]> {
  const ends = new Map<number, DisplayPair[]>();
  const scopes = new Map<Container | undefined, TexClosers<TexMarker & { line: number }>>();
  const dollarClosers = new Map<Container | undefined, DisplayCloser>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const { raw, content, containers } = lines[i]!;
    const dollars = /^( {0,3})\$\$([^$\r\n]*)$/u.exec(content);
    if (!dollars && !content.includes("\\")) continue;
    const pairs: DisplayPair[] = [];
    const contentStart = raw.length - content.length;
    const tokens = dollars ? [] : Array.from(content.matchAll(/\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\.|%/gu),
      (match) => ({ text: match[0], line: i, index: match.index + contentStart }));
    for (let depth = containers.length; depth >= 0; depth--) {
      const parent = containers[depth - 1];
      const indent = raw.slice(parent?.end ?? 0, contentStart);
      if (/\S/u.test(indent)) break;
      if (dollars) {
        const column = dollars[1]!.length;
        // The closer must be bare and within three spaces of this container.
        if (!/^ {0,3}$/u.test(indent + dollars[1])) break;
        const close = dollarClosers.get(parent?.scope);
        if (depth === containers.length && close) pairs.push({ column, opener: "$$", close });
        if (/^[ \t]*$/u.test(dollars[2]!)) {
          dollarClosers.set(parent?.scope, { line: i, column: contentStart + column, length: 2 });
        }
        continue;
      }
      const closers = scopes.get(parent?.scope) ?? new Map();
      scopes.set(parent?.scope, closers);
      matchTexLine(tokens, closers, (open, end) => {
        if (depth === containers.length && end.line > i && open.text !== "\\(") {
          const close = { line: end.line, column: end.index, length: end.text.length };
          pairs.push({ column: open.index - contentStart, opener: open.text, close });
        }
      });
    }
    if (pairs.length) ends.set(i, pairs.reverse());
  }
  return ends;
}
