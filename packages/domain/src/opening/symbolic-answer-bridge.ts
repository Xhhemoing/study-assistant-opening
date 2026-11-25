import type { ProofFeedback, TeachingQuestionInteraction } from "@aistudy/contracts";
import {
  differentiate,
  evaluateScalar,
  normalizeLatexExpr,
  parseScalarExpr,
  rationalForm,
  simplifyRadical,
  toRational,
  verifyIndefiniteIntegral,
  verifyScalarEquivalence,
  type DomainSpec,
  type EquivalenceStatus,
  type ScalarExpr,
  type VerificationResult,
} from "../symbolic-equivalence";
import {
  addRational, bigGcd, divideRational, equalRational, multiplyRational, PolyComplexityError, subtractRational,
  type SpanRational,
} from "../symbolic-equivalence/rational-bounds";

const MAX_STEM_LENGTH = 400;
const MAX_EXPRESSION_LENGTH = 1200;
const MAX_EQUALITY_TERMS = 12;
// Keep individual powers within the engine's polynomial degree bound.
const MAX_POWER = 64;
const ZERO: ScalarExpr = { kind: "const", value: 0 };
const UNIT: ScalarExpr = { kind: "const", value: 1 };
const ORIGIN = { n: 0n, d: 1n };
const ONE = { n: 1n, d: 1n };
const SCALAR_FUNCTIONS = new Set(["sqrt", "abs", "ln", "sin", "cos", "exp"]);
const TEX_SCALAR_COMMANDS = new Set(["\\sin", "\\cos", "\\ln", "\\exp", "\\cdot", "\\times", "\\div"]);
const TEX_CLOSERS = new Map([["(", ")"], ["[", "]"], ["|", "|"], ["\\|", "\\|"]]);
const KEY_PREFIX = /^(?:答案|答|answer)\s*[:：]\s*/i;
const UNFENCED_ESCAPE = /\\(?![A-Za-z*])/;
const INTEGRAL_COMMA = /^\\,[ \t\r\n]*d[ \t\r\n]*[A-Za-z]\b/;

type ChoiceOptions = Extract<TeachingQuestionInteraction, { kind: "choice" }>["options"];
type Outcome = "correct" | "incorrect" | "unparseable" | null;
type SymbolicKind = "scalar" | "derivative" | "indefinite-integral";
type ParsedExpression = {
  expr: ScalarExpr;
  variables: Set<string>;
  hasDenominator: boolean;
  mayRestrictDomain: boolean;
  radicands: ScalarExpr[];
  absoluteValues: ScalarExpr[];
};
type TargetSource = {
  kind: SymbolicKind;
  source: ParsedExpression;
  domain: DomainSpec & { variable: string };
};
type Target = TargetSource & { expected: ScalarExpr };

function bounded<T, F>(fallback: F, verify: () => T): T | F {
  try {
    return verify();
  } catch (error) {
    if (error instanceof PolyComplexityError || error instanceof RangeError) return fallback;
    throw error;
  }
}

function scanMathSpans(text: string, outsideMath: (char: string, index: number) => boolean): boolean {
  let fence = 0;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\r" || char === "\n") {
      if (fence) return false;
      escaped = false;
    } else if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      if (!fence && !outsideMath(char, index)) return false;
      escaped = true;
    } else if (char === "$") {
      let width = 1;
      while (text[index + width] === "$") width++;
      if (width > 2 || (fence && width !== fence)) return false;
      fence = fence ? 0 : width;
      index += width - 1;
    } else if (!fence && !outsideMath(char, index)) {
      return false;
    }
  }
  return fence === 0;
}

function keepsSymbolicMeaningWhenRendered(text: string, allowIntegralDifferential = false): boolean {
  return !text.split(/\r\n?|\n/).some(line => (
    /^\s*(?:-+|[+*]|\d{1,9}[.)]|#{1,6})(?:\s|$)/.test(line) ||
    /^\s*(?:_\s*){3,}$/.test(line) || /^(?: {4}|\t)\s*\S/.test(line)
  )) && scanMathSpans(text, (char, index) => {
    if (char === "*" || char === "~") return false;
    if (char !== "\\" || /[A-Za-z*]/.test(text[index + 1] ?? "")) return true;
    // The target parser checks that this comma ends the integral header.
    return allowIntegralDifferential && INTEGRAL_COMMA.test(text.slice(index)) &&
      /\\int(?![A-Za-z])/.test(text.slice(0, index));
  });
}

function unwrapMath(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.includes("$")) return trimmed;
  return /^(\${1,2})([^$\r\n]+)\1$/.exec(trimmed)?.[2]?.trim() ?? null;
}

function withZeroValue(expr: ScalarExpr): ScalarExpr {
  return { kind: "mul", left: ZERO, right: expr };
}

function domainZero(expr: ScalarExpr, variable: string): boolean {
  const form = rationalForm(expr, variable);
  if (form.zeroDenominator) return true;
  if (!form.unsupported) return form.numerator.size === 0;
  if (form.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
  return verifyScalarEquivalence(expr, withZeroValue(expr), { variable }).status === "equivalent";
}

function inspectExpression(expr: ScalarExpr): ParsedExpression | null {
  const variables = new Set<string>();
  const denominators: ScalarExpr[] = [];
  const radicands: ScalarExpr[] = [];
  const absoluteValues: ScalarExpr[] = [];
  const pending = [expr];
  let mayRestrictDomain = false;
  while (pending.length) {
    const node = pending.pop()!;
    switch (node.kind) {
      case "variable":
        if (!/^[A-Za-z]$/.test(node.name)) return null;
        variables.add(node.name);
        break;
      case "const":
        break;
      case "div":
        denominators.push(node.right);
        pending.push(node.left, node.right);
        break;
      case "add":
      case "sub":
      case "mul":
        pending.push(node.left, node.right);
        break;
      case "pow":
        if (Math.abs(node.exponent) > MAX_POWER) throw new PolyComplexityError();
        if (node.exponent <= 0) denominators.push(node.base);
        pending.push(node.base);
        break;
      case "sqrt":
        radicands.push(node.value);
        mayRestrictDomain = true;
        pending.push(node.value);
        break;
      case "ln":
        mayRestrictDomain = true;
        pending.push(node.value);
        break;
      case "abs":
        absoluteValues.push(node.value);
        pending.push(node.value);
        break;
      default:
        pending.push(node.value);
    }
  }
  if (denominators.some(denominator => domainZero(denominator, variables.values().next().value ?? "x"))) return null;
  return { expr, variables, hasDenominator: denominators.length > 0,
    mayRestrictDomain: mayRestrictDomain || denominators.length > 0, radicands, absoluteValues };
}

function isSingleDerivativeOperand(normalized: string): boolean {
  if (/^(?:[A-Za-z]|\d+)(?:\^(?:-?\d+|\(-?\d+\)))?$/.test(normalized)) return true;
  if (!normalized.startsWith("(")) return false;
  let depth = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === "(") depth++;
    if (normalized[index] === ")" && --depth === 0) return index === normalized.length - 1;
  }
  return false;
}

function argumentGroupEnd(text: string, start: number): number | null {
  const open = text[start];
  const close = open === "{" ? "}" : ")";
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return index + 1;
  }
  return null;
}

function bracedArgument(text: string, offset: number): { start: number; end: number } | null {
  const start = offset + /^[ \t\r\n]*/.exec(text.slice(offset))![0].length;
  if (text[start] !== "{") return null;
  const end = argumentGroupEnd(text, start);
  return end === null ? null : { start, end };
}

