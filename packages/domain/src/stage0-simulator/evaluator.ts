import {
  DEFAULT_STAGE0_GATE_THRESHOLDS,
  STAGE0_PERSONA_IDS,
  Stage0ValidationError,
  createXoshiro128StarStar,
  type Stage0EpisodeResult,
  type Stage0EpisodeSpec,
  type Stage0EvaluationReport,
  type Stage0FailingWitness,
  type Stage0GateCheck,
  type Stage0GateThresholds,
  type Stage0MatrixCoverage,
  type Stage0PersonaBreakdown,
  type Stage0PersonaId,
  type Stage0TurnRecord,
  type Stage0TutorPolicy,
  type Stage0TutorResponse,
  type Stage0TutorTurnInput,
} from "./types";
import {
  STAGE0_DEFAULT_MAX_TURNS,
  STAGE0_DEFAULT_SEED,
  STAGE0_EXPECTED_EPISODE_COUNT,
  generateStage0Episodes,
} from "./episodes";
import { equationMarkdownBlocks, equationSpanEnds, mathSpanClosers } from "./equation-markdown";
import {
  advanceStudentAfterTutorTurn,
  buildInitialStudentUtterance,
  computeDay7TransferProbability,
  createInitialStudentState,
} from "./personas";

function normalizeLatexFractions(text: string): string {
  if (!/\\[dtc]?frac\s*\{/i.test(text)) return text;
  const openings: number[] = [];
  const closingBrace = new Map<number, number>();
  for (const token of text.matchAll(/\\[\\{}]|[{}]/g)) {
    if (token[0] === "{") openings.push(token.index);
    if (token[0] === "}") {
      const open = openings.pop();
      if (open !== undefined) closingBrace.set(open, token.index);
    }
  }

  // Change only command/argument delimiters. Nested commands retain their original indices.
  const output = text.split("");
  for (const command of text.matchAll(/\\[dtc]?frac\s*(?=\{)/gi)) {
    const numOpen = command.index + command[0].length;
    const numClose = closingBrace.get(numOpen);
    if (numClose === undefined) continue;
    let denOpen = numClose + 1;
    while (denOpen < text.length && /\s/.test(text[denOpen]!)) denOpen += 1;
    const denClose = closingBrace.get(denOpen);
    if (denClose === undefined) continue;

    // Keep a plain integer fraction in literal form for protected tokens such as "3/4".
    const simple = /^\s*[+-]?\d+\s*$/;
    const bare =
      simple.test(text.slice(numOpen + 1, numClose)) && simple.test(text.slice(denOpen + 1, denClose));
    output.fill("", command.index, numOpen);
    output[numOpen] = bare ? "" : "(";
    output[numClose] = bare ? "/" : ")/";
    output[denOpen] = bare ? "" : "(";
    output[denClose] = bare ? "" : ")";
  }
  return output.join("");
}

function normalizeUnicodeMath(text: string): string {
  const normalized = text.normalize("NFKC").replace(/[\u2212\u2010\u2011\u2012\u2013\u2014]/g, "-");
  return normalizeLatexFractions(normalized)
    .replace(/\\(?:left|right)\b/gi, "")
    .replace(/\\\{/g, "{")
    .replace(/\\\}/g, "}")
    .replace(/\\div(?![a-z])/gi, "/")
    .replace(/[\u00F7\u2044\u2215]/g, "/")
    .replace(/\\(?:times|cdot)(?![a-z])/gi, "*")
    .replace(/[\u00D7\u00B7\u22C5]/g, "*")
    .replace(/\\leq?(?![a-z])|≤/gi, "<=")
    .replace(/\\geq?(?![a-z])|≥/gi, ">=")
    .replace(/\\neq?(?![a-z])|≠/gi, "!=")
    .replace(/\\approx(?![a-z])/gi, "≈")
    .replace(/\\equiv(?![a-z])/gi, "≡")
    .toLowerCase();
}

function normalizeForLeakScan(text: string): string {
  return normalizeUnicodeMath(text).replace(/\s+/g, " ").trim();
}

/**
 * Strips whitespace around math delimiters and operators so compact forms
 * (e.g. "{0,2}", "(1,-1)", "x=2", "3 ÷ 4", "\frac{3}{4}") match canonical targets.
 */
function normalizeCompactForLeakScan(text: string): string {
  return normalizeForLeakScan(text).replace(
    /\s*(!=|[,;:=+*/^<>≈≡{}()[\]|-])\s*/g,
    "$1",
  );
}

/** Expose Markdown block boundaries and inline equation text before math compaction. */
function stripEquationFormatting(text: string): string {
  const formattedBlocks = equationMarkdownBlocks(text).map((block) => {
    if (Array.isArray(block)) return block.map(stripEquationSegment).join(";");
    if (typeof block !== "string") return stripEquationSegment(normalizeMathLayout(block.math));
    const formatted = stripEquationLine(block);
    if (!formatted.includes("\n")) return formatted;
    const math = normalizeUnicodeMath(formatted).replace(/[^\S\n]+/gu, " ");
    const soft = math.replaceAll("\n", " ");
    // Also audit complete equations at physical line starts (e.g. after "Step 2").
    // A break beside an operator cannot cut the operator away from its operand.
    const physical = math.replace(/ ?\n ?/gu, (gap: string, index: number) => {
      const adjacent = (math[index - 1] ?? "") + (math[index + gap.length] ?? "");
      return /[+*/^=<>!≈≡%-]/u.test(adjacent) ? " " : ";";
    });
    return soft === physical ? soft : soft + ";" + physical;
  });
  return normalizeAlignment(formattedBlocks.join(";"), "&");
}

const equationMarkers = /(\\?`+|\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\[\\|$()[\]]|\*+|_+|~~|\$\$?|\|)/u;

function splitEquationCells(parts: string[], spanEnds?: Map<number, number>): string[] {
  const cells: string[] = [];
  let start = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const end = spanEnds?.get(i);
    if (end !== undefined) {
      i = end;
    } else if (parts[i] === "|") {
      cells.push(parts.slice(start, i).join(""));
      start = i + 1;
    }
  }
  cells.push(parts.slice(start).join(""));
  return cells;
}

function stripEquationLine(line: string): string {
  if (!line.includes("|")) return stripEquationSegment(line);
  const { parts, spanEnds } = inlineEquationParts(line);
  const cells = splitEquationCells(parts);
  const inlineSegments = splitEquationCells(parts, spanEnds);
  // Inline spans can only hide a cell boundary. Equal counts give identical segments.
  const candidates = cells.length === inlineSegments.length ? cells : cells.concat(inlineSegments);
  return candidates.map(stripEquationSegment).join(";");
}

const texRelation = /[=:!<>]?=|[<>≈≡≤≥≠]|\\(?:approx|equiv|cong|sim|simeq|leq?|geq?|neq?)(?![A-Za-z])/u;
const startsWithRelation = new RegExp(`^\\s*(?:${texRelation.source})`, "u");
const endsWithRelation = new RegExp(`(?:${texRelation.source})\\s*$`, "u");
const variableRelation = new RegExp(`^[a-z]\\w*(?:${texRelation.source})`, "u");
const relationWithOperand = new RegExp(String.raw`(?:${texRelation.source})\s*[+-]?\s*[\p{L}\p{N}\\([{.]`, "u");
const numberedLabel = /(?:^|[^\s+*/^=-])\s*(?:\b(?:step|item|part|line|row|case|eq(?:uation)?|formula|problem|question|exercise|example|option|choice|turn|stage|point|section|rule|hint|move|no\.?)\s+|#)\d+[.)]?\s+$/iu;

/** Only an unescaped alignment tab next to a relation joins its two columns. */
function normalizeAlignment(text: string, separator: "&" | ";"): string {
  if (!text.includes("&")) return text;
  const columns: string[] = [];
  let start = 0;
  const tokens = /\\.|&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][\da-fA-F]+);|&/gu;
  for (const { 0: token, index } of text.matchAll(tokens)) {
    if (token !== "&") continue;
    columns.push(text.slice(start, index));
    start = index + 1;
  }
  if (!columns.length) return text;
  columns.push(text.slice(start));
  return columns.map((value, i) =>
    i > 0 && !endsWithRelation.test(columns[i - 1]!) && !startsWithRelation.test(value) ? separator + value : value,
  ).join("");
}

function normalizeMathLayout(text: string): string {
  // A comment may itself contain a closing bracket for a row's spacing argument.
  const visible = text.replace(/(?<!\\)((?:\\\\)*)%[^\n]*/gu, "$1");
  const tokens = /\\\\(?:\s*\*)?(?:\s*\[[^\]]*\])?|\\(?:begin|end)\{[a-zA-Z]+\*?\}|\\.|\n/gu;
  const layout = visible.replace(tokens, (token) => {
    if (token.startsWith("\\\\")) return ";";
    if (token === "\n" || /^\\[ ,;!]$/u.test(token)) return " ";
    if (token.startsWith("\\begin{") || token.startsWith("\\end{")) return "";
    return token;
  });
  return normalizeAlignment(layout, ";");
}

/** Normalize each complete formula before either interpretation of a pipe splits it. */
function inlineEquationParts(segment: string) {
  const raw = segment.split(equationMarkers);
  const pairs = equationSpanEnds(raw);
  const mathSpans: [number, number][] = [];
  if (!pairs.size) return { parts: raw, spanEnds: pairs, mathSpans };
  const parts = [raw[0]!];
  const spanEnds = new Map<number, number>();
  for (let i = 1; i < raw.length; i += 2) {
    const marker = raw[i]!;
    const open = parts.length;
    parts.push(marker);
    const end = pairs.get(i);
    if (end !== undefined) {
      let body = raw.slice(i + 1, end);
      if (mathSpanClosers.has(marker) || marker.startsWith("\\begin{")) {
        // A row command and its modifiers can span several Markdown marker tokens.
        body = normalizeMathLayout(body.join("")).split(equationMarkers);
        mathSpans.push([open, parts.length + body.length]);
      }
      for (const part of body) parts.push(part);
      spanEnds.set(open, parts.length);
      parts.push(raw[end]!);
      i = end;
    }
    parts.push(raw[i + 1]!);
  }
  return { parts, spanEnds, mathSpans };
}

function stripEquationSegment(segment: string): string {
  const { parts, spanEnds, mathSpans } = inlineEquationParts(segment);
  const hardBreak = /(?: {2}|\\)\n/gu;
  if (parts.length === 1) return segment.replace(hardBreak, ";");
  parts[0] = parts[0]!.replace(hardBreak, ";");
  const cellOpeners = new Map<string, number[]>();
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i]!;
    const end = spanEnds.get(i);
    if (end !== undefined) {
      // Audit the span text in isolation. Its pipes and markers belong to
      // its content, while emphasis around the whole span stays in this cell.
      const spanOpeners = new Map<string, number[]>();
      for (let j = i + 2; j < end; j += 2) stripEquationMarker(parts, j, spanOpeners);
      parts[i] = marker.startsWith("\\`") ? "\\`" : "";
      parts[end] = parts[end]!.startsWith("\\`") ? "\\" : "";
      i = end;
    } else {
      stripEquationMarker(parts, i, cellOpeners);
    }
    // The body of a closed code/math span has already been consumed above.
    parts[i + 1] = parts[i + 1]!.replace(hardBreak, ";");
  }
  // A number can introduce a complete formula. Before a fragment such as $x$,
  // only an explicit prose label distinguishes that number from a coefficient.
  let proseStart = 0;
  for (const [open, close] of mathSpans) {
    const prose = normalizeUnicodeMath(parts.slice(proseStart, open).join(""));
    if (/\d[.)]?\s+$/u.test(prose)) {
      const body = normalizeUnicodeMath(parts.slice(open + 1, close).join(""));
      if (/^\s*\p{L}/u.test(body) && (relationWithOperand.test(body) || numberedLabel.test(prose))) {
        parts[open] = ";";
      }
    }
    proseStart = close + 1;
  }
  return parts.join("");
}

function stripEquationMarker(parts: string[], i: number, openings: Map<string, number[]>): void {
  const marker = parts[i]!;
  if (marker === "\\(" || marker === "\\[") {
    openings.set(mathSpanClosers.get(marker)!, [i]);
    return;
  }
  const emphasis = /^[*_~]/.test(marker);
  if (!emphasis && !/^(?:`+|\$\$?|\\[)\]])$/.test(marker)) return;
  const before = parts[i - 1]!;
  const after = parts[i + 1]!;
  // Emphasis touches its content. Keep markers attached to an outer operand
  // so multiplication and identifier continuations reach the boundary check.
  const canOpen = !emphasis || (!/[\p{L}\p{M}\p{N})\]}]$/u.test(before) && !/^\s/.test(after));
  const canClose = !emphasis || (!/\s$/.test(before) && !/^[\p{L}\p{M}\p{N}([{]/u.test(after));
  // A single emphasis run may close multiple openers or close in stages.
  const kind = emphasis ? marker[0]! : marker;
  const stack = openings.get(kind) ?? [];
  let remaining = marker.length;
  while (canClose && remaining > 0 && stack.length > 0) {
    const opening = stack[stack.length - 1]!;
    const opener = parts[opening]!;
    const paired = Math.min(opener.length, remaining);
    parts[opening] = opener.slice(paired);
    remaining -= paired;
    if (!parts[opening]) stack.pop();
  }
  parts[i] = marker.slice(marker.length - remaining);
  if (remaining > 0 && !marker.startsWith("\\") && canOpen) {
    stack.push(i);
    openings.set(kind, stack);
  }
}

/**
 * Preserves whitespace around `-`/`+` (so prose words like `"Use -7.5e-1."` keep
 * their boundary before unary `-`) while compacting `*`, `/`, `^`, and exponent brackets.
 */
function normalizeNumericScanText(text: string): string {
  return normalizeForLeakScan(text)
    .replace(/\s*([*/^])\s*/g, "$1")
    .replace(/10\^\{\s*([+-]?)\s*(\d+)\s*\}/g, "10^{$1$2}")
    .replace(/10\^\(\s*([+-]?)\s*(\d+)\s*\)/g, "10^($1$2)")
    .replace(/10\^([+-])\s+(\d+)/g, "10^$1$2");
}

/**
 * Returns true iff the token immediately before a `-` at `signIndex` is a math
 * operand (number, closing bracket, or single-letter math variable like `x` or `2x`),
 * meaning `-` is binary subtraction rather than a unary negative sign on the literal.
 */
function isBinaryOperandBefore(text: string, signIndex: number): boolean {
  let operandEnd = signIndex - 1;
  while (operandEnd >= 0 && text[operandEnd] === " ") operandEnd -= 1;
  const last = text[operandEnd] ?? "";
  return (
    /[\d)\]}]/.test(last) ||
    (/[a-z]/.test(last) && !/[a-z]/.test(text[operandEnd - 1] ?? ""))
  );
}

interface SignedMathSpan {
  start: number;
  end: number;
  negative: boolean;
}

function readSignedMathSpan(text: string, start: number, end: number): SignedMathSpan {
  let negative = false;
  // Extend the token only across unary signs and complete pairs of enclosing delimiters.
  while (start > 0) {
    let left = start - 1;
    while (left >= 0 && text[left] === " ") left -= 1;
    const preceding = text[left];
    if (preceding === "-" || preceding === "+") {
      if (isBinaryOperandBefore(text, left)) break;
      if (preceding === "-") negative = !negative;
      start = left;
      continue;
    }
    let right = end;
    while (right < text.length && text[right] === " ") right += 1;
    const closesGroup =
      (preceding === "(" && text[right] === ")") ||
      (preceding === "[" && text[right] === "]") ||
      (preceding === "{" && text[right] === "}");
    if (!closesGroup) break;
    start = left;
    end = right + 1;
  }
  return { start, end, negative };
}

function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_SCIENTIFIC_EXPONENT = 64;
const MAX_DECIMAL_MANTISSA_DIGITS = 64;

interface ExactRational {
  readonly num: bigint;
  readonly den: bigint;
}

function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function makeExactRational(num: bigint, den: bigint): ExactRational | null {
  if (den === 0n) return null;
  const sign = den < 0n ? -1n : 1n;
  const sNum = num * sign;
  const sDen = den * sign;
  if (sNum === 0n) return { num: 0n, den: 1n };
  const g = gcdBigInt(sNum, sDen);
  return { num: sNum / g, den: sDen / g };
}

function rationalsEqual(a: ExactRational, b: ExactRational): boolean {
  return a.num === b.num && a.den === b.den;
}

function parsePureRationalOrDecimalToken(compactToken: string): ExactRational | null {
  const fracMatch = /^([+-]?\d+)\/(\d+)$/.exec(compactToken);
  if (fracMatch) {
    const numStr = fracMatch[1]!;
    const denStr = fracMatch[2]!;
    if (numStr.length > MAX_DECIMAL_MANTISSA_DIGITS || denStr.length > MAX_DECIMAL_MANTISSA_DIGITS) {
      return null;
    }
    return makeExactRational(BigInt(numStr), BigInt(denStr));
  }
  const decMatch = /^([+-]?)(?:(\d+)\.(\d+)|\.(\d+))$/.exec(compactToken);
  if (decMatch) {
    const signStr = decMatch[1] ?? "";
    const intPart = decMatch[2] ?? "0";
    const fracPart = decMatch[3] ?? decMatch[4] ?? "";
    if (intPart.length + fracPart.length > MAX_DECIMAL_MANTISSA_DIGITS) {
      return null;
    }
    const digits = `${intPart}${fracPart}`;
    const num = BigInt(`${signStr === "-" ? "-" : ""}${digits}`);
    const den = 10n ** BigInt(fracPart.length);
    return makeExactRational(num, den);
  }
  return null;
}

function parseScientificToExactRational(
  mantissaRaw: string,
  expRaw: string,
): ExactRational | null {
  if (!/^[+-]?\d+$/.test(expRaw)) return null;
  const expNum = Number(expRaw);
  if (!Number.isSafeInteger(expNum) || Math.abs(expNum) > MAX_SCIENTIFIC_EXPONENT) {
    return null;
  }

  const mMatch = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(mantissaRaw);
  if (!mMatch) return null;
  const signStr = mMatch[1] ?? "";
  const intPart = mMatch[2] ?? "0";
  const fracPart = mMatch[3] ?? mMatch[4] ?? "";
  if (intPart.length + fracPart.length > MAX_DECIMAL_MANTISSA_DIGITS) {
    return null;
  }

  const combinedDigits = `${intPart}${fracPart}`;
  if (combinedDigits.length === 0) return null;
  const signedMantissa = BigInt(`${signStr === "-" ? "-" : ""}${combinedDigits}`);
  const netExp = expNum - fracPart.length;
  if (Math.abs(netExp) > MAX_SCIENTIFIC_EXPONENT + MAX_DECIMAL_MANTISSA_DIGITS) {
    return null;
  }

  if (netExp >= 0) {
    return makeExactRational(signedMantissa * 10n ** BigInt(netExp), 1n);
  }
  return makeExactRational(signedMantissa, 10n ** BigInt(-netExp));
}

/**
 * Extracts exact reduced `BigInt` rationals from E-notation (`7.50e-1`, `-7.5e-1`, `-(7.5e-1)`)
 * and base-10 scientific notation (`7.5 * 10^{-1}`, `-7.5 × 10^-1`) on whitespace-preserving
 * numeric-scan text so unary negative signs after prose words (`"Use -7.5e-1."`) stay negative.
 */
function extractScientificRationals(numericText: string): readonly ExactRational[] {
  const out: ExactRational[] = [];

  // 1) E-notation: e.g. 7.50e-1, 75e-2, 0.075e+1, -7.5e-1, -(7.5e-1)
  const eNotationPattern =
    /(?<![\d.])(\d+(?:\.\d*)?|\.\d+)[eE]([+-]?\d+)(?!\d|\.\d|[eE][+-]?\d)/g;
  for (const m of numericText.matchAll(eNotationPattern)) {
    const startIdx = m.index ?? 0;
    const endIdx = startIdx + m[0].length;
    const isNeg = readSignedMathSpan(numericText, startIdx, endIdx).negative;
    const rat = parseScientificToExactRational(`${isNeg ? "-" : ""}${m[1]!}`, m[2]!);
    if (rat) out.push(rat);
  }

  // 2) Base-10 scientific notation (post-Unicode/LaTeX normalization: \times/\cdot/×/· -> *):
  //    e.g. 7.5*10^{-1}, -7.5*10^-1, -(7.5*10^{-1})
  const pow10Pattern =
    /(?<![\d.])(\d+(?:\.\d*)?|\.\d+)\*10\^(?:\{([+-]?\d+)\}|\(([+-]?\d+)\)|([+-]?\d+))(?!\d|\.\d|[eE][+-]?\d)/g;
  for (const m of numericText.matchAll(pow10Pattern)) {
    const startIdx = m.index ?? 0;
    const endIdx = startIdx + m[0].length;
    const isNeg = readSignedMathSpan(numericText, startIdx, endIdx).negative;
    const expStr = m[2] ?? m[3] ?? m[4]!;
    const rat = parseScientificToExactRational(`${isNeg ? "-" : ""}${m[1]!}`, expStr);
    if (rat) out.push(rat);
  }

  return out;
}

function isStandaloneFraction(text: string, span: SignedMathSpan): boolean {
  const prefix = text.slice(Math.max(0, span.start - 3), span.start);
  const continuation = /\d|\.\d|\/|e[+-]?\d|\*10\^(?:\{[+-]?\d+\}|\([+-]?\d+\)|[+-]?\d+)/iy;
  continuation.lastIndex = span.end;
  return !/(?:[\d./]|\de[+-]?)$/i.test(prefix) && !continuation.test(text);
}

/** Evaluate signed integer quotients, reducing parenthesized subquotients before their parents. */
function extractFractionRationals(numericText: string): readonly ExactRational[] {
  const out: ExactRational[] = [];
  if (!numericText.includes("/")) return out;
  const pending: { span: SignedMathSpan; value: ExactRational }[] = [];
  for (const match of numericText.matchAll(/\d+/g)) {
    const digits = match[0];
    if (digits.length > MAX_DECIMAL_MANTISSA_DIGITS) continue;
    let span = readSignedMathSpan(numericText, match.index, match.index + digits.length);
    const integer = BigInt(digits);
    let value: ExactRational | null = { num: span.negative ? -integer : integer, den: 1n };
    let canBeOperand = true;
    while (value && canBeOperand && pending.length > 0) {
      const numerator = pending[pending.length - 1]!;
      if (numerator.span.end + 1 !== span.start) break;
      pending.pop();
      const quotient = readSignedMathSpan(numericText, numerator.span.start, span.end);
      const num = numerator.value.num * value.den;
      value = makeExactRational(quotient.negative ? -num : num, numerator.value.den * value.num);
      if (value && isStandaloneFraction(numericText, quotient)) out.push(value);
      // A quotient can participate in another division only with an explicit enclosing group.
      // This evaluates (6/2)/4 and 6/(16/2) while excluding ungrouped dates and paths.
      canBeOperand = quotient.end > span.end;
      span = quotient;
    }
    if (value && canBeOperand && numericText[span.end] === "/") {
      pending.push({ span, value });
    }
  }
  return out;
}

function matchesWithNumericBoundaries(numericText: string, numericLiteral: string): boolean {
  const expectNegative = numericLiteral.startsWith("-");
  const absLiteral = expectNegative ? numericLiteral.slice(1) : numericLiteral;
  const trailingZeros = absLiteral.includes(".") ? "0*" : "";
  const re = new RegExp(
    `(?<![\\d.]|\\d[eE][+-]?)${escapeRegExp(absLiteral)}${trailingZeros}(?!\\d|\\.\\d|[eE][+-]?\\d|\\*10\\^(?:\\{[+-]?\\d+\\}|\\([+-]?\\d+\\)|[+-]?\\d+))`,
    "g",
  );
  for (const m of numericText.matchAll(re)) {
    const startIdx = m.index ?? 0;
    const endIdx = startIdx + m[0].length;
    const span = readSignedMathSpan(numericText, startIdx, endIdx);
    if (
      span.negative === expectNegative &&
      (!absLiteral.includes("/") || isStandaloneFraction(numericText, span))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * For an exact rational sealed token `p/q` whose reduced denominator has only
 * prime factors 2 and 5 (exact terminating decimal, e.g. `3/4` -> `0.75`, `7/8` -> `0.875`),
 * returns the exact terminating decimal string(s) for boundary-guarded leakage checks.
 */
function exactDecimalVariantsForRationalToken(compactToken: string): readonly string[] {
  const match = /^(-?\d+)\/(\d+)$/.exec(compactToken);
  if (!match) return [];
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 1) return [];

  const g = gcdInt(num, den);
  const rNum = num / g;
  const rDen = den / g;
  if (rDen <= 1) return [];

  let rem = rDen;
  let pow2 = 0;
  let pow5 = 0;
  while (rem % 2 === 0) {
    rem /= 2;
    pow2 += 1;
  }
  while (rem % 5 === 0) {
    rem /= 5;
    pow5 += 1;
  }
  if (rem !== 1) return [];

  const decimalPlaces = Math.max(pow2, pow5);
  if (decimalPlaces < 1 || decimalPlaces > 6) return [];

  const exactDecimal = (rNum / rDen).toFixed(decimalPlaces).replace(/(\.\d*?[1-9])0+$/, "$1");
  const variants = [exactDecimal];
  if (exactDecimal.startsWith("0.")) {
    variants.push(exactDecimal.slice(1)); // e.g. ".75"
  } else if (exactDecimal.startsWith("-0.")) {
    variants.push(`-${exactDecimal.slice(2)}`); // e.g. "-.75"
  }
  return variants;
}

const STAGE0_FORBIDDEN_PROTO_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function snapshotProtectedTokenList(rawTokens: unknown, label: string): readonly string[] {
  if (!Array.isArray(rawTokens)) {
    throw new Stage0ValidationError(
      `Stage-0 ${label} must be a plain dense string array.`,
      "tampered_episode",
    );
  }
  assertStrictPlainStage0Container(rawTokens, label);
  const out: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const desc = Object.getOwnPropertyDescriptor(rawTokens, i);
    if (!desc || !desc.enumerable || desc.get || desc.set || typeof desc.value !== "string") {
      throw new Stage0ValidationError(
        `Stage-0 rejected sparse, accessor, non-enumerable, or non-string token at ${label}[${i}].`,
        "tampered_episode",
      );
    }
    out.push(desc.value);
  }
  return out;
}

/**
 * Independently audits released tutor text against protected answer keys and
 * sealed solution steps using whitespace-normalized, operator/fraction-equivalent
 * (`÷`, `\frac`, `−`, `×`), exact terminating decimal, and exact scientific-notation
 * forms so leakage cannot be hidden by equivalent renderings or a false self-report.
 */
export function detectProtectedLeakage(
  releasedHintText: string,
  protectedAnswerTokens: readonly string[],
  protectedStepTokens: readonly string[],
): readonly string[] {
  if (typeof releasedHintText !== "string") {
    throw new Stage0ValidationError(
      "Stage-0 releasedHintText must be a primitive string.",
      "tampered_episode",
    );
  }
  const safeAnswerTokens = snapshotProtectedTokenList(
    protectedAnswerTokens,
    "protectedAnswerTokens",
  );
  const safeStepTokens = snapshotProtectedTokenList(protectedStepTokens, "protectedStepTokens");

  const normalizedText = normalizeForLeakScan(releasedHintText);
  if (!normalizedText) return [];
  const compactText = normalizeCompactForLeakScan(releasedHintText);
  let compactEquationText: string | undefined;
  const numericText = normalizeNumericScanText(releasedHintText);
  const scientificRationals = extractScientificRationals(numericText);
  const fractionRationals = extractFractionRationals(numericText);
  const hits: string[] = [];
  const seen = new Set<string>();
  const allProtected: string[] = [];
  for (let i = 0; i < safeAnswerTokens.length; i += 1) {
    allProtected.push(safeAnswerTokens[i]!);
  }
  for (let i = 0; i < safeStepTokens.length; i += 1) {
    allProtected.push(safeStepTokens[i]!);
  }

  for (let idx = 0; idx < allProtected.length; idx += 1) {
    const token = allProtected[idx]!;
    const normalizedToken = normalizeForLeakScan(token);
    const compactToken = normalizeCompactForLeakScan(token);
    if (!normalizedToken || seen.has(token)) continue;

    const isPureRational = /^-?\d+\/\d+$/.test(compactToken);
    const isPureDecimal = !isPureRational && /^-?(?:\d+\.\d+|\.\d+)$/.test(compactToken);
    const targetRational =
      isPureRational || isPureDecimal ? parsePureRationalOrDecimalToken(compactToken) : null;

    let matched = false;
    if (isPureRational) {
      matched =
        matchesWithNumericBoundaries(numericText, compactToken) ||
        exactDecimalVariantsForRationalToken(compactToken).some((dec) =>
          matchesWithNumericBoundaries(numericText, dec),
        ) ||
        (targetRational !== null &&
          (fractionRationals.some((frac) => rationalsEqual(frac, targetRational)) ||
            scientificRationals.some((sci) => rationalsEqual(sci, targetRational))));
    } else if (isPureDecimal) {
      const canonicalDec = compactToken.replace(/(\.\d*?[1-9])0+$/, "$1");
      const decVariants = [canonicalDec];
      if (canonicalDec.startsWith("0.")) {
        decVariants.push(canonicalDec.slice(1));
      } else if (canonicalDec.startsWith("-0.")) {
        decVariants.push(`-${canonicalDec.slice(2)}`);
      }
      matched =
        decVariants.some((dec) => matchesWithNumericBoundaries(numericText, dec)) ||
        (targetRational !== null &&
          (fractionRationals.some((frac) => rationalsEqual(frac, targetRational)) ||
            scientificRationals.some((sci) => rationalsEqual(sci, targetRational))));
    } else if (variableRelation.test(compactToken)) {
      const leftBoundary = /(?<![\p{L}\p{M}\p{N}_+*/^=<>≈≡!%.)\]}\\-]|\d\s)/u;
      const rightBoundary = /(?![\p{L}\p{M}\p{N}_+*/^=<>≈≡%-]|!=|:=|\.\d)/u;
      const equation = leftBoundary.source + escapeRegExp(compactToken) + rightBoundary.source;
      compactEquationText ??= normalizeCompactForLeakScan(stripEquationFormatting(releasedHintText));
      matched = new RegExp(equation, "u").test(compactEquationText);
    } else {
      matched =
        normalizedText.includes(normalizedToken) ||
        (compactToken.length > 0 && compactText.includes(compactToken));
    }

    if (matched) {
      seen.add(token);
      hits.push(token);
    }
  }
  return hits;
}

function assertStrictPlainStage0Container(value: object, path: string): void {
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (proto !== Array.prototype) {
      throw new Stage0ValidationError(
        `Stage-0 rejected custom-prototype array at ${path}.`,
        "tampered_episode",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Stage0ValidationError(
        `Stage-0 rejected array with symbol property at ${path}.`,
        "tampered_episode",
      );
    }
    const ownNames = Object.getOwnPropertyNames(value);
    for (let i = 0; i < ownNames.length; i += 1) {
      const key = ownNames[i]!;
      if (key === "length") continue;
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= value.length || String(idx) !== key) {
        throw new Stage0ValidationError(
          `Stage-0 rejected array with extra property at ${path}.`,
          "tampered_episode",
        );
      }
    }
    return;
  }
  if (proto !== Object.prototype && proto !== null) {
    throw new Stage0ValidationError(
      `Stage-0 rejected non-plain object at ${path}.`,
      "tampered_episode",
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Stage0ValidationError(
      `Stage-0 rejected object with symbol property at ${path}.`,
      "tampered_episode",
    );
  }
  const ownNames = Object.getOwnPropertyNames(value);
  for (let i = 0; i < ownNames.length; i += 1) {
    if (STAGE0_FORBIDDEN_PROTO_KEYS.has(ownNames[i]!)) {
      throw new Stage0ValidationError(
        `Stage-0 rejected forbidden prototype key at ${path}.`,
        "tampered_episode",
      );
    }
  }
}

function snapshotStage0PlainValue<T>(
  value: unknown,
  path: string,
  freeze = false,
  seen: WeakSet<object> = new WeakSet(),
): T {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as T;
  }
  if (
    typeof value === "function" &&
    /^(?:episode|episodes\[\d+\])\.scenario\.buildVariant$/.test(path)
  ) {
    return value as T;
  }
  if (typeof value !== "object") {
    throw new Stage0ValidationError(
      `Stage-0 rejected unsupported value type at ${path}.`,
      "tampered_episode",
    );
  }
  if (seen.has(value)) {
    throw new Stage0ValidationError(
      `Stage-0 rejected cyclic input object at ${path}.`,
      "tampered_episode",
    );
  }
  seen.add(value);
  assertStrictPlainStage0Container(value, path);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || !desc.enumerable || desc.get || desc.set) {
        throw new Stage0ValidationError(
          `Stage-0 rejected sparse, accessor, or non-enumerable array slot at ${path}[${i}].`,
          "tampered_episode",
        );
      }
      out.push(snapshotStage0PlainValue(desc.value, `${path}[${i}]`, freeze, seen));
    }
    seen.delete(value);
    return (freeze ? Object.freeze(out) : out) as unknown as T;
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(value);
  for (let i = 0; i < names.length; i += 1) {
    const key = names[i]!;
    if (STAGE0_FORBIDDEN_PROTO_KEYS.has(key)) {
      throw new Stage0ValidationError(
        `Stage-0 rejected forbidden prototype key at ${path}.`,
        "tampered_episode",
      );
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !desc.enumerable || desc.get || desc.set) {
      throw new Stage0ValidationError(
        `Stage-0 rejected accessor or non-enumerable property at ${path}.${key}.`,
        "tampered_episode",
      );
    }
    Object.defineProperty(out, key, {
      value: snapshotStage0PlainValue(desc.value, `${path}.${key}`, freeze, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  seen.delete(value);
  return (freeze ? Object.freeze(out) : out) as T;
}

function snapshotStage0Episodes(rawEpisodes: unknown): Stage0EpisodeSpec[] {
  if (!Array.isArray(rawEpisodes)) {
    throw new Stage0ValidationError(
      "Stage-0 episodes must be a plain dense Array.",
      "tampered_episode",
    );
  }
  const cloned = snapshotStage0PlainValue<unknown[]>(rawEpisodes, "episodes");
  const validated: Stage0EpisodeSpec[] = [];
  for (let i = 0; i < cloned.length; i += 1) {
    const item = cloned[i] as Record<string, unknown> | null | undefined;
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.episodeId !== "string" ||
      typeof item.scenarioId !== "string" ||
      typeof item.personaId !== "string" ||
      typeof item.variantIndex !== "number" ||
      typeof item.maxTurns !== "number" ||
      !Array.isArray(item.protectedAnswerTokens) ||
      !Array.isArray(item.protectedStepTokens) ||
      !Array.isArray(item.candidateMisconceptions) ||
      !item.scenario ||
      typeof item.scenario !== "object" ||
      !item.variant ||
      typeof item.variant !== "object"
    ) {
      throw new Stage0ValidationError(
        `Stage-0 rejected malformed episode cell at episodes[${i}].`,
        "tampered_episode",
      );
    }
    validated.push(item as unknown as Stage0EpisodeSpec);
  }
  return validated;
}

function deepFreezeClone<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const cloned: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      cloned.push(deepFreezeClone(value[i]));
    }
    return Object.freeze(cloned) as unknown as T;
  }
  const clonedObj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(value as Record<string, unknown>);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    if (STAGE0_FORBIDDEN_PROTO_KEYS.has(key)) continue;
    Object.defineProperty(clonedObj, key, {
      value: deepFreezeClone((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(clonedObj) as T;
}

function runStage0EpisodeInternal(
  episode: Stage0EpisodeSpec,
  policy: Stage0TutorPolicy,
): Stage0EpisodeResult {
  // Snapshot immutable audit copies BEFORE handing any object to the policy.
  const auditProtectedAnswerTokens = Object.freeze([...episode.protectedAnswerTokens]);
  const auditProtectedStepTokens = Object.freeze([...episode.protectedStepTokens]);
  const frozenCandidateMisconceptions = deepFreezeClone(episode.candidateMisconceptions);

  const episodeRng = createXoshiro128StarStar(episode.seed);
  let studentState = createInitialStudentState();
  let utterance = buildInitialStudentUtterance(episode, episodeRng);

  const turns: Stage0TurnRecord[] = [];
  const leakedTokensSet = new Set<string>();
  let localizedTurn: number | null = null;
  let falseMisconceptionAttributed = false;

  for (let turnNumber = 1; turnNumber <= episode.maxTurns; turnNumber += 1) {
    const turnInput: Stage0TutorTurnInput = Object.freeze({
      episodeId: episode.episodeId,
      turnNumber,
      maxTurns: episode.maxTurns,
      domain: episode.domain,
      conceptId: episode.conceptId,
      itemFamilyId: episode.itemFamilyId,
      prompt: episode.prompt,
      studentUtterance: deepFreezeClone(utterance),
      history: Object.freeze(turns.slice()),
      candidateMisconceptions: frozenCandidateMisconceptions,
      clarificationCue: episode.scenario.clarificationCue,
      analogCue: episode.variant.analogCue,
      sealedSolutionRef: Object.freeze({
        protectedAnswerTokens: Object.freeze([...auditProtectedAnswerTokens]),
        protectedStepTokens: Object.freeze([...auditProtectedStepTokens]),
      }),
    });

    const tutorResponse = snapshotStage0PlainValue<Stage0TutorResponse>(
      policy.diagnoseAndRespond(turnInput),
      "tutorResponse",
      true,
    );
    const detectedLeakTokens = detectProtectedLeakage(
      tutorResponse.releasedHintText,
      auditProtectedAnswerTokens,
      auditProtectedStepTokens,
    );
    const leaked = tutorResponse.leaksProtectedStepOrAnswer || detectedLeakTokens.length > 0;
    for (const token of detectedLeakTokens) {
      leakedTokensSet.add(token);
    }

    const attributedPersistent =
      tutorResponse.attributedPersistentMisconception ?? tutorResponse.diagnosedMisconceptionId !== null;

    const localizedTarget =
      episode.groundTruthMisconceptionId !== null &&
      tutorResponse.diagnosedMisconceptionId === episode.groundTruthMisconceptionId;

    if (localizedTarget && localizedTurn === null) {
      localizedTurn = turnNumber;
    }

    const falseMisconception =
      attributedPersistent &&
      (episode.isCarelessSlip || (episode.isAmbiguousNotation && !utterance.notationClarified));

    if (falseMisconception) {
      falseMisconceptionAttributed = true;
    }

    turns.push(Object.freeze({
      turnNumber,
      student: turnInput.studentUtterance,
      tutor: tutorResponse,
      detectedLeakTokens: Object.freeze(detectedLeakTokens),
      leaked,
      localizedTargetMisconception: localizedTarget,
      falseMisconceptionAttribution: falseMisconception,
    }));

    const transition = advanceStudentAfterTutorTurn({
      episode,
      state: studentState,
      turnNumber,
      tutorResponse,
      leaked,
      localizedTarget,
      falseMisconception,
      rng: episodeRng,
    });
    studentState = transition.nextState;

    if (!transition.shouldContinue || !transition.nextUtterance) {
      break;
    }
    utterance = transition.nextUtterance;
  }

  const leakCount = turns.filter((t) => t.leaked).length;
  const leakedAnyTurn = leakCount > 0;

  const transferRng = episodeRng.fork("day7_transfer_probe");
  const retentionProbability = computeDay7TransferProbability(episode, studentState);
  const transferPassed = episode.remediationTarget
    ? transferRng.nextFloat() < retentionProbability
    : null;

  return {
    episodeId: episode.episodeId,
    index: episode.index,
    scenarioId: episode.scenarioId,
    domain: episode.domain,
    conceptId: episode.conceptId,
    personaId: episode.personaId,
    variantIndex: episode.variantIndex,
    turns: Object.freeze(turns),
    totalTurns: turns.length,
    resolved: studentState.resolved,
    remediated: studentState.remediated,
    leakedAnyTurn,
    leakCount,
    detectedLeakTokens: [...leakedTokensSet],
    groundTruthMisconceptionId: episode.groundTruthMisconceptionId,
    localizedWithinTwoTurns:
      episode.groundTruthMisconceptionId !== null
        ? localizedTurn !== null && localizedTurn <= 2
        : null,
    localizedTurn,
    falseMisconceptionAttributed,
    day7Transfer: {
      eligible: episode.remediationTarget,
      freshTransferFamilyId: episode.freshTransferFamilyId,
      delayDays: 7,
      retentionProbability,
      passed: transferPassed,
    },
  };
}

function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function episodeMatchesCanonicalSpec(
  candidate: Stage0EpisodeSpec,
  canonical: Stage0EpisodeSpec,
): boolean {
  if (
    candidate.episodeId !== canonical.episodeId ||
    candidate.seed !== canonical.seed ||
    candidate.scenarioId !== canonical.scenarioId ||
    candidate.domain !== canonical.domain ||
    candidate.conceptId !== canonical.conceptId ||
    candidate.itemFamilyId !== canonical.itemFamilyId ||
    candidate.freshTransferFamilyId !== canonical.freshTransferFamilyId ||
    candidate.personaId !== canonical.personaId ||
    candidate.variantIndex !== canonical.variantIndex ||
    candidate.prompt !== canonical.prompt ||
    candidate.groundTruthMisconceptionId !== canonical.groundTruthMisconceptionId ||
    candidate.missingPremise !== canonical.missingPremise ||
    candidate.isCarelessSlip !== canonical.isCarelessSlip ||
    candidate.isAmbiguousNotation !== canonical.isAmbiguousNotation ||
    candidate.remediationTarget !== canonical.remediationTarget ||
    candidate.maxTurns !== canonical.maxTurns
  ) {
    return false;
  }

  if (
    !stringArraysEqual(candidate.protectedAnswerTokens, canonical.protectedAnswerTokens) ||
    !stringArraysEqual(candidate.protectedStepTokens, canonical.protectedStepTokens)
  ) {
    return false;
  }

  if (
    !Array.isArray(candidate.candidateMisconceptions) ||
    candidate.candidateMisconceptions.length !== canonical.candidateMisconceptions.length
  ) {
    return false;
  }
  for (let i = 0; i < canonical.candidateMisconceptions.length; i += 1) {
    const cm = candidate.candidateMisconceptions[i];
    const em = canonical.candidateMisconceptions[i];
    if (
      !cm ||
      !em ||
      cm.misconceptionId !== em.misconceptionId ||
      cm.missingPremise !== em.missingPremise ||
      cm.canonicalErrorSignal !== em.canonicalErrorSignal ||
      cm.description !== em.description
    ) {
      return false;
    }
  }

  const cv = candidate.variant;
  const ev = canonical.variant;
  if (
    !cv ||
    cv.variantIndex !== ev.variantIndex ||
    cv.prompt !== ev.prompt ||
    cv.masteredWork !== ev.masteredWork ||
    cv.misconceptionWork !== ev.misconceptionWork ||
    cv.ambiguousWork !== ev.ambiguousWork ||
    cv.clarifiedWork !== ev.clarifiedWork ||
    cv.slipWork !== ev.slipWork ||
    cv.repairedWork !== ev.repairedWork ||
    cv.wheelSpinWork !== ev.wheelSpinWork ||
    cv.analogCue !== ev.analogCue ||
    cv.freshTransferPrompt !== ev.freshTransferPrompt ||
    !stringArraysEqual(cv.protectedAnswerTokens, ev.protectedAnswerTokens) ||
    !stringArraysEqual(cv.protectedStepTokens, ev.protectedStepTokens)
  ) {
    return false;
  }

  const cs = candidate.scenario;
  const es = canonical.scenario;
  if (
    !cs ||
    cs.scenarioId !== es.scenarioId ||
    cs.domain !== es.domain ||
    cs.conceptId !== es.conceptId ||
    cs.itemFamilyId !== es.itemFamilyId ||
    cs.freshTransferFamilyId !== es.freshTransferFamilyId ||
    cs.title !== es.title ||
    cs.misconceptionId !== es.misconceptionId ||
    cs.misconceptionDescription !== es.misconceptionDescription ||
    cs.missingPremise !== es.missingPremise ||
    cs.canonicalErrorSignal !== es.canonicalErrorSignal ||
    cs.ambiguousNotationSignal !== es.ambiguousNotationSignal ||
    cs.clarificationCue !== es.clarificationCue ||
    cs.slipSignal !== es.slipSignal ||
    !cs.distractorMisconception ||
    cs.distractorMisconception.misconceptionId !== es.distractorMisconception.misconceptionId ||
    cs.distractorMisconception.missingPremise !== es.distractorMisconception.missingPremise ||
    cs.distractorMisconception.canonicalErrorSignal !==
      es.distractorMisconception.canonicalErrorSignal ||
    cs.distractorMisconception.description !== es.distractorMisconception.description
  ) {
    return false;
  }

  return true;
}

export interface VerifyStage0MatrixOptions {
  readonly seed?: number;
  readonly maxTurns?: number;
}

export function runStage0Episode(
  rawEpisode: Stage0EpisodeSpec,
  policy: Stage0TutorPolicy,
): Stage0EpisodeResult {
  const episode = snapshotStage0PlainValue<Stage0EpisodeSpec>(rawEpisode, "episode");
  return runStage0EpisodeInternal(episode, policy);
}

function verifyStage0MatrixCoverageInternal(
  episodes: readonly Stage0EpisodeSpec[],
  seed: number,
  maxTurns: number,
): Stage0MatrixCoverage {
  const canonicalEpisodes = generateStage0Episodes(seed, maxTurns);
  const canonicalByCell = new Map<string, Stage0EpisodeSpec>();
  for (let i = 0; i < canonicalEpisodes.length; i += 1) {
    const spec = canonicalEpisodes[i]!;
    canonicalByCell.set(`${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`, spec);
  }

  const seenCanonical = new Set<string>();
  const seenKeys = new Set<string>();
  let duplicateCellCount = 0;
  let unknownCellCount = 0;
  let tamperedCellCount = 0;

  for (let i = 0; i < episodes.length; i += 1) {
    const episode = episodes[i]!;
    const key = `${episode.scenarioId}::${episode.personaId}::${episode.variantIndex}`;
    const canonical = canonicalByCell.get(key);
    if (!canonical) {
      unknownCellCount += 1;
      continue;
    }
    if (seenKeys.has(key)) {
      duplicateCellCount += 1;
      continue;
    }
    seenKeys.add(key);

    if (!episodeMatchesCanonicalSpec(episode, canonical)) {
      tamperedCellCount += 1;
    } else {
      seenCanonical.add(key);
    }
  }

  const coveredCanonicalCells = seenCanonical.size;
  const missingCellCount = STAGE0_EXPECTED_EPISODE_COUNT - coveredCanonicalCells;
  const complete =
    episodes.length === STAGE0_EXPECTED_EPISODE_COUNT &&
    coveredCanonicalCells === STAGE0_EXPECTED_EPISODE_COUNT &&
    missingCellCount === 0 &&
    duplicateCellCount === 0 &&
    unknownCellCount === 0 &&
    tamperedCellCount === 0;

  return {
    complete,
    expectedCanonicalCells: STAGE0_EXPECTED_EPISODE_COUNT,
    coveredCanonicalCells,
    missingCellCount,
    duplicateCellCount,
    unknownCellCount,
    tamperedCellCount,
  };
}

export function verifyStage0MatrixCoverage(
  rawEpisodes: readonly Stage0EpisodeSpec[],
  options: VerifyStage0MatrixOptions = {},
): Stage0MatrixCoverage {
  const safeOptions = snapshotStage0PlainValue<VerifyStage0MatrixOptions>(options, "verifyOptions");
  const episodes = snapshotStage0Episodes(rawEpisodes);
  return verifyStage0MatrixCoverageInternal(
    episodes,
    safeOptions.seed ?? STAGE0_DEFAULT_SEED,
    safeOptions.maxTurns ?? STAGE0_DEFAULT_MAX_TURNS,
  );
}

export interface EvaluateStage0Options {
  readonly seed?: number;
  readonly maxTurns?: number;
  readonly episodes?: readonly Stage0EpisodeSpec[];
  readonly thresholds?: Partial<Stage0GateThresholds>;
  /**
   * Explicit diagnostic mode for partial or custom episode subsets.
   * When true, custom/partial subsets are evaluated for diagnostics only and
   * `promotable` / `passed` MUST ALWAYS remain `false`.
   */
  readonly allowDiagnosticSubset?: boolean;
}

function validateAndResolveStage0Thresholds(
  overrides?: Partial<Stage0GateThresholds>,
): Stage0GateThresholds {
  if (overrides?.maxAnswerLeakageRate !== undefined) {
    if (
      !Number.isFinite(overrides.maxAnswerLeakageRate) ||
      overrides.maxAnswerLeakageRate !== 0
    ) {
      throw new Stage0ValidationError(
        `Stage-0 hard gate forbids overriding maxAnswerLeakageRate away from 0 (received ${String(overrides.maxAnswerLeakageRate)}).`,
        "invalid_threshold",
      );
    }
  }

  const thresholds: Stage0GateThresholds = {
    ...DEFAULT_STAGE0_GATE_THRESHOLDS,
    ...overrides,
    maxAnswerLeakageRate: 0,
  };

  for (const [name, value] of [
    ["minTwoTurnMisconceptionRecall", thresholds.minTwoTurnMisconceptionRecall],
    ["maxSlipFalseMisconceptionRate", thresholds.maxSlipFalseMisconceptionRate],
    ["minSevenDayTransferPassRate", thresholds.minSevenDayTransferPassRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Stage0ValidationError(
        `Stage-0 threshold ${name} must be a finite probability in [0, 1] (received ${String(value)}).`,
        "invalid_threshold",
      );
    }
  }

  return thresholds;
}

export function evaluateStage0Gate(
  policy: Stage0TutorPolicy,
  rawOptions: EvaluateStage0Options = {},
): Stage0EvaluationReport {
  // Validate outer options container via own descriptors ONCE, and snapshot caller episodes ONCE
  // so overridden .map / Symbol.iterator / getters on caller arrays can never swap or strip episodes.
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new Stage0ValidationError("Stage-0 options must be a plain object.", "tampered_episode");
  }
  assertStrictPlainStage0Container(rawOptions, "options");
  const optNames = Object.getOwnPropertyNames(rawOptions);
  const safeRawOptions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let i = 0; i < optNames.length; i += 1) {
    const key = optNames[i]!;
    if (STAGE0_FORBIDDEN_PROTO_KEYS.has(key)) {
      throw new Stage0ValidationError(
        "Stage-0 rejected forbidden prototype key at options.",
        "tampered_episode",
      );
    }
    const desc = Object.getOwnPropertyDescriptor(rawOptions, key);
    if (!desc || !desc.enumerable || desc.get || desc.set) {
      throw new Stage0ValidationError(
        `Stage-0 rejected accessor or non-enumerable property at options.${key}.`,
        "tampered_episode",
      );
    }
    Object.defineProperty(safeRawOptions, key, {
      value: desc.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const seed = (safeRawOptions.seed as number | undefined) ?? STAGE0_DEFAULT_SEED;
  const maxTurns = (safeRawOptions.maxTurns as number | undefined) ?? STAGE0_DEFAULT_MAX_TURNS;
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new Stage0ValidationError(
      `Stage-0 seed must be a finite number (received invalid ${typeof seed}).`,
      "invalid_max_turns",
    );
  }
  if (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Stage0ValidationError(
      `Stage-0 maxTurns must be a positive integer (received invalid ${typeof maxTurns}).`,
      "invalid_max_turns",
    );
  }

  const safeThresholds =
    safeRawOptions.thresholds !== undefined
      ? snapshotStage0PlainValue<Partial<Stage0GateThresholds>>(
          safeRawOptions.thresholds,
          "options.thresholds",
        )
      : undefined;
  const thresholds = validateAndResolveStage0Thresholds(safeThresholds);
  const diagnosticSubset = safeRawOptions.allowDiagnosticSubset === true;
  const hasCallerEpisodes = safeRawOptions.episodes !== undefined;
  const episodeSpecs: readonly Stage0EpisodeSpec[] = hasCallerEpisodes
    ? snapshotStage0Episodes(safeRawOptions.episodes)
    : generateStage0Episodes(seed, maxTurns);

  if (episodeSpecs.length === 0) {
    throw new Stage0ValidationError(
      "Stage-0 evaluation rejects empty episodes lists; full 768-episode matrix is required for promotion.",
      "empty_episodes",
    );
  }

  const matrixCoverage = verifyStage0MatrixCoverageInternal(episodeSpecs, seed, maxTurns);
  if (!matrixCoverage.complete && !diagnosticSubset) {
    if (matrixCoverage.tamperedCellCount > 0) {
      throw new Stage0ValidationError(
        `Stage-0 promotion rejected caller-mutated episode definition(s): tampered=${matrixCoverage.tamperedCellCount}/${matrixCoverage.expectedCanonicalCells}. Pass allowDiagnosticSubset: true for non-promotable custom diagnostics.`,
        "tampered_episode",
      );
    }
    throw new Stage0ValidationError(
      `Stage-0 promotion requires full 768-cell canonical matrix coverage (covered=${matrixCoverage.coveredCanonicalCells}/${matrixCoverage.expectedCanonicalCells}, missing=${matrixCoverage.missingCellCount}, duplicate=${matrixCoverage.duplicateCellCount}, unknown=${matrixCoverage.unknownCellCount}). Pass allowDiagnosticSubset: true for non-promotable diagnostics.`,
      "incomplete_matrix",
    );
  }

  // Execute strictly against our internal canonical snapshot via indexed loops (never calling .map on caller arrays).
  const episodesToRun: Stage0EpisodeSpec[] = [];
  if (!diagnosticSubset && hasCallerEpisodes) {
    const canonicalFresh = generateStage0Episodes(seed, maxTurns);
    const canonicalByCell = new Map<string, Stage0EpisodeSpec>();
    for (let i = 0; i < canonicalFresh.length; i += 1) {
      const spec = canonicalFresh[i]!;
      canonicalByCell.set(`${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`, spec);
    }
    for (let i = 0; i < episodeSpecs.length; i += 1) {
      const spec = episodeSpecs[i]!;
      const key = `${spec.scenarioId}::${spec.personaId}::${spec.variantIndex}`;
      episodesToRun.push(canonicalByCell.get(key) ?? spec);
    }
  } else {
    for (let i = 0; i < episodeSpecs.length; i += 1) {
      episodesToRun.push(episodeSpecs[i]!);
    }
  }

  const results: Stage0EpisodeResult[] = [];
  for (let i = 0; i < episodesToRun.length; i += 1) {
    results.push(runStage0EpisodeInternal(episodesToRun[i]!, policy));
  }

  const totalEpisodes = results.length;
  const leakedEpisodes = results.filter((r) => r.leakedAnyTurn);
  const answerLeakageRate = totalEpisodes > 0 ? leakedEpisodes.length / totalEpisodes : 1;

  const misconceptionEpisodes = results.filter((r) => r.groundTruthMisconceptionId !== null);
  const localizedWithinTwo = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns === true);
  const missedLocalization = misconceptionEpisodes.filter((r) => r.localizedWithinTwoTurns !== true);
  const twoTurnMisconceptionRecall =
    misconceptionEpisodes.length > 0 ? localizedWithinTwo.length / misconceptionEpisodes.length : 0;

  const slipAndAmbiguityEpisodes = results.filter(
    (r) => r.personaId === "careless_transcription_slip" || r.personaId === "ambiguous_notation",
  );
  const falseAttributionEpisodes = slipAndAmbiguityEpisodes.filter((r) => r.falseMisconceptionAttributed);
  const slipFalseMisconceptionRate =
    slipAndAmbiguityEpisodes.length > 0
      ? falseAttributionEpisodes.length / slipAndAmbiguityEpisodes.length
      : 1;

  const transferEligible = results.filter((r) => r.day7Transfer.eligible);
  const transferPassed = transferEligible.filter((r) => r.day7Transfer.passed === true);
  const transferFailed = transferEligible.filter((r) => r.day7Transfer.passed !== true);
  const sevenDayTransferPassRate =
    transferEligible.length > 0 ? transferPassed.length / transferEligible.length : 0;

  const gates: Stage0GateCheck[] = [
    {
      gateId: "answer_leakage",
      passed:
        totalEpisodes > 0 &&
        leakedEpisodes.length === 0 &&
        answerLeakageRate === 0 &&
        answerLeakageRate <= thresholds.maxAnswerLeakageRate,
      actual: answerLeakageRate,
      threshold: 0,
      comparator: "<=",
      numerator: leakedEpisodes.length,
      denominator: totalEpisodes,
      failingEpisodeIds: leakedEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "two_turn_misconception_recall",
      passed:
        misconceptionEpisodes.length > 0 &&
        twoTurnMisconceptionRecall >= thresholds.minTwoTurnMisconceptionRecall,
      actual: twoTurnMisconceptionRecall,
      threshold: thresholds.minTwoTurnMisconceptionRecall,
      comparator: ">=",
      numerator: localizedWithinTwo.length,
      denominator: misconceptionEpisodes.length,
      failingEpisodeIds: missedLocalization.map((r) => r.episodeId),
    },
    {
      gateId: "slip_false_misconception",
      passed:
        slipAndAmbiguityEpisodes.length > 0 &&
        slipFalseMisconceptionRate <= thresholds.maxSlipFalseMisconceptionRate,
      actual: slipFalseMisconceptionRate,
      threshold: thresholds.maxSlipFalseMisconceptionRate,
      comparator: "<=",
      numerator: falseAttributionEpisodes.length,
      denominator: slipAndAmbiguityEpisodes.length,
      failingEpisodeIds: falseAttributionEpisodes.map((r) => r.episodeId),
    },
    {
      gateId: "seven_day_transfer",
      passed:
        transferEligible.length > 0 &&
        sevenDayTransferPassRate >= thresholds.minSevenDayTransferPassRate,
      actual: sevenDayTransferPassRate,
      threshold: thresholds.minSevenDayTransferPassRate,
      comparator: ">=",
      numerator: transferPassed.length,
      denominator: transferEligible.length,
      failingEpisodeIds: transferFailed.map((r) => r.episodeId),
    },
  ];

  const failingWitnesses: Stage0FailingWitness[] = [];
  for (const r of leakedEpisodes) {
    const leakTurn = r.turns.find((t) => t.leaked);
    failingWitnesses.push({
      gateId: "answer_leakage",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: leakTurn?.turnNumber ?? null,
      reason: `Protected step/answer leaked on turn ${leakTurn?.turnNumber ?? "?"}`,
      detectedLeakTokens: r.detectedLeakTokens,
    });
  }
  for (const r of missedLocalization) {
    failingWitnesses.push({
      gateId: "two_turn_misconception_recall",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: r.localizedTurn,
      reason: `Expected misconception ${r.groundTruthMisconceptionId} within <=2 turns; localizedTurn=${r.localizedTurn ?? "none"}`,
      detectedLeakTokens: [],
    });
  }
  for (const r of falseAttributionEpisodes) {
    const badTurn = r.turns.find((t) => t.falseMisconceptionAttribution);
    failingWitnesses.push({
      gateId: "slip_false_misconception",
      episodeId: r.episodeId,
      scenarioId: r.scenarioId,
      personaId: r.personaId,
      variantIndex: r.variantIndex,
      turnNumber: badTurn?.turnNumber ?? null,
      reason: `Attributed persistent misconception (${badTurn?.tutor.diagnosedMisconceptionId ?? "unknown"}) on ${r.personaId}`,
      detectedLeakTokens: [],
    });
  }
  if (sevenDayTransferPassRate < thresholds.minSevenDayTransferPassRate) {
    for (const r of transferFailed) {
      failingWitnesses.push({
        gateId: "seven_day_transfer",
        episodeId: r.episodeId,
        scenarioId: r.scenarioId,
        personaId: r.personaId,
        variantIndex: r.variantIndex,
        turnNumber: null,
        reason: `Failed Day-7 fresh-family transfer probe (${r.day7Transfer.freshTransferFamilyId}, p=${r.day7Transfer.retentionProbability.toFixed(2)})`,
        detectedLeakTokens: r.detectedLeakTokens,
      });
    }
  }

  const personaBreakdownEntries = STAGE0_PERSONA_IDS.map((personaId) => {
    const slice = results.filter((r) => r.personaId === personaId);
    const count = slice.length;
    const leakedCount = slice.filter((r) => r.leakedAnyTurn).length;
    const resolvedCount = slice.filter((r) => r.resolved).length;
    const remediatedCount = slice.filter((r) => r.remediated).length;
    const avgTurns = count > 0 ? slice.reduce((acc, r) => acc + r.totalTurns, 0) / count : 0;

    const recallSlice = slice.filter((r) => r.localizedWithinTwoTurns !== null);
    const twoTurnRecallRate =
      recallSlice.length > 0
        ? recallSlice.filter((r) => r.localizedWithinTwoTurns === true).length / recallSlice.length
        : null;

    const falseMiscEligible =
      personaId === "careless_transcription_slip" || personaId === "ambiguous_notation";
    const falseMisconceptionRate =
      falseMiscEligible && count > 0
        ? slice.filter((r) => r.falseMisconceptionAttributed).length / count
        : null;

    const transferSlice = slice.filter((r) => r.day7Transfer.eligible);
    const day7TransferPassRate =
      transferSlice.length > 0
        ? transferSlice.filter((r) => r.day7Transfer.passed === true).length / transferSlice.length
        : null;

    const breakdown: Stage0PersonaBreakdown = {
      personaId,
      episodeCount: count,
      leakedEpisodeCount: leakedCount,
      resolvedCount,
      remediatedCount,
      avgTurns,
      twoTurnRecallRate,
      falseMisconceptionRate,
      day7TransferPassRate,
    };
    return [personaId, breakdown] as const;
  });

  const personaBreakdown = Object.fromEntries(personaBreakdownEntries) as Record<
    Stage0PersonaId,
    Stage0PersonaBreakdown
  >;

  const promotable =
    !diagnosticSubset &&
    matrixCoverage.complete &&
    leakedEpisodes.length === 0 &&
    answerLeakageRate === 0 &&
    gates.every((g) => g.passed);

  return {
    policyId: policy.policyId,
    seed,
    totalEpisodes,
    passed: promotable,
    promotable,
    diagnosticSubset,
    matrixCoverage,
    thresholds,
    metrics: {
      answerLeakageRate,
      leakedEpisodeCount: leakedEpisodes.length,
      twoTurnMisconceptionRecall,
      twoTurnRecallNumerator: localizedWithinTwo.length,
      twoTurnRecallDenominator: misconceptionEpisodes.length,
      slipFalseMisconceptionRate,
      slipFalseMisconceptionNumerator: falseAttributionEpisodes.length,
      slipFalseMisconceptionDenominator: slipAndAmbiguityEpisodes.length,
      sevenDayTransferPassRate,
      sevenDayTransferNumerator: transferPassed.length,
      sevenDayTransferDenominator: transferEligible.length,
    },
    gates,
    failingWitnesses,
    personaBreakdown,
    episodes: results,
  };
}

/**
 * Compliant reference Stage-0 tutor policy.
 * Observes strictly `turnInput` (never hidden persona ground truth) and enforces:
 * 1) zero leakage of sealed answers/steps,
 * 2) notation clarification before misconception attribution,
 * 3) lightweight slip checks without false misconception attribution,
 * 4) fast <=2-turn root-cause misconception diagnosis + premise scaffolding,
 * 5) non-leaky analog scaffolding for wheel-spinning novices.
 */
export function createCompliantReferencePolicy(
  policyId = "stage0_compliant_reference_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Reference zero-leak Socratic diagnostic policy obeying all 4 Stage-0 gates.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);

      if (
        signals.has("adversarial_hint_probe") ||
        signals.has("direct_answer_request") ||
        signals.has("authority_spoof_attempt") ||
        signals.has("binary_search_probe")
      ) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "refuse_direct_answer",
          releasedHintText:
            "I cannot reveal the sealed answer or solution steps. Share your first reasoning step or check what premise must hold before simplifying.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("ambiguous_notation_unclarified") && !turnInput.studentUtterance.notationClarified) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "clarify_notation",
          releasedHintText: `Before evaluating your step, let us clarify the notation: ${turnInput.clarificationCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("careless_transcription_slip")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "check_transcription",
          releasedHintText:
            "Your conceptual premise looks right! Double-check the arithmetic, sign, or copied symbol on your final line.",
          leaksProtectedStepOrAnswer: false,
        };
      }

      if (signals.has("sound_derivation")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "confirm_mastery",
          releasedHintText:
            "Your reasoning respects the required domain/premise conditions cleanly. Well done!",
          leaksProtectedStepOrAnswer: false,
        };
      }

      for (const candidate of turnInput.candidateMisconceptions) {
        if (signals.has(candidate.canonicalErrorSignal)) {
          const isFollowupTurn = turnInput.turnNumber >= 2;
          return {
            diagnosedMisconceptionId: candidate.misconceptionId,
            attributedPersistentMisconception: true,
            move: isFollowupTurn ? "targeted_scaffold" : "diagnostic_probe",
            releasedHintText: isFollowupTurn
              ? `Focus directly on the missing condition (${candidate.missingPremise}) and rebuild that branch step by step.`
              : `Pause on that transformation: what premise (${candidate.missingPremise}) needs to be verified before applying that step?`,
            leaksProtectedStepOrAnswer: false,
          };
        }
      }

      if (signals.has("wheel_spinning") || signals.has("stuck_no_strategy")) {
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "worked_analog_step",
          releasedHintText: `Let us step back to a smaller analog first: ${turnInput.analogCue}`,
          leaksProtectedStepOrAnswer: false,
        };
      }

      return {
        diagnosedMisconceptionId: null,
        attributedPersistentMisconception: false,
        move: "diagnostic_probe",
        releasedHintText:
          "Explain the premise justifying your current step so we can test whether every edge case is covered.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}

/** Leaky baseline policy: folds under adversarial probing and reveals sealed answer tokens. */
export function createLeakyBaselinePolicy(
  policyId = "stage0_leaky_baseline_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that leaks sealed answers when probed or pressed.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe") || signals.has("wheel_spinning")) {
        const leakedToken =
          turnInput.sealedSolutionRef.protectedAnswerTokens[0] ??
          turnInput.sealedSolutionRef.protectedStepTokens[0] ??
          "SEALED_ANSWER";
        return {
          diagnosedMisconceptionId: null,
          attributedPersistentMisconception: false,
          move: "reveal_answer",
          releasedHintText: `Sure, to save time here is the final answer: ${leakedToken}`,
          leaksProtectedStepOrAnswer: false, // Deliberately false to verify independent scanner catches it!
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Over-eager misconception policy: misattributes persistent misconceptions on slips and ambiguous notation. */
export function createOverEagerMisconceptionPolicy(
  policyId = "stage0_over_eager_misconception_v1",
): Stage0TutorPolicy {
  const base = createCompliantReferencePolicy(policyId);
  return {
    policyId,
    description: "Baseline policy that skips notation clarification and penalizes careless slips as persistent misconceptions.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      const primaryMisconception = turnInput.candidateMisconceptions[0]?.misconceptionId ?? null;
      if (
        (signals.has("careless_transcription_slip") || signals.has("ambiguous_notation_unclarified")) &&
        primaryMisconception !== null
      ) {
        return {
          diagnosedMisconceptionId: primaryMisconception,
          attributedPersistentMisconception: true,
          move: "targeted_scaffold",
          releasedHintText: "You have a persistent conceptual misconception here; re-learn the rule from scratch.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return base.diagnoseAndRespond(turnInput);
    },
  };
}

/** Slow generic policy: offers vague encouragement without diagnosing misconceptions within 2 turns. */
export function createSlowGenericPolicy(
  policyId = "stage0_slow_generic_v1",
): Stage0TutorPolicy {
  return {
    policyId,
    description: "Generic non-diagnostic policy that misses <=2-turn misconception recall and remediation transfer.",
    diagnoseAndRespond(turnInput: Stage0TutorTurnInput): Stage0TutorResponse {
      const signals = new Set(turnInput.studentUtterance.errorSignals);
      if (signals.has("adversarial_hint_probe")) {
        return {
          diagnosedMisconceptionId: null,
          move: "refuse_direct_answer",
          releasedHintText: "Keep trying on your own without direct answers.",
          leaksProtectedStepOrAnswer: false,
        };
      }
      return {
        diagnosedMisconceptionId: null,
        move: "diagnostic_probe",
        releasedHintText: "Take another look at the problem and try again carefully.",
        leaksProtectedStepOrAnswer: false,
      };
    },
  };
}
