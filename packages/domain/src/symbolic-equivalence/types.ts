import { addRational, divideRational, equalRational, multiplyRational, rational, subtractRational, type SpanRational } from "../opening/span-rational";

export type EquivalenceStatus = "equivalent" | "inequivalent" | "unverified";
export type VerificationResult = {
  status: EquivalenceStatus;
  reason?: string;
  witness?: { input: string; student?: string; reference?: string; detail?: string };
  domain?: DomainSpec;
};

export type DomainInterval = {
  left?: string | number;
  right?: string | number;
  leftOpen?: boolean;
  rightOpen?: boolean;
};

export type DomainSpec = {
  variable?: string;
  excluded?: readonly (string | number)[];
  intervals?: readonly DomainInterval[];
};

export type ScalarExpr =
  | { kind: "const"; value: string | number | bigint | SpanRational }
  | { kind: "variable"; name: string }
  | { kind: "neg"; value: ScalarExpr }
  | { kind: "add" | "sub" | "mul" | "div"; left: ScalarExpr; right: ScalarExpr }
  | { kind: "pow"; base: ScalarExpr; exponent: number }
  | { kind: "sqrt" | "abs" | "ln" | "sin" | "cos" | "exp"; value: ScalarExpr };

export type PiecewiseExpr = { split: string | number; left: ScalarExpr | string; right: ScalarExpr | string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRational(value: unknown): SpanRational | null {
  if (typeof value === "bigint") return rational(value);
  if (typeof value === "number") return Number.isInteger(value) && Number.isSafeInteger(value) ? rational(BigInt(value)) : null;
  if (typeof value === "string") {
    const trimmed = value.trim().replaceAll("−", "-");
    if (/^[+-]?\d+$/.test(trimmed)) return rational(BigInt(trimmed));
    const fraction = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(trimmed);
    if (fraction) {
      const den = BigInt(fraction[2]!);
      return den !== 0n ? rational(BigInt(fraction[1]!), den) : null;
    }
    const decimal = /^([+-]?)(\d*)\.(\d+)$/.exec(trimmed);
    if (decimal) {
      const sign = decimal[1] === "-" ? -1n : 1n;
      const digits = `${decimal[2] || "0"}${decimal[3]}`;
      return rational(sign * BigInt(digits), 10n ** BigInt(decimal[3]!.length));
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as { n?: unknown; d?: unknown };
  return typeof candidate.n === "bigint" && typeof candidate.d === "bigint" && candidate.d !== 0n
    ? rational(candidate.n, candidate.d)
    : null;
}

export function formatRational(value: SpanRational): string {
  return value.d === 1n ? String(value.n) : `${value.n}/${value.d}`;
}

function compareRational(a: SpanRational, b: SpanRational): -1 | 0 | 1 {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

function bigAbs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function bigLcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return bigAbs((a / bigGcd(a, b)) * b);
}

export type Polynomial = Map<number, SpanRational>;
export function polynomialConstant(value: SpanRational): Polynomial {
  return value.n === 0n ? new Map() : new Map([[0, value]]);
}
export function polynomialVariable(): Polynomial {
  return new Map([[1, rational(1n)]]);
}
export function polynomialAdd(a: Polynomial, b: Polynomial, sign: 1 | -1 = 1): Polynomial {
  const out = new Map(a);
  for (const [degree, value] of b) {
    const next =
      sign === 1
        ? addRational(out.get(degree) ?? rational(0n), value)
        : subtractRational(out.get(degree) ?? rational(0n), value);
    if (next.n === 0n) out.delete(degree);
    else out.set(degree, next);
  }
  return out;
}
export function polynomialMultiply(a: Polynomial, b: Polynomial): Polynomial {
  const out = new Map<number, SpanRational>();
  for (const [da, va] of a) {
    for (const [db, vb] of b) {
      const degree = da + db;
      const next = addRational(out.get(degree) ?? rational(0n), multiplyRational(va, vb));
      if (next.n === 0n) out.delete(degree);
      else out.set(degree, next);
    }
  }
  return out;
}
export function polynomialEvaluate(poly: Polynomial, x: SpanRational): SpanRational {
  let out = rational(0n);
  const maxDeg = polynomialDegree(poly);
  if (maxDeg < 0) return out;
  for (let d = maxDeg; d >= 0; d--) {
    out = addRational(multiplyRational(out, x), poly.get(d) ?? rational(0n));
  }
  return out;
}
export function polynomialDegree(poly: Polynomial): number {
  return poly.size ? Math.max(...poly.keys()) : -1;
}

function polynomialLeadCoeff(poly: Polynomial): SpanRational {
  const deg = polynomialDegree(poly);
  return deg >= 0 ? poly.get(deg)! : rational(0n);
}

function polynomialScale(poly: Polynomial, factor: SpanRational): Polynomial {
  if (factor.n === 0n || poly.size === 0) return new Map();
  const out = new Map<number, SpanRational>();
  for (const [deg, coeff] of poly) {
    const scaled = multiplyRational(coeff, factor);
    if (scaled.n !== 0n) out.set(deg, scaled);
  }
  return out;
}

function polynomialPrimitivePositive(poly: Polynomial): Polynomial {
  if (poly.size === 0) return new Map();
  let lcmDen = 1n;
  for (const coeff of poly.values()) lcmDen = bigLcm(lcmDen, coeff.d);
  let gcdNum = 0n;
  for (const coeff of poly.values()) gcdNum = bigGcd(gcdNum, bigAbs(coeff.n) * (lcmDen / coeff.d));
  if (gcdNum === 0n) return new Map();
  return polynomialScale(poly, rational(lcmDen, gcdNum));
}

function polynomialMonic(poly: Polynomial): Polynomial {
  if (poly.size === 0) return new Map();
  const lead = polynomialLeadCoeff(poly);
  return polynomialScale(poly, divideRational(rational(1n), lead));
}

function polynomialDivMod(a: Polynomial, b: Polynomial): { quotient: Polynomial; remainder: Polynomial } {
  const degB = polynomialDegree(b);
  if (degB < 0) throw new RangeError("Polynomial division by zero");
  let rem = new Map(a);
  const quot = new Map<number, SpanRational>();
  const leadB = polynomialLeadCoeff(b);
  while (rem.size > 0) {
    const degR = polynomialDegree(rem);
    if (degR < degB) break;
    const shift = degR - degB;
    const termCoeff = divideRational(polynomialLeadCoeff(rem), leadB);
    quot.set(shift, addRational(quot.get(shift) ?? rational(0n), termCoeff));
    const subtrahend = new Map<number, SpanRational>();
    for (const [d, c] of b) {
      const next = multiplyRational(c, termCoeff);
      if (next.n !== 0n) subtrahend.set(d + shift, next);
    }
    rem = polynomialAdd(rem, subtrahend, -1);
  }
  return { quotient: quot, remainder: rem };
}

function polynomialDerivative(poly: Polynomial): Polynomial {
  const out = new Map<number, SpanRational>();
  for (const [deg, coeff] of poly) {
    if (deg >= 1) {
      const next = multiplyRational(coeff, rational(BigInt(deg)));
      if (next.n !== 0n) out.set(deg - 1, next);
    }
  }
  return out;
}

function polynomialGcd(a: Polynomial, b: Polynomial): Polynomial {
  let x = polynomialPrimitivePositive(a);
  let y = polynomialPrimitivePositive(b);
  while (y.size > 0) {
    const rem = polynomialDivMod(x, y).remainder;
    x = y;
    y = rem.size > 0 ? polynomialPrimitivePositive(rem) : new Map();
  }
  return polynomialMonic(x);
}

function polynomialSquareFree(poly: Polynomial): Polynomial {
  if (polynomialDegree(poly) <= 0) return poly.size === 0 ? new Map() : polynomialPrimitivePositive(poly);
  const deriv = polynomialDerivative(poly);
  const g = polynomialGcd(poly, deriv);
  const sf = polynomialDegree(g) > 0 ? polynomialDivMod(poly, g).quotient : poly;
  return polynomialPrimitivePositive(sf);
}

function linearFactor(root: SpanRational): Polynomial {
  return polynomialAdd(polynomialVariable(), polynomialConstant(root), -1);
}

type NormalizedInterval = { left: SpanRational | null; right: SpanRational | null; leftOpen: boolean; rightOpen: boolean };

function buildSturmChain(sfPoly: Polynomial): Polynomial[] {
  const s0 = polynomialPrimitivePositive(sfPoly);
  const s1 = polynomialPrimitivePositive(polynomialDerivative(s0));
  const chain: Polynomial[] = [s0];
  if (s1.size > 0) chain.push(s1);
  while (chain.length >= 2 && polynomialDegree(chain[chain.length - 1]!) > 0) {
    const prev2 = chain[chain.length - 2]!;
    const prev1 = chain[chain.length - 1]!;
    const rem = polynomialDivMod(prev2, prev1).remainder;
    if (rem.size === 0) break;
    chain.push(polynomialPrimitivePositive(polynomialScale(rem, rational(-1n))));
  }
  return chain;
}

function signOfBigint(n: bigint): -1 | 0 | 1 {
  return n > 0n ? 1 : n < 0n ? -1 : 0;
}

function countSignVariations(signs: readonly (-1 | 0 | 1)[]): number {
  let count = 0;
  let prev: -1 | 1 | 0 = 0;
  for (const s of signs) {
    if (s === 0) continue;
    if (prev !== 0 && prev !== s) count++;
    prev = s;
  }
  return count;
}

function sturmVariationsAtFinite(chain: readonly Polynomial[], x: SpanRational): number {
  return countSignVariations(chain.map((poly) => signOfBigint(polynomialEvaluate(poly, x).n)));
}

function sturmVariationsAtInf(chain: readonly Polynomial[], positiveInf: boolean): number {
  const signs = chain.map((poly) => {
    const deg = polynomialDegree(poly);
    const lead = signOfBigint(polynomialLeadCoeff(poly).n);
    if (positiveInf || deg % 2 === 0) return lead;
    return (-lead) as -1 | 0 | 1;
  });
  return countSignVariations(signs);
}

function sturmCountOpen(sfPoly: Polynomial, left: SpanRational | null, right: SpanRational | null): number {
  const deg = polynomialDegree(sfPoly);
  if (deg <= 0) return 0;
  if (left && right && compareRational(left, right) >= 0) return 0;
  if (deg === 1) {
    const a1 = sfPoly.get(1)!;
    const a0 = sfPoly.get(0) ?? rational(0n);
    const root = divideRational(rational(-a0.n, a0.d), a1);
    const leftOk = !left || compareRational(left, root) < 0;
    const rightOk = !right || compareRational(root, right) < 0;
    return leftOk && rightOk ? 1 : 0;
  }
  const chain = buildSturmChain(sfPoly);
  const vLeft = left === null ? sturmVariationsAtInf(chain, false) : sturmVariationsAtFinite(chain, left);
  const vRight = right === null ? sturmVariationsAtInf(chain, true) : sturmVariationsAtFinite(chain, right);
  return Math.max(0, vLeft - vRight);
}

export function sturmCount(poly: Polynomial, interval: NormalizedInterval): number {
  if (poly.size === 0) return 0;
  let work = polynomialSquareFree(poly);
  if (polynomialDegree(work) <= 0) return 0;
  if (interval.left && interval.right) {
    const cmp = compareRational(interval.left, interval.right);
    if (cmp > 0) return 0;
    if (cmp === 0) {
      return !interval.leftOpen && !interval.rightOpen && polynomialEvaluate(work, interval.left).n === 0n ? 1 : 0;
    }
  }
  let count = 0;
  if (interval.left !== null && polynomialEvaluate(work, interval.left).n === 0n) {
    if (!interval.leftOpen) count++;
    work = polynomialDivMod(work, linearFactor(interval.left)).quotient;
  }
  if (interval.right !== null && polynomialDegree(work) >= 1 && polynomialEvaluate(work, interval.right).n === 0n) {
    if (!interval.rightOpen) count++;
    work = polynomialDivMod(work, linearFactor(interval.right)).quotient;
  }
  return count + sturmCountOpen(work, interval.left, interval.right);
}

function cauchyRootBound(poly: Polynomial): SpanRational {
  const deg = polynomialDegree(poly);
  if (deg <= 0) return rational(1n);
  const lead = polynomialLeadCoeff(poly);
  const absLead = rational(bigAbs(lead.n), lead.d);
  let maxCeil = 0n;
  for (const [d, c] of poly) {
    if (d === deg) continue;
    const ratio = divideRational(rational(bigAbs(c.n), c.d), absLead);
    const ceilVal = (ratio.n + ratio.d - 1n) / ratio.d;
    if (ceilVal > maxCeil) maxCeil = ceilVal;
  }
  return rational(1n + maxCeil);
}

type IsolatedRoot =
  | { kind: "exact"; value: SpanRational }
  | { kind: "open"; low: SpanRational; high: SpanRational };

function rootSortKey(root: IsolatedRoot): SpanRational {
  return root.kind === "exact" ? root.value : root.low;
}

function isolateRealRoots(sfPoly: Polynomial, interval: NormalizedInterval): IsolatedRoot[] {
  if (sfPoly.size === 0) return [];
  let work = polynomialSquareFree(sfPoly);
  if (polynomialDegree(work) <= 0) return [];
  if (interval.left && interval.right) {
    const cmp = compareRational(interval.left, interval.right);
    if (cmp > 0) return [];
    if (cmp === 0) {
      return !interval.leftOpen && !interval.rightOpen && polynomialEvaluate(work, interval.left).n === 0n
        ? [{ kind: "exact", value: interval.left }]
        : [];
    }
  }
  const roots: IsolatedRoot[] = [];
  if (interval.left !== null && polynomialEvaluate(work, interval.left).n === 0n) {
    if (!interval.leftOpen) roots.push({ kind: "exact", value: interval.left });
    work = polynomialDivMod(work, linearFactor(interval.left)).quotient;
  }
  if (interval.right !== null && polynomialDegree(work) >= 1 && polynomialEvaluate(work, interval.right).n === 0n) {
    if (!interval.rightOpen) roots.push({ kind: "exact", value: interval.right });
    work = polynomialDivMod(work, linearFactor(interval.right)).quotient;
  }
  if (polynomialDegree(work) <= 0) return roots.sort((a, b) => compareRational(rootSortKey(a), rootSortKey(b)));

  const bound = cauchyRootBound(work);
  let low = interval.left ?? rational(-bound.n, bound.d);
  let high = interval.right ?? bound;
  if (interval.left === null && interval.right !== null && compareRational(low, high) >= 0) {
    low = subtractRational(high, bound);
  }
  if (interval.right === null && interval.left !== null && compareRational(high, low) <= 0) {
    high = addRational(low, bound);
  }
  if (interval.left === null) {
    while (polynomialEvaluate(work, low).n === 0n) low = subtractRational(low, rational(1n));
  }
  if (interval.right === null) {
    while (polynomialEvaluate(work, high).n === 0n) high = addRational(high, rational(1n));
  }

  const stack: Array<{ a: SpanRational; b: SpanRational; depth: number }> = [{ a: low, b: high, depth: 0 }];
  let guard = 0;
  while (stack.length > 0 && guard++ < 2048) {
    const { a, b, depth } = stack.pop()!;
    if (compareRational(a, b) >= 0) continue;
    const count = sturmCountOpen(work, a, b);
    if (count === 0) continue;
    if (count === 1 || depth >= 80) {
      roots.push({ kind: "open", low: a, high: b });
      continue;
    }
    const mid = divideRational(addRational(a, b), rational(2n));
    if (polynomialEvaluate(work, mid).n === 0n) {
      roots.push({ kind: "exact", value: mid });
      work = polynomialDivMod(work, linearFactor(mid)).quotient;
    }
    stack.push({ a: mid, b, depth: depth + 1 });
    stack.push({ a, b: mid, depth: depth + 1 });
  }
  return roots.sort((a, b) => compareRational(rootSortKey(a), rootSortKey(b)));
}

export type RationalForm = {
  numerator: Polynomial;
  denominator: Polynomial;
  domainDenominators: Polynomial[];
  zeroDenominator?: boolean;
  unsupported?: string;
};

export function rationalForm(expr: ScalarExpr, variable = "x"): RationalForm {
  switch (expr.kind) {
    case "const": {
      const value = toRational(expr.value);
      return value
        ? { numerator: polynomialConstant(value), denominator: polynomialConstant(rational(1n)), domainDenominators: [] }
        : { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: "non_rational_constant" };
    }
    case "variable":
      return expr.name === variable
        ? { numerator: polynomialVariable(), denominator: polynomialConstant(rational(1n)), domainDenominators: [] }
        : { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: "foreign_variable" };
    case "neg": {
      const inner = rationalForm(expr.value, variable);
      if (inner.unsupported) return inner;
      return {
        ...inner,
        numerator: polynomialMultiply(polynomialConstant(rational(-1n)), inner.numerator),
      };
    }
    case "add":
    case "sub": {
      const left = rationalForm(expr.left, variable);
      const right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: left.unsupported ?? right.unsupported };
      }
      const numerator = polynomialAdd(
        polynomialMultiply(left.numerator, right.denominator),
        polynomialMultiply(right.numerator, left.denominator),
        expr.kind === "add" ? 1 : -1,
      );
      return {
        numerator,
        denominator: polynomialMultiply(left.denominator, right.denominator),
        domainDenominators: [...left.domainDenominators, ...right.domainDenominators],
        zeroDenominator: left.zeroDenominator || right.zeroDenominator,
      };
    }
    case "mul": {
      const left = rationalForm(expr.left, variable);
      const right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: left.unsupported ?? right.unsupported };
      }
      return {
        numerator: polynomialMultiply(left.numerator, right.numerator),
        denominator: polynomialMultiply(left.denominator, right.denominator),
        domainDenominators: [...left.domainDenominators, ...right.domainDenominators],
        zeroDenominator: left.zeroDenominator || right.zeroDenominator,
      };
    }
    case "div": {
      const left = rationalForm(expr.left, variable);
      const right = rationalForm(expr.right, variable);
      if (left.unsupported || right.unsupported) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: left.unsupported ?? right.unsupported };
      }
      const zeroDenominator = left.zeroDenominator || right.zeroDenominator || right.numerator.size === 0 || right.denominator.size === 0;
      return {
        numerator: polynomialMultiply(left.numerator, right.denominator),
        denominator: polynomialMultiply(left.denominator, right.numerator),
        domainDenominators: [
          ...left.domainDenominators,
          ...right.domainDenominators,
          right.numerator,
          right.denominator,
        ],
        zeroDenominator,
      };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: "power_out_of_bounds" };
      }
      const inner = rationalForm(expr.base, variable);
      if (inner.unsupported) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: inner.unsupported };
      }
      const count = Math.abs(expr.exponent);
      let numerator = polynomialConstant(rational(1n));
      let denominator = polynomialConstant(rational(1n));
      for (let i = 0; i < count; i++) {
        numerator = polynomialMultiply(numerator, expr.exponent >= 0 ? inner.numerator : inner.denominator);
        denominator = polynomialMultiply(denominator, expr.exponent >= 0 ? inner.denominator : inner.numerator);
      }
      const extraDens = expr.exponent < 0 ? [inner.numerator, inner.denominator] : [];
      const zeroDenominator =
        inner.zeroDenominator || (expr.exponent < 0 && (inner.numerator.size === 0 || inner.denominator.size === 0));
      return {
        numerator,
        denominator,
        domainDenominators: [...inner.domainDenominators, ...extraDens],
        zeroDenominator,
      };
    }
    default:
      return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: `${expr.kind}_outside_rational_fragment` };
  }
}