function validateTexExpression(body: string, texMode: boolean): string | null {
  if ((texMode && (body.includes("_") || /[^\S \t\r\n]/.test(body))) ||
      /[\d.](?:\s|\\[,;:! ]|\\(?:quad|qquad)(?![A-Za-z])|~)+[\d.]|\d\.\d*\.|\.\d+\./.test(body) ||
      /[\d.](?:\s|\\[,;:! ]|\\(?:quad|qquad)(?![A-Za-z])|~)*\\[dt]?frac(?![A-Za-z])/.test(body)) return null;
  const argumentGroups = new Set<number>();
  const closers: string[] = [];
  const tokens = /\\(?:[A-Za-z]+|[^\r\n])|[{}^]/g;
  for (let match = tokens.exec(body); match; match = tokens.exec(body)) {
    const token = match[0];
    const after = tokens.lastIndex;
    if (token === "{") {
      if (!argumentGroups.has(match.index)) return null;
      closers.push("}");
    } else if (token === "}") {
      if (closers.pop() !== "}") return null;
    } else if (token === "^") {
      const tail = body.slice(after);
      // Only lexer whitespace may precede the TeX superscript token.
      const whitespace = texMode ? /^[ \t\r\n]*/ : /^\s*/;
      const start = after + whitespace.exec(tail)![0].length;
      const exponent = body.slice(start);
      let end: number | null;
      if (exponent.startsWith("{")) {
        end = argumentGroupEnd(body, start);
        argumentGroups.add(start);
      } else if (texMode) {
        if (!/^[A-Za-z0-9](?![A-Za-z0-9.])/.test(exponent)) return null;
        end = start + 1;
      } else {
        if (/^(?:[+\-−]|\d*\.)/.test(exponent)) return null;
        const group = /^(?:[A-Za-z]+\s*)?\(/.exec(exponent);
        const atom = /^[A-Za-z0-9]+(?![A-Za-z0-9.])/.exec(exponent)?.[0];
        end = group ? argumentGroupEnd(body, start + group[0].length - 1) : atom ? start + atom.length : null;
      }
      if (end === null) return null;
      if (/^(?:\s|\\[,;:! ]|\\(?:quad|qquad)(?![A-Za-z])|~)*\^/.test(body.slice(end))) return null;
    } else if (token === "\\sqrt" || /^\\[dt]?frac$/.test(token)) {
      const first = bracedArgument(body, after);
      if (!first) return null;
      argumentGroups.add(first.start);
      if (token !== "\\sqrt") {
        const second = bracedArgument(body, first.end);
        if (!second) return null;
        argumentGroups.add(second.start);
      }
    } else if (token === "\\left" || token === "\\right") {
      const delimiter = /^[ \t\r\n]*(\\\||[()[\]|])/.exec(body.slice(after));
      if (!delimiter) return null;
      tokens.lastIndex += delimiter[0].length;
      if (token === "\\left") {
        const close = TEX_CLOSERS.get(delimiter[1]!);
        if (!close) return null;
        closers.push(close);
      } else if (closers.pop() !== delimiter[1]) {
        return null;
      }
    } else if (!TEX_SCALAR_COMMANDS.has(token) && !/^\\(?:[,;:! ]|quad|qquad)$/.test(token)) {
      return null;
    }
  }
  if (closers.length) return null;
  return body.replace(/\\[dt]frac(?![A-Za-z])/g, "\\frac")
    .replace(/(\\left\s*)\[/g, "$1(").replace(/(\\right\s*)\]/g, "$1)");
}

function parseExpression(text: string, derivativeOperand = false, texOperand = false): ParsedExpression | null {
  if (text.length > MAX_EXPRESSION_LENGTH) return null;
  const body = unwrapMath(text);
  const wrapped = text.trim().startsWith("$");
  if (!body) return null;
  const fenced = wrapped || texOperand;
  if (!fenced && (body.includes("~") || UNFENCED_ESCAPE.test(body))) return null;
  const source = fenced ? body : body.replace(/\\\*/g, "*");
  const texMode = fenced || source.includes("\\");
  const validated = validateTexExpression(source, texMode);
  if (!validated) return null;
  // The engine allows adjacent identifiers as implicit products. Reject words before normalization.
  const words = validated.match(/\\[A-Za-z]+|[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  if (words.some(word => !word.startsWith("\\") && word.length > 1 && !SCALAR_FUNCTIONS.has(word))) return null;
  const normalized = normalizeLatexExpr(validated);
  if (!normalized || (derivativeOperand && !isSingleDerivativeOperand(normalized))) return null;
  const expr = parseScalarExpr(normalized);
  return expr && inspectExpression(expr);
}

function openDomainCarrier(expression: ParsedExpression, requireAnalytic = false): ScalarExpr {
  let guarded = expression.expr;
  // ln(u) has the strict domain u > 0, including for a radicand whose square root allows zero.
  for (const value of expression.radicands) guarded = { kind: "add", left: guarded, right: { kind: "ln", value } };
  if (requireAnalytic) {
    for (const value of expression.absoluteValues) {
      guarded = { kind: "add", left: guarded, right: { kind: "div", left: UNIT, right: value } };
    }
  }
  return withZeroValue(guarded);
}

function hasDerivativeInterior(source: ParsedExpression, domain: Target["domain"]): boolean {
  if (!source.mayRestrictDomain) return true;
  const carrier = openDomainCarrier(source);
  const point = domain.intervals?.[0]?.left;
  if (point !== undefined) return verifyScalarEquivalence(carrier, ZERO, domain).status === "equivalent";

  // Interior witnesses alone cannot rule out radicand zeros elsewhere in the source domain.
  if (source.radicands.length && verifyScalarEquivalence(
    carrier, withZeroValue(source.expr), domain,
  ).status !== "equivalent") return false;

  let remaining = 2;
  const excluded = [...domain.excluded ?? []];
  for (const sample of [0, 1, -1, 2, -2, "1/2", "-1/2"]) {
    const at = { ...domain, intervals: [{ left: sample, right: sample }] };
    if (verifyScalarEquivalence(carrier, ZERO, at).status !== "equivalent") continue;
    if (--remaining === 0) return true;
    excluded.push(sample);
  }
  // Ask the engine for points in a domain that may be narrow or far from the origin.
  const shifted = { kind: "add", left: carrier, right: UNIT } as const;
  for (; remaining > 0; remaining--) {
    const search = { ...domain, excluded };
    const result = verifyScalarEquivalence(shifted, carrier, search);
    const witness = result.witness?.input;
    if (result.status !== "inequivalent" || witness === undefined || !toRational(witness) ||
        verifyScalarEquivalence(carrier, ZERO, { ...search, intervals: [{ left: witness, right: witness }] }).status !== "equivalent") {
      return false;
    }
    excluded.push(witness);
  }
  return true;
}

function targetSource(kind: SymbolicKind, source: ParsedExpression, domain?: DomainSpec): TargetSource | null {
  const variable = domain?.variable ?? source.variables.values().next().value ?? "x";
  if ((kind === "indefinite-integral" && variable === "C") || [...source.variables].some(name => name !== variable)) return null;
  return { kind, source, domain: { ...domain, variable } };
}

function makeTarget(input: TargetSource): Target | null {
  const { kind, source, domain } = input;
  if (kind !== "scalar" && !hasDerivativeInterior(source, domain)) return null;
  let expected = source.expr;
  if (kind === "derivative") {
    const derivative = differentiate(source.expr, domain.variable);
    if (!derivative) return null;
    // Differentiation can erase a restriction, such as ln(x) requiring x > 0.
    expected = source.mayRestrictDomain
      ? { kind: "add", left: derivative, right: withZeroValue(source.expr) }
      : derivative;
    const formal = inspectExpression(derivative);
    if (!formal) return null;
    // A quotient from the chain rule can omit points where the actual derivative exists.
    // Establish that its zero-denominator exclusions are already outside the source domain.
    if (formal.hasDenominator && verifyScalarEquivalence(
      withZeroValue(expected), withZeroValue(source.expr), domain,
    ).status !== "equivalent") return null;
  }
  return { ...input, expected };
}

function parseTargetExpression(text: string, promptKind: SymbolicKind, domain?: DomainSpec): TargetSource | null {
  const body = unwrapMath(text);
  if (!body) return null;
  const wrapped = text.trim().startsWith("$");
  const derivative = /^\\(?:dfrac|tfrac|frac)[ \t\r\n]*\{[ \t\r\n]*d[ \t\r\n]*\}[ \t\r\n]*\{[ \t\r\n]*d[ \t\r\n]*([A-Za-z])[ \t\r\n]*\}[ \t\r\n]*(.+)$/s.exec(body);
  const integral = /^\\int(?![A-Za-z])[ \t\r\n]*(.+?)((?:\\[,;:! ]|[ \t\r\n])*)d[ \t\r\n]*([A-Za-z])$/s.exec(body);
  if ((derivative || integral) && /[^\S \t\r\n]/.test(body)) return null;
  if (!wrapped && integral && !/^[ \t\r\n]*(?:\\,[ \t\r\n]*)?$/.test(integral[2]!)) return null;
  const kind = derivative ? "derivative" : integral ? "indefinite-integral" : promptKind;
  if ((promptKind !== "scalar" && kind !== promptKind) || (kind === "indefinite-integral" && !integral)) return null;
  const variable = derivative?.[1] ?? integral?.[3];
  if (domain?.variable && variable && domain.variable !== variable) return null;
  const expression = derivative ? derivative[2]! : integral ? integral[1]! : text;
  const source = parseExpression(expression, Boolean(derivative), wrapped);
  return source && targetSource(kind, source, variable ? { ...domain, variable } : domain);
}

function parseQuestion(question: string): Target | null {
  if (question.length > MAX_STEM_LENGTH || !keepsSymbolicMeaningWhenRendered(question, true)) return null;
  const prompt = /^(?:(求导|differentiate\b)|(求不定积分|(?:evaluate|find|compute)\s+(?:the\s+)?indefinite\s+integral\b)|(?:化简|展开|计算|求值|simplify\b|expand\b|calculate\b|evaluate\b))\s*[:：]?\s*(.+)$/is.exec(question.trim());
  if (!prompt) return null;
  const kind = prompt[1] ? "derivative" : prompt[2] ? "indefinite-integral" : "scalar";
  const body = prompt[3]!.replace(/[?？。]\s*$/, "").trim();
  const fullExpression = unwrapMath(body) ?? body;
  const suffix = /(?:[\s,，;；]+|\\(?:quad|qquad)\s*)(?:(where|for|at|当)\s+)?((?:\${1,2}|[(（])?\s*[A-Za-z]\s*(?:\\neq|\\ne|!=|≠|=)\s*[+-]?(?:\d+\/\d+|\d+(?:\.\d+)?|\.\d+)\s*(?:\${1,2}|[)）])?)$/i.exec(fullExpression);
  const condition = suffix && unwrapMath(suffix[2]!);
  const constraint = condition && /^([A-Za-z])\s*(\\neq|\\ne|!=|≠|=)\s*(\S+)$/.exec(
    condition.replace(/^\((.+)\)$|^（(.+)）$/, "$1$2").trim(),
  );
  let domain: DomainSpec | undefined;
  if (suffix) {
    if (!constraint || !toRational(constraint[3])) return null;
    const [, variable, relation, value] = constraint;
    const atPoint = suffix[1]?.toLowerCase() === "at";
    if (relation === "=" && atPoint && kind === "derivative") {
      domain = { variable, intervals: [{ left: value, right: value }] };
    } else if (relation !== "=" && !atPoint) {
      domain = { variable, excluded: [value!] };
    } else {
      return null;
    }
  }
  const expression = suffix ? fullExpression.slice(0, suffix.index).trim() : body;
  // Keep an original math wrapper when an exclusion was inside that wrapper.
  const outerFence = suffix && fullExpression !== body ? /^\${1,2}/.exec(body)?.[0] : undefined;
  const parsed = parseTargetExpression(outerFence ? outerFence + expression + outerFence : expression, kind, domain);
  const target = parsed && makeTarget(parsed);
  if (!target) return null;
  // A parenthesized or signed literal is still a single literal after parsing.
  let original = target.source.expr;
  while (original.kind === "neg") original = original.value;
  return target.kind === "scalar" && (original.kind === "const" || original.kind === "variable") ? null : target;
}

function compareToTarget(candidate: ParsedExpression, target: Target): VerificationResult {
  const { kind, expected, domain } = target;
  if ((domain.intervals?.some(({ left, right }) => left !== undefined && left === right) && candidate.variables.size) ||
      [...candidate.variables].some(name => name !== domain.variable && !(kind === "indefinite-integral" && name === "C"))) {
    return { status: "unverified" };
  }
  if (kind !== "indefinite-integral") return verifyScalarEquivalence(candidate.expr, expected, domain);
  const family = additiveConstant(candidate.expr, domain.variable);
  if (!family) return { status: "unverified" };
  if (family.coefficient.n === 0n) return { status: "inequivalent", reason: "missing_additive_constant" };
  const result = verifyIndefiniteIntegral({ student: family.expr, integrand: expected, domain });
  if (result.status === "equivalent") {
    const inspected = inspectExpression(family.expr);
    return inspected && hasDerivativeInterior(inspected, domain) ? result : { status: "unverified" };
  }
  if (result.reason !== "natural_domain_mismatch") return result;
  // Require a hole in the candidate itself at an interior point of the integrand's domain.
  const familyDomain = withZeroValue(family.expr);
  const coverage = verifyScalarEquivalence(familyDomain, openDomainCarrier(target.source), domain);
  if (coverage.reason !== "natural_domain_mismatch" || coverage.witness?.detail !== "student undefined") {
    return { status: "unverified" };
  }
  const familyDetails = inspectExpression(family.expr);
  if (!familyDetails || ((familyDetails.radicands.length || familyDetails.absoluteValues.length) &&
      verifyScalarEquivalence(openDomainCarrier(familyDetails, true), familyDomain, domain).status !== "equivalent")) {
    return { status: "unverified" };
  }
  // A restriction introduced by formal differentiation may be spurious at a root.
  const derivative = differentiate(family.expr, domain.variable);
  return derivative && verifyScalarEquivalence(withZeroValue(derivative), familyDomain, domain).status === "equivalent"
    ? result : { status: "unverified" };
}

/** Compare structured scalar, derivative or indefinite-integral steps. The reference is the expression being operated on. */
export function verifySymbolicStepEquivalence(check: {
  kind: SymbolicKind;
  reference: string;
  student: string;
  variable?: string;
}): EquivalenceStatus {
  return bounded("unverified", () => {
    if (check.variable !== undefined && !/^[A-Za-z]$/.test(check.variable)) return "unverified";
    const source = parseExpression(check.reference);
    const candidate = parseExpression(check.student);
    const parsed = source && targetSource(check.kind, source, { variable: check.variable });
    const target = parsed && makeTarget(parsed);
    return target && candidate ? compareToTarget(candidate, target).status : "unverified";
  });
}

function equalityTerms(text: string): string[] | null {
  const trimmed = text.trim();
  const unwrapped = unwrapMath(trimmed);
  const fence = unwrapped !== null ? /^\${1,2}/.exec(trimmed)?.[0] : undefined;
  const body = unwrapped ?? trimmed;
  const terms: string[] = [];
  const groups: string[] = [];
  let start = 0;
  const balanced = scanMathSpans(body, (char, index) => {
    if (char === "(" || char === "{") groups.push(char);
    else if (char === ")" || char === "}") {
      if (groups.pop() !== (char === ")" ? "(" : "{")) return false;
    } else if (char === "=" && !groups.length) {
      if (/[!<>=]/.test(body[index - 1] ?? "") || /[<>=]/.test(body[index + 1] ?? "")) return false;
      terms.push(body.slice(start, index));
      start = index + 1;
    }
    return terms.length < MAX_EQUALITY_TERMS;
  });
  if (!balanced || groups.length) return null;
  terms.push(body.slice(start));
  return fence ? terms.map(term => fence + term + fence) : terms;
}

function savedChoiceKeyTail(trimmed: string, id: string): string | null {
  for (const lead of ["", "(", "（"]) {
    const start = lead + id;
    if (!trimmed.startsWith(start)) continue;
    let tail = trimmed.slice(start.length);
    if (tail.startsWith(")") || tail.startsWith("）")) tail = tail.slice(1);
    if (!tail || /^[\s.．、:：,，]/u.test(tail)) return tail;
  }
  return null;
}

export function savedChoiceKeySuffix(key: string, id: string): string | null {
  const tail = savedChoiceKeyTail(key.trim(), id);
  // Preserve a decimal after a whitespace delimiter, as in "A .5".
  return tail === null ? null : tail.replace(/^[.．、:：,，]|^\s+(?:[．、:：,，]|\.(?!\d))/, "").trim();
}

export function savedChoiceKeyIds(options: ChoiceOptions, key: string): Set<string> {
  const trimmed = key.trim();
  return new Set(options.filter(option => savedChoiceKeyTail(trimmed, option.id) !== null).map(option => option.id));
}

export function matchSavedChoiceSubmission(options: ChoiceOptions, answer: string, correctId: string): Outcome {
  const submitted = options.filter(option => answer === option.id + ". " + option.label);
  if (submitted.length === 0) return "unparseable";
  if (submitted.length > 1) return null;
  return submitted[0]!.id === correctId ? "correct" : "incorrect";
}

// In integral equality chains, compare the expressions for the same arbitrary additive C.
function additiveConstant(expr: ScalarExpr, variable: string): { expr: ScalarExpr; coefficient: SpanRational } | null {
  if (expr.kind === "variable" && expr.name === "C") return { expr: ZERO, coefficient: ONE };
  if (expr.kind === "add" || expr.kind === "sub") {
    const left = additiveConstant(expr.left, variable);
    const right = additiveConstant(expr.right, variable);
    if (!left || !right) return null;
    return {
      expr: { ...expr, left: left.expr, right: right.expr },
      coefficient: (expr.kind === "add" ? addRational : subtractRational)(left.coefficient, right.coefficient),
    };
  }
  if (expr.kind === "neg") {
    const value = additiveConstant(expr.value, variable);
    return value && {
      expr: { kind: "neg", value: value.expr },
      coefficient: { n: -value.coefficient.n, d: value.coefficient.d },
    };
  }
  if (expr.kind === "mul" || expr.kind === "div") {
    const left = additiveConstant(expr.left, variable);
    const right = additiveConstant(expr.right, variable);
    if (!left || !right || (right.coefficient.n !== 0n && (expr.kind === "div" || left.coefficient.n !== 0n))) return null;
    const base = { ...expr, left: left.expr, right: right.expr };
    if (left.coefficient.n === 0n && right.coefficient.n === 0n) return { expr: base, coefficient: ORIGIN };
    const [family, factorExpr] = left.coefficient.n !== 0n ? [left, right.expr] : [right, left.expr];
    const factor = exactRationalValue(factorExpr, { variable });
    if (!factor || (expr.kind === "div" && factor.n === 0n)) return null;
    const coefficient = (expr.kind === "mul" ? multiplyRational : divideRational)(family.coefficient, factor);
    return { expr: base, coefficient };
  }
  // For the remaining operators C cannot be assumed to be purely additive.
  const pending: ScalarExpr[] = [expr];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === "variable" && node.name === "C") return null;
    if ("left" in node) pending.push(node.left, node.right);
    if ("base" in node) pending.push(node.base);
    if ("value" in node && node.kind !== "const") pending.push(node.value);
  }
  return { expr, coefficient: ORIGIN };
}

function compareExpressions(student: ParsedExpression, reference: ParsedExpression, target: Target): EquivalenceStatus {
  if (target.kind !== "indefinite-integral") {
    return verifyScalarEquivalence(student.expr, reference.expr, target.domain).status;
  }
  const left = additiveConstant(student.expr, target.domain.variable);
  const right = additiveConstant(reference.expr, target.domain.variable);
  if (!left || !right) return "unverified";
  if (!equalRational(left.coefficient, right.coefficient)) return "inequivalent";
  return verifyScalarEquivalence(left.expr, right.expr, target.domain).status;
}

function expressionKeyMatches(key: string, expected: ParsedExpression, target: Target): boolean {
  const terms = equalityTerms(key.trim().replace(KEY_PREFIX, ""));
  return Boolean(terms?.every(term => {
    const parsed = parseExpression(term);
    return parsed && (!target.domain.intervals?.length || !parsed.variables.size) &&
      compareExpressions(parsed, expected, target) === "equivalent";
  }));
}

function evaluateSymbolicChoice(options: ChoiceOptions, key: string, answer: string, target: Target): Outcome {
  if (options.length > 6) return null;
  const matches: { id: string; parsed: ParsedExpression }[] = [];
  for (const { id, label } of options) {
    if (label.length > MAX_EXPRESSION_LENGTH || !keepsSymbolicMeaningWhenRendered(label)) return null;
    const parsed = parseExpression(label);
    if (!parsed) return null;
    const { status } = compareToTarget(parsed, target);
    if (status === "unverified") return null;
    if (status === "equivalent") matches.push({ id, parsed });
  }
  const [match] = matches;
  if (!match || matches.length !== 1) return null;
  const prefixIds = savedChoiceKeyIds(options, key);
  if (prefixIds.size > 1) return null;
  if (prefixIds.size === 1) {
    const remainder = savedChoiceKeySuffix(key, match.id);
    if (remainder === null) return null;
    if (remainder && !expressionKeyMatches(remainder, match.parsed, target)) return null;
  } else if (!expressionKeyMatches(key, match.parsed, target)) {
    return null;
  }
  return answer.length > MAX_EXPRESSION_LENGTH ? "unparseable" : matchSavedChoiceSubmission(options, answer, match.id);
}

function rationalAtPoint(expr: ScalarExpr, domain: DomainSpec): SpanRational | undefined {
  const point = toRational(domain.intervals?.[0]?.left) ?? ORIGIN;
  return evaluateScalar(simplifyRadical(expr), point, domain.variable).value;
}

function reduceNamedConstants(expr: ScalarExpr, domain: DomainSpec, probe = false): ScalarExpr {
  switch (expr.kind) {
    case "sin":
    case "ln":
    case "cos":
    case "exp": {
      const inner = expr.value;
      if (expr.kind === "ln" && inner.kind === "exp") return reduceNamedConstants(inner.value, domain, probe);
      if (expr.kind === "exp" && inner.kind === "ln") {
        const value = reduceNamedConstants(inner.value, domain, probe);
        const rationalValue = rationalAtPoint(value, domain);
        if (rationalValue && rationalValue.n > 0n &&
            verifyScalarEquivalence(value, { kind: "const", value: rationalValue }, domain).status === "equivalent") {
          return value;
        }
      }
      const candidate: ScalarExpr = { kind: "const", value: expr.kind === "sin" || expr.kind === "ln" ? 0 : 1 };
      return probe || verifyScalarEquivalence(expr, candidate, domain).status === "equivalent" ? candidate : expr;
    }
    case "const":
    case "variable": return expr;
    case "pow": return { ...expr, base: reduceNamedConstants(expr.base, domain, probe) };
    case "add":
    case "sub":
    case "mul":
    case "div": return {
      ...expr, left: reduceNamedConstants(expr.left, domain, probe), right: reduceNamedConstants(expr.right, domain, probe),
    };
    default: return { ...expr, value: reduceNamedConstants(expr.value, domain, probe) };
  }
}

function exactRationalValue(expr: ScalarExpr, domain: DomainSpec, reduced?: ScalarExpr): SpanRational | undefined {
  const candidate = rationalAtPoint(reduced ?? reduceNamedConstants(expr, domain), domain)
    // Try a candidate from the remaining function atoms. Only an exact engine proof can authorize it.
    ?? rationalAtPoint(reduceNamedConstants(expr, domain, true), domain);
  return candidate && verifyScalarEquivalence(expr, { kind: "const", value: candidate }, domain).status === "equivalent"
    ? candidate : undefined;
}

function isPerfectSmallSquare(value: bigint): boolean {
  const root = BigInt(Math.floor(Math.sqrt(Number(value))));
  return root * root === value;
}

function isProvenIrrationalRadical(expr: ScalarExpr, domain: DomainSpec): boolean {
  const pending = [simplifyRadical(expr)];
  const radicands: bigint[] = [];
  const point = toRational(domain.intervals?.[0]?.left) ?? ORIGIN;
  while (pending.length) {
    let term = pending.pop()!;
    if (term.kind === "add" || term.kind === "sub") {
      pending.push(term.left, term.right);
      continue;
    }
    if (term.kind === "neg") {
      pending.push(term.value);
      continue;
    }
    if (evaluateScalar(term, point, domain.variable).defined) continue;
    if (term.kind === "mul") {
      const coefficient = evaluateScalar(term.left, point, domain.variable).value;
      if (!coefficient || coefficient.n === 0n) return false;
      term = term.right;
    }
    const radicand = term.kind === "sqrt" && term.value.kind === "const" ? toRational(term.value.value) : null;
    // The exact radical engine emits rational multiples of square roots of small integers.
    if (!radicand || radicand.d !== 1n || radicand.n <= 0n || radicand.n > 100_000_000n ||
        isPerfectSmallSquare(radicand.n)) return false;
    // Distinct nontrivial rational square classes are linearly independent over the rationals.
    for (const previous of radicands) {
      const gcd = bigGcd(previous, radicand.n);
      if (isPerfectSmallSquare(previous / gcd) && isPerfectSmallSquare(radicand.n / gcd)) return false;
    }
    radicands.push(radicand.n);
  }
  return radicands.length > 0;
}

function evaluateSymbolicNumeric(key: string, answer: string, target: Target): Outcome {
  if (target.kind === "indefinite-integral" || target.domain.excluded?.length ||
      (target.kind === "scalar" && target.source.variables.size)) return null;
  const parsedKey = parseExpression(key.trim().replace(KEY_PREFIX, ""));
  if (!parsedKey || parsedKey.variables.size || compareToTarget(parsedKey, target).status !== "equivalent") return null;
  const candidate = parseExpression(answer);
  if (!candidate || candidate.variables.size) return "unparseable";
  const result = compareToTarget(candidate, target);
  if (result.reason === "natural_domain_mismatch") return "unparseable";
  if (result.status === "equivalent") return "correct";
  let unresolvedDecimalTarget: ScalarExpr | undefined;
  if (answer.includes(".")) {
    const reduced = reduceNamedConstants(target.expected, target.domain);
    const rationalValue = exactRationalValue(target.expected, target.domain, reduced)
      ?? exactRationalValue(parsedKey.expr, {});
    if (rationalValue) {
      let denominator = rationalValue.d;
      while (denominator % 2n === 0n) denominator /= 2n;
      while (denominator % 5n === 0n) denominator /= 5n;
      if (denominator !== 1n) return "unparseable";
    } else {
      unresolvedDecimalTarget = reduced;
    }
  }
  if (result.status === "inequivalent" && unresolvedDecimalTarget &&
      !isProvenIrrationalRadical(unresolvedDecimalTarget, target.domain)) return null;
  return result.status === "inequivalent" ? "incorrect" : null;
}

export function evaluateSymbolicTeachingAnswer(
  question: string, interaction: TeachingQuestionInteraction | undefined, key: string | null, answer: string,
): Outcome {
  if (!interaction || !key || key.length > MAX_EXPRESSION_LENGTH || !key.trim()) return null;
  return bounded(null, () => {
    const target = parseQuestion(question);
    if (!target) return null;
    if (interaction.kind === "choice") return evaluateSymbolicChoice(interaction.options, key, answer, target);
    return interaction.unit === undefined ? evaluateSymbolicNumeric(key, answer, target) : null;
  });
}

type ProofClaimVerification = { status: EquivalenceStatus; unconditional: boolean };

function isValueRefutation(result: VerificationResult): boolean {
  return result.status === "inequivalent" && result.reason !== "natural_domain_mismatch";
}

function substitutePoint(expr: ScalarExpr, point: SpanRational): ScalarExpr {
  if (expr.kind === "const") return expr;
  if (expr.kind === "variable") return { kind: "const", value: point };
  if ("left" in expr) return { ...expr, left: substitutePoint(expr.left, point), right: substitutePoint(expr.right, point) };
  if (expr.kind === "pow") return { ...expr, base: substitutePoint(expr.base, point) };
  return { ...expr, value: substitutePoint(expr.value, point) };
}

function scalarProofContradiction(left: ParsedExpression, right: ParsedExpression): boolean {
  const variables = new Set([...left.variables, ...right.variables]);
  if (variables.size > 1) return false;
  const domain = { variable: variables.values().next().value ?? "x" };
  const result = verifyScalarEquivalence(right.expr, left.expr, domain);
  if (!isValueRefutation(result)) return false;
  if (!variables.size) return true;

  const difference = { kind: "sub", left: left.expr, right: right.expr } as const;
  const mayRestrict = left.mayRestrictDomain || right.mayRestrictDomain;
  if (mayRestrict && verifyScalarEquivalence(withZeroValue(left.expr), withZeroValue(right.expr), domain).status !== "equivalent") {
    return false;
  }
  const point = toRational(result.witness?.input) ?? ORIGIN;
  const value = substitutePoint(difference, point);
  const rational = exactRationalValue(value, domain);
  const constant: ScalarExpr = rational ? { kind: "const", value: rational } : value;
  if (!isValueRefutation(verifyScalarEquivalence(constant, ZERO, domain))) return false;
  if (!mayRestrict) return verifyScalarEquivalence(difference, constant, domain).status === "equivalent";
  // Retain any holes in the common domain while proving the difference is constant.
  const sameDomainConstant = { kind: "add", left: constant, right: withZeroValue(difference) } as const;
  return verifyScalarEquivalence(difference, sameDomainConstant, domain).status === "equivalent";
}

function scalarChainContradiction(terms: ParsedExpression[]): boolean {
  return terms.some((left, index) => terms.slice(index + 1).some(right => scalarProofContradiction(left, right)));
}

function integralChainContradiction(candidates: ParsedExpression[], variable: string): boolean {
  const families = candidates.flatMap(candidate => {
    const family = additiveConstant(candidate.expr, variable);
    if (!family) return [];
    return [{
      coefficient: family.coefficient,
      expression: {
        ...candidate,
        expr: family.expr,
        variables: new Set([...candidate.variables].filter(name => name !== "C")),
      },
    }];
  });
  return families.some((left, index) => families.slice(index + 1).some(right =>
    equalRational(left.coefficient, right.coefficient) && scalarProofContradiction(left.expression, right.expression)));
}

function calculusProofContradiction(candidate: ParsedExpression, target: Target, result: VerificationResult): boolean {
  if (!isValueRefutation(result)) return false;
  if (result.reason === "missing_additive_constant") return true;
  const { domain } = target;
  if (target.kind === "derivative") {
    if (verifyScalarEquivalence(withZeroValue(target.expected), openDomainCarrier(target.source), domain).status !== "equivalent") {
      return false;
    }
    const derivative = inspectExpression(target.expected);
    return derivative !== null && scalarProofContradiction(derivative, candidate);
  }
  const family = additiveConstant(candidate.expr, domain.variable);
  const compared = family ? { ...candidate, expr: family.expr } : candidate;
  if ((target.source.mayRestrictDomain || candidate.mayRestrictDomain) &&
      verifyScalarEquivalence(withZeroValue(compared.expr), withZeroValue(target.expected), domain).status !== "equivalent") {
    return false;
  }

  return [{ left: 0, leftOpen: true }, { right: 0, rightOpen: true }].every(interval => {
    const half = { ...domain, intervals: [interval] };
    if (!isValueRefutation(compareToTarget(candidate, { ...target, domain: half }))) return false;
    // A counterexample on a half-line rules out an identity on its subintervals only if
    // the expressions are analytic throughout it. A shifted radical or absolute value can switch branches.
    return [target.source, compared].every(expression =>
      (!expression.mayRestrictDomain && !expression.absoluteValues.length) ||
      verifyScalarEquivalence(openDomainCarrier(expression, true), ZERO, half).status === "equivalent");
  });
}

function standaloneProofEquationBody(claim: string): string {
  const body = claim.trim().replace(
    /^(?:(?:Step\s+\d{1,3}|第\s*\d{1,3}\s*步)\s*[:：.)]\s*|\d{1,3}\.\s+(?![\s+\-−*/^=]))/i, "",
  );
  const suffix = /[。，；：,;:]+\s*$|(?<!\.)\.\s*$/u.exec(body);
  if (!suffix) return body;
  let outside = false;
  const balanced = scanMathSpans(body, (_char, index) => {
    if (index === suffix.index) outside = true;
    return true;
  });
  return balanced && outside ? body.slice(0, suffix.index).trimEnd() : body;
}

