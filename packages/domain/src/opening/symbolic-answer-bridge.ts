import type { TeachingQuestionInteraction } from "@aistudy/contracts";
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
const ORIGIN = { n: 0n, d: 1n };
const ONE = { n: 1n, d: 1n };
const SCALAR_FUNCTIONS = new Set(["sqrt", "abs", "ln", "sin", "cos", "exp"]);
const KEY_PREFIX = /^(?:答案|答|answer)\s*[:：]\s*/i;

type ChoiceOptions = Extract<TeachingQuestionInteraction, { kind: "choice" }>["options"];
type Outcome = "correct" | "incorrect" | "unparseable" | null;
type SymbolicKind = "scalar" | "derivative" | "indefinite-integral";
type ParsedExpression = {
  expr: ScalarExpr;
  variables: Set<string>;
  hasDenominator: boolean;
  mayRestrictDomain: boolean;
};
type Target = {
  kind: SymbolicKind;
  source: ParsedExpression;
  expected: ScalarExpr;
  domain: DomainSpec & { variable: string };
};

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

function keepsSymbolicMeaningWhenRendered(text: string): boolean {
  return !text.split(/\r\n?|\n/).some(line => (
    /^\s*(?:-+|[+*]|\d{1,9}[.)]|#{1,6})(?:\s|$)/.test(line) ||
    /^\s*(?:_\s*){3,}$/.test(line) || /^(?: {4}|\t)\s*\S/.test(line)
  )) && scanMathSpans(text, char => char !== "*");
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
      case "ln":
        mayRestrictDomain = true;
        pending.push(node.value);
        break;
      default:
        pending.push(node.value);
    }
  }
  if (denominators.some(denominator => domainZero(denominator, variables.values().next().value ?? "x"))) return null;
  return { expr, variables, hasDenominator: denominators.length > 0, mayRestrictDomain: mayRestrictDomain || denominators.length > 0 };
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

function afterBracedArgument(text: string, start: number): number | null {
  while (start < text.length && /\s/.test(text[start]!)) start++;
  if (text[start] !== "{") return null;
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return index + 1;
  }
  return null;
}

