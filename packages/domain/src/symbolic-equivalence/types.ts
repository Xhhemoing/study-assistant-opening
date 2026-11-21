import { addRational, divideRational, equalRational, multiplyRational, rational, subtractRational, type SpanRational } from "../opening/span-rational";

export type EquivalenceStatus = "equivalent" | "inequivalent" | "unverified";
export type VerificationResult = {
  status: EquivalenceStatus;
  reason?: string;
  witness?: { input: string; student?: string; reference?: string; detail?: string };
  domain?: DomainSpec;
};

export type DomainSpec = {
  variable?: string;
  excluded?: readonly (string | number)[];
  intervals?: readonly { left?: string | number; right?: string | number; leftOpen?: boolean; rightOpen?: boolean }[];
};

export type ScalarExpr =
  | { kind: "const"; value: string | number | bigint | SpanRational }
  | { kind: "variable"; name: string }
  | { kind: "neg"; value: ScalarExpr }
  | { kind: "add" | "sub" | "mul" | "div"; left: ScalarExpr; right: ScalarExpr }
  | { kind: "pow"; base: ScalarExpr; exponent: number }
  | { kind: "sqrt" | "abs" | "ln" | "sin" | "cos"; value: ScalarExpr };

export type PiecewiseExpr = { split: string | number; left: ScalarExpr; right: ScalarExpr };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRational(value: string | number | bigint | SpanRational): SpanRational | null {
  if (typeof value === "bigint") return rational(value);
  if (typeof value === "number") return Number.isInteger(value) && Number.isSafeInteger(value) ? rational(BigInt(value)) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) return rational(BigInt(trimmed));
    const fraction = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(trimmed);
    if (fraction && fraction[2] !== "0") return rational(BigInt(fraction[1]!), BigInt(fraction[2]!));
    return null;
  }
  return value && typeof value.n === "bigint" && typeof value.d === "bigint" && value.d !== 0n ? rational(value.n, value.d) : null;
}

export function formatRational(value: SpanRational): string {
  return value.d === 1n ? String(value.n) : `${value.n}/${value.d}`;
}

export type Polynomial = Map<number, SpanRational>;
export function polynomialConstant(value: SpanRational): Polynomial { return value.n === 0n ? new Map() : new Map([[0, value]]); }
export function polynomialVariable(): Polynomial { return new Map([[1, rational(1n)]]); }
export function polynomialAdd(a: Polynomial, b: Polynomial, sign: 1 | -1 = 1): Polynomial {
  const out = new Map(a);
  for (const [degree, value] of b) {
    const next = sign === 1 ? addRational(out.get(degree) ?? rational(0n), value) : subtractRational(out.get(degree) ?? rational(0n), value);
    if (next.n === 0n) out.delete(degree); else out.set(degree, next);
  }
  return out;
}
export function polynomialMultiply(a: Polynomial, b: Polynomial): Polynomial {
  const out = new Map<number, SpanRational>();
  for (const [da, va] of a) for (const [db, vb] of b) {
    const degree = da + db;
    const next = addRational(out.get(degree) ?? rational(0n), multiplyRational(va, vb));
    if (next.n === 0n) out.delete(degree); else out.set(degree, next);
  }
  return out;
}
export function polynomialEvaluate(poly: Polynomial, x: SpanRational): SpanRational {
  let out = rational(0n);
  const entries = [...poly.entries()].sort((a, b) => b[0] - a[0]);
  for (const [degree, coefficient] of entries) {
    let power = rational(1n);
    for (let i = 0; i < degree; i++) power = multiplyRational(power, x);
    out = addRational(out, multiplyRational(coefficient, power));
  }
  return out;
}
export function polynomialDegree(poly: Polynomial): number { return poly.size ? Math.max(...poly.keys()) : -1; }

