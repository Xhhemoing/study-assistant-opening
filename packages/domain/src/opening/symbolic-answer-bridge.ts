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

const PROOF_SUPPOSITION = /\b(?:assume|assuming|suppose|supposing|hypothesi[sz]e)\b|(?:^|[,.!?;:，。！？；：\r\n])\s*(?:if\s+|(?:assumption|hypothesis)\s*[:：]|(?:先|现|暂且)?(?:假设|假定)(?!\s*(?:(?:并非|并不|不是)\s*)?(?:不成立|错误|荒谬))|不妨设|(?:先|现|暂且|反)?设(?!置|计|备|施|想|定为)|若)/iu;
const CONTRADICTION_INTENT = /\b(?:(?:for|by)\s+(?:way\s+of\s+|the\s+sake\s+of\s+)?contradiction|(?:seek\w*|sought|look\w*\s+for|search\w*\s+for|aim\w*\s+(?:for|at|to\s+[a-z]+)|(?:want\w*|need\w*)(?:\s+to\s+[a-z]+)?|(?:try\w*|attempt\w*|hop\w*|in\s+order)\s+to\s+[a-z]+|towards?|to\s+(?!(?:a|an|the)\s)[a-z]+)\s+(?:a\s+|an\s+|some\s+|any\s+|the\s+)?contradiction)\b|(?:用|采用|使用|通过)?反证法?|(?:欲|试图|为了|寻求|寻找)(?:导出|推出|得到|得出)?矛盾/giu;
const OUTER_REJECTION_QUALIFIER = /(?:outer|first|initial|earlier)/u.source;
const INNER_REJECTION_QUALIFIER = /(?:inner|second|latter)/u.source;
const REJECTION_TARGET = String.raw`(?:(${OUTER_REJECTION_QUALIFIER}|${INNER_REJECTION_QUALIFIER})\s+)?(?:assumption|supposition|hypothesis|premise)`;
const REJECTION_ACTION = /(?:(?:reject|refut|disprov|discharg|falsif|negat|contradict)\w*|contrary\s+to)/u.source;
const REJECTION_RESULT = /(?:false|impossible|contradicted|rejected|refuted|disproved|discharged|falsified|negated)/u.source;
const REJECTION_COPULA = /(?:(?:is|was|must\s+be|has\s+been|has\s+proved(?:\s+to\s+be)?)\s+)?/u.source;
const CHINESE_ASSUMPTION = /(?:假设|假定|前提)/u.source;
const CHINESE_REJECTION_QUALIFIER = /原|上述|该|内层|外层/u.source;
const CHINESE_REJECTION_ACTION = /(?:否定|推翻|驳倒|反驳|证伪|驳斥)/u.source;
const CHINESE_REJECTION_RESULT = /(?:不成立|错误|荒谬|被(?:否定|推翻|驳倒|反驳|证伪|驳斥))/u.source;
const CHINESE_REJECTION_TARGET = String.raw`(${CHINESE_REJECTION_QUALIFIER})?${CHINESE_ASSUMPTION}`;
const ACTIVE_REJECTION = String.raw`${REJECTION_ACTION}\s+(?:(?:the|this|that)\s+)?${REJECTION_TARGET}`;
const PASSIVE_REJECTION = String.raw`${REJECTION_TARGET}\s+${REJECTION_COPULA}${REJECTION_RESULT}`;
const CHINESE_REJECTION = String.raw`(?:${CHINESE_REJECTION_ACTION}${CHINESE_REJECTION_TARGET}|${CHINESE_REJECTION_TARGET}(?:是|为)?${CHINESE_REJECTION_RESULT})`;
const EXPLICIT_REJECTION = new RegExp(String.raw`\b(?:${ACTIVE_REJECTION}|${PASSIVE_REJECTION})\b|${CHINESE_REJECTION}`, "iu");
const OUTER_REJECTION = new RegExp(String.raw`^(?:${OUTER_REJECTION_QUALIFIER}|外层|原)$`, "iu");
const INNER_REJECTION = new RegExp(String.raw`^(?:${INNER_REJECTION_QUALIFIER}|内层)$`, "iu");
const DERIVED_CONTRADICTION = new RegExp([
  /(?:^|[—–])\s*\(?(?:(?:a|the)\s+)?contradiction[.!。！)\s]*$/iu.source,
  /\b(?:(?:is|are|was|were|becomes?)\s+(?:(?:a|an|the|this|that|another)\s+(?:(?:derived|resulting|logical|direct|clear|actual)\s+)?contradiction|(?:(?:derived|resulting|logical|direct|clear|actual)\s+)?contradictions)|(?:constitut\w*|reach\w*|yield\w*|giv(?:e|es|en|ing)|gave|deriv\w*|lead\w*\s+to|led\s+to|result\w*\s+in|produc\w*|obtain\w*|show\w*|have|has|had|found|finds?)\s+(?:(?:a|an|the|this|that|another)\s+)?(?:(?:derived|resulting|logical|direct|clear|actual)\s+)?contradictions?)\b(?!\s+(?:of|rule|definition|concept|example|form|notation|principle)\b)/iu.source,
  /\b(?:contradict(?:s|ed)\s+(?!(?:the\s+)?(?:rule|definition|concept|principle)\s+of\s+contradiction)\S|in\s+contradiction\s+with\b|(?:which|this|that|it)\s+is\s+(?:impossible|absurd)\b(?!\s*(?:\(\s*)?(?:to|that)\b)|by\s+reductio\b)/iu.source,
  /^\s*(?:矛盾|归谬|荒谬)[。！!\s]*$|(?:导出|推出|得到|得出|产生|出现|构成|造成|发现|导致|由此(?:可知|可见)?|自相)\s*矛盾(?!\s*的)|(?:这|此结论|此结果)(?:显然|实在|确实)?(?:是|很|太)?(?:荒谬|不可能)(?:(?!的)|的(?=[。！!\s]*$))|与[^，。！？；：,.!?;:\r\n]+矛盾(?=\s*(?:$|[，。！？；：,.!?;:]|因此|所以|从而|故))|(?:由此|从而|据此)归谬(?!\s*的)/u.source,
].join("|"), "iu");
const LEXICAL_PROOF_SUBJECT = /^(?:(?:the|a|an|this|that|our)\s+)?(?:(?:technical|ordinary|english|chinese|relevant|quoted|following|new|mathematical|logical|current|next|first|second|stated|purported|known|chosen)\s+)*(?:word|term|terminology|vocabulary|topic|subject|theme|title|name|label|concept|notion|definition|meaning|section|chapter|lesson|example|exercise|question|sense|spelling)s?\b|(?:介绍|讨论|讲解|解释|定义).*(?:术语|概念)|^(?:本|这一|该)(?:节|章|课|例|题)(?:介绍|讨论|讲解|解释|定义)/iu;
const PROOF_QUOTATION = /(?<!\x60)(\x60{1,3})(?!\x60)[^\r\n]+?(?<!\x60)\1(?!\x60)|\$\$[^\r\n]+?\$\$|\$[^$\r\n]+\$|"[^"\r\n]+"|“[^”\r\n]+”|(?:(?<![\p{L}\p{N}])|(?<=\p{Script=Han}))‘(?:[^‘’\r\n]|(?<=[\p{L}\p{N}])’(?=[\p{L}\p{N}])|(?<![\p{L}\p{N}])’(?=\p{L})|(?<=s)’(?=[^\S\r\n]+\p{Ll}[^‘’\r\n]*’))+(?:’(?![\p{L}\p{N}])|’(?=\p{Script=Han}))|(?<![\p{L}\p{N}])'(?:[^'\r\n]|(?<=[\p{L}])'(?=[\p{L}]))+'(?![\p{L}\p{N}])|「[^」\r\n]+」|『[^』\r\n]+』|《[^》\r\n]+》/gu;
export const ILLUSTRATIVE_PROOF_ROLE = /\bas\s+an?\s+(?:example|illustration|template|sample|model|instance|phrase|wording)\b|作为[^，。；！？,;.!?\r\n]{0,24}(?:例子|示例|示范|样例)|举例(?:说明|而言)/iu;