function hasAmbiguousTexArguments(body: string, texMode: boolean): boolean {
  if ((texMode || /\\[A-Za-z]/.test(body)) &&
      /[\^_]\s*(?:[A-Za-z0-9]{2,}|[+\-(]|\d\.\d)/.test(body)) return true;
  for (const macro of body.matchAll(/\\(sqrt|dfrac|tfrac|frac)(?![A-Za-z])/g)) {
    const firstEnd = afterBracedArgument(body, macro.index + macro[0].length);
    if (firstEnd === null || (macro[1] !== "sqrt" && afterBracedArgument(body, firstEnd) === null)) return true;
  }
  return false;
}

function parseExpression(text: string, derivativeOperand = false, texOperand = false): ParsedExpression | null {
  if (text.length > MAX_EXPRESSION_LENGTH) return null;
  const body = unwrapMath(text);
  const wrapped = text.trim().startsWith("$");
  if (!body || /[\d.]\s+[\d.]|\d\.\d*\.|\.\d+\./.test(body) ||
      hasAmbiguousTexArguments(body, wrapped || texOperand)) return null;
  // The engine allows adjacent identifiers as implicit products. Reject words before normalization.
  const words = body.match(/\\[A-Za-z]+|[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  if (words.some(word => !word.startsWith("\\") && word.length > 1 && !SCALAR_FUNCTIONS.has(word))) return null;
  const source = wrapped || texOperand ? body : body.replace(/\\\*/g, "*");
  const normalized = normalizeLatexExpr(source);
  if (!normalized || (derivativeOperand && !isSingleDerivativeOperand(normalized))) return null;
  const expr = parseScalarExpr(normalized);
  return expr && inspectExpression(expr);
}

function makeTarget(kind: SymbolicKind, source: ParsedExpression, domain?: DomainSpec): Target | null {
  const variable = domain?.variable ?? source.variables.values().next().value ?? "x";
  if ([...source.variables].some(name => name !== variable)) return null;
  const targetDomain = { ...domain, variable };
  let expected = source.expr;
  if (kind === "derivative") {
    const derivative = differentiate(source.expr, variable);
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
      withZeroValue(expected), withZeroValue(source.expr), targetDomain,
    ).status !== "equivalent") return null;
  }
  return { kind, source, expected, domain: targetDomain };
}

function parseTargetExpression(text: string, promptKind: SymbolicKind, domain?: DomainSpec): Target | null {
  const body = unwrapMath(text);
  if (!body) return null;
  const derivative = /^\\(?:dfrac|tfrac|frac)\s*\{\s*d\s*\}\s*\{\s*d\s*([A-Za-z])\s*\}\s*(.+)$/s.exec(body);
  const integral = /^\\int(?![A-Za-z])\s*(.+?)(?:\\[,;! ]|\s)*d\s*([A-Za-z])$/s.exec(body);
  const kind = derivative ? "derivative" : integral ? "indefinite-integral" : promptKind;
  if ((promptKind !== "scalar" && kind !== promptKind) || (kind === "indefinite-integral" && !integral)) return null;
  const variable = derivative?.[1] ?? integral?.[2];
  if (domain?.variable && variable && domain.variable !== variable) return null;
  const expression = derivative ? derivative[2]! : integral ? integral[1]! : text;
  const source = parseExpression(expression, Boolean(derivative), Boolean(derivative || integral));
  return source && makeTarget(kind, source, variable ? { ...domain, variable } : domain);
}

function parseQuestion(question: string): Target | null {
  if (question.length > MAX_STEM_LENGTH || !keepsSymbolicMeaningWhenRendered(question)) return null;
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
  const target = parseTargetExpression(outerFence ? outerFence + expression + outerFence : expression, kind, domain);
  if (!target) return null;
  // A parenthesized or signed literal is still a single literal after parsing.
  let original = target.source.expr;
  while (original.kind === "neg") original = original.value;
  return target.kind === "scalar" && (original.kind === "const" || original.kind === "variable") ? null : target;
}

function compareToTarget(candidate: ParsedExpression, target: Target): VerificationResult {
  const { kind, expected, domain } = target;
  if ((domain.intervals?.length && candidate.variables.size) ||
      [...candidate.variables].some(name => name !== domain.variable && !(kind === "indefinite-integral" && name === "C"))) {
    return { status: "unverified" };
  }
  if (kind !== "indefinite-integral") return verifyScalarEquivalence(candidate.expr, expected, domain);
  let student = candidate.expr;
  if (domain.variable !== "C") {
    const family = additiveConstant(student, domain.variable);
    if (!family) return { status: "unverified" };
    if (family.coefficient.n === 0n) return { status: "inequivalent" };
    student = family.expr;
  }
  return verifyIndefiniteIntegral({ student, integrand: expected, domain });
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
    const target = source && makeTarget(check.kind, source, { variable: check.variable });
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
  if (target.kind !== "indefinite-integral" || target.domain.variable === "C") {
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
    const tail = savedChoiceKeyTail(key.trim(), match.id);
    if (tail === null) return null;
    // Preserve a decimal after a whitespace delimiter, as in "A .5".
    const remainder = tail.replace(/^[.．、:：,，]|^\s+(?:[．、:：,，]|\.(?!\d))/, "").trim();
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
  const result = compareToTarget(candidate, target);
  if (result.reason === "natural_domain_mismatch") return "unparseable";
  if (result.status === "inequivalent" && unresolvedDecimalTarget &&
      !isProvenIrrationalRadical(unresolvedDecimalTarget, target.domain)) return null;
  return result.status === "equivalent" ? "correct" : result.status === "inequivalent" ? "incorrect" : null;
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

/** Corroborate only standalone scalar identities and explicit calculus equations. */
export function verifyStandaloneProofEquationClaim(claim: string): ProofClaimVerification {
  const unverified: ProofClaimVerification = { status: "unverified", unconditional: false };
  if (claim.length > MAX_EXPRESSION_LENGTH) return unverified;
  return bounded(unverified, () => {
    const body = claim.trim().replace(
      /^(?:(?:Step\s+\d{1,3}|第\s*\d{1,3}\s*步)\s*[:：.)]\s*|\d{1,3}\.\s+(?![\s+\-−*/^=]))/i, "",
    );
    if (!keepsSymbolicMeaningWhenRendered(body)) return unverified;
    const parts = equalityTerms(body);
    if (!parts || parts.length < 2) return unverified;
    const [first, ...rest] = parts;
    const candidates = rest.flatMap(term => {
      const parsed = parseExpression(term);
      return parsed ? [parsed] : [];
    });
    if (candidates.length !== rest.length) return unverified;
    const variable = candidates.find(candidate => candidate.variables.size)?.variables.values().next().value;
    const target = parseTargetExpression(first!, "scalar");
    if (!target) return unverified;
    if (target.kind === "scalar" && target.source.variables.size === 0 && variable) target.domain.variable = variable;
    const results = candidates.map(candidate => compareToTarget(candidate, target).status);
    if (target.kind === "indefinite-integral") {
      for (const candidate of candidates.slice(1)) results.push(compareExpressions(candidate, candidates[0]!, target));
    }
    if (results.includes("inequivalent")) return { status: "inequivalent", unconditional: false };
    if (results.includes("unverified")) return unverified;
    const unconditional = [target.source, ...candidates].every(expression => !expression.hasDenominator &&
      (!expression.mayRestrictDomain || verifyScalarEquivalence(
        withZeroValue(expression.expr), ZERO, target.domain,
      ).status === "equivalent"));
    return { status: "equivalent", unconditional };
  });
}