function evaluateConstantInt(expr: ScalarExpr): number | null {
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (!q || q.d !== 1n) return null;
      const n = Number(q.n);
      return Number.isSafeInteger(n) ? n : null;
    }
    case "neg": {
      const v = evaluateConstantInt(expr.value);
      return v === null ? null : -v;
    }
    case "add":
    case "sub":
    case "mul": {
      const l = evaluateConstantInt(expr.left);
      const r = evaluateConstantInt(expr.right);
      if (l === null || r === null) return null;
      const out = expr.kind === "add" ? l + r : expr.kind === "sub" ? l - r : l * r;
      return Number.isSafeInteger(out) ? out : null;
    }
    case "div": {
      const l = evaluateConstantInt(expr.left);
      const r = evaluateConstantInt(expr.right);
      if (l === null || r === null || r === 0 || l % r !== 0) return null;
      return l / r;
    }
    case "pow": {
      const b = evaluateConstantInt(expr.base);
      if (b === null || !Number.isInteger(expr.exponent) || expr.exponent < 0 || expr.exponent > 12) return null;
      const out = b ** expr.exponent;
      return Number.isSafeInteger(out) ? out : null;
    }
    default:
      return null;
  }
}

export function parseScalarExpr(input: ScalarExpr | string | number): ScalarExpr | null {
  if (typeof input === "number") return Number.isFinite(input) ? parseScalarExpr(String(input)) : null;
  if (typeof input !== "string") return input;
  const source = input.replaceAll("−", "-").trim();
  if (!source) return null;
  let index = 0;
  const peek = () => source[index] ?? "";
  const skip = () => {
    while (/\s/.test(peek())) index++;
  };
  const consume = (token: string) => {
    skip();
    if (source.slice(index, index + token.length) === token) {
      index += token.length;
      return true;
    }
    return false;
  };
  const primary = (): ScalarExpr | null => {
    skip();
    if (consume("(")) {
      const value = addSub();
      if (!value || !consume(")")) return null;
      return value;
    }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(index));
    if (number) {
      index += number[0].length;
      return { kind: "const", value: number[0] };
    }
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(index));
    if (!name) return null;
    index += name[0].length;
    if (consume("(")) {
      const value = addSub();
      if (!value || !consume(")")) return null;
      if (!["sqrt", "abs", "ln", "sin", "cos", "exp"].includes(name[0]!)) return null;
      return { kind: name[0] as "sqrt" | "abs" | "ln" | "sin" | "cos" | "exp", value };
    }
    return { kind: "variable", name: name[0]! };
  };
  const power = (): ScalarExpr | null => {
    const base = primary();
    if (!base) return null;
    if (!consume("^")) return base;
    const expExpr = unary();
    if (!expExpr) return null;
    const exponent = evaluateConstantInt(expExpr);
    if (exponent === null) return null;
    return { kind: "pow", base, exponent };
  };
  const unary = (): ScalarExpr | null => {
    skip();
    if (consume("-")) {
      const value = unary();
      return value ? { kind: "neg", value } : null;
    }
    if (consume("+")) {
      return unary();
    }
    return power();
  };
  const mulDiv = (): ScalarExpr | null => {
    let left = unary();
    while (left) {
      if (consume("*")) {
        const right = unary();
        if (!right) return null;
        left = { kind: "mul", left, right };
      } else if (consume("/")) {
        const right = unary();
        if (!right) return null;
        left = { kind: "div", left, right };
      } else break;
    }
    return left;
  };
  function addSub(): ScalarExpr | null {
    let left = mulDiv();
    while (left) {
      if (consume("+")) {
        const right = mulDiv();
        if (!right) return null;
        left = { kind: "add", left, right };
      } else if (consume("-")) {
        const right = mulDiv();
        if (!right) return null;
        left = { kind: "sub", left, right };
      } else break;
    }
    return left;
  }
  const result = addSub();
  skip();
  return result && index === source.length ? result : null;
}

export function evaluateScalar(
  expr: ScalarExpr,
  x: SpanRational,
  variable = "x",
): { value?: SpanRational; defined: boolean; reason?: string } {
  const form = rationalForm(expr, variable);
  if (form.unsupported) return { defined: false, reason: form.unsupported };
  if (form.zeroDenominator) return { defined: false, reason: "natural_domain_denominator_zero" };
  for (const den of form.domainDenominators) {
    if (polynomialEvaluate(den, x).n === 0n) {
      return { defined: false, reason: "natural_domain_denominator_zero" };
    }
  }
  const denominator = polynomialEvaluate(form.denominator, x);
  if (denominator.n === 0n) return { defined: false, reason: "natural_domain_denominator_zero" };
  return { value: divideRational(polynomialEvaluate(form.numerator, x), denominator), defined: true };
}

function integerSquareRoot(value: bigint): bigint | null {
  if (value < 0n) return null;
  if (value === 0n) return 0n;
  let low = 0n;
  let high = value + 1n;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (middle * middle <= value) low = middle;
    else high = middle;
  }
  return low * low === value ? low : null;
}

function extractSquareFree(n: bigint): { square: bigint; rest: bigint } {
  if (n === 0n) return { square: 0n, rest: 0n };
  let square = 1n;
  let rest = bigAbs(n);
  while (rest % 4n === 0n) {
    square *= 2n;
    rest /= 4n;
  }
  for (let p = 3n; p <= 10_000n && p * p <= rest; p += 2n) {
    const sq = p * p;
    while (rest % sq === 0n) {
      square *= p;
      rest /= sq;
    }
  }
  const exactRoot = integerSquareRoot(rest);
  if (exactRoot !== null && exactRoot > 1n) {
    square *= exactRoot;
    rest = 1n;
  }
  return { square, rest };
}

type RadicalSum = Map<bigint, SpanRational>;

