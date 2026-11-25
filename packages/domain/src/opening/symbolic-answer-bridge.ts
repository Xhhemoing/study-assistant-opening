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
import { PolyComplexityError } from "../symbolic-equivalence/rational-bounds";

const MAX_STEM_LENGTH = 400;
const MAX_EXPRESSION_LENGTH = 1200;
const MAX_EQUALITY_TERMS = 12;
// Keep individual powers within the engine's polynomial degree bound.
const MAX_POWER = 64;
const ZERO: ScalarExpr = { kind: "const", value: 0 };
const ORIGIN = { n: 0n, d: 1n };
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

function keepsSymbolicMeaningWhenRendered(text: string): boolean {
  for (const line of text.split(/\r\n?|\n/)) {
    if (/^\s*(?:-+|[+*]|\d{1,9}[.)]|#{1,6})(?:\s|$)/.test(line) ||
        /^\s*(?:_\s*){3,}$/.test(line) || /^(?: {4}|\t)\s*\S/.test(line)) return false;
    let fence = 0;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "$") {
        let width = 1;
        while (line[index + width] === "$") width++;
        if (width > 2 || (fence && width !== fence)) return false;
        fence = fence ? 0 : width;
        index += width - 1;
      } else if (char === "*" && !fence) {
        return false;
      }
    }
    if (fence) return false;
  }
  return true;
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

function parseExpression(text: string, derivativeOperand = false): ParsedExpression | null {
  if (text.length > MAX_EXPRESSION_LENGTH) return null;
  const body = unwrapMath(text);
  if (!body || /[\d.]\s+[\d.]/.test(body)) return null;
  // The engine allows adjacent identifiers as implicit products. Reject words before normalization.
  const words = body.match(/\\[A-Za-z]+|[A-Za-z][A-Za-z0-9_]*/g) ?? [];
  if (words.some(word => !word.startsWith("\\") && word.length > 1 && !SCALAR_FUNCTIONS.has(word))) return null;
  const source = text.trim().startsWith("$") ? body : body.replace(/\\\*/g, "*");
  const normalized = normalizeLatexExpr(source);
  if (!normalized || (derivativeOperand && !isSingleDerivativeOperand(normalized))) return null;
  const expr = parseScalarExpr(normalized);
  return expr && inspectExpression(expr);
}

function makeTarget(kind: SymbolicKind, source: ParsedExpression, domain?: DomainSpec): Target | null {
  const variable = domain?.variable ?? source.variables.values().next().value ?? "x";
  if ([...source.variables].some(name => name !== variable)) return null;
  let expected = source.expr;
  if (kind === "derivative") {
    const derivative = differentiate(source.expr, variable);
    if (!derivative) return null;
    // Differentiation can erase a restriction, such as ln(x) requiring x > 0.
    expected = source.mayRestrictDomain
      ? { kind: "add", left: derivative, right: withZeroValue(source.expr) }
      : derivative;
  }
  return { kind, source, expected, domain: { ...domain, variable } };
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
  const source = parseExpression(expression, Boolean(derivative));
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
  return kind === "indefinite-integral"
    ? verifyIndefiniteIntegral({ student: candidate.expr, integrand: expected, domain })
    : verifyScalarEquivalence(candidate.expr, expected, domain);
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
  const terms = (unwrapMath(text) ?? text).split("=");
  return terms.length <= MAX_EQUALITY_TERMS ? terms : null;
}

export function savedChoiceKeyIds(options: ChoiceOptions, key: string): Set<string> {
  const trimmed = key.trim();
  return new Set(options.filter(option => {
    for (const lead of ["", "(", "（"]) {
      const start = lead + option.id;
      if (!trimmed.startsWith(start)) continue;
      let tail = trimmed.slice(start.length);
      if (tail.startsWith(")") || tail.startsWith("）")) tail = tail.slice(1);
      if (!tail || /^[\s.．、:：,，]/u.test(tail)) return true;
    }
    return false;
  }).map(option => option.id));
}

export function matchSavedChoiceSubmission(options: ChoiceOptions, answer: string, correctId: string): Outcome {
  const submitted = options.filter(option => answer === option.id + ". " + option.label);
  if (submitted.length === 0) return "unparseable";
  if (submitted.length > 1) return null;
  return submitted[0]!.id === correctId ? "correct" : "incorrect";
}