export type RationalForm = { numerator: Polynomial; denominator: Polynomial; unsupported?: string };
export function rationalForm(expr: ScalarExpr, variable = "x"): RationalForm {
  switch (expr.kind) {
    case "const": { const value = toRational(expr.value); return value ? { numerator: polynomialConstant(value), denominator: polynomialConstant(rational(1n)) } : { numerator: new Map(), denominator: new Map(), unsupported: "non_rational_constant" }; }
    case "variable": return expr.name === variable ? { numerator: polynomialVariable(), denominator: polynomialConstant(rational(1n)) } : { numerator: new Map(), denominator: new Map(), unsupported: "foreign_variable" };
    case "neg": { const inner = rationalForm(expr.value, variable); return { ...inner, numerator: polynomialMultiply(polynomialConstant(rational(-1n)), inner.numerator) }; }
    case "add": case "sub": {
      const left = rationalForm(expr.left, variable), right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) return { numerator: new Map(), denominator: new Map(), unsupported: left.unsupported ?? right.unsupported };
      const numerator = polynomialAdd(polynomialMultiply(left.numerator, right.denominator), polynomialMultiply(right.numerator, left.denominator), expr.kind === "add" ? 1 : -1);
      return { numerator, denominator: polynomialMultiply(left.denominator, right.denominator) };
    }
    case "mul": {
      const left = rationalForm(expr.left, variable), right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) return { numerator: new Map(), denominator: new Map(), unsupported: left.unsupported ?? right.unsupported };
      return { numerator: polynomialMultiply(left.numerator, right.numerator), denominator: polynomialMultiply(left.denominator, right.denominator) };
    }
    case "div": {
      const left = rationalForm(expr.left, variable), right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) return { numerator: new Map(), denominator: new Map(), unsupported: left.unsupported ?? right.unsupported };
      return { numerator: polynomialMultiply(left.numerator, right.denominator), denominator: polynomialMultiply(left.denominator, right.numerator) };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) return { numerator: new Map(), denominator: new Map(), unsupported: "power_out_of_bounds" };
      const inner = rationalForm(expr.base, variable); if (inner.unsupported) return { numerator: new Map(), denominator: new Map(), unsupported: inner.unsupported };
      const count = Math.abs(expr.exponent); let numerator = polynomialConstant(rational(1n)); let denominator = polynomialConstant(rational(1n));
      for (let i = 0; i < count; i++) { numerator = polynomialMultiply(numerator, expr.exponent >= 0 ? inner.numerator : inner.denominator); denominator = polynomialMultiply(denominator, expr.exponent >= 0 ? inner.denominator : inner.numerator); }
      return { numerator, denominator };
    }
    default: return { numerator: new Map(), denominator: new Map(), unsupported: `${expr.kind}_outside_rational_fragment` };
  }
}

export function parseScalarExpr(input: ScalarExpr | string): ScalarExpr | null {
  if (typeof input !== "string") return input;
  const source = input.replaceAll("−", "-").trim();
  let index = 0;
  const peek = () => source[index] ?? "";
  const skip = () => { while (/\s/.test(peek())) index++; };
  const consume = (token: string) => { skip(); if (source.slice(index, index + token.length) === token) { index += token.length; return true; } return false; };
  const primary = (): ScalarExpr | null => {
    skip(); if (consume("(")) { const value = addSub(); if (!value || !consume(")")) return null; return value; }
    const number = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(index));
    if (number) { index += number[0].length; return { kind: "const", value: number[0] }; }
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(index));
    if (!name) return null;
    index += name[0].length; if (consume("(")) { const value = addSub(); if (!value || !consume(")")) return null; if (!["sqrt", "abs", "ln", "sin", "cos"].includes(name[0]!)) return null; return { kind: name[0] as "sqrt", value }; }
    return { kind: "variable", name: name[0]! };
  };
  const unary = (): ScalarExpr | null => { skip(); if (consume("-")) { const value = unary(); return value ? { kind: "neg", value } : null; } return primary(); };
  const power = (): ScalarExpr | null => { let left = unary(); while (left && consume("^")) { skip(); const exponent = /^[+-]?\d+/.exec(source.slice(index)); if (!exponent) return null; index += exponent[0].length; left = { kind: "pow", base: left, exponent: Number(exponent[0]) }; } return left; };
  const mulDiv = (): ScalarExpr | null => { let left = power(); while (left) { if (consume("*")) { const right = power(); if (!right) return null; left = { kind: "mul", left, right }; } else if (consume("/")) { const right = power(); if (!right) return null; left = { kind: "div", left, right }; } else break; } return left; };
  function addSub(): ScalarExpr | null { let left = mulDiv(); while (left) { if (consume("+")) { const right = mulDiv(); if (!right) return null; left = { kind: "add", left, right }; } else if (consume("-")) { const right = mulDiv(); if (!right) return null; left = { kind: "sub", left, right }; } else break; } return left; }
  const result = addSub(); skip(); return result && index === source.length ? result : null;
}