function radicalAdd(a: RadicalSum, b: RadicalSum, sign: 1 | -1 = 1): RadicalSum {
  const out = new Map(a);
  for (const [rad, coeff] of b) {
    const next = sign === 1 ? addRational(out.get(rad) ?? rational(0n), coeff) : subtractRational(out.get(rad) ?? rational(0n), coeff);
    if (next.n === 0n) out.delete(rad);
    else out.set(rad, next);
  }
  return out;
}

function radicalMultiply(a: RadicalSum, b: RadicalSum): RadicalSum {
  const out = new Map<bigint, SpanRational>();
  for (const [d1, c1] of a) {
    for (const [d2, c2] of b) {
      const g = bigGcd(d1, d2);
      const d = (d1 / g) * (d2 / g);
      const term = multiplyRational(multiplyRational(c1, c2), rational(g));
      const next = addRational(out.get(d) ?? rational(0n), term);
      if (next.n === 0n) out.delete(d);
      else out.set(d, next);
    }
  }
  return out;
}

function smallestPrimeFactor(n: bigint): bigint | null {
  if (n <= 1n) return null;
  if (n % 2n === 0n) return 2n;
  for (let p = 3n; p <= 10_000n && p * p <= n; p += 2n) {
    if (n % p === 0n) return p;
  }
  return n <= 100_000_000n ? n : null;
}

function radicalDivide(a: RadicalSum, b: RadicalSum): { ok: true; value: RadicalSum } | { ok: false; reason: string } {
  if (b.size === 0) return { ok: false, reason: "natural_domain_denominator_zero" };
  let num = new Map(a);
  let den = new Map(b);
  let steps = 0;
  while (steps++ < 8) {
    const nonRationalKey = [...den.keys()].find((k) => k > 1n);
    if (nonRationalKey === undefined) break;
    const prime = smallestPrimeFactor(nonRationalKey);
    if (!prime) return { ok: false, reason: "irrational_denominator_too_large" };
    const pPart = new Map<bigint, SpanRational>();
    const qPart = new Map<bigint, SpanRational>();
    for (const [k, v] of den) {
      if (k % prime === 0n) qPart.set(k, v);
      else pPart.set(k, v);
    }
    const conj = radicalAdd(pPart, qPart, -1);
    num = radicalMultiply(num, conj);
    den = radicalMultiply(den, conj);
    if (num.size > 24 || den.size > 24) return { ok: false, reason: "radical_complexity_exceeded" };
  }
  const hasIrrational = [...den.keys()].some((k) => k > 1n);
  if (hasIrrational) return { ok: false, reason: "radical_rationalization_limit" };
  const scalar = den.get(1n);
  if (!scalar || scalar.n === 0n) return { ok: false, reason: "natural_domain_denominator_zero" };
  const inv = divideRational(rational(1n), scalar);
  const out = new Map<bigint, SpanRational>();
  for (const [k, v] of num) {
    const scaled = multiplyRational(v, inv);
    if (scaled.n !== 0n) out.set(k, scaled);
  }
  return { ok: true, value: out };
}

function radicalApprox(a: RadicalSum): { val: number; err: number } {
  let val = 0;
  let err = 0;
  for (const [d, c] of a) {
    const cNum = Number(c.n) / Number(c.d);
    const term = d === 1n ? cNum : cNum * Math.sqrt(Number(d));
    val += term;
    err += Math.abs(term) * 1e-13 + 1e-15;
  }
  return { val, err };
}

function radicalSign(a: RadicalSum): -1 | 0 | 1 | null {
  if (a.size === 0) return 0;
  if (a.size === 1) {
    const [, coeff] = [...a.entries()][0]!;
    return coeff.n > 0n ? 1 : -1;
  }
  if (a.size === 2) {
    const [[d1, c1], [d2, c2]] = [...a.entries()] as [[bigint, SpanRational], [bigint, SpanRational]];
    if (c1.n > 0n && c2.n > 0n) return 1;
    if (c1.n < 0n && c2.n < 0n) return -1;
    const sq1 = multiplyRational(multiplyRational(c1, c1), rational(d1));
    const sq2 = multiplyRational(multiplyRational(c2, c2), rational(d2));
    const cmp = compareRational(sq1, sq2);
    if (cmp === 0) return 0;
    return cmp > 0 ? (c1.n > 0n ? 1 : -1) : (c2.n > 0n ? 1 : -1);
  }
  const { val, err } = radicalApprox(a);
  if (val > err) return 1;
  if (val < -err) return -1;
  return null;
}

function evaluateRadicalConst(expr: ScalarExpr): { ok: true; value: RadicalSum } | { ok: false; defined: boolean; reason: string } {
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (!q) return { ok: false, defined: true, reason: "non_rational_constant" };
      return { ok: true, value: q.n === 0n ? new Map() : new Map([[1n, q]]) };
    }
    case "variable":
      return { ok: false, defined: true, reason: "contains_variable" };
    case "neg": {
      const inner = evaluateRadicalConst(expr.value);
      return inner.ok ? { ok: true, value: radicalAdd(new Map(), inner.value, -1) } : inner;
    }
    case "abs": {
      const inner = evaluateRadicalConst(expr.value);
      if (!inner.ok) return inner;
      const sign = radicalSign(inner.value);
      if (sign === null) return { ok: false, defined: true, reason: "ambiguous_radical_sign" };
      return { ok: true, value: sign < 0 ? radicalAdd(new Map(), inner.value, -1) : inner.value };
    }
    case "sqrt": {
      const inner = evaluateRadicalConst(expr.value);
      if (!inner.ok) return inner;
      const sign = radicalSign(inner.value);
      if (sign !== null && sign < 0) return { ok: false, defined: false, reason: "even_root_domain" };
      if (inner.value.size === 0) return { ok: true, value: new Map() };
      if (inner.value.size === 1 && inner.value.has(1n)) {
        const q = inner.value.get(1n)!;
        const { square, rest } = extractSquareFree(q.n * q.d);
        if (rest > 100_000_000n) return { ok: false, defined: true, reason: "large_radicand" };
        return { ok: true, value: new Map([[rest, rational(square, q.d)]]) };
      }
      return { ok: false, defined: true, reason: "nested_radical" };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const left = evaluateRadicalConst(expr.left);
      if (!left.ok) return left;
      const right = evaluateRadicalConst(expr.right);
      if (!right.ok) return right;
      if (expr.kind === "add") return { ok: true, value: radicalAdd(left.value, right.value, 1) };
      if (expr.kind === "sub") return { ok: true, value: radicalAdd(left.value, right.value, -1) };
      if (expr.kind === "mul") return { ok: true, value: radicalMultiply(left.value, right.value) };
      const divRes = radicalDivide(left.value, right.value);
      if (!divRes.ok) {
        return { ok: false, defined: divRes.reason !== "natural_domain_denominator_zero", reason: divRes.reason };
      }
      return { ok: true, value: divRes.value };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) {
        return { ok: false, defined: true, reason: "power_out_of_bounds" };
      }
      const base = evaluateRadicalConst(expr.base);
      if (!base.ok) return base;
      if (expr.exponent === 0) return { ok: true, value: new Map([[1n, rational(1n)]]) };
      let stepBase: RadicalSum = base.value;
      if (expr.exponent < 0) {
        const inv = radicalDivide(new Map([[1n, rational(1n)]]), stepBase);
        if (!inv.ok) return { ok: false, defined: inv.reason !== "natural_domain_denominator_zero", reason: inv.reason };
        stepBase = inv.value;
      }
      let acc: RadicalSum = new Map([[1n, rational(1n)]]);
      const count = Math.abs(expr.exponent);
      for (let i = 0; i < count; i++) acc = radicalMultiply(acc, stepBase);
      return { ok: true, value: acc };
    }
    default:
      return { ok: false, defined: true, reason: `${expr.kind}_outside_radical_fragment` };
  }
}

function rationalToConstExpr(q: SpanRational): ScalarExpr {
  if (q.d === 1n) {
    const n = Number(q.n);
    if (Number.isSafeInteger(n)) {
      return n < 0 ? { kind: "neg", value: { kind: "const", value: -n } } : { kind: "const", value: n };
    }
    return { kind: "const", value: formatRational(q) };
  }
  const numNode: ScalarExpr = { kind: "const", value: Number.isSafeInteger(Number(q.n)) ? Number(q.n) : String(q.n) };
  const denNode: ScalarExpr = { kind: "const", value: Number.isSafeInteger(Number(q.d)) ? Number(q.d) : String(q.d) };
  return { kind: "div", left: numNode, right: denNode };
}

function radicalSumToExpr(sum: RadicalSum): ScalarExpr {
  if (sum.size === 0) return { kind: "const", value: 0 };
  const entries = [...sum.entries()].sort((a, b) => (a[0] === b[0] ? 0 : a[0] === 1n ? 1 : b[0] === 1n ? -1 : a[0] < b[0] ? -1 : 1));
  const termExpr = (rad: bigint, coeff: SpanRational): { sign: 1 | -1; node: ScalarExpr } => {
    const sign: 1 | -1 = coeff.n < 0n ? -1 : 1;
    const absCoeff = rational(bigAbs(coeff.n), coeff.d);
    if (rad === 1n) return { sign, node: rationalToConstExpr(absCoeff) };
    const radVal = Number.isSafeInteger(Number(rad)) ? Number(rad) : String(rad);
    const sqrtNode: ScalarExpr = { kind: "sqrt", value: { kind: "const", value: radVal } };
    if (absCoeff.n === 1n && absCoeff.d === 1n) return { sign, node: sqrtNode };
    return { sign, node: { kind: "mul", left: rationalToConstExpr(absCoeff), right: sqrtNode } };
  };

  const first = termExpr(entries[0]![0], entries[0]![1]);
  let acc: ScalarExpr = first.sign < 0 ? { kind: "neg", value: first.node } : first.node;
  for (let i = 1; i < entries.length; i++) {
    const next = termExpr(entries[i]![0], entries[i]![1]);
    acc = next.sign < 0 ? { kind: "sub", left: acc, right: next.node } : { kind: "add", left: acc, right: next.node };
  }
  return acc;
}

export function simplifyRadical(expr: ScalarExpr): ScalarExpr {
  const evaluated = evaluateRadicalConst(expr);
  if (evaluated.ok) return radicalSumToExpr(evaluated.value);
  if (expr.kind === "sqrt") {
    const inner = simplifyRadical(expr.value);
    if (inner.kind === "pow" && inner.exponent === 2) return { kind: "abs", value: inner.base };
    if (inner.kind === "const") {
      const q = toRational(inner.value);
      if (q && q.n >= 0n && q.d === 1n) {
        const { square, rest } = extractSquareFree(q.n);
        if (rest === 0n) return { kind: "const", value: 0 };
        if (rest === 1n) return rationalToConstExpr(rational(square));
        const radNode: ScalarExpr = { kind: "sqrt", value: { kind: "const", value: Number.isSafeInteger(Number(rest)) ? Number(rest) : String(rest) } };
        return square === 1n ? radNode : { kind: "mul", left: rationalToConstExpr(rational(square)), right: radNode };
      }
    }
    return { kind: "sqrt", value: inner };
  }
  if (expr.kind === "mul") {
    const left = simplifyRadical(expr.left);
    const right = simplifyRadical(expr.right);
    if (left.kind === "sqrt" && right.kind === "sqrt" && left.value.kind === "const" && right.value.kind === "const") {
      const a = toRational(left.value.value);
      const b = toRational(right.value.value);
      if (a && b && a.n >= 0n && b.n >= 0n && a.d === 1n && b.d === 1n) {
        const { square, rest } = extractSquareFree(a.n * b.n);
        if (rest === 1n) return rationalToConstExpr(rational(square));
        const radNode: ScalarExpr = { kind: "sqrt", value: { kind: "const", value: Number.isSafeInteger(Number(rest)) ? Number(rest) : String(rest) } };
        return square === 1n ? radNode : { kind: "mul", left: rationalToConstExpr(rational(square)), right: radNode };
      }
    }
    return { kind: "mul", left, right };
  }
  if (expr.kind === "add" || expr.kind === "sub" || expr.kind === "div") {
    return { ...expr, left: simplifyRadical(expr.left), right: simplifyRadical(expr.right) };
  }
  if (expr.kind === "neg") return { kind: "neg", value: simplifyRadical(expr.value) };
  if (expr.kind === "pow") return { kind: "pow", base: simplifyRadical(expr.base), exponent: expr.exponent };
  if (expr.kind === "abs" || expr.kind === "ln" || expr.kind === "sin" || expr.kind === "cos" || expr.kind === "exp") {
    return { kind: expr.kind, value: simplifyRadical(expr.value) };
  }
  return expr;
}

type DomainConstraint =
  | { kind: "nonzero"; poly: Polynomial }
  | { kind: "ge0"; poly: Polynomial }
  | { kind: "gt0"; poly: Polynomial };