/** Corroborate only standalone scalar identities and explicit calculus equations. */
export function verifyStandaloneProofEquationClaim(claim: string): ProofClaimVerification {
  const unverified: ProofClaimVerification = { status: "unverified", unconditional: false };
  if (claim.length > MAX_EXPRESSION_LENGTH) return unverified;
  return bounded(unverified, () => {
    const body = standaloneProofEquationBody(claim);
    if (!keepsSymbolicMeaningWhenRendered(body, true)) return unverified;
    const parts = equalityTerms(body);
    if (!parts || parts.length < 2) return unverified;
    const [first, ...rest] = parts;
    const candidates = rest.flatMap(term => {
      const parsed = parseExpression(term);
      return parsed ? [parsed] : [];
    });
    if (candidates.length !== rest.length) return unverified;
    const parsed = parseTargetExpression(first!, "scalar");
    if (!parsed) return unverified;
    // The RHS must agree with itself even when we cannot establish the calculus target's domain.
    if (candidates.length > 1) {
      const contradiction = (parsed.kind === "derivative" && scalarChainContradiction(candidates)) ||
        (parsed.kind === "indefinite-integral" && (integralChainContradiction(candidates, parsed.domain.variable) ||
          scalarChainContradiction(candidates.filter(candidate => !candidate.variables.has("C")))));
      if (contradiction) return { status: "inequivalent", unconditional: false };
    }
    const target = makeTarget(parsed);
    if (!target) return unverified;
    const variable = candidates.find(candidate => candidate.variables.size)?.variables.values().next().value;
    if (target.kind === "scalar" && target.source.variables.size === 0 && variable) target.domain.variable = variable;
    const results = candidates.map(candidate => compareToTarget(candidate, target));
    if (target.kind === "indefinite-integral" && candidates.length > 1) {
      if (candidates.slice(1).some(candidate => compareExpressions(candidate, candidates[0]!, target) !== "equivalent")) {
        // Candidate equality can depend on x or C even when one side fails as an antiderivative.
        return results.some(result => result.reason === "missing_additive_constant")
          ? { status: "inequivalent", unconditional: false }
          : unverified;
      }
    }
    if (results.some(result => result.status !== "equivalent") ||
        (target.kind === "derivative" &&
          candidates.slice(1).some(candidate => compareExpressions(candidate, candidates[0]!, target) !== "equivalent"))) {
      const contradiction = target.kind === "scalar"
        ? scalarChainContradiction([target.source, ...candidates])
        : candidates.some((candidate, index) => calculusProofContradiction(candidate, target, results[index]!));
      return contradiction ? { status: "inequivalent", unconditional: false } : unverified;
    }
    const unconditional = [target.source, ...candidates].every(expression => !expression.hasDenominator &&
      (!expression.mayRestrictDomain || verifyScalarEquivalence(
        withZeroValue(expression.expr), ZERO, target.domain,
      ).status === "equivalent"));
    return { status: "equivalent", unconditional };
  });
}