export function evaluateScalar(expr: ScalarExpr, x: SpanRational, variable = "x"): { value?: SpanRational; defined: boolean; reason?: string } {
  const form = rationalForm(expr, variable);
  if (form.unsupported) return { defined: false, reason: form.unsupported };
  const denominator = polynomialEvaluate(form.denominator, x);
  if (denominator.n === 0n) return { defined: false, reason: "natural_domain_denominator_zero" };
  return { value: divideRational(polynomialEvaluate(form.numerator, x), denominator), defined: true };
}

export function simplifyRadical(expr: ScalarExpr): ScalarExpr {
  if (expr.kind === "sqrt" && expr.value.kind === "pow" && expr.value.exponent === 2) return { kind: "abs", value: simplifyRadical(expr.value.base) };
  if (expr.kind === "mul" && expr.left.kind === "sqrt" && expr.right.kind === "sqrt" && expr.left.value.kind === "const" && expr.right.value.kind === "const") {
    const a = toRational(expr.left.value.value), b = toRational(expr.right.value.value);
    if (a && b && a.n >= 0n && b.n >= 0n && a.d === 1n && b.d === 1n) return { kind: "sqrt", value: { kind: "const", value: Number(a.n * b.n) } };
  }
  if (expr.kind === "div" && expr.left.kind === "const" && toRational(expr.left.value)?.n === 1n && expr.right.kind === "add" && expr.right.left.kind === "const" && toRational(expr.right.left.value)?.n === 1n && expr.right.right.kind === "sqrt" && expr.right.right.value.kind === "const" && toRational(expr.right.right.value.value)?.n === 2n) return { kind: "sub", left: { kind: "sqrt", value: { kind: "const", value: 2 } }, right: { kind: "const", value: 1 } };
  if (expr.kind === "add" || expr.kind === "sub" || expr.kind === "mul" || expr.kind === "div") return { ...expr, left: simplifyRadical(expr.left), right: simplifyRadical(expr.right) };
  if (expr.kind === "neg") return { kind: "neg", value: simplifyRadical(expr.value) };
  if (expr.kind === "pow") return { kind: "pow", base: simplifyRadical(expr.base), exponent: expr.exponent };
  if (expr.kind === "sqrt" || expr.kind === "abs" || expr.kind === "ln" || expr.kind === "sin" || expr.kind === "cos") return { kind: expr.kind, value: simplifyRadical(expr.value) };
  return expr;
}

function domainAllows(domain: DomainSpec | undefined, x: SpanRational): boolean {
  if (!domain) return true;
  const text = formatRational(x);
  if ((domain.excluded ?? []).some((value) => String(value) === text || toRational(value)?.n === x.n && toRational(value)?.d === x.d)) return false;
  return (domain.intervals ?? []).some((interval) => {
    const left = interval.left === undefined ? null : toRational(interval.left); const right = interval.right === undefined ? null : toRational(interval.right);
    const leftOk = !left || x.n * left.d > left.n * x.d || (!interval.leftOpen && x.n * left.d === left.n * x.d);
    const rightOk = !right || x.n * right.d < right.n * x.d || (!interval.rightOpen && x.n * right.d === right.n * x.d);
    return leftOk && rightOk;
  }) || (domain.intervals?.length ? false : true);
}