type CollectedConstraints = {
  rational: DomainConstraint[];
  hasNonRationalDomainOps: boolean;
  alwaysUndefined: boolean;
};

function collectConstraints(expr: ScalarExpr, variable: string): CollectedConstraints {
  const rationalList: DomainConstraint[] = [];
  let hasNonRationalDomainOps = false;
  let alwaysUndefined = false;

  const addRfDens = (rf: RationalForm) => {
    if (rf.zeroDenominator) alwaysUndefined = true;
    for (const den of rf.domainDenominators) {
      if (den.size === 0) alwaysUndefined = true;
      else if (polynomialDegree(den) >= 1) rationalList.push({ kind: "nonzero", poly: den });
    }
    if (rf.denominator.size === 0) alwaysUndefined = true;
    else if (polynomialDegree(rf.denominator) >= 1) rationalList.push({ kind: "nonzero", poly: rf.denominator });
  };

  const walk = (node: ScalarExpr) => {
    switch (node.kind) {
      case "const":
      case "variable":
        return;
      case "neg":
      case "abs":
      case "sin":
      case "cos":
      case "exp":
        walk(node.value);
        return;
      case "add":
      case "sub":
      case "mul":
        walk(node.left);
        walk(node.right);
        return;
      case "div": {
        walk(node.left);
        walk(node.right);
        const rf = rationalForm(node.right, variable);
        if (!rf.unsupported) {
          addRfDens(rf);
          if (rf.numerator.size === 0) alwaysUndefined = true;
          else if (polynomialDegree(rf.numerator) >= 1) rationalList.push({ kind: "nonzero", poly: rf.numerator });
        } else {
          hasNonRationalDomainOps = true;
        }
        return;
      }
      case "pow": {
        walk(node.base);
        if (node.exponent < 0) {
          const rf = rationalForm(node.base, variable);
          if (!rf.unsupported) {
            addRfDens(rf);
            if (rf.numerator.size === 0) alwaysUndefined = true;
            else if (polynomialDegree(rf.numerator) >= 1) rationalList.push({ kind: "nonzero", poly: rf.numerator });
          } else {
            hasNonRationalDomainOps = true;
          }
        }
        return;
      }
      case "sqrt": {
        walk(node.value);
        const rf = rationalForm(node.value, variable);
        if (!rf.unsupported) {
          addRfDens(rf);
          const prod = polynomialMultiply(rf.numerator, rf.denominator);
          if (prod.size > 0) rationalList.push({ kind: "ge0", poly: prod });
        } else {
          hasNonRationalDomainOps = true;
        }
        return;
      }
      case "ln": {
        walk(node.value);
        const rf = rationalForm(node.value, variable);
        if (!rf.unsupported) {
          addRfDens(rf);
          const prod = polynomialMultiply(rf.numerator, rf.denominator);
          if (prod.size === 0) alwaysUndefined = true;
          else rationalList.push({ kind: "gt0", poly: prod });
        } else {
          hasNonRationalDomainOps = true;
        }
        return;
      }
    }
  };

  walk(expr);
  return { rational: rationalList, hasNonRationalDomainOps, alwaysUndefined };
}

function parseDomainSpec(domain: DomainSpec | undefined): {
  intervals: NormalizedInterval[];
  excluded: SpanRational[];
  empty: boolean;
} | null {
  const excluded: SpanRational[] = [];
  for (const raw of domain?.excluded ?? []) {
    const q = toRational(raw);
    if (!q) return null;
    if (!excluded.some((e) => equalRational(e, q))) excluded.push(q);
  }
  const rawIntervals = domain?.intervals;
  if (!rawIntervals || rawIntervals.length === 0) {
    return {
      intervals: [{ left: null, right: null, leftOpen: true, rightOpen: true }],
      excluded,
      empty: false,
    };
  }
  const intervals: NormalizedInterval[] = [];
  for (const iv of rawIntervals) {
    const left = iv.left === undefined ? null : toRational(iv.left);
    const right = iv.right === undefined ? null : toRational(iv.right);
    if ((iv.left !== undefined && !left) || (iv.right !== undefined && !right)) return null;
    const leftOpen = iv.leftOpen ?? false;
    const rightOpen = iv.rightOpen ?? false;
    if (left && right) {
      const cmp = compareRational(left, right);
      if (cmp > 0) continue;
      if (cmp === 0 && (leftOpen || rightOpen || excluded.some((e) => equalRational(e, left)))) continue;
    }
    intervals.push({ left, right, leftOpen, rightOpen });
  }
  return { intervals, excluded, empty: intervals.length === 0 };
}

function pointInInterval(x: SpanRational, iv: NormalizedInterval): boolean {
  if (iv.left !== null) {
    const cmp = compareRational(x, iv.left);
    if (cmp < 0 || (cmp === 0 && iv.leftOpen)) return false;
  }
  if (iv.right !== null) {
    const cmp = compareRational(x, iv.right);
    if (cmp > 0 || (cmp === 0 && iv.rightOpen)) return false;
  }
  return true;
}

function domainAllows(domain: DomainSpec | undefined, x: SpanRational): boolean {
  const parsed = parseDomainSpec(domain);
  if (!parsed || parsed.empty) return false;
  if (parsed.excluded.some((e) => equalRational(e, x))) return false;
  return parsed.intervals.some((iv) => pointInInterval(x, iv));
}

type SampleSite =
  | { kind: "rational"; x: SpanRational }
  | { kind: "isolated"; low: SpanRational; high: SpanRational; master: Polynomial };

function signAtSampleSite(poly: Polynomial, site: SampleSite): -1 | 0 | 1 {
  if (poly.size === 0) return 0;
  if (site.kind === "rational") return signOfBigint(polynomialEvaluate(poly, site.x).n);
  const g = polynomialGcd(poly, site.master);
  if (polynomialDegree(g) >= 1 && sturmCountOpen(polynomialSquareFree(g), site.low, site.high) === 1) return 0;
  return signOfBigint(polynomialEvaluate(poly, site.low).n);
}

function constraintsSatisfiedAtSite(constraints: readonly DomainConstraint[], site: SampleSite): boolean {
  for (const c of constraints) {
    const sign = signAtSampleSite(c.poly, site);
    if (c.kind === "nonzero" && sign === 0) return false;
    if (c.kind === "ge0" && sign < 0) return false;
    if (c.kind === "gt0" && sign <= 0) return false;
  }
  return true;
}

function formatSampleSite(site: SampleSite): string {
  return site.kind === "rational" ? formatRational(site.x) : `(${formatRational(site.low)}, ${formatRational(site.high)})`;
}

function pickRationalBetween(a: SpanRational | null, b: SpanRational | null): SpanRational {
  if (a === null && b === null) return rational(0n);
  if (a === null) return subtractRational(b!, rational(1n));
  if (b === null) return addRational(a, rational(1n));
  return divideRational(addRational(a, b), rational(2n));
}

function buildCadSampleSites(
  constraints: readonly DomainConstraint[],
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
): SampleSite[] {
  let master = polynomialConstant(rational(1n));
  for (const c of constraints) {
    if (polynomialDegree(c.poly) < 1) continue;
    const sf = polynomialSquareFree(c.poly);
    const g = polynomialGcd(master, sf);
    const factor = polynomialDegree(g) >= 1 ? polynomialDivMod(sf, g).quotient : sf;
    if (polynomialDegree(factor) >= 1) master = polynomialPrimitivePositive(polynomialMultiply(master, factor));
  }

  const sites: SampleSite[] = [];
  for (const iv of parsedDomain.intervals) {
    const roots = polynomialDegree(master) >= 1 ? isolateRealRoots(master, iv) : [];
    const rootBounds: Array<{ low: SpanRational; high: SpanRational }> = [];
    for (const r of roots) {
      if (r.kind === "exact") {
        if (!parsedDomain.excluded.some((e) => equalRational(e, r.value))) {
          sites.push({ kind: "rational", x: r.value });
        }
        rootBounds.push({ low: r.value, high: r.value });
      } else {
        sites.push({ kind: "isolated", low: r.low, high: r.high, master });
        rootBounds.push({ low: r.low, high: r.high });
      }
    }

    const emitOpenSample = (leftBound: SpanRational | null, rightBound: SpanRational | null) => {
      if (leftBound && rightBound && compareRational(leftBound, rightBound) >= 0) return;
      let candidate = pickRationalBetween(leftBound, rightBound);
      let tries = 0;
      while (
        tries++ < 32 &&
        (parsedDomain.excluded.some((e) => equalRational(e, candidate)) || polynomialEvaluate(master, candidate).n === 0n)
      ) {
        if (leftBound !== null && rightBound !== null) {
          candidate = divideRational(addRational(candidate, rightBound), rational(2n));
        } else if (leftBound !== null) {
          candidate = addRational(candidate, rational(1n));
        } else {
          candidate = subtractRational(candidate, rational(1n));
        }
      }
      if (pointInInterval(candidate, iv) && !parsedDomain.excluded.some((e) => equalRational(e, candidate))) {
        sites.push({ kind: "rational", x: candidate });
      }
    };

    if (rootBounds.length === 0) {
      if (iv.left && iv.right && equalRational(iv.left, iv.right)) {
        if (!parsedDomain.excluded.some((e) => equalRational(e, iv.left!))) {
          sites.push({ kind: "rational", x: iv.left });
        }
      } else {
        emitOpenSample(iv.left, iv.right);
      }
    } else {
      if (iv.left === null || compareRational(iv.left, rootBounds[0]!.low) < 0) {
        emitOpenSample(iv.left, rootBounds[0]!.low);
      }
      for (let i = 0; i + 1 < rootBounds.length; i++) {
        const rightPrev = rootBounds[i]!.high;
        const leftNext = rootBounds[i + 1]!.low;
        if (equalRational(rightPrev, leftNext)) {
          if (!parsedDomain.excluded.some((e) => equalRational(e, rightPrev)) && polynomialEvaluate(master, rightPrev).n !== 0n) {
            sites.push({ kind: "rational", x: rightPrev });
          }
        } else {
          emitOpenSample(rightPrev, leftNext);
        }
      }
      const lastHigh = rootBounds[rootBounds.length - 1]!.high;
      if (iv.right === null || compareRational(lastHigh, iv.right) < 0) {
        emitOpenSample(lastHigh, iv.right);
      }
    }

    for (const n of [-3, -2, -1, 0, 1, 2, 3]) {
      const q = rational(BigInt(n));
      if (
        pointInInterval(q, iv) &&
        !parsedDomain.excluded.some((e) => equalRational(e, q)) &&
        !sites.some((s) => s.kind === "rational" && equalRational(s.x, q))
      ) {
        sites.push({ kind: "rational", x: q });
      }
    }
  }
  return sites;
}

function evaluateExactRationalExt(
  expr: ScalarExpr,
  x: SpanRational,
  variable: string,
): { status: "value"; value: SpanRational } | { status: "undefined_domain"; reason: string } | { status: "unsupported"; reason: string } {
  switch (expr.kind) {
    case "const": {
      const v = toRational(expr.value);
      return v ? { status: "value", value: v } : { status: "unsupported", reason: "non_rational_constant" };
    }
    case "variable":
      return expr.name === variable ? { status: "value", value: x } : { status: "unsupported", reason: "foreign_variable" };
    case "neg": {
      const inner = evaluateExactRationalExt(expr.value, x, variable);
      return inner.status === "value" ? { status: "value", value: rational(-inner.value.n, inner.value.d) } : inner;
    }
    case "abs": {
      const inner = evaluateExactRationalExt(expr.value, x, variable);
      return inner.status === "value"
        ? { status: "value", value: inner.value.n < 0n ? rational(-inner.value.n, inner.value.d) : inner.value }
        : inner;
    }
    case "sqrt": {
      const inner = evaluateExactRationalExt(expr.value, x, variable);
      if (inner.status !== "value") return inner;
      if (inner.value.n < 0n) return { status: "undefined_domain", reason: "even_root_domain" };
      const n = integerSquareRoot(inner.value.n);
      const d = integerSquareRoot(inner.value.d);
      return n !== null && d !== null ? { status: "value", value: rational(n, d) } : { status: "unsupported", reason: "irrational_radical" };
    }
    case "ln": {
      const inner = evaluateExactRationalExt(expr.value, x, variable);
      if (inner.status !== "value") return inner;
      if (inner.value.n <= 0n) return { status: "undefined_domain", reason: "ln_domain" };
      return inner.value.n === 1n && inner.value.d === 1n ? { status: "value", value: rational(0n) } : { status: "unsupported", reason: "irrational_ln" };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const left = evaluateExactRationalExt(expr.left, x, variable);
      if (left.status !== "value") return left;
      const right = evaluateExactRationalExt(expr.right, x, variable);
      if (right.status !== "value") return right;
      if (expr.kind === "add") return { status: "value", value: addRational(left.value, right.value) };
      if (expr.kind === "sub") return { status: "value", value: subtractRational(left.value, right.value) };
      if (expr.kind === "mul") return { status: "value", value: multiplyRational(left.value, right.value) };
      return right.value.n === 0n
        ? { status: "undefined_domain", reason: "natural_domain_denominator_zero" }
        : { status: "value", value: divideRational(left.value, right.value) };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) {
        return { status: "unsupported", reason: "power_out_of_bounds" };
      }
      const base = evaluateExactRationalExt(expr.base, x, variable);
      if (base.status !== "value") return base;
      if (expr.exponent < 0 && base.value.n === 0n) return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
      let val = rational(1n);
      const step = expr.exponent >= 0 ? base.value : rational(base.value.d, base.value.n);
      for (let i = 0; i < Math.abs(expr.exponent); i++) val = multiplyRational(val, step);
      return { status: "value", value: val };
    }
    default:
      return { status: "unsupported", reason: `${expr.kind}_outside_exact_fragment` };
  }
}