export function maskProofQuotations(text: string, preserveCodeEquations = false): string {
  return text.replace(PROOF_QUOTATION, (span, codeFence: string | undefined) => {
    if (span.startsWith("$")) return span;
    if (preserveCodeEquations && codeFence && span.length <= MAX_EXPRESSION_LENGTH) {
      const body = span.slice(codeFence.length, -codeFence.length);
      const terms = equalityTerms(body);
      if (terms && terms.length > 1 && terms.every(term => parseExpression(term))) {
        const padding = " ".repeat(codeFence.length - 1);
        return padding + "$" + body + "$" + padding;
      }
    }
    return " ".repeat(span.length);
  });
}
const INDIRECT_QUESTION = /\b(?:whether|(?:wonder|ask|check|test|see|question|consider)\w*\s+(?:if|whether|what)|what\s+if)\b|是否|能否/iu;
const CONDITIONAL_DOMAIN = /\b(?:if|whether|suppose|supposing|assuming|unless|imagine|in\s+case)\b|(?:如果|假若|若是?|倘若|要是|一旦)\s*(?=在|改在|换成|切换到)/iu;
const DOMAIN_MODAL = /\b(?:would|could|might)\b/iu;
const DOMAIN_MODAL_ACTION = /\b(?:instead|switch\w*|work\w*|chang\w*|differ\w*|hold\w*|fail\w*)\b/iu;
const CHINESE_DOMAIN_HYPOTHETICAL = /(?:本会|就会|将会)(?:改变|不同|成立)/u;
const CONDITIONAL_DISCHARGE = /\b(?:if|unless|in\s+case|whenever|provided|assuming|supposing|on\s+condition|once|when)\b|如果|若|倘若|要是|一旦|除非|只有|只要|前提是|当且仅当/iu;
const SEQUENTIAL_DISCHARGE = /^(?:when\b|当(?!且仅当))/iu;
const DEDUCTIVE_CONCLUSION = /[,，]\s*(?:\b(?:so|therefore|hence|thus)\b|从而|因此|故|所以)\s*/iu;
const DISCHARGE_CLAUSE_END = /[;:；：\r\n]/u;
const CONTRADICTION_ROLE = /(?:contradict\w*|absurd\w*|reductio)/u.source;
const CONTRADICTION_ERROR = /(?:invalid|false|wrong|incorrect|mistaken|bogus|spurious|erroneous|flawed|unjustified|unsound|failed)/u.source;
const MODAL = /(?:might|may|could|would|should|possibly|perhaps|potentially|hopefully)/u.source;
const MODAL_PROOF_ROLE = /(?:contradict\w*|absurd\w*|reductio|assumption|supposition|hypothesis|reject\w*|refut\w*|discharg\w*|which\s+is\s+impossible)/u.source;
const ENGLISH_DISCHARGE_HEDGE = String.raw`(?:${MODAL}|not|no|never|neither|nor|without|hardly|fail\w*\s+to|unable\s+to|cannot|[a-z]+n['’]t|avoid\w*|yet\s+to|far\s+from|short\s+of|remains?\s+to|still\s+(?:need\w*|have|must|try\w*|attempt\w*|wait\w*)|prior\s+to|before|until)`;
const CHINESE_DISCHARGE_HEDGE = /(?:无|没有|未曾?|未能|并未|并非|并不|不是|不会|不能|无法|不足以|尚未|仍未|还未|可能|也许|或许|未必|不一定|有待|仍需)/u.source;
const PENDING_REJECTION = /^[\s,，"”’')）]*(?:(?:remains?|is|was|are|were|be|being|been)[\s,]+(?:(?:still|actually|clearly|however|indeed)[\s,]+)?(?:unproved|unproven|unverified|open|pending|doubtful|unjustified|unsupported|unestablished|questionable|uncertain|disputed|premature|false|wrong|incorrect|invalid|mistaken)|(?:has|have|had)\s+(?:not|never)\s+been\s+(?:proved|proven|shown|established))\b/iu;
const CHINESE_PENDING_REJECTION = /^[\s,，"”’')）]*(?:的)?(?:这一|该|上述)?(?:说法|结论|断言|判断|观点)?\s*(?:(?:尚未|未经|未获|有待|并未)(?:证明|证实|确立|成立)|(?:是|为)?(?:存疑|不成立|错误|有误|站不住脚))/u;
const UNPROVED_PROOF_ROLE = /\b(?:(?:needs?|requires?|awaits?|lacks?|wants?|demands?|is\s+(?:missing|without))\s+(?:(?:further|a|any|valid|rigorous)\s+)*(?:to\s+be\s+(?:prov|verif|justif|establish|demonstrat|show|confirm)\w*|proof|justification|verification|derivation|argument|evidence|support)|(?:remains?|is(?:\s+still)?)\s+(?:to\s+be\s+(?:prov|verif|justif|establish|demonstrat|show|confirm)\w*|unprov\w*|unverif\w*|unjustif\w*|unestablished|unsupported|open)|(?:has|have|had)\s+not\s+(?:yet\s+)?been\s+(?:prov|verif|justif|establish|demonstrat|show|confirm)\w*)\b|(?:仍待|尚待|有待|还需|仍需|尚需|需要|尚未|还未|未获|未经|缺乏|缺少)(?:(?:得到|获得?|进一步)\s*)?\s*(?:证明|证实|验证|推导|论证|说明|依据|理由)/iu;
const REJECTION_AS_TOPIC = /^(?:(?:consider|discuss|test|check|examine|question)\s+)?(?:(?:the|a|an|this|that)\s+)?(?:claim|assertion|statement|conclusion|idea|view|contention)\s+that\b/iu;
const ASSERTED_PROOF_PREDICATE = /\b(?:(?:follows?|results?)\s+from|(?:is|was|has\s+been)\s+(?:proved|proven|verified|justified|shown|established|demonstrated|confirmed|supported)|(?:we|this|that)\s+(?:prov|verif|justif|establish|demonstrat|show|confirm)\w*)\b/iu;
const REJECTION_ASIDE = /^\s*(?:\([^()]*\)|（[^（）]*）|[,，][^,，]*[,，])/u;
const END_OF_REJECTION = /^[\s.。!！"”’')）]*$/u;

// Classify a denied rejection before masking its individual words as proof roles.
const NONASSERTED_REJECTION = new RegExp([
  String.raw`\b${ENGLISH_DISCHARGE_HEDGE}\b(?:[^\S\r\n]+[a-z'’-]+){0,10}[^\S\r\n]+(?:${ACTIVE_REJECTION}|${PASSIVE_REJECTION})\b`,
  String.raw`\b${REJECTION_TARGET}\b(?:[^\S\r\n]+[a-z'’-]+){0,5}[^\S\r\n]+${ENGLISH_DISCHARGE_HEDGE}\b(?:[^\S\r\n]+[a-z'’-]+){0,5}[^\S\r\n]+${REJECTION_RESULT}\b`,
  String.raw`${CHINESE_DISCHARGE_HEDGE}[^，。！？；：,.!?;:\r\n]{0,20}${CHINESE_REJECTION}`,
  String.raw`${CHINESE_REJECTION_TARGET}(?:是|为)?${CHINESE_DISCHARGE_HEDGE}[^，。！？；：,.!?;:\r\n]{0,8}${CHINESE_REJECTION_RESULT}`,
  String.raw`${CHINESE_REJECTION_TARGET}(?:是|为)?${CHINESE_REJECTION_RESULT}(?:的(?:结论|判断|说法))?\s*${CHINESE_DISCHARGE_HEDGE}`,
].join("|"), "iu");

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
    if (char === "!" && (text[index + 1] === "=" || isPostfixFactorial(text, index))) continue;
    if (char === "." && /\d/u.test(text[index - 1] ?? "") && /\d/u.test(text[index + 1] ?? "")) continue;
    if (char === "." && (/\be\.g\.$/iu.test(text.slice(Math.max(0, index - 4), index + 1)) ||
      (/[eE]/u.test(text[index - 1] ?? "") && /^g\./iu.test(text.slice(index + 1, index + 3)) &&
        !isWordAt(text, index - 2)))) continue;
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

type ScopedDomainText = { text: string; temporary?: boolean };
type DomainScope = { stepIndex: number; temporary: boolean };
type CriterionDomainText = { label: string; feedback: string };

function* proofDomainChanges(texts: readonly ScopedDomainText[]) {
  for (const { text, temporary: inheritedTemporary } of texts) {
    // Keep characteristic and field notation intact when splitting clauses.
    const clauses = assertiveProseSentences(text).flatMap(sentence => {
      const question = INDIRECT_QUESTION.exec(sentence);
      const conditional = CONDITIONAL_DOMAIN.exec(sentence);
      const end = Math.min(question?.index ?? sentence.length, conditional?.index ?? sentence.length);
      const assertion = sentence.slice(0, end);
      const clauses: { text: string; separator: string }[] = [];
      let start = 0;
      for (const token of assertion.matchAll(DOMAIN_CLAUSE_TOKEN)) {
        if (!token[1]) continue;
        clauses.push({ text: assertion.slice(start, token.index), separator: token[1] });
        start = token.index + token[0].length;
      }
      clauses.push({ text: assertion.slice(start), separator: "" });
      return clauses.map((clause, index) => {
        const leadsIntoCondition = conditional?.index === end && index === clauses.length - 1;
        const { text } = clause;
        const ignored = CHINESE_DOMAIN_HYPOTHETICAL.test(text) ||
          (DOMAIN_MODAL.test(text) && (leadsIntoCondition || DOMAIN_MODAL_ACTION.test(text)));
        if (ignored) return { text: "", separator: "" };
        return clause;
      });
    });
    const temporaryQualifier = (clause: string | undefined) =>
      !!clause && isTemporaryProofDomain(clause) && !mentionsProofDomain(clause);
    for (const [clauseIndex, { text: clause, separator }] of clauses.entries()) {
      const previous = clauses[clauseIndex - 1];
      const following = clauses[clauseIndex + 1];
      const temporary = !PERMANENT_DOMAIN.test(clause) && !SEQUENTIAL_DOMAIN_TRANSITION.test(clause) &&
        (inheritedTemporary || isTemporaryProofDomain(clause) ||
          (isComma(previous?.separator) && temporaryQualifier(previous?.text)) ||
          (isComma(separator) && temporaryQualifier(following?.text)));
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
        if (!excluded) yield { domain: mention.domain, temporary };
        else if (mention.domain === "real") yield { domain: "non_real" as const, temporary };
        previousEnd = mention.end;
        index = mention.end - 1;
      }
    }
  }
}

type ProofDomain = { persistent: ScalarDomain; effective: ScalarDomain };

function advanceProofDomain(state: ProofDomain, texts: readonly ScopedDomainText[], includeTemporary = true): boolean {
  let applied = false;
  for (const change of proofDomainChanges(texts)) {
    if (change.temporary && !includeTemporary) continue;
    state.effective = change.domain;
    if (!change.temporary) state.persistent = change.domain;
    applied = true;
  }
  return applied;
}

type TextSpan = { start: number; end: number };

const SPACE = /\s/u;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const ALPHABETIC_PROSE = /^[\p{L}\p{M}\s]+[.!?。？！]*$/u;
const CALCULATION = /[=≠<>≤≥≈]|\\(?:ne|neq|le|leq|ge|geq|approx|equiv)\b|\d\s*[+×÷−-]/u;
const PROSE_CALCULATION = /\b(?:equals?|is\s+equal\s+to|adds?\s+up\s+to|sums?\s+to|is\s+congruent\s+to|evaluates?\s+to)\b|等于|同余于|相加为|相乘为|计算得/iu;
const PROOF_STEP_NOUN = /(?:steps?|lines?|parts?|cases?|calculations?|claims?|equalit(?:y|ies)|equations?|stages?)\b/u.source;
const CURRENT_STEP_NOUN = String.raw`\bthis\s+(?:(?:current|present|single|particular)\s+)?${PROOF_STEP_NOUN}`;
const CHINESE_CURRENT_STEP_NOUN = /(?:本|此|这一|当前)(?:步骤?|行|式|部分)(?:中|里|内|而言|来说)?/u.source;
const TEMPORARY_STEP_END = /\buntil\s+(?:this\s+(?:(?:current|present)\s+)?(?:step|line|part|case|calculation|claim|equation|stage)\s+(?:is\s+(?:done|finished|complete(?:d)?)|ends?)|this\s+is\s+(?:done|finished|complete(?:d)?)|the\s+end\s+of\s+this\s+step)\b|(?:在本步结束前|直到本步完成)/iu;
const DEFERRED_DOMAIN_TRANSITION = new RegExp([
  String.raw`\b(?:after|following|once|beyond)\s+(?:[\p{L}]+\s+){0,4}${CURRENT_STEP_NOUN}`,
  /\b(?:after|following|once|beyond)\s+this\b(?:\s+(?:is\s+(?:done|finished|complete(?:d)?)|ends?\b))?(?=\s*(?:$|[,.;:!?，。；：！？]|\b(?:we|you|use|work|switch|move|comput\w*|calculat\w*)\b))/iu.source,
  String.raw`(?:在|于)?(?:${CHINESE_CURRENT_STEP_NOUN}|此|这)(?:之后|以后|完成后)|从下一步(?:开始|起)`,
].join("|"), "iu");
const BEFORE_RELATIVE_TRANSITION = /^(?:[\s.,，;；。]|(?:and|but)\b|并且|而后|且|但是?)*$/iu;
const ENGLISH_ORDINALS = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ");
const ENGLISH_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const TENS_ORDINALS = ENGLISH_TENS.map(word => word.slice(0, -1) + "ieth");
const HAN_ORDINAL = /[一二三四五六七八九十百零两]+/u.source;
const STEP_REFERENCE = new RegExp([
  String.raw`(?<deferred>${DEFERRED_DOMAIN_TRANSITION.source})`,
  String.raw`(?<until>${TEMPORARY_STEP_END.source})`,
  String.raw`\b(?<inclusive>(?:every|each|all|both)\s+${PROOF_STEP_NOUN})`,
  String.raw`(?<current>${CURRENT_STEP_NOUN}|(?:在|对|针对|就)?${CHINESE_CURRENT_STEP_NOUN})`,
  /\bsteps?\s+(?<index>\d+)\b/u.source,
  String.raw`\b(?:(?:the|this|that)\s+)?(?<numeric>\d+)\s*(?:st|nd|rd|th)\s+${PROOF_STEP_NOUN}`,
  String.raw`\b(?:(?:the|this)\s+)?(?<word>(?:${ENGLISH_TENS.join("|")})[- ](?:${ENGLISH_ORDINALS.slice(0, 9).join("|")})|${[...TENS_ORDINALS,
    ...ENGLISH_ORDINALS].join("|")})\s+${PROOF_STEP_NOUN}`,
  String.raw`\b(?:the|this)\s+(?<unmapped>[a-z]+th)\s+${PROOF_STEP_NOUN}`,
  String.raw`\b(?:(?:the|this|that)\s+)?(?<relative>next|following|subsequent|later|remaining|final|last|penultimate|prior|previous|earlier|preceding|other|another)\s+${PROOF_STEP_NOUN}`,
  String.raw`(?:(?<fromEnd>倒数)\s*)?第\s*(?:(?<digits>\d+)|(?<han>${HAN_ORDINAL}))\s*(?:步骤?|行|部分|式|阶段)`,
  /(?<final>最后(?:一)?(?:步骤?|行|部分|式|阶段))|(?<previous>前一[步行]|上一[步行])|(?<other>其他步骤|其余步骤)|下一(?:步|行|部分)|后续步骤|接下来的步骤|后面的步骤|下式|后面/u.source,
].join("|"), "giu");
const FUTURE_STEP = /^(?:next|following|subsequent|later|remaining)$/u;
const LATER_DOMAIN_TRANSITION = /\b(?:now|then|next|after\s+which|whereupon|from\s+which\s+point|following\s+which|at\s+which\s+point|thereafter|subsequently|afterwards?|later|hereafter|from\s+now\s+on|for\s+the\s+rest)\b|随后|然后|接下来|此后|之后|接着|继而|下面/iu;
const SEQUENTIAL_DOMAIN_TRANSITION = /\b(?:then|thereafter|hereafter|subsequently|afterwards?|from\s+now\s+on|for\s+the\s+rest)\b|随后|然后|接下来|此后|接着|继而/iu;
const PERMANENT_DOMAIN = /\bpermanently\b|永久/iu;
const DOMAIN_SEQUENCE_BREAK = new RegExp(
  String.raw`[,，]\s*(?:and\s+)?(?=${SEQUENTIAL_DOMAIN_TRANSITION.source})|\s+(?:and\s+)?(?=\bthen\b)`, "giu",
);
const PREAMBLE_DOMAIN_SWITCH = /\b(?:switch\w*|shift\w*)\b|切换|改用|改在/iu;
const DOMAIN_SWITCH_ACTION = /\b(?:switch\w*|shift\w*|chang\w*|mov\w*|pass\w*)\s+(?:to|into|over\s+to)\b|切换|改用|改为|改在|转到|转用|换到|换用|換到|換用/iu;
const DOMAIN_TRANSITION_ACTION = /\b(?:work\w*|comput\w*|calculat\w*|operat\w*|reason\w*)\s+(?:in|over|within)\b/iu;
const DOMAIN_JUSTIFICATION = /\b(?:because|since|as|for|given\s+that|inasmuch\s+as|seeing\s+that|where)\b|因为|由于|鉴于|既然|其中/iu;
const POST_CLAIM_DOMAIN_BREAK = /[,，;；]|\b(?:and|but|yet|whereas|while)\b|并且|而后|且|但(?:是)?/giu;
const STEP_SCOPE_QUALIFIER = /^\s*(?:(?:starting|beginning|commencing)\s+)?(?:in|for|at|on|from|after|following|once|beyond|until|during|within|throughout|only|solely|exclusively|just|merely)\b|^\s*(?:从|在|自|对|仅|只)/iu;
const TEMPORARY_DOMAIN = /\btemporarily\b|暂时/iu;
const SINGLE_STEP_PREFIX = /\b(?:only|solely|exclusively|just|merely)(?:\s+(?:for|in|at|on|during|within|throughout))?(?:\s+(?:the|this|that|a|an|our|your))?\s*$|(?:仅|只|单独)(?:在|对|针对|就)?\s*$/iu;
const SINGLE_STEP_SUFFIX = /^\s*(?:only|alone|solely|exclusively)\b|^\s*(?:仅限|为限|单独)/iu;
const SINGLE_STEP_REFERENCE = /\bthis\s+single\b|仅此一步|只此一步/iu;
const RUBRIC_WORDING = /\b(?:rubrics?|feedback|comments?|templates?|sample\s+wording)\b|评分(?:细则|标准)|评语|反馈/iu;
const EXAMPLE_INTRO = /\bfor\s+example\b|\be\.\s*g\.|例如|举例(?:说明|而言)/iu;
const EXAMPLE_ASIDE_START = /[,，(（]\s*(?:\b(?:using|taking|choosing|giving|considering|treating|for\s+example)\b|以)/giu;
const CHINESE_EXAMPLE_ASIDE = /为例|作为(?:例子|示例|示范|样例)/u;

function isTemporaryProofDomain(text: string): boolean {
  if (TEMPORARY_DOMAIN.test(text) || TEMPORARY_STEP_END.test(text)) return true;
  for (const reference of text.matchAll(STEP_REFERENCE)) {
    if (SINGLE_STEP_REFERENCE.test(reference[0]) ||
      SINGLE_STEP_PREFIX.test(text.slice(0, reference.index)) ||
      SINGLE_STEP_SUFFIX.test(text.slice(reference.index + reference[0].length))) return true;
  }
  return false;
}

function hasStepScope(clause: string): boolean {
  return !!clause.matchAll(STEP_REFERENCE).next().value;
}

function mentionsProofDomain(clause: string): boolean {
  return DOMAIN_MENTIONS.some(({ pattern }) => !!clause.matchAll(pattern).next().value);
}

function isComma(separator: string | undefined): boolean {
  return separator === "," || separator === "，";
}

function joinsTrailingStepQualifier(clause: string, boundary: string, tail: string): boolean {
  return isComma(boundary) && (STEP_SCOPE_QUALIFIER.test(tail) || TEMPORARY_STEP_END.test(tail)) &&
    hasStepScope(tail) && !mentionsProofDomain(tail) && mentionsProofDomain(clause);
}

function startsLaterDomain(clause: string, qualified: boolean): boolean {
  if (qualified || hasStepScope(clause)) return false;
  return LATER_DOMAIN_TRANSITION.test(clause) || DOMAIN_SWITCH_ACTION.test(clause) ||
    (!DOMAIN_JUSTIFICATION.test(clause) && DOMAIN_TRANSITION_ACTION.test(clause));
}

function postClaimDomainEnd(text: string): number {
  let start = 0;
  let clauseStart = 0;
  let qualified = false;
  const boundaries = [...text.matchAll(POST_CLAIM_DOMAIN_BREAK)];
  for (const [index, boundary] of boundaries.entries()) {
    const clause = text.slice(clauseStart, boundary.index);
    const tail = text.slice(boundary.index + boundary[0].length, boundaries[index + 1]?.index);
    if (joinsTrailingStepQualifier(clause, boundary[0], tail)) continue;
    if (startsLaterDomain(clause, qualified)) return start;
    if (boundary[0] === ";" || boundary[0] === "；") return boundary.index;
    qualified = isComma(boundary[0]) && hasStepScope(clause) &&
      !mentionsProofDomain(clause) && !(TEMPORARY_STEP_END.test(clause) && SEQUENTIAL_DOMAIN_TRANSITION.test(tail));
    start = boundary.index;
    clauseStart = start + boundary[0].length;
  }
  const clause = text.slice(clauseStart);
  return startsLaterDomain(clause, qualified) ? start : text.length;
}

function prepareTranscription(transcription: string) {
  const sentenceEnds: number[] = [];
  const masked: string[] = [];
  const chars: (string | null)[] = [];
  const originalIndex: number[] = [];
  let offset = 0;
  let preambleEnd = 0;
  let firstProseClaim: TextSpan | undefined;
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
        const proseClaim = PROSE_CALCULATION.exec(sentence);
        const domainBeforeClaim = proseClaim && !CALCULATION.test(sentence.slice(0, proseClaim.index));
        if (domainBeforeClaim) firstProseClaim = { start: offset + proseClaim.index, end };
        inPreamble = !CALCULATION.test(sentence) && !proseClaim && !LATER_DOMAIN_TRANSITION.test(sentence) &&
          !DEFERRED_DOMAIN_TRANSITION.test(sentence) && !PREAMBLE_DOMAIN_SWITCH.test(sentence);
        if (inPreamble) preambleEnd = end;
      }
    }
    offset = end;
  }
  return { context: masked.join(""), sentenceEnds, preambleEnd, firstProseClaim, chars, originalIndex };
}