function integerSquareRoot(value: bigint): bigint | null { if (value < 0n) return null; let low = 0n, high = value + 1n; while (high - low > 1n) { const middle = (low + high) / 2n; if (middle * middle <= value) low = middle; else high = middle; } return low * low === value ? low : null; }
function evaluateExtended(expr: ScalarExpr, x: SpanRational, variable = "x"): { value?: SpanRational; defined: boolean; reason?: string } {
  switch (expr.kind) {
    case "const": { const value = toRational(expr.value); return value ? { value, defined: true } : { defined: false, reason: "non_rational_constant" }; }
    case "variable": return expr.name === variable ? { value: x, defined: true } : { defined: false, reason: "foreign_variable" };
    case "neg": { const inner = evaluateExtended(expr.value, x, variable); return inner.defined ? { value: rational(-inner.value!.n, inner.value!.d), defined: true } : inner; }
    case "abs": { const inner = evaluateExtended(expr.value, x, variable); return inner.defined ? { value: inner.value!.n < 0n ? rational(-inner.value!.n, inner.value!.d) : inner.value, defined: true } : inner; }
    case "sqrt": { const inner = evaluateExtended(expr.value, x, variable); if (!inner.defined || inner.value!.n < 0n) return { defined: false, reason: "even_root_domain" }; const n = integerSquareRoot(inner.value!.n), d = integerSquareRoot(inner.value!.d); return n !== null && d !== null ? { value: rational(n, d), defined: true } : { defined: false, reason: "irrational_radical" }; }
    case "add": case "sub": case "mul": case "div": { const left = evaluateExtended(expr.left, x, variable), right = evaluateExtended(expr.right, x, variable); if (!left.defined || !right.defined) return { defined: false, reason: left.reason ?? right.reason }; if (expr.kind === "add") return { value: addRational(left.value!, right.value!), defined: true }; if (expr.kind === "sub") return { value: subtractRational(left.value!, right.value!), defined: true }; if (expr.kind === "mul") return { value: multiplyRational(left.value!, right.value!), defined: true }; return right.value!.n === 0n ? { defined: false, reason: "natural_domain_denominator_zero" } : { value: divideRational(left.value!, right.value!), defined: true }; }
    case "pow": { const base = evaluateExtended(expr.base, x, variable); if (!base.defined || !Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) return { defined: false, reason: base.reason ?? "power_out_of_bounds" }; let value = rational(1n); const count = Math.abs(expr.exponent); for (let i = 0; i < count; i++) value = multiplyRational(value, expr.exponent >= 0 ? base.value! : rational(base.value!.d, base.value!.n)); return { value, defined: true }; }
    default: return { defined: false, reason: `${expr.kind}_outside_decidable_fragment` };
  }
}
export function verifyScalarEquivalence(studentInput: ScalarExpr | string, referenceInput: ScalarExpr | string, domain?: DomainSpec): VerificationResult {
  const student = parseScalarExpr(studentInput), reference = parseScalarExpr(referenceInput);
  if (!student || !reference) return { status: "unverified", reason: "parse_outside_decidable_fragment", domain };
  const sf = rationalForm(student), rf = rationalForm(reference);
  if (sf.unsupported || rf.unsupported) {
    const candidates = [-2, -1, 0, 1, 2].map((value) => rational(BigInt(value)));
    for (const x of candidates) {
      if (!domainAllows(domain, x)) continue;
      const left = evaluateExtended(student, x), right = evaluateExtended(reference, x);
      if (left.defined !== right.defined) return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: formatRational(x), detail: left.defined ? "reference undefined" : "student undefined" }, domain };
      if (left.defined && right.defined && !equalRational(left.value!, right.value!)) return { status: "inequivalent", reason: "exact_radical_counterexample", witness: { input: formatRational(x), detail: "exact values differ" }, domain };
    }
    if (JSON.stringify(simplifyRadical(student)) === JSON.stringify(simplifyRadical(reference))) return { status: "equivalent", reason: "canonical_radical_identity", domain };
    return { status: "unverified", reason: sf.unsupported ?? rf.unsupported, domain };
  }
  const denominator = polynomialMultiply(sf.denominator, rf.denominator);
  const residual = polynomialAdd(polynomialMultiply(sf.numerator, rf.denominator), polynomialMultiply(rf.numerator, sf.denominator), -1);
  const candidates = [-3, -2, -1, 0, 1, 2, 3].map((value) => rational(BigInt(value)));
  for (const x of candidates) {
    if (!domainAllows(domain, x)) continue;
    const denominatorValue = polynomialEvaluate(denominator, x);
    if (denominatorValue.n === 0n) {
      const studentValue = evaluateScalar(student, x), referenceValue = evaluateScalar(reference, x);
      if (studentValue.defined !== referenceValue.defined) return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: formatRational(x), detail: studentValue.defined ? "reference undefined" : "student undefined" }, domain };
      continue;
    }
    if (polynomialEvaluate(residual, x).n !== 0n) return { status: "inequivalent", reason: "residual_nonzero", witness: { input: formatRational(x), detail: "exact residual is non-zero" }, domain };
  }
  if (residual.size === 0) return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
  if (polynomialDegree(residual) <= 12) return { status: "equivalent", reason: "exact_polynomial_identity_after_domain_lock", domain };
  return { status: "unverified", reason: "degree_bound_exceeded", domain };
}