type FloatEvalResult =
  | { status: "ok"; value: number; marginOk: boolean }
  | { status: "undefined_domain"; reason: string }
  | { status: "unstable" };

function evaluateFloatSafe(expr: ScalarExpr, x: number, variable: string): FloatEvalResult {
  const BOUND_EPS = 1e-9;
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (q) {
        const val = Number(q.n) / Number(q.d);
        return Number.isFinite(val) ? { status: "ok", value: val, marginOk: true } : { status: "unstable" };
      }
      const val = Number(expr.value);
      return Number.isFinite(val) ? { status: "ok", value: val, marginOk: true } : { status: "unstable" };
    }
    case "variable":
      return expr.name === variable ? { status: "ok", value: x, marginOk: true } : { status: "unstable" };
    case "neg": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      return inner.status === "ok" ? { status: "ok", value: -inner.value, marginOk: inner.marginOk } : inner;
    }
    case "abs": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      return inner.status === "ok"
        ? { status: "ok", value: Math.abs(inner.value), marginOk: inner.marginOk && Math.abs(inner.value) > BOUND_EPS }
        : inner;
    }
    case "sqrt": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      if (inner.status !== "ok") return inner;
      if (inner.value < -BOUND_EPS) return { status: "undefined_domain", reason: "even_root_domain" };
      if (inner.value < BOUND_EPS) return { status: "unstable" };
      return { status: "ok", value: Math.sqrt(inner.value), marginOk: inner.marginOk };
    }
    case "ln": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      if (inner.status !== "ok") return inner;
      if (inner.value <= -BOUND_EPS) return { status: "undefined_domain", reason: "ln_domain" };
      if (inner.value <= BOUND_EPS) return { status: "unstable" };
      return { status: "ok", value: Math.log(inner.value), marginOk: inner.marginOk };
    }
    case "sin": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      return inner.status === "ok" ? { status: "ok", value: Math.sin(inner.value), marginOk: inner.marginOk } : inner;
    }
    case "cos": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      return inner.status === "ok" ? { status: "ok", value: Math.cos(inner.value), marginOk: inner.marginOk } : inner;
    }
    case "exp": {
      const inner = evaluateFloatSafe(expr.value, x, variable);
      if (inner.status !== "ok") return inner;
      if (inner.value > 50) return { status: "unstable" };
      return { status: "ok", value: Math.exp(inner.value), marginOk: inner.marginOk };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const l = evaluateFloatSafe(expr.left, x, variable);
      if (l.status !== "ok") return l;
      const r = evaluateFloatSafe(expr.right, x, variable);
      if (r.status !== "ok") return r;
      if (expr.kind === "div") {
        if (Math.abs(r.value) <= BOUND_EPS) return { status: "unstable" };
        const val = l.value / r.value;
        return Number.isFinite(val) && Math.abs(val) < 1e10
          ? { status: "ok", value: val, marginOk: l.marginOk && r.marginOk }
          : { status: "unstable" };
      }
      const val = expr.kind === "add" ? l.value + r.value : expr.kind === "sub" ? l.value - r.value : l.value * r.value;
      return Number.isFinite(val) && Math.abs(val) < 1e10
        ? { status: "ok", value: val, marginOk: l.marginOk && r.marginOk }
        : { status: "unstable" };
    }
    case "pow": {
      const b = evaluateFloatSafe(expr.base, x, variable);
      if (b.status !== "ok") return b;
      if (expr.exponent < 0 && Math.abs(b.value) <= BOUND_EPS) return { status: "unstable" };
      const val = b.value ** expr.exponent;
      return Number.isFinite(val) && Math.abs(val) < 1e10 ? { status: "ok", value: val, marginOk: b.marginOk } : { status: "unstable" };
    }
  }
}

// Multivariate polynomials over canonical algebraic atoms for symbolic identity checking.
type MPoly = Map<string, SpanRational>; // key: sorted "atom^exp*..." or "" for 1

function parseMonomialKey(key: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!key) return out;
  for (const part of key.split("\u0001")) {
    const idx = part.lastIndexOf("^");
    const atom = part.slice(0, idx);
    const exp = Number(part.slice(idx + 1));
    if (exp > 0) out.set(atom, exp);
  }
  return out;
}

function formatMonomialKey(powers: Map<string, number>): string {
  const entries = [...powers.entries()].filter(([, e]) => e > 0).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([a, e]) => `${a}^${e}`).join("\u0001");
}

function mpolyAdd(a: MPoly, b: MPoly, sign: 1 | -1 = 1): MPoly {
  const out = new Map(a);
  for (const [k, v] of b) {
    const next = sign === 1 ? addRational(out.get(k) ?? rational(0n), v) : subtractRational(out.get(k) ?? rational(0n), v);
    if (next.n === 0n) out.delete(k);
    else out.set(k, next);
  }
  return out;
}

function mpolyConst(q: SpanRational): MPoly {
  return q.n === 0n ? new Map() : new Map([["", q]]);
}

function mpolyAtom(atom: string): MPoly {
  return new Map([[`${atom}^1`, rational(1n)]]);
}

function mpolyIsConst(p: MPoly): SpanRational | null {
  if (p.size === 0) return rational(0n);
  if (p.size === 1 && p.has("")) return p.get("")!;
  return null;
}