type Transcription = ReturnType<typeof prepareTranscription>;

type TranscriptionCandidate = {
  pattern: string;
  prose: boolean;
  failureTable: number[];
  maxStart: number;
};

type MatchNode = {
  edges: Map<string, number>;
  depth: number;
  failure: number;
  proseOutput: number;
  mathOutput: number;
  candidate?: TranscriptionCandidate;
  suffixes?: TerminalSuffixes;
};
type MatchOutput = "proseOutput" | "mathOutput";
type TerminalSuffixes = {
  depthBit: bigint;
  liveDepths: bigint;
  liveOutput: number;
};

function matchNode(depth: number): MatchNode {
  return { edges: new Map(), depth, failure: 0, proseOutput: 0, mathOutput: 0 };
}

const MATH_OPERATOR = /[+\-−±∓*/×÷·⋅^_=≠<>≤≥≈]/u;
const MATH_CONTINUATION = /[\\{}]/u;
const DECIMAL_DIGIT = /\d/u;
const MATH_LETTER = /[\p{Script=Latin}\p{Script=Greek}\u{1D400}-\u{1D7FF}]/u;
const MATH_OPEN = /[([{（]/u;
const MATH_CLOSE = /[)\]}）]/u;
const TEX_NAME_CHARACTER = /[a-z]/iu;
const HORIZONTAL_WHITESPACE = /[^\S\r\n]/u;
const PARENTHESIZED_MODULUS = /[(（]\s*mod(?:ulo)?\b/iuy;
const CHINESE_DOMAIN_AFTER_MATH = /(?:且|而后|并且|但(?:是)?)?\s*(?:随后|然后|接下来|此后|之后|接着|继而|下面|切换|改在|改用|改为|转到|换到|其中特征|下一(?:步|行|部分)|后续步骤|因为|由于|鉴于|既然|其中)/uy;
const PROSE_AFTER_MATH = /(?:in|on|at|by|to|of|or|as|if|so|we|is|be|are|was|were|over|under|with|without|from|into|onto|upon|mod|modulo|where|when|while|whereas|since|because|for|and|but|yet|nor|then|now|next|thus|hence|therefore|though|although|after|before|until|unless|via|per|holds?|gives?|yields?|equals?|shows?|means?|impl(?:ies|y)|proves?|has|have|had|does|do|did|can|may|must|will|would|should|could|which|that|who|whose)(?![\p{L}\p{N}\p{M}_])/iuy;
const FACTORIAL_CONTINUATION = /[a-z]|[在中下上与且或即时而及]/uy;

function isWordAt(text: string, offset: number): boolean {
  const codeUnit = text.charCodeAt(offset);
  const codePoint = text.codePointAt(codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? offset - 1 : offset);
  return codePoint !== undefined && WORD_CHARACTER.test(String.fromCodePoint(codePoint));
}

function mathBoundary(text: string, offset: number, adjacent: number): boolean {
  const char = text[offset] ?? "";
  return !isWordAt(text, offset) && !MATH_OPERATOR.test(char) && !MATH_CONTINUATION.test(char) &&
    !(char === "." && DECIMAL_DIGIT.test(text[adjacent] ?? "")) && !isPostfixFactorial(text, offset);
}

function codePointAt(text: string, offset: number): string {
  const point = text.codePointAt(offset);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function startsMathOperand(text: string, offset: number): boolean {
  const first = codePointAt(text, offset);
  if (MATH_OPEN.test(first)) {
    PARENTHESIZED_MODULUS.lastIndex = offset;
    return !PARENTHESIZED_MODULUS.test(text);
  }
  if (first === "\\") return TEX_NAME_CHARACTER.test(text[offset + 1] ?? "");
  if (!MATH_LETTER.test(first)) return DECIMAL_DIGIT.test(first);
  PROSE_AFTER_MATH.lastIndex = offset;
  return !PROSE_AFTER_MATH.test(text);
}

function endsMathOperand(text: string, offset: number): boolean {
  const last = text[offset] ?? "";
  if (DECIMAL_DIGIT.test(last) || MATH_CLOSE.test(last) || last === "!") return true;
  const unit = text.charCodeAt(offset);
  const start = unit >= 0xdc00 && unit <= 0xdfff ? offset - 1 : offset;
  if (MATH_LETTER.test(codePointAt(text, start)) && !isWordAt(text, start - 1)) return true;
  let command = offset;
  while (TEX_NAME_CHARACTER.test(text[command] ?? "")) command--;
  return command < offset && text[command] === "\\";
}

function isPostfixFactorial(text: string, offset: number): boolean {
  if (text[offset] !== "!" || !endsMathOperand(text, offset - 1)) return false;
  let following = offset + 1;
  while (HORIZONTAL_WHITESPACE.test(text[following] ?? "")) following++;
  const next = text[following] ?? "";
  FACTORIAL_CONTINUATION.lastIndex = following;
  if (FACTORIAL_CONTINUATION.test(text)) return true;
  if (following > offset + 1 && /[A-Z][a-z]/u.test(text.slice(following, following + 2))) return false;
  return !next || /[.!$,，;；。\r\n]/u.test(next) || MATH_OPERATOR.test(next) || MATH_CLOSE.test(next) ||
    startsMathOperand(text, following);
}

function mathStartsAt(context: string, start: number, preceding: number | undefined): boolean {
  if (!mathBoundary(context, start - 1, start - 2)) return false;
  if (preceding === undefined || preceding + 1 === start) return true;
  const before = context[preceding]!;
  return !(MATH_OPERATOR.test(before) || (before === "!" ? isPostfixFactorial(context, preceding) : endsMathOperand(context, preceding))) ||
    /[\r\n]/u.test(context.slice(preceding + 1, start));
}

function mathEndsAt(context: string, end: number, following: number | undefined): boolean {
  if (!mathBoundary(context, end, end + 1)) return false;
  return following === undefined || !(MATH_OPERATOR.test(context[following]!) || startsMathOperand(context, following)) ||
    /[\r\n]/u.test(context.slice(end, following));
}

function proseEndsAt(context: string, offset: number): boolean {
  return !isWordAt(context, offset) || !isWordAt(context, offset + 1);
}

function transcribedMathEndsAt(context: string, end: number, following: number | undefined): boolean {
  if (mathEndsAt(context, end, following)) return true;
  CHINESE_DOMAIN_AFTER_MATH.lastIndex = end;
  return CHINESE_DOMAIN_AFTER_MATH.test(context);
}

function indexTranscribedCandidates(transcription: Transcription, candidates: Iterable<TranscriptionCandidate>): void {
  const nodes = [matchNode(0)];
  let unresolved = 0;
  let longest = 0;
  for (const candidate of candidates) {
    unresolved++;
    longest = Math.max(longest, candidate.pattern.length);
    let nodeIndex = 0;
    for (let index = candidate.pattern.length - 1; index >= 0; index--) {
      const char = candidate.pattern[index]!;
      const node = nodes[nodeIndex]!;
      let child = node.edges.get(char);
      if (child === undefined) {
        child = nodes.length;
        node.edges.set(char, child);
        nodes.push(matchNode(node.depth + 1));
      }
      nodeIndex = child;
    }
    nodes[nodeIndex]!.candidate = candidate;
  }
  if (nodes.length === 1) return;

  function advance(nodeIndex: number, char: string): number {
    let target = nodes[nodeIndex]!.edges.get(char);
    while (target === undefined && nodeIndex !== 0) {
      nodeIndex = nodes[nodeIndex]!.failure;
      target = nodes[nodeIndex]!.edges.get(char);
    }
    return target ?? 0;
  }

  const queue = [...nodes[0]!.edges.values()];
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!;
    const node = nodes[index]!;
    const suffix = nodes[node.failure]!;
    // Each boundary rule has its own chain of reversed terminal suffixes.
    node.proseOutput = node.candidate?.prose ? index : suffix.proseOutput;
    node.mathOutput = node.candidate && !node.candidate.prose ? index : suffix.mathOutput;
    if (node.candidate) {
      const link = node.candidate.prose ? "proseOutput" : "mathOutput";
      const liveOutput = suffix[link];
      const depthBit = 1n << BigInt(node.depth - 1);
      node.suffixes = { depthBit, liveOutput, liveDepths: (nodes[liveOutput]!.suffixes?.liveDepths ?? 0n) | depthBit };
    }
    for (const [char, child] of node.edges) {
      nodes[child]!.failure = advance(node.failure, char);
      queue.push(child);
    }
  }

  const { chars, context, originalIndex } = transcription;
  // Bit d marks a valid right boundary d compact characters after the current
  // character. Proof claims are capped at 2,000 characters by the input schema.
  const depthMask = (1n << BigInt(longest)) - 1n;
  let state = 0;
  let proseEnds = 0n;
  let mathEnds = 0n;
  for (let index = chars.length - 1; index >= 0 && unresolved; index--) {
    const char = chars[index];
    if (char == null) {
      state = 0;
      proseEnds = mathEnds = 0n;
      continue;
    }
    const offset = originalIndex[index]!;
    proseEnds = ((proseEnds << 1n) | (proseEndsAt(context, offset) ? 1n : 0n)) & depthMask;
    mathEnds = ((mathEnds << 1n) | (transcribedMathEndsAt(context, offset + 1, originalIndex[index + 1]) ? 1n : 0n)) & depthMask;
    state = advance(state, char);
    const { proseOutput, mathOutput } = nodes[state]!;
    if (!isWordAt(context, offset - 1)) {
      if (proseOutput) recordMaxStart("proseOutput", proseEnds, offset);
      if (mathOutput && mathStartsAt(context, offset, originalIndex[index - 1])) {
        recordMaxStart("mathOutput", mathEnds, offset);
      }
    }
  }

  function liveOutput(nodeIndex: number, link: MatchOutput): number {
    let live = nodes[nodeIndex]![link];
    while (nodes[live]![link] !== live) live = nodes[live]![link];
    // Compress stale aliases so satisfied candidates are never reconsidered.
    while (nodes[nodeIndex]![link] !== live) {
      const next = nodes[nodeIndex]![link];
      nodes[nodeIndex]![link] = live;
      nodeIndex = next;
    }
    return live;
  }

  function recordMaxStart(link: MatchOutput, rightEnds: bigint, start: number): void {
    let index = liveOutput(state, link);
    if (((nodes[index]!.suffixes?.liveDepths ?? 0n) & rightEnds) === 0n) return;
    const visited: number[] = [];
    while (index) {
      const { liveDepths, liveOutput: suffix } = nodes[index]!.suffixes!;
      if ((liveDepths & rightEnds) === 0n) break;
      visited.push(index);
      index = liveOutput(suffix, link);
    }
    // Cached masks can overestimate after a suffix resolves on another chain.
    // Each visit removes either this terminal or a depth from its cached mask.
    for (let position = visited.length - 1; position >= 0; position--) {
      const terminalIndex = visited[position]!;
      const terminal = nodes[terminalIndex]!;
      const suffixes = terminal.suffixes!;
      if ((suffixes.depthBit & rightEnds) !== 0n) {
        terminal.candidate!.maxStart = start;
        terminal[link] = index;
        unresolved--;
      } else {
        suffixes.liveOutput = index;
        suffixes.liveDepths = (nodes[index]!.suffixes?.liveDepths ?? 0n) | suffixes.depthBit;
        index = terminalIndex;
      }
    }
  }
}

function patternFailureTable(pattern: string): number[] {
  const failure = [0];
  let prefix = 0;
  for (let index = 1; index < pattern.length; index++) {
    while (prefix && pattern[prefix] !== pattern[index]) prefix = failure[prefix - 1]!;
    if (pattern[prefix] === pattern[index]) prefix++;
    failure.push(prefix);
  }
  return failure;
}

function locateTranscribedSteps(steps: readonly ProofStep[], transcription: Transcription) {
  const locations = new Map<ProofStep, TextSpan>();
  if (!transcription.chars.length) return locations;

  const candidates = new Map<string, TranscriptionCandidate>();
  const candidatesByStep = steps.map(step => {
    const body = standaloneProofEquationBody(step.claim);
    const patterns = new Set([step.claim.trim(), body, unwrapMath(body)].map(text => text?.replace(/\s/gu, "") ?? ""));
    patterns.delete("");
    return [...patterns].map(pattern => {
      const existing = candidates.get(pattern);
      if (existing) return existing;
      const candidate = { pattern, prose: ALPHABETIC_PROSE.test(pattern), failureTable: patternFailureTable(pattern), maxStart: -1 };
      candidates.set(pattern, candidate);
      return candidate;
    });
  });
  indexTranscribedCandidates(transcription, candidates.values());

  const { chars, context, originalIndex } = transcription;
  let cursor = 0;
  let charCursor = 0;
  for (const [stepIndex, step] of steps.entries()) {
    const active = candidatesByStep[stepIndex]!.filter(candidate => candidate.maxStart >= cursor);
    if (!active.length) continue;
    const prefixes = active.map(() => 0);
    const longest = Math.max(...active.map(candidate => candidate.pattern.length));
    let bestStart = -1;
    let bestEnd = -1;
    for (let index = charCursor; index < chars.length; index++) {
      const char = chars[index];
      for (const [candidateIndex, candidate] of active.entries()) {
        const { pattern, failureTable, prose } = candidate;
        let prefix = prefixes[candidateIndex]!;
        while (prefix && pattern[prefix] !== char) prefix = failureTable[prefix - 1]!;
        if (pattern[prefix] === char) prefix++;
        prefixes[candidateIndex] = prefix === pattern.length ? failureTable[prefix - 1]! : prefix;
        if (prefix !== pattern.length) continue;

        const first = index - pattern.length + 1;
        let start = originalIndex[first]!;
        let end = originalIndex[index]! + 1;
        if (isWordAt(context, start - 1) || (prose
          ? !proseEndsAt(context, end - 1)
          : !mathStartsAt(context, start, originalIndex[first - 1]) ||
            !transcribedMathEndsAt(context, end, originalIndex[index + 1]))) continue;

        // A match inside a math fence can extend by up to two original characters.
        const fence = context[start - 1] === "$" && context[end] === "$"
          ? (context[start - 2] === "$" && context[end + 1] === "$" ? 2 : 1) : 0;
        if (start - fence >= cursor) {
          start -= fence;
          end += fence;
        }
        if (bestStart < 0 || start < bestStart || (start === bestStart && end > bestEnd)) {
          bestStart = start;
          bestEnd = end;
        }
      }
      const nextFirst = index - longest + 2;
      if (bestStart >= 0 && nextFirst >= charCursor &&
          (originalIndex[nextFirst] ?? Infinity) > bestStart + 2) break;
    }
    if (bestStart < 0) continue;
    locations.set(step, { start: bestStart, end: bestEnd });
    cursor = bestEnd;
    while (originalIndex[charCursor] !== undefined && originalIndex[charCursor]! < cursor) charCursor++;
  }
  return locations;
}

function referencedStep(match: RegExpMatchArray, steps: readonly ProofStep[], current: number, nextStep: number): number {
  const { index, numeric, word, unmapped, relative, digits, han, other, fromEnd, final, previous, inclusive } = match.groups!;
  if (match.groups!.deferred) return nextStep;
  if (match.groups!.current || match.groups!.until || inclusive) return current;
  if (index || (!fromEnd && digits && match[0].includes("步"))) return Number(index ?? digits);
  if (other || unmapped) return -Infinity;
  if (final) return steps.at(-1)?.stepIndex ?? -Infinity;
  if (previous) return steps[steps.findIndex(step => step.stepIndex === current) - 1]?.stepIndex ?? -Infinity;
  if (relative) {
    const modifier = relative.toLowerCase();
    if (FUTURE_STEP.test(modifier)) return nextStep;
    if (modifier === "final" || modifier === "last") return steps.at(-1)?.stepIndex ?? -Infinity;
    if (modifier === "penultimate") return steps.at(-2)?.stepIndex ?? -Infinity;
    if (/^(?:prior|previous|earlier|preceding)$/u.test(modifier)) {
      return steps[steps.findIndex(step => step.stepIndex === current) - 1]?.stepIndex ?? -Infinity;
    }
    return -Infinity;
  }
  if (word) {
    const [tens, ones] = word.toLowerCase().split(/[- ]/u);
    const ordinal = ones ? (ENGLISH_TENS.indexOf(tens!) + 2) * 10 + ENGLISH_ORDINALS.indexOf(ones) + 1
      : TENS_ORDINALS.includes(tens!) ? (TENS_ORDINALS.indexOf(tens!) + 2) * 10
      : ENGLISH_ORDINALS.indexOf(tens!) + 1;
    return steps[ordinal - 1]?.stepIndex ?? Infinity;
  }
  if (han) {
    let ordinal = 0;
    let digit = 0;
    for (const character of han) {
      if (character === "十" || character === "百") {
        ordinal += (digit || 1) * (character === "十" ? 10 : 100);
        digit = 0;
      } else {
        digit = character === "两" ? 2 : "零一二三四五六七八九".indexOf(character);
      }
    }
    const position = ordinal + digit;
    return position > 0 ? steps.at(fromEnd ? -position : position - 1)?.stepIndex ?? Infinity : Infinity;
  }
  if (numeric || digits) {
    const position = Number(numeric ?? digits);
    return position > 0 ? steps.at(fromEnd ? -position : position - 1)?.stepIndex ?? Infinity : Infinity;
  }
  return nextStep;
}

const AFTER_POSITIONED_STEP = /\b(?:after|following|beyond)\s+(?:(?:the|this|that)\s+)?$/iu;
const CHINESE_AFTER_POSITIONED_STEP = /^(?:之后|以后|完成后)/u;
const EXCLUSIVE_STEP_REFERENCE = /^(?:another|other|remaining|subsequent|later)$/iu;
const PREVIOUS_STEP_REFERENCE = /^(?:prior|previous|earlier|preceding)$/iu;
const CHINESE_EXCLUSIVE_STEP_REFERENCE = /^(?:后续步骤|接下来的步骤|后面的步骤)$/u;
const INDEFINITE_STEP_PREFIX = /\b(?:some|any|no|several|many)\s*$/iu;
const INCLUSIVE_STEP_PREFIX = /\b(?:every|each|all|both)\s*$/iu;
const STEP_DEFECT_OBJECT = /\b(?:skip\w*|omit\w*|miss\w*|lack\w*(?:\s+of)?|without|no)\s+(?:(?:the|this|that|a|an|any|some|necessary|required|intermediate)\s+)*$|(?:跳过|遗漏|缺少|缺乏)(?:了)?\s*$/iu;
const STEP_REFERENCE_NOUN = /\bsteps?$/iu;

function* resolveProofStepReferences(
  text: string, steps: readonly ProofStep[], current: number, nextStep: number,
) {
  for (const reference of text.matchAll(STEP_REFERENCE)) {
    const start = reference.index;
    let end = start + reference[0].length;
    let stepIndex = referencedStep(reference, steps, current, nextStep);
    const { index, numeric, word, digits, han, final, relative, previous } = reference.groups!;
    const prefix = text.slice(0, start);
    const after = (digits || han || final || previous || /^下一/u.test(reference[0])) &&
      CHINESE_AFTER_POSITIONED_STEP.exec(text.slice(end));
    if (after) end += after[0].length;
    if (stepIndex !== -Infinity && (after || ((index || numeric || word || relative) && AFTER_POSITIONED_STEP.test(prefix)))) {
      stepIndex = steps.find(step => step.stepIndex > stepIndex)?.stepIndex ?? Infinity;
    }
    yield {
      start, end, stepIndex, relative, inclusive: reference.groups!.inclusive,
      other: reference.groups!.other, text: reference[0],
    };
  }
}

export function* proofStepReferences(text: string, ordered: readonly ProofStep[], current: number) {
  const next = ordered.find(step => step.stepIndex > current)?.stepIndex ?? Infinity;
  for (const reference of resolveProofStepReferences(text, ordered, current, next)) {
    const prefix = text.slice(0, reference.start);
    if (STEP_DEFECT_OBJECT.test(prefix) || (reference.relative && INDEFINITE_STEP_PREFIX.test(prefix))) continue;
    const relative = reference.relative;
    const indefinite = relative && EXCLUSIVE_STEP_REFERENCE.test(relative);
    if (reference.other || CHINESE_EXCLUSIVE_STEP_REFERENCE.test(reference.text) ||
        (relative && STEP_REFERENCE_NOUN.test(reference.text) &&
          (indefinite || PREVIOUS_STEP_REFERENCE.test(relative)))) {
      yield { ...reference, stepIndex: -Infinity };
    } else if (reference.inclusive || (relative && INCLUSIVE_STEP_PREFIX.test(prefix))) {
      yield { ...reference, stepIndex: current };
    } else if (!indefinite) {
      yield reference;
    }
  }
}

function* scopedDomainAssertions(text: string, inheritedTemporary = false) {
  let followsTemporaryScope = false;
  for (const assertion of assertiveProseSentences(maskProofQuotations(text)).flatMap(independentProseClauses)) {
    let start = 0;
    for (const boundary of assertion.matchAll(DOMAIN_SEQUENCE_BREAK)) {
      const prefix = assertion.slice(start, boundary.index);
      if (!isTemporaryProofDomain(prefix) && !(inheritedTemporary && !hasStepScope(prefix))) continue;
      yield { text: prefix, deferred: followsTemporaryScope && SEQUENTIAL_DOMAIN_TRANSITION.test(prefix) };
      inheritedTemporary = false;
      followsTemporaryScope = true;
      start = boundary.index + boundary[0].length;
    }
    const tail = assertion.slice(start);
    const deferred = followsTemporaryScope &&
      (SEQUENTIAL_DOMAIN_TRANSITION.test(tail) || PERMANENT_DOMAIN.test(tail));
    yield { text: tail, deferred };
    if (tail.trim()) followsTemporaryScope = isTemporaryProofDomain(tail) || (inheritedTemporary && !hasStepScope(tail));
    inheritedTemporary = false;
  }
}

function collectDomainContext(
  text: string, local: ScopedDomainText[], anchored: Map<number, ScopedDomainText[]>,
  steps: readonly ProofStep[], current: number, nextStep: number, initialScope?: DomainScope,
): void {
  function targetFor(stepIndex: number): ScopedDomainText[] | undefined {
    if (stepIndex === current) return local;
    if (stepIndex < current || !Number.isFinite(stepIndex)) return undefined;
    const target = anchored.get(stepIndex) ?? [];
    anchored.set(stepIndex, target);
    return target;
  }
  let temporaryStep = current;
  for (const { text: assertion, deferred } of scopedDomainAssertions(text, initialScope?.temporary)) {
    const scope = initialScope;
    initialScope = undefined;
    let sentence = assertion;
    for (const aside of sentence.matchAll(EXAMPLE_ASIDE_START)) {
      const tail = sentence.slice(aside.index + 1);
      if ((!ILLUSTRATIVE_PROOF_ROLE.test(tail) && !EXAMPLE_INTRO.test(tail) && !CHINESE_EXAMPLE_ASIDE.test(tail)) ||
          mentionsProofDomain(tail)) continue;
      sentence = sentence.slice(0, aside.index);
      break;
    }
    if (ILLUSTRATIVE_PROOF_ROLE.test(sentence)) continue;
    const example = RUBRIC_WORDING.test(sentence) ? EXAMPLE_INTRO.exec(sentence) : null;
    sentence = example ? sentence.slice(0, example.index) : sentence;
    let start = 0;
    let temporary = scope?.temporary;
    let stepIndex = deferred
      ? steps.find(step => step.stepIndex > temporaryStep)?.stepIndex ?? Infinity
      : scope?.stepIndex ?? current;
    let target = targetFor(stepIndex);
    const boundaries = [...sentence.matchAll(POST_CLAIM_DOMAIN_BREAK)];
    let boundaryIndex = 0;
    let previousReferenceEnd = 0;
    for (const reference of resolveProofStepReferences(sentence, steps, current, nextStep)) {
      // A domain can precede its qualifier ("over F₂ in the fourth step").
      let clauseStart = previousReferenceEnd;
      let boundary: RegExpExecArray | undefined;
      while ((boundary = boundaries[boundaryIndex]) && boundary.index < reference.start) {
        const end = boundary.index + boundary[0].length;
        boundaryIndex++;
        const tail = sentence.slice(end, boundaries[boundaryIndex]?.index);
        if (end > clauseStart && !joinsTrailingStepQualifier(sentence.slice(clauseStart, boundary.index), boundary[0], tail)) {
          clauseStart = end;
        }
      }
      target?.push({ text: sentence.slice(start, clauseStart), temporary });
      stepIndex = reference.stepIndex;
      target = targetFor(stepIndex);
      temporary = undefined;
      previousReferenceEnd = reference.end;
      start = clauseStart;
    }
    target?.push({ text: sentence.slice(start), temporary });
    if (temporary || isTemporaryProofDomain(sentence)) temporaryStep = stepIndex;
  }
}

export function proofStepUsesRealScalar(
  steps: readonly ProofStep[], transcription: string | undefined,
  proposalContext: readonly (string | CriterionDomainText | undefined)[],
): ReadonlyMap<ProofStep, boolean> {
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  const transcribed = prepareTranscription(maskProofQuotations(transcription ?? "", true));
  const locations = locateTranscribedSteps(ordered, transcribed);
  const global: ScopedDomainText[] = [];
  const anchored = new Map<number, ScopedDomainText[]>();
  const firstStep = ordered[0]?.stepIndex ?? Infinity;
  const secondStep = ordered[1]?.stepIndex ?? Infinity;
  const remainder: ScopedDomainText[] = [];
  if (!locations.size) {
    const { context, preambleEnd, firstProseClaim } = transcribed;
    const end = firstProseClaim
      ? firstProseClaim.start + postClaimDomainEnd(context.slice(firstProseClaim.start, firstProseClaim.end))
      : preambleEnd;
    collectDomainContext(context.slice(0, end), global, anchored, ordered, firstStep, secondStep);
    collectDomainContext(context.slice(end), remainder, anchored, ordered, firstStep, secondStep);
  }
  for (const context of proposalContext) {
    if (!context) continue;
    if (typeof context === "string") {
      collectDomainContext(context, global, anchored, ordered, firstStep, secondStep);
      continue;
    }
    const { label, feedback } = context;
    collectDomainContext(label, global, anchored, ordered, firstStep, secondStep);
    let scope: DomainScope | undefined;
    for (const assertion of assertiveProseSentences(maskProofQuotations(label))) {
      for (const reference of resolveProofStepReferences(assertion, ordered, firstStep, secondStep)) {
        scope = { stepIndex: reference.stepIndex, temporary: isTemporaryProofDomain(assertion) };
      }
    }
    collectDomainContext(feedback, global, anchored, ordered, firstStep, secondStep, scope);
  }
  const domain: ProofDomain = { persistent: "real", effective: "real" };
  advanceProofDomain(domain, global);
  let unmatchedDomainAmbiguous = false;
  for (const change of proofDomainChanges(remainder)) {
    if (change.domain !== domain.persistent) {
      unmatchedDomainAmbiguous = true;
      break;
    }
  }
  let cursor = 0;
  const matches = locations.values();
  let next = matches.next();
  let sentenceIndex = 0;
  const result = new Map<ProofStep, boolean>();
  for (const [index, step] of ordered.entries()) {
    if (index > 0) domain.effective = domain.persistent;
    let scopedDomain = domain.effective !== domain.persistent;
    const followingStep = ordered[index + 1]?.stepIndex ?? Infinity;
    const location = locations.get(step);
    let end = cursor;
    if (location) {
      next = matches.next();
      while (transcribed.sentenceEnds[sentenceIndex]! < location.end) sentenceIndex++;
      end = Math.min(transcribed.sentenceEnds[sentenceIndex]!, next.value?.start ?? transcribed.context.length);
      end = location.end + postClaimDomainEnd(transcribed.context.slice(location.end, end));
    } else if (cursor === 0 && locations.size) {
      end = Math.min(transcribed.preambleEnd, next.value?.start ?? 0);
    } else if (cursor > 0) {
      // A transition explicitly attached to the preceding claim belongs to this
      // step even when the transcription paraphrases its expression.
      while (transcribed.sentenceEnds[sentenceIndex] !== undefined &&
        transcribed.sentenceEnds[sentenceIndex]! <= cursor) sentenceIndex++;
      const boundary = Math.min(transcribed.sentenceEnds[sentenceIndex] ?? cursor, next.value?.start ?? Infinity);
      const candidate = transcribed.context.slice(cursor, boundary);
      const relative = DEFERRED_DOMAIN_TRANSITION.exec(candidate);
      if (relative && BEFORE_RELATIVE_TRANSITION.test(candidate.slice(0, relative.index))) end = boundary;
    }
    if (end > cursor) {
      const immediate: ScopedDomainText[] = [];
      const relativeStep = cursor > 0 ? step.stepIndex : followingStep;
      const tailStart = location?.end ?? end;
      collectDomainContext(transcribed.context.slice(cursor, tailStart), immediate, anchored, ordered, step.stepIndex, relativeStep);
      collectDomainContext(transcribed.context.slice(tailStart, end), immediate, anchored, ordered, step.stepIndex, followingStep);
      scopedDomain = advanceProofDomain(domain, immediate) || scopedDomain;
      cursor = end;
    }
    for (let stepNumber = 0; stepNumber <= step.stepIndex; stepNumber++) {
      const deferred = anchored.get(stepNumber);
      if (!deferred) continue;
      scopedDomain = advanceProofDomain(domain, deferred, stepNumber === step.stepIndex) || scopedDomain;
      anchored.delete(stepNumber);
    }
    const local: ScopedDomainText[] = [];
    for (const text of [step.claim, step.feedback, step.repairPrompt]) {
      if (text) collectDomainContext(text, local, anchored, ordered, step.stepIndex, followingStep);
    }
    scopedDomain = advanceProofDomain(domain, local) || scopedDomain;
    result.set(step, domain.effective === "real" || (unmatchedDomainAmbiguous && !scopedDomain));
  }
  return result;
}

const CARDINAL_SUBJECT = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|${ENGLISH_TENS.join("|")}|hundred|thousand|million|billion|\d+)`;
const EXPLICIT_CLAUSE_SUBJECT = String.raw`(?:${CARDINAL_SUBJECT}|the|this|that|these|those|a|an|we|you|it|they|he|she|there|my|your|his|her|its|our|their|whose|such|which|what|every|each|all|both|some|any|no|neither|either|another|other|first|second|third|next|later|earlier|previous|subsequent|final|last|remaining|following|overall|entire|whole|steps?|lines?|parts?|equations?|equalit(?:y|ies)|identit(?:y|ies)|claims?|proofs?|arguments?|derivations?|inferences?|reasoning|calculations?|expansions?|here|now)\b`;
const PLURAL_PROOF_SUBJECT = /(?:steps|lines|parts|equations|equalities|identities|claims|proofs|arguments|derivations|inferences|calculations|expansions|sides)\b/u.source;
const POSITIONAL_SUBJECT_MODIFIER = /(?:other|first|second|third|next|later|earlier|previous|subsequent|final|last|remaining|following)/u.source;
const COMPLEMENT_VERB = /(?:is|are|was|were|has|have|had|do|does|did|can|could|will|would|should|may|might|must|lacks?|misses?|skips?|omits?|assumes?|restates?|divides?|begs?|fails?|follows?|gives?|yields?|needs?|requires?)\b/u.source;
const COMPLEMENT_SUBJECT = String.raw`(?:(?:${CARDINAL_SUBJECT}|the|this|that|these|those|a|an|we|you|it|they|he|she|there|my|your|his|her|its|our|their|every|each|all|no|any|some|both|neither|either|another|many|several|few|most|step\s+\d+)\b|(?:(?!${COMPLEMENT_VERB})[\p{L}\p{N}'’-]+\s+){0,4}${PLURAL_PROOF_SUBJECT})`;
const DEMONSTRATIVE_NOUN = String.raw`(?:${POSITIONAL_SUBJECT_MODIFIER}\s+)?(?:step|line|part|equation|equality|identity|claim|proof|argument|derivation|inference|reasoning|calculation|expansion|side)\b`;
const COORDINATED_COMPLEMENT = String.raw`(?:whether\b|if\b|to\s+\w|that\s+(?:${COMPLEMENT_SUBJECT}|(?!${DEMONSTRATIVE_NOUN})[\p{L}]+\s+${COMPLEMENT_VERB}))`;
const INDEPENDENT_PROSE_CLAUSE = new RegExp([
  /[;；\r\n]/u.source,
  String.raw`\b(?:however|moreover|furthermore)\b,?\s+(?=${EXPLICIT_CLAUSE_SUBJECT})`,
  String.raw`(?:\b(?:but|yet|whereas|while)|[,，]\s*(?:though|although))\s+(?=${EXPLICIT_CLAUSE_SUBJECT})`,
  String.raw`[,，]\s*\b(?:and|also)\s+(?!${COORDINATED_COMPLEMENT})(?=${EXPLICIT_CLAUSE_SUBJECT})`,
  /(?:但(?:是)?|不过|此外|另外)(?=\s*(?:这|该|其|此|原|假设|前提|论证|证明|结果|还|仍|你[的们]|您的|他的|她的|它的|我们的|他们的|学生的|作者的|上述|后面|前面|下一步))|[，,]\s*(?:但(?:是)?|不过|此外|另外)/u.source,
].join("|"), "iu");

export function independentProseClauses(sentence: string): string[] {
  return sentence.split(INDEPENDENT_PROSE_CLAUSE);
}

function proofRoleText(text: string): string {
  const unquoted = maskProofQuotations(text);
  return assertiveProseSentences(unquoted).flatMap(independentProseClauses).map(clause => {
    const indirect = INDIRECT_QUESTION.exec(clause);
    const assertion = (indirect ? clause.slice(0, indirect.index) : clause).trim().replace(/\s+/gu, " ");
    if (ILLUSTRATIVE_PROOF_ROLE.test(assertion) ||
        (REJECTION_AS_TOPIC.test(assertion) && !ASSERTED_PROOF_PREDICATE.test(assertion))) return "";
    if (UNPROVED_PROOF_ROLE.test(assertion) &&
        (EXPLICIT_REJECTION.test(assertion) || DERIVED_CONTRADICTION.test(assertion))) return "";
    if (NONASSERTED_REJECTION.test(assertion.replace(/[,，()（）]/gu, " "))) return "";
    const rejection = EXPLICIT_REJECTION.exec(assertion);
    if (rejection) {
      const status = /\p{Script=Han}/u.test(rejection[0]) ? CHINESE_PENDING_REJECTION : PENDING_REJECTION;
      const tail = assertion.slice(rejection.index + rejection[0].length);
      if (status.test(tail) || status.test(tail.replace(REJECTION_ASIDE, "")) ||
          (END_OF_REJECTION.test(tail) && REJECTION_AS_TOPIC.test(assertion))) return "";
    }
    return NEGATED_PROOF_ROLE.reduce((value, pattern) => value.replace(pattern, " "), assertion);
  }).join("\n");
}

function assertedDischargeText(text: string): string {
  return text.split(DISCHARGE_CLAUSE_END).map(segment => {
    let clause = segment.trim();
    if (SEQUENTIAL_DISCHARGE.test(clause)) {
      const conclusion = DEDUCTIVE_CONCLUSION.exec(clause);
      if (conclusion) clause = clause.slice(conclusion.index + conclusion[0].length);
    }
    return CONDITIONAL_DISCHARGE.test(clause) ? "" : clause;
  }).join("\n");
}

function derivesContradiction(text: string): boolean {
  return text.split("\n").some(clause => !LEXICAL_PROOF_SUBJECT.test(clause) &&
    clause.split(/[,，]/u).some(part => !LEXICAL_PROOF_SUBJECT.test(part.trim()) && DERIVED_CONTRADICTION.test(part)));
}

/** Only a discharged supposition scopes other steps. An explicitly counterfactual step can stand on its own. */
export function counterfactualProofSteps(steps: readonly ProofStep[]): ReadonlySet<ProofStep> {
  const ordered = [...steps].sort((left, right) => left.stepIndex - right.stepIndex);
  const exempt = new Set<ProofStep>();
  const openStack: number[] = [];
  let pendingRejectionFromContradiction = false;
  for (const [pos, step] of ordered.entries()) {
    const texts = [step.claim, step.feedback].map(proofRoleText);
    const withoutIntent = texts.map(text => text.replace(CONTRADICTION_INTENT,
      intent => /^\s*(?:in\s+order\s+)?to\b/iu.test(intent) ? " to " : " "));
    const hasIntent = texts.some((text, index) => text !== withoutIntent[index]);
    const explicitSupposition = texts.some(text => PROOF_SUPPOSITION.test(text));
    const opensSupposition = explicitSupposition || (hasIntent && openStack.length === 0);
    if (opensSupposition) {
      openStack.push(pos);
      pendingRejectionFromContradiction = false;
    }

    const assertedDischarge = withoutIntent.map(assertedDischargeText);
    if (ordered.length === 1 && ((explicitSupposition && hasIntent) ||
        assertedDischarge.some(derivesContradiction))) {
      exempt.add(step);
    }
    const canDischargeFromFeedback = !opensSupposition || pos === ordered.length - 1;
    const dischargeTexts = canDischargeFromFeedback ? assertedDischarge : assertedDischarge.slice(0, 1);
    const rejection = dischargeTexts.map(text => EXPLICIT_REJECTION.exec(text)).find(match => match !== null);
    const qualifier = rejection?.slice(1).find(Boolean) ?? "";
    const outer = OUTER_REJECTION.test(qualifier);
    const inner = INNER_REJECTION.test(qualifier);
    const derives = !rejection && dischargeTexts.some(derivesContradiction);
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