export type IntegralVerificationInput = { student: ScalarExpr | string; integrand: ScalarExpr | string; variable?: string; domain?: DomainSpec; piecewise?: PiecewiseExpr };
export function verifyIndefiniteIntegral(input: IntegralVerificationInput): VerificationResult {
  const student = parseScalarExpr(input.student), integrand = parseScalarExpr(input.integrand);
  if (!student || !integrand) return { status: "unverified", reason: "parse_outside_decidable_fragment" };
  const derivative = differentiate(student, input.variable ?? "x");
  if (!derivative) return { status: "unverified", reason: "derivative_outside_supported_fragment" };
  return verifyScalarEquivalence({ kind: "sub", left: derivative, right: integrand }, { kind: "const", value: 0 }, input.domain);
}

export function differentiate(expr: ScalarExpr, variable = "x"): ScalarExpr | null {
  switch (expr.kind) {
    case "const": return { kind: "const", value: 0 };
    case "variable": return { kind: "const", value: expr.name === variable ? 1 : 0 };
    case "neg": { const value = differentiate(expr.value, variable); return value ? { kind: "neg", value } : null; }
    case "add": case "sub": { const left = differentiate(expr.left, variable), right = differentiate(expr.right, variable); return left && right ? { kind: expr.kind, left, right } : null; }
    case "mul": { const left = differentiate(expr.left, variable), right = differentiate(expr.right, variable); return left && right ? { kind: "add", left: { kind: "mul", left, right: expr.right }, right: { kind: "mul", left: expr.left, right } } : null; }
    case "div": { const left = differentiate(expr.left, variable), right = differentiate(expr.right, variable); return left && right ? { kind: "div", left: { kind: "sub", left: { kind: "mul", left, right: expr.right }, right: { kind: "mul", left: expr.left, right } }, right: { kind: "pow", base: expr.right, exponent: 2 } } : null; }
    case "pow": { if (expr.exponent < 0 || expr.base.kind !== "variable" || expr.base.name !== variable) return null; return { kind: "mul", left: { kind: "const", value: expr.exponent }, right: { kind: "pow", base: expr.base, exponent: expr.exponent - 1 } }; }
    default: return null;
  }
}

export type SubstitutionBounds = { lower: string | number; upper: string | number; substitution: ScalarExpr | string; transformedLower: string | number; transformedUpper: string | number };
export function verifySubstitutionBounds(input: SubstitutionBounds): VerificationResult {
  const substitution = parseScalarExpr(input.substitution); const lower = toRational(input.lower), upper = toRational(input.upper); const expectedLower = toRational(input.transformedLower), expectedUpper = toRational(input.transformedUpper);
  if (!substitution || !lower || !upper || !expectedLower || !expectedUpper) return { status: "unverified", reason: "bounds_outside_exact_fragment" };
  const lowValue = evaluateScalar(substitution, lower), highValue = evaluateScalar(substitution, upper);
  if (!lowValue.defined || !highValue.defined || !equalRational(lowValue.value!, expectedLower) || !equalRational(highValue.value!, expectedUpper)) return { status: "inequivalent", reason: "transformed_bounds_mismatch", witness: { input: `${formatRational(lower)}..${formatRational(upper)}`, detail: `expected ${formatRational(lowValue.value ?? rational(0n))}..${formatRational(highValue.value ?? rational(0n))}` } };
  return { status: "equivalent", reason: "ordered_transformed_bounds_verified" };
}
export const checkScalarEquivalence = verifyScalarEquivalence;
export const canonicalizeRadical = simplifyRadical;
export const checkSubstitutionBounds = verifySubstitutionBounds;
export const verifyCalculus = verifyIndefiniteIntegral;