const INEQUALITY = /!=|≠|\\(?:neq|ne)(?![a-z])|\b(?:(?:is|are|was|were)\s+)?not\s+equal\s+to\b|\b(?:does|do|did)\s+not\s+equal\b|不等于/giu;
const COLLECTIVE_SIDES = /\b(?:sides|(?:both|(?:the\s+)?two)\s+(?:expressions|values|results))\s+(?:of\s+the\s+(?:equation|equality|identity|step)\s+)?(?:are\s+(?:not\s+equal|unequal)|do\s+not\s+(?:equal|match))\b(?:\s+(?:to\s+)?(?:each\s+other|one\s+another)\b)?|(?:左右)?(?:两边|两侧)(?:不相等|不等于|不等)/giu;
const COLLECTIVE_DENIAL_END = /\s*(?:$|[.,;:?!，。；：？！、)}\]）】]|(?:because|since|as|for|when|where|if|unless|although|though|while|and|but|so|in|on|over|at|under|by|without|with)\b|(?:因为|由于|所以|但是|而且|并且|且|并|但|在|当))/iuy;
const LEFT_SIDE = /\b(?:the\s+)?(?:left(?:[- ]hand)?\s+side|lhs)\b|等号左边|左边|左式/giu;
const RIGHT_SIDE = /\b(?:the\s+)?(?:right(?:[- ]hand)?\s+side|rhs)\b|等号右边|右边|右式/giu;
const INEQUALITY_TEXT_TOKEN = /(\${1,2})[^$\r\n]+\1|\\(?:[a-z]+|[,;:! ])|\bd[a-z]\b|!=|(\b(?!(?:sqrt|abs|ln|sin|cos|exp)\b)[a-z]{2,}\b|[\p{Script=Han}，。！？；：、,;:!?]|\.(?!\d))/giu;