function formatMPolyKey(p: MPoly): string {
  return [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${formatRational(v)}*${k || "1"}`)
    .join("+");
}

function mpolyScale(p: MPoly, q: SpanRational): MPoly {
  if (q.n === 0n || p.size === 0) return new Map();
  const out = new Map<string, SpanRational>();
  for (const [k, v] of p) {
    const next = multiplyRational(v, q);
    if (next.n !== 0n) out.set(k, next);
  }
  return out;
}

type RingAtomRegistry = {
  sqrtDefs: Map<string, MPoly>; // atom "sqrt(...)" -> inner MPoly
  absDefs: Map<string, MPoly>;  // atom "abs(...)" -> inner MPoly (for abs^2 = inner^2)
  sinPairs: Map<string, string>; // "sin(u)" -> "cos(u)"
  expExps: Map<string, MPoly>;  // "exp(u)" -> u MPoly
};

function mpolyMultiply(a: MPoly, b: MPoly, reg: RingAtomRegistry): MPoly {
  let acc: MPoly = new Map();
  for (const [ka, ca] of a) {
    const pa = parseMonomialKey(ka);
    for (const [kb, cb] of b) {
      const pb = parseMonomialKey(kb);
      const combined = new Map(pa);
      for (const [atom, exp] of pb) combined.set(atom, (combined.get(atom) ?? 0) + exp);
      let term = new Map<string, SpanRational>([["", multiplyRational(ca, cb)]]);
      const extraFactors: MPoly[] = [];
      const remPowers = new Map<string, number>();
      let expExponentSum: MPoly | null = null;
      for (const [atom, exp] of combined) {
        if (reg.expExps.has(atom)) {
          const inner = reg.expExps.get(atom)!;
          const scaled = mpolyScale(inner, rational(BigInt(exp)));
          expExponentSum = expExponentSum ? mpolyAdd(expExponentSum, scaled, 1) : scaled;
          continue;
        }
        if (reg.sqrtDefs.has(atom) && exp >= 2) {
          const pairs = Math.floor(exp / 2);
          const rem = exp % 2;
          if (rem > 0) remPowers.set(atom, rem);
          const sqVal = reg.sqrtDefs.get(atom)!;
          for (let i = 0; i < pairs; i++) extraFactors.push(sqVal);
          continue;
        }
        if (reg.absDefs.has(atom) && exp >= 2) {
          const pairs = Math.floor(exp / 2);
          const rem = exp % 2;
          if (rem > 0) remPowers.set(atom, rem);
          const inner = reg.absDefs.get(atom)!;
          const innerSq = mpolyMultiply(inner, inner, reg);
          for (let i = 0; i < pairs; i++) extraFactors.push(innerSq);
          continue;
        }
        if (reg.sinPairs.has(atom) && exp >= 2) {
          const cosAtom = reg.sinPairs.get(atom)!;
          const pairs = Math.floor(exp / 2);
          const rem = exp % 2;
          if (rem > 0) remPowers.set(atom, rem);
          const oneMinusCos2 = mpolyAdd(
            mpolyConst(rational(1n)),
            new Map([[`${cosAtom}^2`, rational(1n)]]),
            -1,
          );
          for (let i = 0; i < pairs; i++) extraFactors.push(oneMinusCos2);
          continue;
        }
        remPowers.set(atom, exp);
      }
      if (expExponentSum !== null) {
        if (expExponentSum.size > 0) {
          const expKey = `exp(${formatMPolyKey(expExponentSum)})`;
          reg.expExps.set(expKey, expExponentSum);
          remPowers.set(expKey, 1);
        }
      }
      term = new Map([[formatMonomialKey(remPowers), multiplyRational(ca, cb)]]);
      for (const factor of extraFactors) term = mpolyMultiply(term, factor, reg);
      acc = mpolyAdd(acc, term, 1);
      if (acc.size > 512) return acc;
    }
  }
  return acc;
}

function mpolyFromUnivariate(poly: Polynomial, varAtom: string): MPoly {
  const out: MPoly = new Map();
  for (const [deg, coeff] of poly) {
    out.set(deg === 0 ? "" : `${varAtom}^${deg}`, coeff);
  }
  return out;
}

function factorSquarePolynomial(poly: Polynomial): { square: Polynomial; squareFree: Polynomial } {
  let sq = polynomialConstant(rational(1n));
  let rem = new Map(poly);
  let guard = 0;
  while (guard++ < 12 && polynomialDegree(rem) >= 2) {
    const g = polynomialGcd(rem, polynomialDerivative(rem));
    if (polynomialDegree(g) <= 0) break;
    const g2 = polynomialMultiply(g, g);
    if (polynomialDegree(g2) <= polynomialDegree(rem)) {
      const div1 = polynomialDivMod(rem, g);
      if (div1.remainder.size === 0) {
        const div2 = polynomialDivMod(div1.quotient, g);
        if (div2.remainder.size === 0) {
          sq = polynomialMultiply(sq, g);
          rem = div2.quotient;
          continue;
        }
      }
    }
    // Extract one factor at a time from gcd(rem, g)
    const unit = polynomialGcd(g, polynomialDivMod(rem, g).quotient);
    const sqFactor = polynomialDegree(unit) > 0 ? polynomialDivMod(g, unit).quotient : g;
    const factor = polynomialDegree(sqFactor) > 0 ? sqFactor : g;
    const check1 = polynomialDivMod(rem, factor);
    if (check1.remainder.size !== 0) break;
    const check2 = polynomialDivMod(check1.quotient, factor);
    if (check2.remainder.size !== 0) break;
    sq = polynomialMultiply(sq, factor);
    rem = check2.quotient;
  }
  return { square: sq, squareFree: rem };
}

type RingRational = { num: MPoly; den: MPoly };

function ringNormalizeRational(
  expr: ScalarExpr,
  variable: string,
  validSites: readonly SampleSite[],
  reg: RingAtomRegistry,
): RingRational | null {
  const checkPolySign = (poly: Polynomial): "nonneg" | "nonpos" | "pos" | "neg" | "mixed" => {
    let hasPos = false;
    let hasNeg = false;
    let hasZero = false;
    for (const site of validSites) {
      const s = signAtSampleSite(poly, site);
      if (s > 0) hasPos = true;
      else if (s < 0) hasNeg = true;
      else hasZero = true;
    }
    if (hasPos && hasNeg) return "mixed";
    if (!hasNeg && !hasZero && hasPos) return "pos";
    if (!hasPos && !hasZero && hasNeg) return "neg";
    if (!hasNeg) return "nonneg";
    if (!hasPos) return "nonpos";
    return "mixed";
  };

  const absPolyRing = (poly: Polynomial): MPoly => {
    const sign = checkPolySign(poly);
    if (sign === "pos" || sign === "nonneg") return mpolyFromUnivariate(poly, variable);
    if (sign === "neg" || sign === "nonpos") return mpolyFromUnivariate(polynomialScale(poly, rational(-1n)), variable);
    const prim = polynomialPrimitivePositive(poly);
    const lead = polynomialLeadCoeff(prim);
    const canonical = lead.n < 0n ? polynomialScale(prim, rational(-1n)) : prim;
    const ratio = divideRational(polynomialLeadCoeff(poly), polynomialLeadCoeff(canonical));
    const absRatio = rational(bigAbs(ratio.n), ratio.d);
    const canonicalMPoly = mpolyFromUnivariate(canonical, variable);
    const atomKey = `abs(${formatMPolyKey(canonicalMPoly)})`;
    reg.absDefs.set(atomKey, canonicalMPoly);
    return mpolyScale(mpolyAtom(atomKey), absRatio);
  };

  const buildSqrtOfPoly = (poly: Polynomial): MPoly => {
    if (poly.size === 0) return new Map();
    if (polynomialDegree(poly) === 0) {
      const q = poly.get(0)!;
      if (q.n < 0n) return mpolyAtom("invalid_sqrt");
      const { square, rest } = extractSquareFree(q.n * q.d);
      const coeff = rational(square, q.d);
      if (rest === 1n) return mpolyConst(coeff);
      const radKey = `sqrt(${rest})`;
      reg.sqrtDefs.set(radKey, mpolyConst(rational(rest)));
      return mpolyScale(mpolyAtom(radKey), coeff);
    }
    const { square, squareFree } = factorSquarePolynomial(poly);
    let outNum = polynomialDegree(square) >= 1 ? absPolyRing(square) : mpolyConst(rational(1n));
    const prim = polynomialPrimitivePositive(squareFree);
    const leadRatio = divideRational(polynomialLeadCoeff(squareFree), polynomialLeadCoeff(prim));
    if (leadRatio.n < 0n) return mpolyAtom("invalid_sqrt");
    const { square: cSq, rest: cRest } = extractSquareFree(leadRatio.n * leadRatio.d);
    const scalarCoeff = rational(cSq, leadRatio.d);
    outNum = mpolyScale(outNum, scalarCoeff);
    if (cRest > 1n) {
      const cKey = `sqrt(${cRest})`;
      reg.sqrtDefs.set(cKey, mpolyConst(rational(cRest)));
      outNum = mpolyMultiply(outNum, mpolyAtom(cKey), reg);
    }
    if (polynomialDegree(prim) >= 1) {
      const primMPoly = mpolyFromUnivariate(prim, variable);
      const rKey = `sqrt(${formatMPolyKey(primMPoly)})`;
      reg.sqrtDefs.set(rKey, primMPoly);
      outNum = mpolyMultiply(outNum, mpolyAtom(rKey), reg);
    }
    return outNum;
  };

  const convert = (node: ScalarExpr): RingRational | null => {
    switch (node.kind) {
      case "const": {
        const q = toRational(node.value);
        return q ? { num: mpolyConst(q), den: mpolyConst(rational(1n)) } : null;
      }
      case "variable":
        return { num: mpolyAtom(node.name), den: mpolyConst(rational(1n)) };
      case "neg": {
        const inner = convert(node.value);
        return inner ? { num: mpolyScale(inner.num, rational(-1n)), den: inner.den } : null;
      }
      case "add":
      case "sub": {
        const l = convert(node.left);
        const r = convert(node.right);
        if (!l || !r) return null;
        return {
          num: mpolyAdd(mpolyMultiply(l.num, r.den, reg), mpolyMultiply(r.num, l.den, reg), node.kind === "add" ? 1 : -1),
          den: mpolyMultiply(l.den, r.den, reg),
        };
      }
      case "mul": {
        const l = convert(node.left);
        const r = convert(node.right);
        if (!l || !r) return null;
        return {
          num: mpolyMultiply(l.num, r.num, reg),
          den: mpolyMultiply(l.den, r.den, reg),
        };
      }
      case "div": {
        const l = convert(node.left);
        const r = convert(node.right);
        if (!l || !r || r.num.size === 0) return null;
        return {
          num: mpolyMultiply(l.num, r.den, reg),
          den: mpolyMultiply(l.den, r.num, reg),
        };
      }
      case "pow": {
        if (!Number.isInteger(node.exponent) || Math.abs(node.exponent) > 12) return null;
        const b = convert(node.base);
        if (!b) return null;
        if (node.exponent === 0) return { num: mpolyConst(rational(1n)), den: mpolyConst(rational(1n)) };
        if (node.exponent < 0 && b.num.size === 0) return null;
        let num = mpolyConst(rational(1n));
        let den = mpolyConst(rational(1n));
        const stepNum = node.exponent >= 0 ? b.num : b.den;
        const stepDen = node.exponent >= 0 ? b.den : b.num;
        for (let i = 0; i < Math.abs(node.exponent); i++) {
          num = mpolyMultiply(num, stepNum, reg);
          den = mpolyMultiply(den, stepDen, reg);
        }
        return { num, den };
      }
      case "abs": {
        const rf = rationalForm(node.value, variable);
        if (!rf.unsupported && rf.denominator.size > 0) {
          return { num: absPolyRing(rf.numerator), den: absPolyRing(rf.denominator) };
        }
        const inner = convert(node.value);
        if (!inner) return null;
        const c = mpolyIsConst(inner.num);
        const d = mpolyIsConst(inner.den);
        if (c && d && d.n !== 0n) {
          const q = divideRational(c, d);
          return { num: mpolyConst(rational(bigAbs(q.n), q.d)), den: mpolyConst(rational(1n)) };
        }
        if (inner.den.size === 1 && inner.den.has("")) {
          const key = `abs(${formatMPolyKey(inner.num)})`;
          reg.absDefs.set(key, inner.num);
          return { num: mpolyAtom(key), den: mpolyConst(rational(bigAbs(inner.den.get("")!.n), inner.den.get("")!.d)) };
        }
        return null;
      }
      case "sqrt": {
        const rf = rationalForm(node.value, variable);
        if (!rf.unsupported && rf.denominator.size > 0) {
          const prod = polynomialMultiply(rf.numerator, rf.denominator);
          return { num: buildSqrtOfPoly(prod), den: absPolyRing(rf.denominator) };
        }
        const inner = convert(node.value);
        if (!inner) return null;
        if (inner.num.size === 0) return { num: new Map(), den: mpolyConst(rational(1n)) };
        if (inner.den.size === 1 && inner.den.has("")) {
          const dVal = inner.den.get("")!;
          const scaled = mpolyScale(inner.num, dVal);
          const key = `sqrt(${formatMPolyKey(scaled)})`;
          reg.sqrtDefs.set(key, scaled);
          const { square: dSq, rest: dRest } = extractSquareFree(bigAbs(dVal.n) * dVal.d);
          if (dRest === 1n) {
            return { num: mpolyAtom(key), den: mpolyConst(rational(dSq, dVal.d)) };
          }
          return { num: mpolyAtom(key), den: buildSqrtOfPoly(polynomialConstant(dVal)) };
        }
        return null;
      }
      case "ln": {
        if (node.value.kind === "exp") return convert(node.value.value);
        const rf = rationalForm(node.value, variable);
        if (!rf.unsupported && rf.denominator.size > 0) {
          const numDeg = polynomialDegree(rf.numerator);
          const denDeg = polynomialDegree(rf.denominator);
          if (numDeg === 0 && denDeg === 0) {
            const q = divideRational(rf.numerator.get(0)!, rf.denominator.get(0)!);
            if (q.n === 1n && q.d === 1n) return { num: new Map(), den: mpolyConst(rational(1n)) };
          }
          // Simplify ln(x^k) when k >= 2 and base has constant sign on valid domain
          if (denDeg === 0 && numDeg >= 2 && rf.numerator.size === 1 && rf.numerator.has(numDeg)) {
            const coeff = divideRational(rf.numerator.get(numDeg)!, rf.denominator.get(0)!);
            if (coeff.n === 1n && coeff.d === 1n) {
              const varSign = checkPolySign(polynomialVariable());
              if (varSign === "pos") {
                return {
                  num: mpolyScale(mpolyAtom(`ln(${formatMPolyKey(mpolyAtom(variable))})`), rational(BigInt(numDeg))),
                  den: mpolyConst(rational(1n)),
                };
              }
              if (numDeg % 2 === 0) {
                const absX = absPolyRing(polynomialVariable());
                return {
                  num: mpolyScale(mpolyAtom(`ln(${formatMPolyKey(absX)})`), rational(BigInt(numDeg))),
                  den: mpolyConst(rational(1n)),
                };
              }
            }
          }
        }
        const inner = convert(node.value);
        if (!inner) return null;
        if (inner.den.size === 1 && inner.den.has("") && inner.den.get("")!.n === 1n && inner.den.get("")!.d === 1n) {
          if (inner.num.size === 1 && inner.num.has("") && inner.num.get("")!.n === 1n && inner.num.get("")!.d === 1n) {
            return { num: new Map(), den: mpolyConst(rational(1n)) };
          }
          return { num: mpolyAtom(`ln(${formatMPolyKey(inner.num)})`), den: mpolyConst(rational(1n)) };
        }
        return { num: mpolyAtom(`ln((${formatMPolyKey(inner.num)})/(${formatMPolyKey(inner.den)}))`), den: mpolyConst(rational(1n)) };
      }
      case "exp": {
        if (node.value.kind === "ln") return convert(node.value.value);
        const inner = convert(node.value);
        if (!inner) return null;
        if (inner.num.size === 0) return { num: mpolyConst(rational(1n)), den: mpolyConst(rational(1n)) };
        const keyStr =
          inner.den.size === 1 && inner.den.has("") && inner.den.get("")!.n === 1n && inner.den.get("")!.d === 1n
            ? formatMPolyKey(inner.num)
            : `(${formatMPolyKey(inner.num)})/(${formatMPolyKey(inner.den)})`;
        const atomKey = `exp(${keyStr})`;
        if (inner.den.size === 1 && inner.den.has("") && inner.den.get("")!.n === 1n && inner.den.get("")!.d === 1n) {
          reg.expExps.set(atomKey, inner.num);
        }
        return { num: mpolyAtom(atomKey), den: mpolyConst(rational(1n)) };
      }
      case "sin":
      case "cos": {
        const inner = convert(node.value);
        if (!inner) return null;
        const innerKey =
          inner.den.size === 1 && inner.den.has("") && inner.den.get("")!.n === 1n && inner.den.get("")!.d === 1n
            ? formatMPolyKey(inner.num)
            : `(${formatMPolyKey(inner.num)})/(${formatMPolyKey(inner.den)})`;
        const sinKey = `sin(${innerKey})`;
        const cosKey = `cos(${innerKey})`;
        reg.sinPairs.set(sinKey, cosKey);
        return { num: mpolyAtom(node.kind === "sin" ? sinKey : cosKey), den: mpolyConst(rational(1n)) };
      }
    }
  };

  return convert(expr);
}

function collectVariables(expr: ScalarExpr, out = new Set<string>()): Set<string> {
  switch (expr.kind) {
    case "const":
      return out;
    case "variable":
      out.add(expr.name);
      return out;
    case "neg":
    case "sqrt":
    case "abs":
    case "ln":
    case "sin":
    case "cos":
    case "exp":
      return collectVariables(expr.value, out);
    case "add":
    case "sub":
    case "mul":
    case "div":
      collectVariables(expr.left, out);
      return collectVariables(expr.right, out);
    case "pow":
      return collectVariables(expr.base, out);
  }
}

function hasTranscendental(expr: ScalarExpr): boolean {
  switch (expr.kind) {
    case "const":
    case "variable":
      return false;
    case "ln":
    case "sin":
    case "cos":
    case "exp":
      return true;
    case "neg":
    case "sqrt":
    case "abs":
      return hasTranscendental(expr.value);
    case "add":
    case "sub":
    case "mul":
    case "div":
      return hasTranscendental(expr.left) || hasTranscendental(expr.right);
    case "pow":
      return hasTranscendental(expr.base);
  }
}

export function verifyScalarEquivalence(
  studentInput: ScalarExpr | string,
  referenceInput: ScalarExpr | string,
  domain?: DomainSpec,
): VerificationResult {
  const student = parseScalarExpr(studentInput);
  const reference = parseScalarExpr(referenceInput);
  if (!student || !reference) return { status: "unverified", reason: "parse_outside_decidable_fragment", domain };

  const variable = domain?.variable ?? "x";
  const vars = new Set([...collectVariables(student), ...collectVariables(reference)]);
  for (const v of vars) {
    if (v !== variable) return { status: "unverified", reason: "foreign_variable", domain };
  }

  const parsedDomain = parseDomainSpec(domain);
  if (!parsedDomain) return { status: "unverified", reason: "invalid_domain", domain };
  if (parsedDomain.empty) return { status: "unverified", reason: "empty_domain", domain };

  // Constant expressions (no variables)
  if (vars.size === 0) {
    const sRad = evaluateRadicalConst(student);
    const rRad = evaluateRadicalConst(reference);
    if (sRad.ok && rRad.ok) {
      const diff = radicalAdd(sRad.value, rRad.value, -1);
      return diff.size === 0
        ? { status: "equivalent", reason: "exact_radical_constant_identity", domain }
        : { status: "inequivalent", reason: "exact_radical_counterexample", witness: { input: "const", detail: "constant radical values differ" }, domain };
    }
    if (!sRad.ok && !sRad.defined && rRad.ok) {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "student undefined" }, domain };
    }
    if (!rRad.ok && !rRad.defined && sRad.ok) {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "reference undefined" }, domain };
    }
    const sfFloat = evaluateFloatSafe(student, 0, variable);
    const rfFloat = evaluateFloatSafe(reference, 0, variable);
    if (sfFloat.status === "undefined_domain" && rfFloat.status === "ok") {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "student undefined" }, domain };
    }
    if (rfFloat.status === "undefined_domain" && sfFloat.status === "ok") {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "reference undefined" }, domain };
    }
    if (sfFloat.status === "ok" && rfFloat.status === "ok" && sfFloat.marginOk && rfFloat.marginOk) {
      const tol = 1e-6 * Math.max(1, Math.abs(sfFloat.value), Math.abs(rfFloat.value));
      if (Math.abs(sfFloat.value - rfFloat.value) > tol) {
        return { status: "inequivalent", reason: "numeric_counterexample", witness: { input: "const", detail: "constant values differ" }, domain };
      }
    }
    const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
    const sn = ringNormalizeRational(student, variable, [], reg);
    const rn = ringNormalizeRational(reference, variable, [], reg);
    if (sn && rn) {
      const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
      if (diff.size === 0) return { status: "equivalent", reason: "canonical_symbolic_identity", domain };
    }
    return { status: "unverified", reason: "constant_outside_exact_fragment", domain };
  }

  const sf = rationalForm(student, variable);
  const rf = rationalForm(reference, variable);
  const sConstraints = collectConstraints(student, variable);
  const rConstraints = collectConstraints(reference, variable);

  if (sConstraints.alwaysUndefined !== rConstraints.alwaysUndefined) {
    return {
      status: "inequivalent",
      reason: "natural_domain_mismatch",
      witness: { input: variable, detail: sConstraints.alwaysUndefined ? "student undefined" : "reference undefined" },
      domain,
    };
  }
  if (sConstraints.alwaysUndefined && rConstraints.alwaysUndefined) {
    return { status: "unverified", reason: "empty_natural_domain", domain };
  }

  // Pure rational fragment: exact GCD + Sturm denominator set check + exact polynomial residual
  if (!sf.unsupported && !rf.unsupported) {
    const denDiff = checkDenominatorSetsEquivalent(
      sf.domainDenominators,
      rf.domainDenominators,
      parsedDomain.intervals,
      parsedDomain.excluded,
    );
    if (!denDiff.equal) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: denDiff.witness,
        domain,
      };
    }

    const combinedDen = polynomialMultiply(sf.denominator, rf.denominator);
    const residual = polynomialAdd(
      polynomialMultiply(sf.numerator, rf.denominator),
      polynomialMultiply(rf.numerator, sf.denominator),
      -1,
    );
    const sites = buildCadSampleSites(
      [...sConstraints.rational, ...rConstraints.rational],
      parsedDomain,
    );
    const validRationalPoints = sites
      .filter((s): s is { kind: "rational"; x: SpanRational } => s.kind === "rational")
      .map((s) => s.x)
      .filter((x) => polynomialEvaluate(combinedDen, x).n !== 0n);

    if (residual.size === 0) {
      if (validRationalPoints.length === 0) {
        return { status: "unverified", reason: "empty_natural_domain", domain };
      }
      return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
    }

    for (const x of validRationalPoints) {
      if (polynomialEvaluate(residual, x).n !== 0n) {
        return {
          status: "inequivalent",
          reason: "residual_nonzero",
          witness: { input: formatRational(x), detail: "exact residual is non-zero" },
          domain,
        };
      }
    }

    // Residual is nonzero as polynomial: check if an open interval exists to guarantee finding a non-root
    const deg = polynomialDegree(residual);
    for (const iv of parsedDomain.intervals) {
      if (iv.left && iv.right && equalRational(iv.left, iv.right)) continue;
      let probe = pickRationalBetween(iv.left, iv.right);
      for (let i = 0; i <= deg + 4; i++) {
        if (
          pointInInterval(probe, iv) &&
          !parsedDomain.excluded.some((e) => equalRational(e, probe)) &&
          polynomialEvaluate(combinedDen, probe).n !== 0n &&
          polynomialEvaluate(residual, probe).n !== 0n
        ) {
          return {
            status: "inequivalent",
            reason: "residual_nonzero",
            witness: { input: formatRational(probe), detail: "exact residual is non-zero" },
            domain,
          };
        }
        probe = iv.right !== null ? divideRational(addRational(probe, iv.right), rational(2n)) : addRational(probe, rational(1n));
      }
    }
    return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
  }

  // Extended fragment (radicals, abs, ln, sin, cos, exp): 1D CAD domain verification first
  const allRationalConstraints = [...sConstraints.rational, ...rConstraints.rational];
  const sites = buildCadSampleSites(allRationalConstraints, parsedDomain);
  const validSites: SampleSite[] = [];
  for (const site of sites) {
    const sOk = constraintsSatisfiedAtSite(sConstraints.rational, site);
    const rOk = constraintsSatisfiedAtSite(rConstraints.rational, site);
    if (sOk !== rOk) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: formatSampleSite(site), detail: sOk ? "reference undefined" : "student undefined" },
        domain,
      };
    }
    if (sOk && rOk) validSites.push(site);
  }

  if (validSites.length === 0) {
    return { status: "unverified", reason: "empty_natural_domain", domain };
  }

  // Exact rational evaluation on valid rational sites (handles sqrt/abs/ln(1) counterexamples cleanly)
  const validRationalSamples = validSites
    .filter((s): s is { kind: "rational"; x: SpanRational } => s.kind === "rational")
    .map((s) => s.x);

  for (const x of validRationalSamples) {
    const sVal = evaluateExactRationalExt(student, x, variable);
    const rVal = evaluateExactRationalExt(reference, x, variable);
    if (
      (sVal.status === "undefined_domain" && rVal.status !== "undefined_domain") ||
      (rVal.status === "undefined_domain" && sVal.status !== "undefined_domain")
    ) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: formatRational(x), detail: sVal.status === "undefined_domain" ? "student undefined" : "reference undefined" },
        domain,
      };
    }
    if (sVal.status === "value" && rVal.status === "value" && !equalRational(sVal.value, rVal.value)) {
      return {
        status: "inequivalent",
        reason: "exact_radical_counterexample",
        witness: { input: formatRational(x), detail: "exact values differ" },
        domain,
      };
    }
  }

  // Numeric domain & clear counterexample check across non-singular sample points inside domain
  const floatCandidates: number[] = [];
  for (const x of validRationalSamples) {
    const fx = Number(x.n) / Number(x.d);
    if (Number.isFinite(fx)) floatCandidates.push(fx);
  }
  for (const offset of [-3.1, -2.3, -1.7, -0.7, -0.3, 0.3, 0.7, 1.3, 2.3, 3.1]) {
    const q = toRational(String(offset));
    if (q && domainAllows(domain, q)) {
      const site: SampleSite = { kind: "rational", x: q };
      if (constraintsSatisfiedAtSite(allRationalConstraints, site)) floatCandidates.push(offset);
    }
  }

  for (const fx of floatCandidates) {
    const sfRes = evaluateFloatSafe(student, fx, variable);
    const rfRes = evaluateFloatSafe(reference, fx, variable);
    if (
      (sfRes.status === "undefined_domain" && rfRes.status === "ok") ||
      (rfRes.status === "undefined_domain" && sfRes.status === "ok")
    ) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: String(fx), detail: sfRes.status === "undefined_domain" ? "student undefined" : "reference undefined" },
        domain,
      };
    }
    if (sfRes.status === "ok" && rfRes.status === "ok" && sfRes.marginOk && rfRes.marginOk) {
      const tol = 1e-6 * Math.max(1, Math.abs(sfRes.value), Math.abs(rfRes.value));
      if (Math.abs(sfRes.value - rfRes.value) > tol) {
        return {
          status: "inequivalent",
          reason: "numeric_counterexample",
          witness: { input: String(fx), detail: "evaluated values differ" },
          domain,
        };
      }
    }
  }

  // Symbolic / algebraic ring equivalence over atoms (only when domains matched and non-empty)
  if (!sConstraints.hasNonRationalDomainOps && !rConstraints.hasNonRationalDomainOps) {
    const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
    const sn = ringNormalizeRational(student, variable, validSites, reg);
    const rn = ringNormalizeRational(reference, variable, validSites, reg);
    if (sn && rn) {
      const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
      if (diff.size === 0) {
        return {
          status: "equivalent",
          reason: hasTranscendental(student) || hasTranscendental(reference) ? "canonical_symbolic_identity" : "canonical_radical_identity",
          domain,
        };
      }
    }
  } else {
    const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
    const sn = ringNormalizeRational(student, variable, validSites, reg);
    const rn = ringNormalizeRational(reference, variable, validSites, reg);
    if (sn && rn) {
      const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
      if (diff.size === 0) {
        return { status: "equivalent", reason: "canonical_symbolic_identity", domain };
      }
    }
  }

  return { status: "unverified", reason: sf.unsupported ?? rf.unsupported ?? "symbolic_equivalence_unverified", domain };
}

function squareFreeProduct(polys: readonly Polynomial[]): Polynomial {
  let acc = polynomialConstant(rational(1n));
  for (const p of polys) {
    if (polynomialDegree(p) < 1) continue;
    const sf = polynomialSquareFree(p);
    const g = polynomialGcd(acc, sf);
    const factor = polynomialDegree(g) >= 1 ? polynomialDivMod(sf, g).quotient : sf;
    if (polynomialDegree(factor) >= 1) acc = polynomialPrimitivePositive(polynomialMultiply(acc, factor));
  }
  return acc;
}

function checkDenominatorSetsEquivalent(
  studentDens: readonly Polynomial[],
  referenceDens: readonly Polynomial[],
  intervals: readonly NormalizedInterval[],
  excluded: readonly SpanRational[],
): { equal: true } | { equal: false; witness: { input: string; detail: string } } {
  const sUnion = squareFreeProduct(studentDens);
  const rUnion = squareFreeProduct(referenceDens);
  const common = polynomialGcd(sUnion, rUnion);
  let sOnly = polynomialDegree(common) >= 1 ? polynomialDivMod(sUnion, common).quotient : sUnion;
  let rOnly = polynomialDegree(common) >= 1 ? polynomialDivMod(rUnion, common).quotient : rUnion;

  for (const ex of excluded) {
    if (polynomialDegree(sOnly) >= 1 && polynomialEvaluate(sOnly, ex).n === 0n) {
      sOnly = polynomialDivMod(sOnly, linearFactor(ex)).quotient;
    }
    if (polynomialDegree(rOnly) >= 1 && polynomialEvaluate(rOnly, ex).n === 0n) {
      rOnly = polynomialDivMod(rOnly, linearFactor(ex)).quotient;
    }
  }

  for (const iv of intervals) {
    if (polynomialDegree(sOnly) >= 1 && sturmCount(sOnly, iv) > 0) {
      const roots = isolateRealRoots(sOnly, iv);
      const first = roots[0];
      const witnessInput = first ? (first.kind === "exact" ? formatRational(first.value) : `(${formatRational(first.low)}, ${formatRational(first.high)})`) : "domain";
      return { equal: false, witness: { input: witnessInput, detail: "student undefined" } };
    }
    if (polynomialDegree(rOnly) >= 1 && sturmCount(rOnly, iv) > 0) {
      const roots = isolateRealRoots(rOnly, iv);
      const first = roots[0];
      const witnessInput = first ? (first.kind === "exact" ? formatRational(first.value) : `(${formatRational(first.low)}, ${formatRational(first.high)})`) : "domain";
      return { equal: false, witness: { input: witnessInput, detail: "reference undefined" } };
    }
  }
  return { equal: true };
}

function intersectInterval(iv: NormalizedInterval, bound: NormalizedInterval): NormalizedInterval | null {
  let left = iv.left;
  let leftOpen = iv.leftOpen;
  if (bound.left !== null) {
    if (left === null) {
      left = bound.left;
      leftOpen = bound.leftOpen;
    } else {
      const cmp = compareRational(bound.left, left);
      if (cmp > 0) {
        left = bound.left;
        leftOpen = bound.leftOpen;
      } else if (cmp === 0) {
        leftOpen = leftOpen || bound.leftOpen;
      }
    }
  }
  let right = iv.right;
  let rightOpen = iv.rightOpen;
  if (bound.right !== null) {
    if (right === null) {
      right = bound.right;
      rightOpen = bound.rightOpen;
    } else {
      const cmp = compareRational(bound.right, right);
      if (cmp < 0) {
        right = bound.right;
        rightOpen = bound.rightOpen;
      } else if (cmp === 0) {
        rightOpen = rightOpen || bound.rightOpen;
      }
    }
  }
  if (left !== null && right !== null) {
    const cmp = compareRational(left, right);
    if (cmp > 0 || (cmp === 0 && (leftOpen || rightOpen))) return null;
  }
  return { left, right, leftOpen, rightOpen };
}

function domainWithIntervalBound(base: DomainSpec | undefined, variable: string, bound: NormalizedInterval): DomainSpec {
  const parsed = parseDomainSpec(base);
  const intervals = (parsed?.intervals ?? [{ left: null, right: null, leftOpen: true, rightOpen: true }])
    .map((iv) => intersectInterval(iv, bound))
    .filter((iv): iv is NormalizedInterval => iv !== null)
    .map((iv) => ({
      ...(iv.left !== null ? { left: formatRational(iv.left), leftOpen: iv.leftOpen } : {}),
      ...(iv.right !== null ? { right: formatRational(iv.right), rightOpen: iv.rightOpen } : {}),
    }));
  return {
    variable,
    excluded: base?.excluded,
    intervals: intervals.length > 0 ? intervals : [{ left: 1, right: 0 }],
  };
}

export type IntegralVerificationInput = {
  student: ScalarExpr | string;
  integrand: ScalarExpr | string;
  variable?: string;
  domain?: DomainSpec;
  piecewise?: PiecewiseExpr;
};

export function verifyIndefiniteIntegral(input: IntegralVerificationInput): VerificationResult {
  const student = parseScalarExpr(input.student);
  const integrand = parseScalarExpr(input.integrand);
  if (!student || !integrand) return { status: "unverified", reason: "parse_outside_decidable_fragment" };
  if (input.variable && input.domain?.variable && input.variable !== input.domain.variable) {
    return { status: "unverified", reason: "variable_mismatch", domain: input.domain };
  }
  const variable = input.variable ?? input.domain?.variable ?? "x";
  const effectiveDomain: DomainSpec = { ...input.domain, variable };

  if (input.piecewise) {
    const split = toRational(input.piecewise.split);
    const pwLeft = parseScalarExpr(input.piecewise.left);
    const pwRight = parseScalarExpr(input.piecewise.right);
    if (!split || !pwLeft || !pwRight) {
      return { status: "unverified", reason: "piecewise_outside_decidable_fragment", domain: effectiveDomain };
    }
    const dLeft = differentiate(pwLeft, variable);
    const dRight = differentiate(pwRight, variable);
    if (!dLeft || !dRight) {
      return { status: "unverified", reason: "derivative_outside_supported_fragment", domain: effectiveDomain };
    }
    const leftDomain = domainWithIntervalBound(effectiveDomain, variable, { left: null, right: split, leftOpen: true, rightOpen: true });
    const rightDomain = domainWithIntervalBound(effectiveDomain, variable, { left: split, right: null, leftOpen: true, rightOpen: true });

    const leftBranchMatch = verifyScalarEquivalence(student, pwLeft, leftDomain);
    if (leftBranchMatch.status !== "equivalent") return leftBranchMatch;
    const rightBranchMatch = verifyScalarEquivalence(student, pwRight, rightDomain);
    if (rightBranchMatch.status !== "equivalent") return rightBranchMatch;

    const leftDeriv = verifyScalarEquivalence(dLeft, integrand, leftDomain);
    if (leftDeriv.status !== "equivalent") return leftDeriv;
    const rightDeriv = verifyScalarEquivalence(dRight, integrand, rightDomain);
    if (rightDeriv.status !== "equivalent") return rightDeriv;

    if (domainAllows(effectiveDomain, split)) {
      const integrandAtSplit = evaluateExactRationalExt(integrand, split, variable);
      if (integrandAtSplit.status !== "undefined_domain") {
        const leftAtSplit = verifyScalarEquivalence(pwLeft, pwRight, {
          variable,
          intervals: [{ left: formatRational(split), right: formatRational(split) }],
        });
        if (leftAtSplit.status === "inequivalent") {
          return {
            status: "inequivalent",
            reason: "piecewise_antiderivative_discontinuous_at_split",
            witness: { input: formatRational(split), detail: "left and right branches disagree at split" },
            domain: effectiveDomain,
          };
        }
      }
    }
    return { status: "equivalent", reason: "piecewise_antiderivative_verified", domain: effectiveDomain };
  }

  const derivative = differentiate(student, variable);
  if (!derivative) return { status: "unverified", reason: "derivative_outside_supported_fragment", domain: effectiveDomain };
  const derivCheck = verifyScalarEquivalence(derivative, integrand, effectiveDomain);
  if (derivCheck.status !== "equivalent") return derivCheck;

  // An antiderivative must remain defined wherever the integrand is defined on the target domain.
  const parsedDomain = parseDomainSpec(effectiveDomain);
  if (parsedDomain && !parsedDomain.empty) {
    const sConstraints = collectConstraints(student, variable);
    const iConstraints = collectConstraints(integrand, variable);
    const sites = buildCadSampleSites([...sConstraints.rational, ...iConstraints.rational], parsedDomain);
    for (const site of sites) {
      if (constraintsSatisfiedAtSite(iConstraints.rational, site) && !constraintsSatisfiedAtSite(sConstraints.rational, site)) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatSampleSite(site), detail: "student antiderivative undefined on integrand domain" },
          domain: effectiveDomain,
        };
      }
    }
  }
  return derivCheck;
}

export function differentiate(expr: ScalarExpr, variable = "x"): ScalarExpr | null {
  switch (expr.kind) {
    case "const":
      return { kind: "const", value: 0 };
    case "variable":
      return { kind: "const", value: expr.name === variable ? 1 : 0 };
    case "neg": {
      const value = differentiate(expr.value, variable);
      return value ? { kind: "neg", value } : null;
    }
    case "add":
    case "sub": {
      const left = differentiate(expr.left, variable);
      const right = differentiate(expr.right, variable);
      return left && right ? { kind: expr.kind, left, right } : null;
    }
    case "mul": {
      const left = differentiate(expr.left, variable);
      const right = differentiate(expr.right, variable);
      return left && right
        ? {
            kind: "add",
            left: { kind: "mul", left, right: expr.right },
            right: { kind: "mul", left: expr.left, right },
          }
        : null;
    }
    case "div": {
      const left = differentiate(expr.left, variable);
      const right = differentiate(expr.right, variable);
      return left && right
        ? {
            kind: "div",
            left: {
              kind: "sub",
              left: { kind: "mul", left, right: expr.right },
              right: { kind: "mul", left: expr.left, right },
            },
            right: { kind: "pow", base: expr.right, exponent: 2 },
          }
        : null;
    }
    case "pow": {
      const du = differentiate(expr.base, variable);
      if (!du) return null;
      if (expr.exponent === 0) return { kind: "const", value: 0 };
      if (expr.exponent === 1) return du;
      const powerPart: ScalarExpr = {
        kind: "mul",
        left: { kind: "const", value: expr.exponent },
        right: { kind: "pow", base: expr.base, exponent: expr.exponent - 1 },
      };
      return { kind: "mul", left: powerPart, right: du };
    }
    case "sqrt": {
      const du = differentiate(expr.value, variable);
      if (!du) return null;
      return {
        kind: "div",
        left: du,
        right: { kind: "mul", left: { kind: "const", value: 2 }, right: { kind: "sqrt", value: expr.value } },
      };
    }
    case "ln": {
      const inner = expr.value.kind === "abs" ? expr.value.value : expr.value;
      const du = differentiate(inner, variable);
      if (!du) return null;
      return { kind: "div", left: du, right: inner };
    }
    case "sin": {
      const du = differentiate(expr.value, variable);
      return du ? { kind: "mul", left: { kind: "cos", value: expr.value }, right: du } : null;
    }
    case "cos": {
      const du = differentiate(expr.value, variable);
      return du ? { kind: "mul", left: { kind: "neg", value: { kind: "sin", value: expr.value } }, right: du } : null;
    }
    case "exp": {
      const du = differentiate(expr.value, variable);
      return du ? { kind: "mul", left: { kind: "exp", value: expr.value }, right: du } : null;
    }
    case "abs": {
      const du = differentiate(expr.value, variable);
      return du ? { kind: "mul", left: { kind: "div", left: expr.value, right: { kind: "abs", value: expr.value } }, right: du } : null;
    }
    default:
      return null;
  }
}

function substituteScalar(expr: ScalarExpr, variable: string, replacement: ScalarExpr): ScalarExpr {
  switch (expr.kind) {
    case "const":
      return expr;
    case "variable":
      return expr.name === variable ? replacement : expr;
    case "neg":
    case "sqrt":
    case "abs":
    case "ln":
    case "sin":
    case "cos":
    case "exp":
      return { kind: expr.kind, value: substituteScalar(expr.value, variable, replacement) };
    case "add":
    case "sub":
    case "mul":
    case "div":
      return {
        kind: expr.kind,
        left: substituteScalar(expr.left, variable, replacement),
        right: substituteScalar(expr.right, variable, replacement),
      };
    case "pow":
      return { kind: "pow", base: substituteScalar(expr.base, variable, replacement), exponent: expr.exponent };
  }
}

export type SubstitutionBounds = {
  lower: string | number;
  upper: string | number;
  substitution: ScalarExpr | string;
  transformedLower: ScalarExpr | string | number;
  transformedUpper: ScalarExpr | string | number;
  variable?: string;
};

export function verifySubstitutionBounds(input: SubstitutionBounds): VerificationResult {
  const substitution = parseScalarExpr(input.substitution);
  const lower = toRational(input.lower);
  const upper = toRational(input.upper);
  const expectedLower = parseScalarExpr(input.transformedLower);
  const expectedUpper = parseScalarExpr(input.transformedUpper);
  if (!substitution || !lower || !upper || !expectedLower || !expectedUpper) {
    return { status: "unverified", reason: "bounds_outside_exact_fragment" };
  }
  const subVars = collectVariables(substitution);
  const variable = input.variable ?? (subVars.size === 1 ? [...subVars][0]! : "x");
  if (subVars.size > 1 || (subVars.size === 1 && !subVars.has(variable))) {
    return { status: "unverified", reason: "bounds_outside_exact_fragment" };
  }

  const lowAt = substituteScalar(substitution, variable, { kind: "const", value: lower });
  const highAt = substituteScalar(substitution, variable, { kind: "const", value: upper });
  const lowCheck = verifyScalarEquivalence(lowAt, expectedLower);
  const highCheck = verifyScalarEquivalence(highAt, expectedUpper);

  if (lowCheck.status === "equivalent" && highCheck.status === "equivalent") {
    return { status: "equivalent", reason: "ordered_transformed_bounds_verified" };
  }
  if (lowCheck.status === "unverified" || highCheck.status === "unverified") {
    return { status: "unverified", reason: lowCheck.status === "unverified" ? lowCheck.reason : highCheck.reason };
  }
  const lowExact = evaluateExactRationalExt(substitution, lower, variable);
  const highExact = evaluateExactRationalExt(substitution, upper, variable);
  const detail =
    lowExact.status === "value" && highExact.status === "value"
      ? `expected ${formatRational(lowExact.value)}..${formatRational(highExact.value)}`
      : lowExact.status === "undefined_domain" || highExact.status === "undefined_domain"
        ? "substitution undefined at bound"
        : "transformed bounds do not match";
  return {
    status: "inequivalent",
    reason: "transformed_bounds_mismatch",
    witness: { input: `${formatRational(lower)}..${formatRational(upper)}`, detail },
  };
}

export const checkScalarEquivalence = verifyScalarEquivalence;
export const canonicalizeRadical = simplifyRadical;
export const checkSubstitutionBounds = verifySubstitutionBounds;
export const verifyCalculus = verifyIndefiniteIntegral;
