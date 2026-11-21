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
  paragraphBreak: boolean;
  literalStart?: number;
}

// A list item owns indented continuation lines. A task checkbox is content of the item
// and adds no indentation requirement. Each sibling item gets a distinct scope.
function markdownLines(rawLines: string[]): EquationLine[] {
  let previous: EquationLine["containers"] = [];
  return rawLines.map((raw) => {
    const containers: EquationLine["containers"] = [];
    let offset = 0;
    let quote: Container | undefined;
    for (const { scope } of previous) {
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
    for (;;) {
      const rest = raw.slice(offset);
      const prefix = /^(?:( {0,3}>[ \t]?)|( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)(?:\[[ xX]\][ \t]+)?)/u.exec(rest);
      if (!prefix) break;
      let scope: Container;
      if (prefix[1]) {
        scope = { kind: "quote" };
        quote = scope;
      } else {
        let indent = 0;
        for (const char of prefix[2]!) indent += char === "\t" ? 4 - indent % 4 : 1;
        scope = { kind: "list", indent };
      }
      offset += prefix[0].length;
      containers.push({ scope, end: offset });
    }
    previous = containers;
    const content = raw.slice(offset);
    const trimmed = content.trim();
    const fence = readFence(content);
    const heading = /^ {0,3}(?:#{1,6}(?:\s|$)|(?:=+|-+)[ \t]*$)/u.test(content);
    const thematicBreak = /^ {0,3}([_*-])(?:[ \t]*\1){2,}[ \t]*$/u.test(content);
    const paragraphBreak = !trimmed || !!fence || heading || thematicBreak;
    return { raw, containers, content, trimmed, quote, fence, paragraphBreak };
  });
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

/** Strip Markdown block prefixes only where the physical line starts in Markdown. */
export function stripEquationBlockPrefixes(text: string): string[] {
  const rawLines = text.split(/\r\n|[\r\n\u2028\u2029]/u);
  if (rawLines.length === 1) return [stripMarkdownPrefix(text)];
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
  return lines.map(({ raw, literalStart }) =>
    literalStart === undefined ? stripMarkdownPrefix(raw) : raw.slice(literalStart),
  );
}

function stripMarkdownPrefix(line: string): string {
  const containerPrefix = /^[ \t]*(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)+/;
  return line.replace(containerPrefix, "").replace(/^[ \t]*#{1,6}[ \t]+/, "");
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
    const scope = first.containers.at(-1)?.scope;
    while (
      !first.paragraphBreak && stop < lines.length &&
      !lines[stop]!.paragraphBreak && lines[stop]!.containers.at(-1)?.scope === scope
    ) {
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
    const { quote, trimmed, containers } = lines[i]!;
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