export function feedbackDeniesProvenEquality(text: string, claim: string): boolean {
  let collectiveDenial = false;
  for (const match of text.matchAll(COLLECTIVE_SIDES)) {
    COLLECTIVE_DENIAL_END.lastIndex = match.index + match[0].length;
    if (!COLLECTIVE_DENIAL_END.test(text)) continue;
    collectiveDenial = true;
    break;
  }
  if (collectiveDenial && verifyStandaloneProofEquationClaim(claim).unconditional) return true;
  let assertion = text.replace(INEQUALITY, "!=");
  if (!assertion.includes("!=")) return false;
  const sides = claim.length <= MAX_EXPRESSION_LENGTH ? equalityTerms(standaloneProofEquationBody(claim)) : null;
  if (sides && sides.length >= 2) {
    assertion = assertion.replace(LEFT_SIDE, "\uE000").replace(RIGHT_SIDE, "\uE001");
  }
  assertion = assertion.replace(/\bzero\b|零/giu, "0").replace(/\bone\b/giu, "1");
  // Keep fenced math and TeX commands intact while removing surrounding prose.
  return assertion.replace(INEQUALITY_TEXT_TOKEN, (token, _fence, boundary) => boundary ? "\n" : token)
    .split("\n").some(assertion => {
      const operands = assertion.split("!=");
      if (operands.length !== 2) return false;
      const equality = sides && sides.length >= 2 ? operands.map(operand =>
        operand.replaceAll("\uE000", () => sides[0]!).replaceAll("\uE001", () => sides.at(-1)!),
      ) : operands;
      return verifyStandaloneProofEquationClaim(equality.join("=")).unconditional ||
        verifyStandaloneProofEquationClaim([equality[1]!, equality[0]!].join("=")).unconditional;
    });
}