// In integral equality chains, compare the expressions for the same arbitrary additive C.
function additiveConstant(expr: ScalarExpr): { expr: ScalarExpr; coefficient: number } | null {
  if (expr.kind === "variable" && expr.name === "C") return { expr: ZERO, coefficient: 1 };
  if (expr.kind === "add" || expr.kind === "sub") {
    const left = additiveConstant(expr.left);
    const right = additiveConstant(expr.right);
    if (!left || !right) return null;
    return {
      expr: { ...expr, left: left.expr, right: right.expr },
      coefficient: left.coefficient + (expr.kind === "add" ? right.coefficient : -right.coefficient),
    };
  }
  if (expr.kind === "neg") {
    const value = additiveConstant(expr.value);
    return value && { expr: { kind: "neg", value: value.expr }, coefficient: -value.coefficient };
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
  return { expr, coefficient: 0 };
}

function compareExpressions(student: ParsedExpression, reference: ParsedExpression, target: Target): EquivalenceStatus {
  if (target.kind !== "indefinite-integral" || target.domain.variable === "C") {
    return verifyScalarEquivalence(student.expr, reference.expr, target.domain).status;
  }
  const left = additiveConstant(student.expr);
  const right = additiveConstant(reference.expr);
  if (!left || !right) return "unverified";
  if (left.coefficient !== right.coefficient) return "inequivalent";
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
  if (prefixIds.size > 1 || (prefixIds.size === 1 ? !prefixIds.has(match.id) : !expressionKeyMatches(key, match.parsed, target))) return null;
  return answer.length > MAX_EXPRESSION_LENGTH ? "unparseable" : matchSavedChoiceSubmission(options, answer, match.id);
}

function reduceNamedConstants(expr: ScalarExpr, domain: DomainSpec): ScalarExpr {
  switch (expr.kind) {
    case "sin":
    case "ln":
    case "cos":
    case "exp": {
      const candidate: ScalarExpr = { kind: "const", value: expr.kind === "sin" || expr.kind === "ln" ? 0 : 1 };
      return verifyScalarEquivalence(expr, candidate, domain).status === "equivalent" ? candidate : expr;
    }
    case "const":
    case "variable": return expr;
    case "pow": return { ...expr, base: reduceNamedConstants(expr.base, domain) };
    case "add":
    case "sub":
    case "mul":
    case "div": return { ...expr, left: reduceNamedConstants(expr.left, domain), right: reduceNamedConstants(expr.right, domain) };
    default: return { ...expr, value: reduceNamedConstants(expr.value, domain) };
  }
}

function exactRationalValue(expr: ScalarExpr, domain: DomainSpec) {
  const point = toRational(domain.intervals?.[0]?.left) ?? ORIGIN;
  return evaluateScalar(simplifyRadical(expr), point, domain.variable).value
    ?? evaluateScalar(simplifyRadical(reduceNamedConstants(expr, domain)), point, domain.variable).value;
}

function evaluateSymbolicNumeric(key: string, answer: string, target: Target): Outcome {
  if (target.kind === "indefinite-integral" || target.domain.excluded?.length ||
      (target.kind === "scalar" && target.source.variables.size)) return null;
  const parsedKey = parseExpression(key.trim().replace(KEY_PREFIX, ""));
  if (!parsedKey || parsedKey.variables.size || compareToTarget(parsedKey, target).status !== "equivalent") return null;
  const candidate = parseExpression(answer);
  if (!candidate || candidate.variables.size) return "unparseable";
  if (answer.includes(".")) {
    const rationalValue = exactRationalValue(parsedKey.expr, {})
      ?? exactRationalValue(target.expected, target.domain);
    if (rationalValue) {
      let denominator = rationalValue.d;
      while (denominator % 2n === 0n) denominator /= 2n;
      while (denominator % 5n === 0n) denominator /= 5n;
      if (denominator !== 1n) return "unparseable";
    }
  }
  const result = compareToTarget(candidate, target);
  if (result.reason === "natural_domain_mismatch") return "unparseable";
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
    const body = unwrapMath(claim.trim().replace(/^(?:\(\d{1,3}\)|\d{1,3}\.(?!\d)|Step\s+\d{1,3}\s*:)\s*/i, ""));
    const parts = body && equalityTerms(body);
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
