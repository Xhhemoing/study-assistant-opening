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

function classifyLabel(
  rawLabel: string | undefined,
  fallbackVisibility: PedagogicalVisibility,
): { readonly kind: PedagogicalBlockKind; readonly visibility: PedagogicalVisibility } | null {
  if (!rawLabel) return null;
  const normalized = rawLabel.trim().replace(/\*$/, "").toLowerCase();
  const entry = PEDAGOGICAL_LABELS[normalized];
  if (!entry) return null;
  if (entry.visibility === "sealed" || fallbackVisibility === "sealed") {
    return { kind: entry.kind, visibility: "sealed" };
  }
  if (entry.visibility === "hint_gated" || fallbackVisibility === "hint_gated") {
    return { kind: entry.kind, visibility: "hint_gated" };
  }
  return entry;
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

function findMatchingLatexEnvEnd(text: string, envName: string, searchFrom: number): number {
  const tokenRe = /\\(begin|end)\{([a-zA-Z]+\*?)\}/g;
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
      if (stack.length === 0) return match.index + match[0].length;
    }
  }
  return text.length;
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
  if (/^[ \t]*\\begin\{([a-zA-Z]+\*?)\}/.test(raw)) {
    const env = /^[ \t]*\\begin\{([a-zA-Z]+\*?)\}/.exec(raw)![1]!;
    if (MATH_ENVS.has(env) || classifyLabel(env, "public") !== null) return true;
  }
  if (/^[ \t]*\$\$/.test(raw) && !isEscaped(raw, raw.indexOf("$$"))) return true;
  if (/^[ \t]*\\\[/.test(raw)) return true;
  if (/^[ \t]*>[ \t]*\[!([a-zA-Z_-]+)\]/.test(raw)) {
    const label = /^[ \t]*>[ \t]*\[!([a-zA-Z_-]+)\]/.exec(raw)![1]!;
    if (classifyLabel(label, "public") !== null) return true;
  }
  if (/^[ \t]{0,3}#{1,6}[ \t]+/.test(raw)) return true;
  if (raw.includes("|") && index + 1 < lines.length && isTableDelimiterRow(lines[index + 1]!.raw)) {
    return true;
  }
  if (parseInlineTranscriptCue(raw) !== null) return true;
  return false;
}

function findInlineDisplayMathSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("$$", i) && !isEscaped(text, i)) {
      const close = findUnescapedToken(text, "$$", i + 2);
      if (close !== -1) {
        spans.push({ start: i, end: close + 2 });
        i = close + 2;
        continue;
      }
      spans.push({ start: i, end: text.length });
      break;
    }
    if (text.startsWith("\\[", i) && !isEscaped(text, i)) {
      const close = findUnescapedToken(text, "\\]", i + 2);
      if (close !== -1) {
        spans.push({ start: i, end: close + 2 });
        i = close + 2;
        continue;
      }
      spans.push({ start: i, end: text.length });
      break;
    }
    if (text.startsWith("\\begin{", i) && !isEscaped(text, i)) {
      const m = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(text.slice(i));
      if (m && (MATH_ENVS.has(m[1]!) || classifyLabel(m[1]!, "public") !== null)) {
        const end = findMatchingLatexEnvEnd(text, m[1]!, i + m[0].length);
        spans.push({ start: i, end });
        i = end;
        continue;
      }
    }
    i++;
  }
  return spans;
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
  if (!text) return [];
  const defaultVisibility = options.defaultVisibility ?? "public";
  const propagateSectionVisibility = options.propagateSectionVisibility ?? true;
  const lines = splitLinesWithOffsets(text);
  const blocks: PedagogicalAstBlock[] = [];
  let activeSectionVisibility: PedagogicalVisibility = defaultVisibility;
  let activeSectionLevel = 0;

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

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const raw = line.raw;

    if (/^\s*$/.test(raw)) {
      i++;
      continue;
    }

    // 1. Heading (and section visibility propagation for Answer Key / Hint sections)
    const headingMatch = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*$/.exec(raw);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const headingText = headingMatch[2]!.trim();
      if (propagateSectionVisibility) {
        if (SEALED_HEADING_RE.test(headingText)) {
          activeSectionVisibility = "sealed";
          activeSectionLevel = level;
        } else if (HINT_HEADING_RE.test(headingText)) {
          activeSectionVisibility = defaultVisibility === "sealed" ? "sealed" : "hint_gated";
          activeSectionLevel = level;
        } else if (activeSectionLevel === 0 || level <= activeSectionLevel) {
          activeSectionVisibility = defaultVisibility;
          activeSectionLevel = 0;
        }
      }
      pushBlock("heading", activeSectionVisibility, false, line.start, line.contentEnd, {
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
      pushBlock("code", activeSectionVisibility, true, line.start, lines[endLineIdx]!.contentEnd);
      i = endLineIdx + 1;
      continue;
    }

    // 3. Fenced pedagogical container (:::theorem ... :::)
    const containerMatch = /^[ \t]{0,3}(:{3,})[ \t]*([a-zA-Z][\w-]*)(.*)$/.exec(raw);
    if (containerMatch) {
      const classified = classifyLabel(containerMatch[2], activeSectionVisibility);
      if (classified) {
        const minColons = containerMatch[1]!.length;
        const openRe = /^[ \t]{0,3}:{3,}[ \t]*[a-zA-Z][\w-]*/;
        const closeRe = new RegExp(`^[ \\t]{0,3}:{${minColons},}[ \\t]*$`);
        let depth = 1;
        let inCodeFenceChar: string | null = null;
        let inCodeFenceLen = 0;
        let j = i + 1;
        while (j < lines.length && depth > 0) {
          const cur = lines[j]!.raw;
          if (inCodeFenceChar) {
            const codeClose = new RegExp(`^[ \\t]{0,3}${inCodeFenceChar}{${inCodeFenceLen},}[ \\t]*$`);
            if (codeClose.test(cur)) inCodeFenceChar = null;
          } else {
            const innerCode = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(cur);
            if (innerCode && !(innerCode[1]![0] === "`" && innerCode[2]!.includes("`"))) {
              inCodeFenceChar = innerCode[1]![0]!;
              inCodeFenceLen = innerCode[1]!.length;
            } else if (openRe.test(cur)) {
              depth++;
            } else if (closeRe.test(cur)) {
              depth--;
              if (depth === 0) break;
            }
          }
          j++;
        }
        const endLineIdx = j < lines.length ? j : lines.length - 1;
        const label = containerMatch[3]!.trim() || containerMatch[2]!;
        pushBlock(classified.kind, classified.visibility, true, line.start, lines[endLineIdx]!.contentEnd, {
          label,
        });
        i = endLineIdx + 1;
        continue;
      }
    }

    // 4. LaTeX environment (\begin{equation|align|theorem|lemma|proof|definition|solution}...)
    const envMatch = /^[ \t]*\\begin\{([a-zA-Z]+\*?)\}/.exec(raw);
    if (envMatch) {
      const envName = envMatch[1]!;
      const isMath = MATH_ENVS.has(envName);
      const classified = isMath
        ? { kind: "display_math" as const, visibility: activeSectionVisibility }
        : classifyLabel(envName, activeSectionVisibility);
      if (classified) {
        const openEndOffset = line.start + envMatch[0].length;
        const closeEndOffset = findMatchingLatexEnvEnd(text, envName, openEndOffset);
        const endLineIdx = lineIndexContaining(lines, Math.max(line.start, closeEndOffset - 1), i);
        const endOffset = Math.max(closeEndOffset, lines[endLineIdx]!.contentEnd);
        pushBlock(classified.kind, classified.visibility, true, line.start, endOffset, {
          label: envName,
        });
        i = endLineIdx + 1;
        continue;
      }
    }

    // 5. Display math ($$...$$)
    const ddMatch = /^[ \t]*\$\$/.exec(raw);
    if (ddMatch) {
      const startOffset = line.start;
      const afterOpen = line.start + ddMatch[0].length;
      const closeOffset = findUnescapedToken(text, "$$", afterOpen);
      if (closeOffset !== -1) {
        const endLineIdx = lineIndexContaining(lines, closeOffset + 1, i);
        const endOffset = Math.max(closeOffset + 2, lines[endLineIdx]!.contentEnd);
        pushBlock("display_math", activeSectionVisibility, true, startOffset, endOffset);
        i = endLineIdx + 1;
      } else {
        pushBlock("display_math", activeSectionVisibility, true, startOffset, text.length);
        i = lines.length;
      }
      continue;
    }

    // 6. LaTeX bracket display math (\[...\])
    const bracketMatch = /^[ \t]*\\\[/.exec(raw);
    if (bracketMatch) {
      const startOffset = line.start;
      const afterOpen = line.start + bracketMatch[0].length;
      const closeOffset = findUnescapedToken(text, "\\]", afterOpen);
      if (closeOffset !== -1) {
        const endLineIdx = lineIndexContaining(lines, closeOffset + 1, i);
        const endOffset = Math.max(closeOffset + 2, lines[endLineIdx]!.contentEnd);
        pushBlock("display_math", activeSectionVisibility, true, startOffset, endOffset);
        i = endLineIdx + 1;
      } else {
        pushBlock("display_math", activeSectionVisibility, true, startOffset, text.length);
        i = lines.length;
      }
      continue;
    }

    // 7. Markdown callout (> [!theorem], > [!proof], > [!solution], ...)
    const calloutMatch = /^[ \t]*>[ \t]*\[!([a-zA-Z_-]+)\][+-]?(.*)$/.exec(raw);
    if (calloutMatch) {
      const classified = classifyLabel(calloutMatch[1], activeSectionVisibility);
      if (classified) {
        let j = i + 1;
        while (j < lines.length && /^[ \t]*>/.test(lines[j]!.raw)) j++;
        const endLineIdx = j - 1;
        const label = calloutMatch[2]!.trim() || calloutMatch[1]!;
        pushBlock(classified.kind, classified.visibility, true, line.start, lines[endLineIdx]!.contentEnd, {
          label,
        });
        i = j;
        continue;
      }
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
      pushBlock("table", activeSectionVisibility, true, line.start, lines[endLineIdx]!.contentEnd);
      i = j;
      continue;
    }

    // 9. Inline timestamped transcript cue line
    const cueTiming = parseInlineTranscriptCue(raw);
    if (cueTiming) {
      pushBlock("transcript_cue", activeSectionVisibility, true, line.start, line.contentEnd, {
        startMs: cueTiming.startMs,
        endMs: cueTiming.endMs,
      });
      i++;
      continue;
    }

    // 10. Prose paragraph (with embedded inline display-math protection)
    let j = i + 1;
    while (j < lines.length && !startsSpecialBlock(lines, j)) j++;
    const paraStart = line.start;
    const paraEnd = lines[j - 1]!.contentEnd;
    const paraText = text.slice(paraStart, paraEnd);
    const mathSpans = findInlineDisplayMathSpans(paraText);
    if (mathSpans.length === 0) {
      pushBlock("prose", activeSectionVisibility, false, paraStart, paraEnd);
    } else {
      let cursor = 0;
      for (const span of mathSpans) {
        if (span.start > cursor) {
          pushBlock("prose", activeSectionVisibility, false, paraStart + cursor, paraStart + span.start);
        }
        pushBlock("display_math", activeSectionVisibility, true, paraStart + span.start, paraStart + span.end);
        cursor = span.end;
      }
      if (cursor < paraText.length) {
        pushBlock("prose", activeSectionVisibility, false, paraStart + cursor, paraEnd);
      }
    }
    i = j;
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