type ProofStep = ProofFeedback["steps"][number];

const FIELD_CHARACTERISTIC = /(?:\\operatorname\{\s*char\s*\}|\b(?:characteristic|char)|特征)(?:\s*\([^()\r\n]+\))?/iu;
const DOMAIN_CLAUSE_TOKEN = new RegExp(
  FIELD_CHARACTERISTIC.source + String.raw`|\bgf\s*\([^()\r\n]+\)|/\s*\(\s*[0-9a-z]+\s*\)|!=|([,;:.!?()\r\n，；：。！？—–]|\b(?:but|however|whereas|while|though|although|yet)\b)`,
  "giu",
);
const DOMAIN_EXCLUSION_PREFIX = /(?:\b(?:not|never|neither|nor|without|other\s+than|rather\s+than|instead\s+of|unlike|apart\s+from|except|exclud\w*|avoid\w*)\b(?:\s+(?:work(?:ing)?|reason(?:ing)?|calculat(?:e|ing)|comput(?:e|ing)|operat(?:e|ing)|in|over|on|within|using|under|for|where|the|a|an|field))*|而非(?:在)?|而不是(?:在)?|不在|不是(?:在)?|排除|除了)(?:\s*\${1,2})?\s*$/iu;
const DOMAIN_EXCLUSION_SUFFIX = /(?:\s*\${1,2})?(?:\s+(?:(?:is|are|was|were|be|being|must\s+be|should\s+be)\s+)?(?:excluded|ruled\s+out|disallowed|omitted|avoided|not\s+(?:used|allowed))\b|\s*(?:除外|被排除))/iuy;
const REAL_SCALAR_DOMAIN = /(?:ℝ|\\(?:mathbb|mathbf)\{\s*R\s*\}|\b(?:reals|real\s+(?:numbers?(?:\s+fields?)?|fields?))\b|实数域?)/iu;
const EXCLUDED_ZERO_CHARACTERISTIC = new RegExp([
  FIELD_CHARACTERISTIC.source + String.raw`\s*(?:(?:is\s+)?not|other\s+than|rather\s+than|instead\s+of)\s*(?:0\b|zero\b|零)`,
  String.raw`\bnot\s+of\s+` + FIELD_CHARACTERISTIC.source + String.raw`\s+(?:0\b|zero\b|零)`,
].join("|"), "iu");

const INDEXED_FIELD = /(?:𝔽|ℤ|\\mathbb\{\s*[FZ]\s*\}|\\mathbf\{\s*[FZ]\s*\}|\b[FZ])\s*(?:(?:_\s*)?(?:\{\s*)?(?:[0-9]+(?:\^[0-9a-z]+)?|[pqn])(?![A-Za-z0-9])(?:\s*\})?|[₀-₉]+)/u;
const GALOIS_FIELD = /\bgf\s*\([0-9a-z^+\s]+\)/iu;
const FIELD_DESCRIPTION = /\b(?:finite|galois|residue|quotient|splitting|cyclotomic|p-adic|padic|complex|algebraically\s+closed|arbitrary|general|abstract)\s+fields?\b|\bfields?\s+of\s+(?:fractions|complex)\b/iu;
const NON_REAL_SCALAR_CONTEXT = [
  /(?:ℤ|\\mathbb\{\s*Z\s*\}|\\mathbf\{\s*Z\s*\}|\bZ)\s*\/\s*(?:\(\s*)?(?:[0-9]+|[A-Za-z])(?:\s*(?:ℤ|\\mathbb\{\s*Z\s*\}|\\mathbf\{\s*Z\s*\}|Z))?(?:\s*\))?(?![A-Za-z0-9])/u,
  INDEXED_FIELD,
  GALOIS_FIELD,
  /\b(?:modulo|mod)\b|\\(?:pmod|bmod)\b|同余|模\s*[0-9p]/iu,
  new RegExp(FIELD_CHARACTERISTIC.source + String.raw`\s*(?:(?:of\s+(?:(?:the\s+)?field\s+)?[^\s,.;:()]+\s+)?(?:(?:=|is\b|equals?\b|equal\s+to\b|为|是)\s*)?(?:[1-9][0-9]*|[pq]|two|three|five|seven|eleven|prime|positive|nonzero|non-zero)\b|(?:!=|≠|\\neq|\\ne|>)\s*(?:0|zero|零)(?![a-z0-9])|(?:(?:为|是|=)\s*)?(?:二|三|五|七|素数|质数|正|非零)|(?:不等于|不为)\s*(?:0|零))`, "iu"),
  new RegExp(String.raw`(?:${FIELD_DESCRIPTION.source})(?:\s+\${0,2}(?:${INDEXED_FIELD.source}|${GALOIS_FIELD.source}))?`, "iu"),
  /ℂ|ℍ|\\mathbb\{\s*[CH]\s*\}|\b(?:complex\s+numbers?|quaternions?|rings?|semirings?|boolean|tropical|matrix|matrices|vectors?|linear\s+operators?|operator\s+algebra)\b|有限域|伽罗瓦域|复数域|复数|四元数|布尔|半环|热带|矩阵|向量|算子/iu,
];

type ScalarDomain = "real" | "non_real";

const DOMAIN_MENTIONS = [
  ...NON_REAL_SCALAR_CONTEXT.map(pattern => ({ pattern, domain: "non_real" as const })),
  { pattern: REAL_SCALAR_DOMAIN, domain: "real" as const },
  { pattern: EXCLUDED_ZERO_CHARACTERISTIC, domain: "non_real" as const },
].map(({ pattern, domain }) => ({ pattern: new RegExp(pattern.source, pattern.flags + "g"), domain }));

