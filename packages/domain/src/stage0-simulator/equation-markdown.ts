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

interface EquationLine {
  raw: string;
  quoteEnds: number[]; // Offset after each enclosing quote marker, starting at depth zero.
  literalStart?: number;
}

/** Strip Markdown block prefixes only where the physical line starts in Markdown. */
export function stripEquationBlockPrefixes(text: string): string[] {
  const rawLines = text.split(/\r\n|[\r\n\u2028\u2029]/u);
  if (rawLines.length === 1) return [stripMarkdownPrefix(text)];
  const lines: EquationLine[] = rawLines.map((raw) => ({
    raw,
    quoteEnds: [0, ...Array.from(raw.matchAll(/ {0,3}>[ \t]?/gy), (m) => m.index + m[0].length)],
  }));
  const fences = matchedFences(lines);
  let proseStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = fences.get(i);
    if (end === undefined) continue;
    markMathLines(lines.slice(proseStart, i));
    const depth = lines[i]!.quoteEnds.length - 1;
    for (let j = i + 1; j < end; j++) lines[j]!.literalStart = lines[j]!.quoteEnds[depth];
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

function matchedFences(lines: EquationLine[]): Map<number, number> {
  const ends = new Map<number, number>();
  const scopes: { ticks: Map<number, number>; tildes: Map<number, number> }[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const { raw, quoteEnds } = lines[i]!;
    const depth = quoteEnds.length - 1;
    scopes.length = depth + 1; // A fence cannot close across the end of its blockquote.
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(raw.slice(quoteEnds[depth]));
    if (!fence) continue;
    const run = fence[1]!;
    const info = fence[2]!;
    if (run[0] === "`" && info.includes("`")) continue;
    const scope = scopes[depth] ??= { ticks: new Map(), tildes: new Map() };
    const closers = run[0] === "`" ? scope.ticks : scope.tildes;
    const end = closers.get(run.length);
    if (end !== undefined) ends.set(i, end);
    if (/^[ \t]*$/.test(info)) {
      // A closer of width N can close any opener of the same kind up to N.
      for (let width = 3; width <= run.length; width++) closers.set(width, i);
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

/** Code spans and escaped characters cannot supply a math delimiter. */
function mathMarkers(line: string, lineIndex: number): MathMarker[] {
  const parts = line.split(/(\\?`+|\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\.|\$+)/u);
  const spanEnds = equationSpanEnds(parts);
  const markers: MathMarker[] = [];
  const loneDollar = line.trim() === "$";
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i]!;
    if (marker.endsWith("`")) {
      i = spanEnds.get(i) ?? i;
      continue;
    }
    if (!/^(?:\${1,2}$|\\[()[\]]$|\\(?:begin|end)\{)/u.test(marker)) continue;
    const before = parts[i - 1]!.at(-1) ?? parts[i - 2]?.at(-1);
    const after = parts[i + 1]![0] ?? parts[i + 2]?.[0];
    // An opening $ in later prose (e.g. "use $y$") cannot close a stray $.
    const canOpen = marker !== "$" || loneDollar || !after || !/\s/u.test(after);
    const canClose = marker !== "$" || loneDollar || (before ? !/\s/u.test(before) : !/[\p{L}\p{N}]/u.test(after ?? ""));
    markers.push({ line: lineIndex, part: i, text: marker, canOpen, canClose });
  }
  return markers;
}

function markMathLines(lines: EquationLine[]): void {
  const pairs: { open: MathMarker; close: MathMarker }[] = [];
  const scopes: Map<string, MathMarker[]>[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const { raw, quoteEnds } = lines[i]!;
    const depth = quoteEnds.length - 1;
    scopes.length = depth + 1;
    const scope = scopes[depth] ??= new Map();
    const content = raw.slice(quoteEnds[depth]);
    if (!content.trim()) scope.delete("$");
    for (const token of mathMarkers(content, i).reverse()) {
      const marker = token.text;
      if (marker === "$" || marker === "$$") {
        const close = scope.get(marker)?.[0];
        if (token.canOpen && close) pairs.push({ open: token, close });
        if (token.canClose) scope.set(marker, [token]);
        else scope.delete(marker);
      } else if (marker === "\\]" || marker === "\\)" || marker.startsWith("\\end")) {
        const stack = scope.get(marker) ?? [];
        stack.push(token);
        scope.set(marker, stack);
      } else {
        const closer = mathSpanClosers.get(marker) ?? marker.replace("\\begin", "\\end");
        const close = scope.get(closer)?.pop();
        if (close) pairs.push({ open: token, close });
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
    const depth = lines[open.line]!.quoteEnds.length - 1;
    for (let i = open.line + 1; i <= close.line; i++) lines[i]!.literalStart = lines[i]!.quoteEnds[depth];
  }
}