const PROOF_SUPPOSITION = /\b(?:assume|assuming|suppose|supposing|hypothesi[sz]e)\b|(?:^|[.!?;:。！？；：])\s*(?:if\s+|(?:assumption|hypothesis)\s*[:：]|(?:先|现|暂且)?假设(?!\s*不成立)|不妨设|若)/iu;
const CONTRADICTION_INTENT = /\b(?:(?:for|by)\s+(?:way\s+of\s+|the\s+sake\s+of\s+)?contradiction|(?:seek\w*|sought|look\w*\s+for|search\w*\s+for|aim\w*\s+(?:for|at|to\s+[a-z]+)|(?:want\w*|need\w*)(?:\s+to\s+[a-z]+)?|(?:try\w*|attempt\w*|hop\w*|in\s+order)\s+to\s+[a-z]+|towards?|to\s+[a-z]+)\s+(?:a\s+|an\s+|some\s+|any\s+|the\s+)?contradiction)\b|(?:用|采用|使用|通过)?反证法?|(?:欲|试图|为了|寻求|寻找)(?:导出|推出|得到|得出)?矛盾/giu;
const EXPLICIT_COUNTERFACTUAL = /\b(?:(?:derived|resulting)\s+contradiction|(?:derive[sd]?|yield[sd]?|give[sn]?|show[sn]?|is)\s+(?:a|the)\s+contradiction)\b|^\s*contradiction\b|归谬|(?:推出|得到|得出|导出)矛盾/iu;
const OUTER_REJECTION_QUALIFIER = /(?:outer|first|initial|earlier)/u.source;
const INNER_REJECTION_QUALIFIER = /(?:inner|second|latter)/u.source;
const REJECTION_QUALIFIER = String.raw`(?:(${OUTER_REJECTION_QUALIFIER}|${INNER_REJECTION_QUALIFIER})\s+)?(?:assumption|supposition|hypothesis)`;
const EXPLICIT_REJECTION = new RegExp(String.raw`\b(?:(?:reject\w*|refut\w*|disprov\w*|discharg\w*|falsif\w*|negat\w*|contrary\s+to)\s+(?:the\s+)?${REJECTION_QUALIFIER}|${REJECTION_QUALIFIER}\s+(?:is\s+|must\s+be\s+)?(?:false|impossible|contradicted|rejected|refuted|discharged))\b|(?:否定|推翻)(原|上述|该|内层|外层)?假设|(原|上述|该|内层|外层)?假设不成立`, "iu");
const OUTER_REJECTION = new RegExp(String.raw`^(?:${OUTER_REJECTION_QUALIFIER}|外层|原)$`, "iu");
const INNER_REJECTION = new RegExp(String.raw`^(?:${INNER_REJECTION_QUALIFIER}|内层)$`, "iu");
const DERIVED_CONTRADICTION = /\b(?:contradict\w*|absurd\w*|reductio|which\s+is\s+impossible)\b|矛盾|归谬|荒谬/iu;
const INDIRECT_QUESTION = /\b(?:whether|(?:wonder|ask|check|test|see|question|consider)\w*\s+(?:if|whether|what)|what\s+if)\b|是否|能否/iu;
const CONDITIONAL_DOMAIN = /\b(?:if|whether|suppose|supposing|assuming|unless|imagine|in\s+case)\b|(?:如果|假若|若是?|倘若|要是|一旦)\s*(?=在|改在|换成|切换到)/iu;
const DOMAIN_MODAL = /\b(?:would|could|might)\b/iu;
const DOMAIN_MODAL_ACTION = /\b(?:instead|switch\w*|work\w*|chang\w*|differ\w*|hold\w*|fail\w*)\b/iu;
const CHINESE_DOMAIN_HYPOTHETICAL = /(?:本会|就会|将会)(?:改变|不同|成立)/u;
const CONDITIONAL_DISCHARGE = /\b(?:if|unless|in\s+case|whenever|provided(?:\s+that)?|once|when)\b|如果|若|倘若|要是|一旦|除非/iu;
const DISCHARGE_CLAUSE_END = /[;:；：\r\n]/u;
const CONTRADICTION_ROLE = /(?:contradict\w*|absurd\w*|reductio)/u.source;
const CONTRADICTION_ERROR = /(?:invalid|false|wrong|incorrect|mistaken|bogus|spurious|erroneous|flawed|unjustified|unsound|failed)/u.source;
const MODAL = /(?:might|may|could|would|should|possibly|perhaps|potentially|hopefully)/u.source;
const MODAL_PROOF_ROLE = /(?:contradict\w*|absurd\w*|reductio|assumption|supposition|hypothesis|reject\w*|refut\w*|discharg\w*|which\s+is\s+impossible)/u.source;
const NEGATED_PROOF_ROLE = [
  new RegExp(String.raw`\b${CONTRADICTION_ERROR}\b[^\S\r\n]+(?:(?:purported|alleged|claimed|supposed)[^\S\r\n]+)?${CONTRADICTION_ROLE}\b`, "giu"),
  new RegExp(String.raw`\b${CONTRADICTION_ROLE}\b(?:[^\S\r\n]+(?!(?:assumption|supposition|hypothesis)\b)[a-z'’-]+){0,5}[^\S\r\n]+(?:${CONTRADICTION_ERROR}|fails?|collapses?|breaks?\s+down)\b`, "giu"),
  /(?:矛盾|归谬|荒谬)(?:(?!假设|前提|假定)[^，。！？；：,.!?;:\r\n]){0,6}(?:不成立|无效|错误|有误|失败|站不住脚)|(?:无效|错误|虚假)的?(?:矛盾|归谬)/gu,
  new RegExp(String.raw`\b${MODAL}\b(?:[^\S\r\n]+[a-z'’-]+){0,6}[^\S\r\n]+${MODAL_PROOF_ROLE}\b|\b${MODAL_PROOF_ROLE}\b(?:[^\S\r\n]+[a-z'’-]+){0,6}[^\S\r\n]+${MODAL}\b`, "giu"),
  /(?:可能|也许|或许|未必|不一定)[^，。！？；：]{0,8}(?:矛盾|归谬|荒谬|(?:否定|推翻)(?:原|上述|该|内层|外层)?假设)|(?:矛盾|归谬|荒谬|(?:否定|推翻)(?:原|上述|该|内层|外层)?假设)[^，。！？；：]{0,8}(?:可能|也许|或许|未必|不一定)/gu,
  /\b(?:contradict\w*|assumption|supposition|hypothesis)[^\S\r\n]+(?:[a-z'’-]+[^\S\r\n]+){0,5}(?:yet\s+to\s+be(?:\s+[a-z'’-]+)?|far\s+from|short\s+of|unestablished|unproven|unreached|unresolved|pending|open|missing|absent|lacking)\b/giu,
  /\b(?:yet\s+to|far\s+from|short\s+of|remains?\s+to|still\s+(?:need\w*|have|must|try\w*|attempt\w*|wait\w*)|prior\s+to|before|until)\b(?:[^\S\r\n]+[a-z'’-]+){0,6}[^\S\r\n]+(?:contradict\w*|absurd\w*|reductio|reject\w*|refut\w*|discharg\w*)\b/giu,
  /\b(?:contradict\w*|assumption|supposition|hypothesis)[^\S\r\n]+(?:[a-z'’-]+[^\S\r\n]+){0,4}(?:not|never|[a-z]+n['’]t)\b/giu,
  /\b(?:not|no|never|neither|nor|without|hardly|fail\w*[^\S\r\n]+to|unable[^\S\r\n]+to|cannot|can['’]t|[a-z]+n['’]t|avoid\w*)\b(?:[^\S\r\n]+[a-z'’-]+){0,6}[^\S\r\n]+(?:assum\w*|suppos\w*|hypothesi[sz]\w*|contradict\w*|absurd\w*|reductio|impossib\w*|reject\w*|refut\w*|disprov\w*|discharg\w*|falsif\w*|negat\w*)\b/giu,
  /(?:有待|尚未|仍未|还未|直到|在[^，。！？；：]{0,8}之前)[^，。！？；：]{0,8}(?:矛盾|归谬|荒谬)|(?:矛盾|归谬|荒谬)[^，。！？；：]{0,8}(?:有待|尚未|仍未|还未)/gu,
  /(?:无|没有|未曾?|并未|并非|不会|不能|尚未|不)[^，。！？；：,.!?;:—–()\r\n]{0,8}(?:矛盾|归谬|荒谬|反证|(?:否定|推翻)(?:原|上述|该)?假设)/gu,
];

const SENTENCE_PUNCTUATION = /[.!?。？！]/u;
const SENTENCE_CLOSER = /["'”’)}\]】）》」』]/u;

function endsInQuestion(sentence: string): boolean {
  for (let index = sentence.length - 1; index >= 0; index--) {
    const char = sentence[index]!;
    if (char === "?" || char === "？") return true;
    if (!SENTENCE_PUNCTUATION.test(char) && !SENTENCE_CLOSER.test(char) && !/\s/u.test(char)) return false;
  }
  return false;
}

function splitProseSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let fence = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && /[$\\.!?。？！]/u.test(text[index + 1] ?? "")) {
      index++;
      continue;
    }
    if (char === "$") {
      let width = 1;
      while (text[index + width] === "$") width++;
      if (width === fence) fence = 0;
      else if (!fence && width <= 2) fence = width;
      index += width - 1;
      continue;
    }
    if (fence) continue;
    const newline = char === "\n" || char === "\r";
    if (!newline && !SENTENCE_PUNCTUATION.test(char)) continue;
    if (char === "!" && text[index + 1] === "=") continue;
    if (char === "." && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "")) continue;
    let end = index + 1;
    while (SENTENCE_PUNCTUATION.test(text[end] ?? "") || SENTENCE_CLOSER.test(text[end] ?? "")) end++;
    sentences.push(text.slice(start, end));
    start = end;
    index = end - 1;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

export function assertiveProseSentences(text: string): string[] {
  return splitProseSentences(text).filter(sentence => !endsInQuestion(sentence));
}

function advanceProofDomain(domain: ScalarDomain, texts: readonly (string | undefined)[]): ScalarDomain {
  for (const text of texts) {
    if (!text) continue;
    // Keep characteristic and field notation intact when splitting clauses.
    const clauses = assertiveProseSentences(text).flatMap(sentence => {
      const question = INDIRECT_QUESTION.exec(sentence);
      const conditional = CONDITIONAL_DOMAIN.exec(sentence);
      const end = Math.min(question?.index ?? sentence.length, conditional?.index ?? sentence.length);
      const clauses = sentence.slice(0, end)
        .replace(DOMAIN_CLAUSE_TOKEN, (token, boundary) => boundary ? "\n" : token).split("\n");
      return clauses.filter((clause, index) => {
        const leadsIntoCondition = conditional?.index === end && index === clauses.length - 1;
        return !CHINESE_DOMAIN_HYPOTHETICAL.test(clause) &&
          !(DOMAIN_MODAL.test(clause) && (leadsIntoCondition || DOMAIN_MODAL_ACTION.test(clause)));
      });
    });
    for (const clause of clauses) {
      const mentions = new Map<number, { end: number; domain: ScalarDomain }>();
      for (const { pattern, domain } of DOMAIN_MENTIONS) {
        for (const match of clause.matchAll(pattern)) {
          const end = match.index + match[0].length;
          if (end > (mentions.get(match.index)?.end ?? 0)) mentions.set(match.index, { end, domain });
        }
      }
      if (!mentions.size) continue;
      let previousEnd = 0;
      for (let index = 0; index < clause.length; index++) {
        const mention = mentions.get(index);
        if (!mention) continue;
        DOMAIN_EXCLUSION_SUFFIX.lastIndex = mention.end;
        const excluded = DOMAIN_EXCLUSION_PREFIX.test(clause.slice(previousEnd, index)) ||
          DOMAIN_EXCLUSION_SUFFIX.test(clause);
        if (!excluded) domain = mention.domain;
        else if (mention.domain === "real") domain = "non_real";
        previousEnd = mention.end;
        index = mention.end - 1;
      }
    }
  }
  return domain;
}

export const STEP_ANCHOR = /\bStep\s+(\d{1,3})\b|第\s*(\d{1,3})\s*步/giu;

type TextSpan = { start: number; end: number };

const SPACE = /\s/u;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const ALPHABETIC_PROSE = /^[\p{L}\p{M}\s]+[.!?。？！]*$/u;
const CALCULATION = /[=≠<>≤≥≈]|\\(?:ne|neq|le|leq|ge|geq|approx|equiv)\b|\d\s*[+×÷−-]/u;
const LATER_DOMAIN_TRANSITION = /\b(?:now|then|next|switch\w*|shift\w*|afterwards?)\b|随后|然后|接下来|切换|改用|改在/iu;

function prepareTranscription(transcription: string) {
  const sentenceEnds: number[] = [];
  const masked: string[] = [];
  const chars: (string | null)[] = [];
  const originalIndex: number[] = [];
  let offset = 0;
  let preambleEnd = 0;
  let inPreamble = true;
  for (const sentence of splitProseSentences(transcription)) {
    const end = offset + sentence.length;
    sentenceEnds.push(end);
    if (endsInQuestion(sentence)) {
      masked.push(" ".repeat(sentence.length));
      // Keep an ignored question from stitching together the two surrounding assertions.
      chars.push(null);
      originalIndex.push(offset);
    } else {
      masked.push(sentence);
      for (let index = 0; index < sentence.length; index++) {
        const char = sentence[index]!;
        if (SPACE.test(char)) continue;
        chars.push(char);
        originalIndex.push(offset + index);
      }
      if (inPreamble) {
        inPreamble = !CALCULATION.test(sentence) && !LATER_DOMAIN_TRANSITION.test(sentence);
        if (inPreamble) preambleEnd = end;
      }
    }
    offset = end;
  }
  return { context: masked.join(""), sentenceEnds, preambleEnd, chars, originalIndex };
}

type Transcription = ReturnType<typeof prepareTranscription>;

function firstTranscribedMatch(transcription: Transcription, candidate: string, cursor: number): TextSpan | undefined {
  const pattern = candidate.replace(/\s/gu, "");
  const { chars, context, originalIndex } = transcription;
  if (!pattern || pattern.length > chars.length - cursor) return undefined;
  const prose = ALPHABETIC_PROSE.test(candidate);
  const wordEnding = WORD_CHARACTER.test(pattern.at(-1)!);

  // A prefix table bounds the search even for long, almost-identical runs.
  const prefix = [0];
  for (let index = 1, length = 0; index < pattern.length; index++) {
    while (length && pattern[index] !== pattern[length]) length = prefix[length - 1]!;
    if (pattern[index] === pattern[length]) length++;
    prefix.push(length);
  }
  for (let index = cursor, length = 0; index < chars.length; index++) {
    while (length && chars[index] !== pattern[length]) length = prefix[length - 1]!;
    if (chars[index] === pattern[length]) length++;
    if (length !== pattern.length) continue;
    const start = originalIndex[index - length + 1]!;
    const end = originalIndex[index]! + 1;
    if (!prose || (!WORD_CHARACTER.test(context[start - 1] ?? "") &&
        (!wordEnding || !WORD_CHARACTER.test(context[end] ?? "")))) return { start, end };
    length = prefix[length - 1]!;
  }
  return undefined;
}

function locateTranscribedSteps(steps: readonly ProofStep[], transcription: Transcription) {
  const locations = new Map<ProofStep, TextSpan>();
  const { context, originalIndex } = transcription;
  let cursor = 0;
  let previousEnd = 0;
  for (const step of steps) {
    const body = standaloneProofEquationBody(step.claim);
    const candidates = new Set([step.claim.trim(), body, unwrapMath(body)]);
    let location: TextSpan | undefined;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = firstTranscribedMatch(transcription, candidate, cursor);
      if (!match) continue;
      let { start, end } = match;
      // An unwrapped match can be inside a fence in the transcription.
      const fence = context[start - 1] === "$" && context[end] === "$"
        ? (context[start - 2] === "$" && context[end + 1] === "$" ? 2 : 1) : 0;
      if (start - fence >= previousEnd) {
        start -= fence;
        end += fence;
      }
      if (!location || start < location.start || (start === location.start && end > location.end)) {
        location = { start, end };
      }
    }
    if (location) {
      locations.set(step, location);
      previousEnd = location.end;
      while (cursor < originalIndex.length && originalIndex[cursor]! < previousEnd) cursor++;
    }
  }
  return locations;
}

function collectDomainContext(text: string, global: string[], anchored: Map<number, string[]>): void {
  for (const sentence of assertiveProseSentences(text)) {
    let start = 0;
    let target = global;
    for (const match of sentence.matchAll(STEP_ANCHOR)) {
      target.push(sentence.slice(start, match.index));
      const stepNumber = Number(match[1] ?? match[2]);
      target = anchored.get(stepNumber) ?? [];
      anchored.set(stepNumber, target);
      start = match.index + match[0].length;
    }
    target.push(sentence.slice(start));
  }
}

export function proofStepUsesRealScalar(
  steps: readonly ProofStep[], transcription: string | undefined, proposalContext: readonly (string | undefined)[],
): ReadonlyMap<ProofStep, boolean> {
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  const transcribed = prepareTranscription(transcription ?? "");
  const locations = locateTranscribedSteps(ordered, transcribed);
  const global: string[] = [];
  const anchored = new Map<number, string[]>();
  for (const text of [locations.size ? undefined : transcription, ...proposalContext]) {
    if (text) collectDomainContext(text, global, anchored);
  }
  let domain = advanceProofDomain("real", global);
  let cursor = 0;
  const matches = locations.values();
  let next = matches.next();
  let sentenceIndex = 0;
  const result = new Map<ProofStep, boolean>();
  for (const step of ordered) {
    const location = locations.get(step);
    let end = cursor;
    if (location) {
      next = matches.next();
      while (transcribed.sentenceEnds[sentenceIndex]! < location.end) sentenceIndex++;
      end = Math.min(transcribed.sentenceEnds[sentenceIndex]!, next.value?.start ?? transcribed.context.length);
    } else if (cursor === 0 && locations.size) {
      end = Math.min(transcribed.preambleEnd, next.value?.start ?? 0);
    }
    if (end > cursor) {
      const immediate: string[] = [];
      collectDomainContext(transcribed.context.slice(cursor, end), immediate, anchored);
      domain = advanceProofDomain(domain, immediate);
      cursor = end;
    }
    for (let stepNumber = 0; stepNumber <= step.stepIndex; stepNumber++) {
      const deferred = anchored.get(stepNumber);
      if (!deferred) continue;
      domain = advanceProofDomain(domain, deferred);
      anchored.delete(stepNumber);
    }
    domain = advanceProofDomain(domain, [step.claim, step.feedback, step.repairPrompt]);
    result.set(step, domain === "real");
  }
  return result;
}

function proofRoleText(text: string): string {
  const assertions = assertiveProseSentences(text)
    .map(sentence => sentence.split(/([,;，；])/u).map(clause => {
      const indirect = INDIRECT_QUESTION.exec(clause);
      return indirect ? clause.slice(0, indirect.index) : clause;
    }).join("")).join("\n");
  return NEGATED_PROOF_ROLE.reduce((value, pattern) => value.replace(pattern, " "), assertions);
}

function assertedDischargeText(text: string): string {
  return text.split(DISCHARGE_CLAUSE_END).map(clause => {
    const conditional = CONDITIONAL_DISCHARGE.exec(clause);
    return conditional ? clause.slice(0, conditional.index) : clause;
  }).join("\n");
}

/** Only a discharged supposition scopes other steps. An explicitly counterfactual step can stand on its own. */
export function counterfactualProofSteps(steps: readonly ProofStep[]): ReadonlySet<ProofStep> {
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  const exempt = new Set<ProofStep>();
  const openStack: number[] = [];
  let pendingRejectionFromContradiction = false;
  for (const [pos, step] of ordered.entries()) {
    const texts = [step.claim, step.feedback].map(proofRoleText);
    const withoutIntent = texts.map(text => text.replace(CONTRADICTION_INTENT, " "));
    const hasIntent = texts.some((text, index) => text !== withoutIntent[index]);
    const explicitSupposition = texts.some(text => PROOF_SUPPOSITION.test(text));
    const opensSupposition = explicitSupposition || (hasIntent && openStack.length === 0);
    if (opensSupposition) {
      openStack.push(pos);
      pendingRejectionFromContradiction = false;
    }

    const assertedDischarge = withoutIntent.map(assertedDischargeText);
    if (ordered.length === 1 && ((explicitSupposition && hasIntent) ||
        assertedDischarge.some(text => EXPLICIT_COUNTERFACTUAL.test(text)))) {
      exempt.add(step);
    }
    const canDischargeFromFeedback = !opensSupposition || pos === ordered.length - 1;
    const dischargeTexts = canDischargeFromFeedback ? assertedDischarge : assertedDischarge.slice(0, 1);
    const rejection = dischargeTexts.map(text => EXPLICIT_REJECTION.exec(text)).find(match => match !== null);
    const qualifier = rejection?.slice(1).find(Boolean) ?? "";
    const outer = OUTER_REJECTION.test(qualifier);
    const inner = INNER_REJECTION.test(qualifier);
    const derives = !rejection && dischargeTexts.some(text => DERIVED_CONTRADICTION.test(text));
    if (rejection && pendingRejectionFromContradiction && !outer) {
      // A rejection after a derived contradiction can refer to the frame that already closed.
      exempt.add(step);
      pendingRejectionFromContradiction = false;
    } else if (openStack.length > (inner ? 1 : 0) && (rejection || derives)) {
      const start = outer ? openStack[0]! : openStack.pop()!;
      if (outer) openStack.length = 0;
      for (let index = start; index <= pos; index++) exempt.add(ordered[index]!);
      pendingRejectionFromContradiction = derives;
    } else if (rejection || derives || (pendingRejectionFromContradiction && !exempt.has(step) &&
      verifyStandaloneProofEquationClaim(step.claim).status === "inequivalent")) {
      pendingRejectionFromContradiction = false;
    }
  }
  return exempt;
}
