import {
  addRational,
  bigAbs,
  bigGcd,
  bigLcm,
  checkPolyCoeffBound,
  divideRational,
  equalRational,
  MAX_POLY_COEFF_MAGNITUDE,
  MAX_RATIONAL_DECIMAL_DIGITS,
  multiplyRational,
  PolyComplexityError,
  rational,
  subtractRational,
  type SpanRational,
} from "./rational-bounds";

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
  nonCommutativeVars?: readonly string[];
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
    const intMatch = /^([+-]?)(\d+)$/.exec(trimmed);
    if (intMatch) {
      const digits = intMatch[2]!.replace(/^0+/, "");
      if (digits.length > MAX_RATIONAL_DECIMAL_DIGITS) throw new PolyComplexityError();
      const sign = intMatch[1] === "-" ? -1n : 1n;
      return rational(digits ? sign * BigInt(digits) : 0n);
    }
    const fraction = /^([+-]?\d+)\s*\/\s*([+-]?\d+)$/.exec(trimmed);
    if (fraction) {
      const nDigits = fraction[1]!.replace(/^[+-]?0+/, "");
      const dDigits = fraction[2]!.replace(/^[+-]?0+/, "");
      if (nDigits.length > MAX_RATIONAL_DECIMAL_DIGITS * 2 || dDigits.length > MAX_RATIONAL_DECIMAL_DIGITS * 2) {
        throw new PolyComplexityError();
      }
      const den = BigInt(fraction[2]!);
      return den !== 0n ? rational(BigInt(fraction[1]!), den) : null;
    }
    const decimal = /^([+-]?)(\d*)\.(\d+)$/.exec(trimmed);
    if (decimal) {
      if (trimmed.length > MAX_RATIONAL_DECIMAL_DIGITS * 4) throw new PolyComplexityError();
      const intTrimmed = (decimal[2] || "").replace(/^0+/, "");
      const decTrimmed = decimal[3]!.replace(/0+$/, "");
      if (!decTrimmed) {
        const sign = decimal[1] === "-" ? -1n : 1n;
        if (intTrimmed.length > MAX_RATIONAL_DECIMAL_DIGITS) throw new PolyComplexityError();
        return rational(intTrimmed ? sign * BigInt(intTrimmed) : 0n);
      }
      if (intTrimmed.length + decTrimmed.length > MAX_RATIONAL_DECIMAL_DIGITS) {
        throw new PolyComplexityError();
      }
      const sign = decimal[1] === "-" ? -1n : 1n;
      const digits = `${intTrimmed || "0"}${decTrimmed}`;
      return rational(sign * BigInt(digits), 10n ** BigInt(decTrimmed.length));
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

export type Polynomial = Map<number, SpanRational>;
export function polynomialConstant(value: SpanRational): Polynomial {
  checkPolyCoeffBound(value);
  return value.n === 0n ? new Map() : new Map([[0, value]]);
}
export function polynomialVariable(): Polynomial {
  return new Map([[1, rational(1n)]]);
}

export function polynomialAdd(a: Polynomial, b: Polynomial, sign: 1 | -1 = 1): Polynomial {
  const out = new Map<number, SpanRational>();
  for (const [degree, value] of a) {
    checkPolyCoeffBound(value);
    out.set(degree, value);
  }
  for (const [degree, value] of b) {
    checkPolyCoeffBound(value);
    const next =
      sign === 1
        ? addRational(out.get(degree) ?? rational(0n), value)
        : subtractRational(out.get(degree) ?? rational(0n), value);
    checkPolyCoeffBound(next);
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
  checkPolyCoeffBound(x);
  for (const coeff of poly.values()) checkPolyCoeffBound(coeff);
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
  checkPolyCoeffBound(factor);
  for (const coeff of poly.values()) checkPolyCoeffBound(coeff);
  if (factor.n === 0n || poly.size === 0) return new Map();
  const out = new Map<number, SpanRational>();
  for (const [deg, coeff] of poly) {
    const scaled = multiplyRational(coeff, factor);
    checkPolyCoeffBound(scaled);
    if (scaled.n !== 0n) out.set(deg, scaled);
  }
  return out;
}

function polynomialPrimitivePositive(poly: Polynomial): Polynomial {
  if (poly.size === 0) return new Map();
  let lcmDen = 1n;
  for (const coeff of poly.values()) {
    checkPolyCoeffBound(coeff);
    lcmDen = bigLcm(lcmDen, coeff.d);
    if (lcmDen > MAX_POLY_COEFF_MAGNITUDE) throw new PolyComplexityError();
  }
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
  if (a.size > 512 || b.size > 512) throw new PolyComplexityError();
  let rem = new Map(a);
  const quot = new Map<number, SpanRational>();
  const leadB = polynomialLeadCoeff(b);
  let divSteps = 0;
  while (rem.size > 0) {
    if (++divSteps > 128) throw new PolyComplexityError();
    const degR = polynomialDegree(rem);
    if (degR < degB) break;
    const shift = degR - degB;
    const termCoeff = divideRational(polynomialLeadCoeff(rem), leadB);
    checkPolyCoeffBound(termCoeff);
    quot.set(shift, addRational(quot.get(shift) ?? rational(0n), termCoeff));
    const subtrahend = new Map<number, SpanRational>();
    for (const [d, c] of b) {
      const next = multiplyRational(c, termCoeff);
      checkPolyCoeffBound(next);
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
  let gcdSteps = 0;
  while (y.size > 0) {
    if (++gcdSteps > 128) throw new PolyComplexityError();
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
  if (polynomialDegree(s0) > MAX_SYMBOLIC_POLY_DEGREE) throw new PolyComplexityError();
  const s1 = polynomialPrimitivePositive(polynomialDerivative(s0));
  const chain: Polynomial[] = [s0];
  if (s1.size > 0) chain.push(s1);
  while (chain.length >= 2 && polynomialDegree(chain[chain.length - 1]!) > 0) {
    if (chain.length > MAX_SYMBOLIC_POLY_DEGREE + 8) throw new PolyComplexityError();
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

type IsolateRealRootsResult = {
  roots: IsolatedRoot[];
  unresolvedRootIsolation: boolean;
};

function isolateRealRoots(sfPoly: Polynomial, interval: NormalizedInterval): IsolateRealRootsResult {
  if (sfPoly.size === 0) return { roots: [], unresolvedRootIsolation: false };
  let work = polynomialSquareFree(sfPoly);
  if (polynomialDegree(work) <= 0) return { roots: [], unresolvedRootIsolation: false };
  if (interval.left && interval.right) {
    const cmp = compareRational(interval.left, interval.right);
    if (cmp > 0) return { roots: [], unresolvedRootIsolation: false };
    if (cmp === 0) {
      return {
        roots:
          !interval.leftOpen && !interval.rightOpen && polynomialEvaluate(work, interval.left).n === 0n
            ? [{ kind: "exact", value: interval.left }]
            : [],
        unresolvedRootIsolation: false,
      };
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
  if (polynomialDegree(work) <= 0) {
    return { roots: roots.sort((a, b) => compareRational(rootSortKey(a), rootSortKey(b))), unresolvedRootIsolation: false };
  }
  if (polynomialDegree(work) === 1) {
    const a1 = work.get(1)!;
    const a0 = work.get(0) ?? rational(0n);
    const root = divideRational(rational(-a0.n, a0.d), a1);
    if (pointInInterval(root, interval)) roots.push({ kind: "exact", value: root });
    return { roots: roots.sort((a, b) => compareRational(rootSortKey(a), rootSortKey(b))), unresolvedRootIsolation: false };
  }

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

  let unresolvedRootIsolation = false;
  const stack: Array<{ a: SpanRational; b: SpanRational; depth: number }> = [{ a: low, b: high, depth: 0 }];
  let guard = 0;
  while (stack.length > 0 && guard++ < 2048) {
    const { a, b, depth } = stack.pop()!;
    if (compareRational(a, b) >= 0) continue;
    const count = sturmCountOpen(work, a, b);
    if (count === 0) continue;
    if (count === 1) {
      roots.push({ kind: "open", low: a, high: b });
      continue;
    }
    if (depth >= 80) {
      unresolvedRootIsolation = true;
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
  if (stack.length > 0) unresolvedRootIsolation = true;
  return { roots: roots.sort((a, b) => compareRational(rootSortKey(a), rootSortKey(b))), unresolvedRootIsolation };
}

export type RationalForm = {
  numerator: Polynomial;
  denominator: Polynomial;
  domainDenominators: Polynomial[];
  zeroDenominator?: boolean;
  unsupported?: string;
};

const MAX_SYMBOLIC_POLY_DEGREE = 64;
const MAX_SYMBOLIC_POLY_TERMS = 512;
const MAX_SYMBOLIC_MUL_STEPS = 4096;
const MAX_AST_WALK_STEPS = 16384;
const MAX_AST_WALK_DEPTH = 512;
const MAX_PARSE_AST_NODES = 4096;
const MAX_PARSE_TOKENS = 16384;

function bumpAstSteps(state: { steps: number }, depth = 0): void {
  if (depth > MAX_AST_WALK_DEPTH) throw new PolyComplexityError();
  state.steps++;
  if (state.steps > MAX_AST_WALK_STEPS) throw new PolyComplexityError();
}

type PolyMulBudget = { mulSteps: number };

function exceedsPolyLimits(poly: Polynomial, maxDegree = MAX_SYMBOLIC_POLY_DEGREE): boolean {
  if (polynomialDegree(poly) > maxDegree || poly.size > MAX_SYMBOLIC_POLY_TERMS) return true;
  for (const coeff of poly.values()) {
    if (bigAbs(coeff.n) > MAX_POLY_COEFF_MAGNITUDE || coeff.d > MAX_POLY_COEFF_MAGNITUDE) return true;
  }
  return false;
}

function boundedPolyMultiply(
  a: Polynomial,
  b: Polynomial,
  budget: PolyMulBudget,
  maxDegree = MAX_SYMBOLIC_POLY_DEGREE,
): Polynomial | null {
  if (a.size > MAX_SYMBOLIC_POLY_TERMS || b.size > MAX_SYMBOLIC_POLY_TERMS) return null;
  for (const [, va] of a) {
    if (bigAbs(va.n) > MAX_POLY_COEFF_MAGNITUDE || va.d > MAX_POLY_COEFF_MAGNITUDE) return null;
  }
  for (const [, vb] of b) {
    if (bigAbs(vb.n) > MAX_POLY_COEFF_MAGNITUDE || vb.d > MAX_POLY_COEFF_MAGNITUDE) return null;
  }
  if (a.size === 0 || b.size === 0) return new Map();
  const degA = polynomialDegree(a);
  const degB = polynomialDegree(b);
  if (degA + degB > maxDegree) return null;
  if (budget.mulSteps + a.size * b.size > MAX_SYMBOLIC_MUL_STEPS) return null;

  const out = new Map<number, SpanRational>();
  for (const [da, va] of a) {
    for (const [db, vb] of b) {
      budget.mulSteps++;
      if (budget.mulSteps > MAX_SYMBOLIC_MUL_STEPS) return null;
      const degree = da + db;
      const prod = multiplyRational(va, vb);
      if (bigAbs(prod.n) > MAX_POLY_COEFF_MAGNITUDE || prod.d > MAX_POLY_COEFF_MAGNITUDE) return null;
      const next = addRational(out.get(degree) ?? rational(0n), prod);
      if (bigAbs(next.n) > MAX_POLY_COEFF_MAGNITUDE || next.d > MAX_POLY_COEFF_MAGNITUDE) return null;
      if (next.n === 0n) out.delete(degree);
      else {
        out.set(degree, next);
        if (out.size > MAX_SYMBOLIC_POLY_TERMS) return null;
      }
    }
  }
  return out;
}

const polyComplexityFailure = (): RationalForm => ({
  numerator: new Map(),
  denominator: new Map(),
  domainDenominators: [],
  unsupported: "polynomial_complexity_exceeded",
});

export function rationalForm(
  expr: ScalarExpr,
  variable = "x",
  budget: PolyMulBudget = { mulSteps: 0 },
): RationalForm {
  try {
    return rationalFormInner(expr, variable, budget);
  } catch (err) {
    if (err instanceof PolyComplexityError) return polyComplexityFailure();
    throw err;
  }
}

function mergeRationalUnsupported(a?: string, b?: string): string | undefined {
  if (a === "polynomial_complexity_exceeded" || b === "polynomial_complexity_exceeded") {
    return "polynomial_complexity_exceeded";
  }
  return a ?? b;
}

function rationalFormInner(
  expr: ScalarExpr,
  variable = "x",
  budget: PolyMulBudget = { mulSteps: 0 },
  walkState: { steps: number } = { steps: 0 },
  depth = 0,
): RationalForm {
  bumpAstSteps(walkState, depth);
  switch (expr.kind) {
    case "const": {
      const value = toRational(expr.value);
      if (!value) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: "non_rational_constant" };
      }
      if (bigAbs(value.n) > MAX_POLY_COEFF_MAGNITUDE || value.d > MAX_POLY_COEFF_MAGNITUDE) {
        return polyComplexityFailure();
      }
      return { numerator: polynomialConstant(value), denominator: polynomialConstant(rational(1n)), domainDenominators: [] };
    }
    case "variable":
      return expr.name === variable
        ? { numerator: polynomialVariable(), denominator: polynomialConstant(rational(1n)), domainDenominators: [] }
        : { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: "foreign_variable" };
    case "neg": {
      const inner = rationalFormInner(expr.value, variable, budget, walkState, depth + 1);
      if (inner.unsupported) return inner;
      return {
        ...inner,
        numerator: polynomialScale(inner.numerator, rational(-1n)),
      };
    }
    case "add":
    case "sub": {
      const left = rationalFormInner(expr.left, variable, budget, walkState, depth + 1);
      const right = rationalFormInner(expr.right, variable, budget, walkState, depth + 1);
      if (left.unsupported || right.unsupported) {
        return {
          numerator: new Map(),
          denominator: new Map(),
          domainDenominators: [],
          unsupported: mergeRationalUnsupported(left.unsupported, right.unsupported),
        };
      }
      const leftTerm = boundedPolyMultiply(left.numerator, right.denominator, budget);
      const rightTerm = boundedPolyMultiply(right.numerator, left.denominator, budget);
      const denominator = boundedPolyMultiply(left.denominator, right.denominator, budget);
      if (!leftTerm || !rightTerm || !denominator) return polyComplexityFailure();
      const numerator = polynomialAdd(leftTerm, rightTerm, expr.kind === "add" ? 1 : -1);
      if (exceedsPolyLimits(numerator)) return polyComplexityFailure();
      return {
        numerator,
        denominator,
        domainDenominators: [...left.domainDenominators, ...right.domainDenominators],
        zeroDenominator: left.zeroDenominator || right.zeroDenominator,
      };
    }
    case "mul": {
      const left = rationalFormInner(expr.left, variable, budget, walkState, depth + 1);
      const right = rationalFormInner(expr.right, variable, budget, walkState, depth + 1);
      if (left.unsupported || right.unsupported) {
        return {
          numerator: new Map(),
          denominator: new Map(),
          domainDenominators: [],
          unsupported: mergeRationalUnsupported(left.unsupported, right.unsupported),
        };
      }
      const numerator = boundedPolyMultiply(left.numerator, right.numerator, budget);
      const denominator = boundedPolyMultiply(left.denominator, right.denominator, budget);
      if (!numerator || !denominator) return polyComplexityFailure();
      return {
        numerator,
        denominator,
        domainDenominators: [...left.domainDenominators, ...right.domainDenominators],
        zeroDenominator: left.zeroDenominator || right.zeroDenominator,
      };
    }
    case "div": {
      const left = rationalFormInner(expr.left, variable, budget, walkState, depth + 1);
      const right = rationalFormInner(expr.right, variable, budget, walkState, depth + 1);
      if (left.unsupported || right.unsupported) {
        return {
          numerator: new Map(),
          denominator: new Map(),
          domainDenominators: [],
          unsupported: mergeRationalUnsupported(left.unsupported, right.unsupported),
        };
      }
      const numerator = boundedPolyMultiply(left.numerator, right.denominator, budget);
      const denominator = boundedPolyMultiply(left.denominator, right.numerator, budget);
      if (!numerator || !denominator) return polyComplexityFailure();
      const zeroDenominator = left.zeroDenominator || right.zeroDenominator || right.numerator.size === 0 || right.denominator.size === 0;
      return {
        numerator,
        denominator,
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
      const inner = rationalFormInner(expr.base, variable, budget, walkState, depth + 1);
      if (inner.unsupported) {
        return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: inner.unsupported };
      }
      const count = Math.abs(expr.exponent);
      const stepNum = expr.exponent >= 0 ? inner.numerator : inner.denominator;
      const stepDen = expr.exponent >= 0 ? inner.denominator : inner.numerator;
      const degNum = Math.max(0, polynomialDegree(stepNum));
      const degDen = Math.max(0, polynomialDegree(stepDen));
      if (
        degNum * count > MAX_SYMBOLIC_POLY_DEGREE ||
        degDen * count > MAX_SYMBOLIC_POLY_DEGREE ||
        stepNum.size > MAX_SYMBOLIC_POLY_TERMS ||
        stepDen.size > MAX_SYMBOLIC_POLY_TERMS
      ) {
        return polyComplexityFailure();
      }
      let numerator = polynomialConstant(rational(1n));
      let denominator = polynomialConstant(rational(1n));
      for (let i = 0; i < count; i++) {
        const nextNum = boundedPolyMultiply(numerator, stepNum, budget);
        const nextDen = boundedPolyMultiply(denominator, stepDen, budget);
        if (!nextNum || !nextDen) return polyComplexityFailure();
        numerator = nextNum;
        denominator = nextDen;
      }
      const extraDens = expr.exponent <= 0 ? [inner.numerator, inner.denominator] : [];
      const zeroDenominator =
        inner.zeroDenominator || (expr.exponent <= 0 && (inner.numerator.size === 0 || inner.denominator.size === 0));
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
  try {
    return evaluateConstantIntInner(expr);
  } catch (err) {
    if (err instanceof PolyComplexityError) return null;
    throw err;
  }
}

function evaluateConstantIntInner(expr: ScalarExpr, state: { steps: number } = { steps: 0 }, depth = 0): number | null {
  bumpAstSteps(state, depth);
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (!q || q.d !== 1n) return null;
      const n = Number(q.n);
      return Number.isSafeInteger(n) ? n : null;
    }
    case "neg": {
      const v = evaluateConstantIntInner(expr.value, state, depth + 1);
      return v === null ? null : -v;
    }
    case "add":
    case "sub":
    case "mul": {
      const l = evaluateConstantIntInner(expr.left, state, depth + 1);
      const r = evaluateConstantIntInner(expr.right, state, depth + 1);
      if (l === null || r === null) return null;
      const out = expr.kind === "add" ? l + r : expr.kind === "sub" ? l - r : l * r;
      return Number.isSafeInteger(out) ? out : null;
    }
    case "div": {
      const l = evaluateConstantIntInner(expr.left, state, depth + 1);
      const r = evaluateConstantIntInner(expr.right, state, depth + 1);
      if (l === null || r === null || r === 0 || l % r !== 0) return null;
      return l / r;
    }
    case "pow": {
      const b = evaluateConstantIntInner(expr.base, state, depth + 1);
      if (b === null || !Number.isInteger(expr.exponent) || expr.exponent < 0 || expr.exponent > 12) return null;
      if (b === 0 && expr.exponent <= 0) return null;
      const out = b ** expr.exponent;
      return Number.isSafeInteger(out) ? out : null;
    }
    default:
      return null;
  }
}

export type NormalizeLatexOptions = {
  preservedIdentifiers?: readonly string[];
  implicitMulIdentifiers?: readonly string[];
  matrixImplicitMul?: boolean;
};

const LATEX_FN_NAMES = new Set([
  "sqrt",
  "abs",
  "ln",
  "log",
  "exp",
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "asin",
  "acos",
  "atan",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "det",
  "tr",
  "inv",
]);

const DEFAULT_PRESERVED_IDENTIFIERS = new Set([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "theta",
  "lambda",
  "mu",
  "sigma",
  "omega",
  "pi",
]);

const MAX_PARSE_DEPTH = 256;

function precheckParseNestingDepth(src: string): void {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let leftDepth = 0;
  let envDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === "\\") {
      if (src.startsWith("\\left", i) && !/[A-Za-z]/.test(src[i + 5] ?? "")) {
        leftDepth++;
        i += 4;
      } else if (src.startsWith("\\right", i) && !/[A-Za-z]/.test(src[i + 6] ?? "")) {
        leftDepth = Math.max(0, leftDepth - 1);
        i += 5;
      } else if (src.startsWith("\\begin{", i)) {
        envDepth++;
        i += 6;
      } else if (src.startsWith("\\end{", i)) {
        envDepth = Math.max(0, envDepth - 1);
        i += 4;
      }
    }
    if (
      parenDepth > MAX_PARSE_DEPTH ||
      bracketDepth > MAX_PARSE_DEPTH ||
      braceDepth > MAX_PARSE_DEPTH ||
      leftDepth > MAX_PARSE_DEPTH ||
      envDepth > MAX_PARSE_DEPTH ||
      parenDepth + bracketDepth + braceDepth + envDepth > MAX_PARSE_DEPTH
    ) {
      throw new PolyComplexityError();
    }
  }
}

function readBalancedGroup(
  src: string,
  start: number,
  openCh: "{" | "[" | "(",
  closeCh: "}" | "]" | ")",
): { content: string; nextIndex: number } | null {
  if (src[start] !== openCh) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === openCh) {
      depth++;
      if (depth > MAX_PARSE_DEPTH) throw new PolyComplexityError();
    } else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), nextIndex: i + 1 };
    }
  }
  return null;
}

function skipWs(src: string, idx: number): number {
  let i = idx;
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

export function normalizeLatexExpr(input: string, options?: NormalizeLatexOptions): string | null {
  try {
    return normalizeLatexExprInner(input, options);
  } catch (err) {
    if (err instanceof PolyComplexityError || err instanceof MPolyOverflowError) return null;
    throw err;
  }
}

function normalizeLatexExprInner(input: string, options?: NormalizeLatexOptions): string | null {
  let s = input.replaceAll("−", "-").trim();
  while (s.length >= 2 && s.startsWith("$") && s.endsWith("$")) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return "";
  precheckParseNestingDepth(s);

  const preservedSet = new Set(DEFAULT_PRESERVED_IDENTIFIERS);
  for (const ident of options?.preservedIdentifiers ?? []) {
    if (ident) preservedSet.add(ident);
  }
  const implicitMulSet = new Set<string>(options?.implicitMulIdentifiers ?? []);
  const matrixMode = Boolean(options?.matrixImplicitMul);

  const isSingleAtomId = (ident: string): boolean =>
    ident.length === 1 ||
    /^[A-Za-z]\d+$/.test(ident) ||
    /^[A-Za-z]_[A-Za-z0-9]+$/.test(ident) ||
    preservedSet.has(ident);

  const readUnbracedAtom = (src: string, start: number): { text: string; nextIndex: number } | null => {
    const tail = src.slice(start);
    const numMatch = /^\d+(?:\.\d+)?/.exec(tail);
    if (numMatch) {
      const nextIndex = start + numMatch[0].length;
      if (src[nextIndex] === ".") return null;
      return { text: numMatch[0], nextIndex };
    }
    if (tail.startsWith("\\")) {
      const greekMatch = /^\\([A-Za-z]+)/.exec(tail);
      if (greekMatch && DEFAULT_PRESERVED_IDENTIFIERS.has(greekMatch[1]!)) {
        let nextIndex = start + greekMatch[0].length;
        let text = greekMatch[1]!;
        const subStart = skipWs(src, nextIndex);
        if (src[subStart] === "_") {
          const subArgStart = skipWs(src, subStart + 1);
          if (src[subArgStart] === "{") {
            const grp = readBalancedGroup(src, subArgStart, "{", "}");
            const sub = grp?.content.trim() ?? "";
            if (!grp || !/^[A-Za-z0-9]+$/.test(sub)) return null;
            text = `${text}_${sub}`;
            nextIndex = grp.nextIndex;
          } else if (/^[A-Za-z0-9]$/.test(src[subArgStart] ?? "")) {
            text = `${text}_${src[subArgStart]}`;
            nextIndex = subArgStart + 1;
          } else {
            return null;
          }
        }
        return { text, nextIndex };
      }
      return null;
    }
    const idMatch = /^[A-Za-z][A-Za-z0-9_]*/.exec(tail);
    if (idMatch) {
      let text = idMatch[0];
      let nextIndex = start + text.length;
      if (!isSingleAtomId(text)) return null;
      const subStart = skipWs(src, nextIndex);
      if (src[subStart] === "_" && !text.includes("_")) {
        const subArgStart = skipWs(src, subStart + 1);
        if (src[subArgStart] === "{") {
          const grp = readBalancedGroup(src, subArgStart, "{", "}");
          const sub = grp?.content.trim() ?? "";
          if (!grp || !/^[A-Za-z0-9]+$/.test(sub)) return null;
          text = `${text}_${sub}`;
          nextIndex = grp.nextIndex;
        } else {
          return null;
        }
      }
      return { text, nextIndex };
    }
    return null;
  };

  const rewriteMacros = (src: string, depth = 0): string | null => {
    if (depth > MAX_PARSE_DEPTH) throw new PolyComplexityError();
    let out = "";
    let i = 0;
    const readFracArg = (pos: number): { content: string; nextIndex: number } | null => {
      const p = skipWs(src, pos);
      if (src[p] === "{") return readBalancedGroup(src, p, "{", "}");
      if (/[A-Za-z0-9]/.test(src[p] ?? "")) return { content: src[p]!, nextIndex: p + 1 };
      return null;
    };
    const needSpaceBeforeIdent = (): string => (out && /[A-Za-z0-9_]/.test(out[out.length - 1]!) ? " " : "");

    while (i < src.length) {
      const ch = src[i]!;
      if (ch === "\\") {
        const tail = src.slice(i + 1);
        const cmdMatch = /^([A-Za-z]+|[,;! ])/.exec(tail);
        if (!cmdMatch) return null;
        const cmd = cmdMatch[1]!;
        const afterCmd = i + 1 + cmd.length;
        if (cmd === "," || cmd === ";" || cmd === "!" || cmd === " ") {
          out += " ";
          i = afterCmd;
          continue;
        }
        if (cmd === "cdot" || cmd === "times") {
          out += " * ";
          i = afterCmd;
          continue;
        }
        if (cmd === "div") {
          out += " / ";
          i = afterCmd;
          continue;
        }
        if (cmd === "left" || cmd === "right") {
          const nextPos = skipWs(src, afterCmd);
          if (src[nextPos] === "|") {
            out += cmd === "left" ? " abs(" : ") ";
            i = nextPos + 1;
            continue;
          }
          if (src.slice(nextPos, nextPos + 2) === "\\|") {
            out += cmd === "left" ? " abs(" : ") ";
            i = nextPos + 2;
            continue;
          }
          i = afterCmd;
          continue;
        }
        if (cmd === "frac") {
          const num = readFracArg(afterCmd);
          const den = num ? readFracArg(num.nextIndex) : null;
          if (!num || !den) return null;
          const rewrittenNum = rewriteMacros(num.content, depth + 1);
          const rewrittenDen = rewriteMacros(den.content, depth + 1);
          if (rewrittenNum === null || rewrittenDen === null) return null;
          out += `((${rewrittenNum})/(${rewrittenDen}))`;
          i = den.nextIndex;
          continue;
        }
        if (cmd === "sqrt") {
          let argStart = skipWs(src, afterCmd);
          if (src[argStart] === "^") return null;
          if (src[argStart] === "[") {
            const opt = readBalancedGroup(src, argStart, "[", "]");
            if (!opt || opt.content.trim() !== "2") return null;
            argStart = skipWs(src, opt.nextIndex);
          }
          if (src[argStart] === "{" || src[argStart] === "(") {
            const grp =
              src[argStart] === "{"
                ? readBalancedGroup(src, argStart, "{", "}")
                : readBalancedGroup(src, argStart, "(", ")");
            if (!grp) return null;
            const inner = rewriteMacros(grp.content, depth + 1);
            if (inner === null) return null;
            out += `${needSpaceBeforeIdent()}sqrt(${inner})`;
            i = grp.nextIndex;
            continue;
          }
          const atom = readUnbracedAtom(src, argStart);
          if (!atom) return null;
          const afterAtom = skipWs(src, atom.nextIndex);
          if (
            afterAtom < src.length &&
            !/^[+\-*/=)},]$/.test(src[afterAtom]!) &&
            !/^\\right(?![A-Za-z])/.test(src.slice(afterAtom))
          ) {
            return null;
          }
          out += `${needSpaceBeforeIdent()}sqrt(${atom.text})`;
          i = atom.nextIndex;
          continue;
        }
        if (LATEX_FN_NAMES.has(cmd)) {
          const argStart = skipWs(src, afterCmd);
          if (src[argStart] === "^") {
            const expStart = skipWs(src, argStart + 1);
            let expText: string;
            let afterExp: number;
            if (src[expStart] === "{") {
              const expGrp = readBalancedGroup(src, expStart, "{", "}");
              if (!expGrp) return null;
              expText = expGrp.content.trim();
              afterExp = expGrp.nextIndex;
            } else {
              const intMatch = /^(-?\d+)/.exec(src.slice(expStart));
              if (!intMatch) return null;
              expText = intMatch[1]!;
              afterExp = expStart + intMatch[0].length;
            }
            if (!/^[1-9]\d*$/.test(expText)) return null;
            const fnArgPos = skipWs(src, afterExp);
            if (src[fnArgPos] !== "{" && src[fnArgPos] !== "(") return null;
            const fnGrp =
              src[fnArgPos] === "{"
                ? readBalancedGroup(src, fnArgPos, "{", "}")
                : readBalancedGroup(src, fnArgPos, "(", ")");
            if (!fnGrp) return null;
            const inner = rewriteMacros(fnGrp.content, depth + 1);
            if (inner === null) return null;
            out += `${needSpaceBeforeIdent()}((${cmd}(${inner}))^(${expText}))`;
            i = fnGrp.nextIndex;
            continue;
          }
          if (src[argStart] === "{" || src[argStart] === "(") {
            const grp =
              src[argStart] === "{"
                ? readBalancedGroup(src, argStart, "{", "}")
                : readBalancedGroup(src, argStart, "(", ")");
            if (!grp) return null;
            const inner = rewriteMacros(grp.content, depth + 1);
            if (inner === null) return null;
            out += `${needSpaceBeforeIdent()}${cmd}(${inner})`;
            i = grp.nextIndex;
            continue;
          }
          const atom = readUnbracedAtom(src, argStart);
          if (!atom) return null;
          const afterAtom = skipWs(src, atom.nextIndex);
          if (
            afterAtom < src.length &&
            !"+-=)},".includes(src[afterAtom]!) &&
            !/^\\right(?![A-Za-z])/.test(src.slice(afterAtom))
          ) {
            return null;
          }
          out += `${needSpaceBeforeIdent()}${cmd}(${atom.text})`;
          i = atom.nextIndex;
          continue;
        }
        if (DEFAULT_PRESERVED_IDENTIFIERS.has(cmd)) {
          out += `${needSpaceBeforeIdent()}${cmd}`;
          if (src[afterCmd] === " ") out += " ";
          i = afterCmd;
          continue;
        }
        return null;
      }
      if (ch === "_") {
        if (out.length === 0 || !/[A-Za-z0-9]/.test(out[out.length - 1]!)) return null;
        const argStart = skipWs(src, i + 1);
        if (argStart >= src.length) return null;
        if (src[argStart] === "{") {
          const grp = readBalancedGroup(src, argStart, "{", "}");
          const sub = grp?.content.trim() ?? "";
          if (!grp || !/^[A-Za-z0-9]+$/.test(sub)) return null;
          out += `_${sub}`;
          i = grp.nextIndex;
          continue;
        }
        if (/^[A-Za-z0-9]$/.test(src[argStart]!)) {
          out += `_${src[argStart]}`;
          i = argStart + 1;
          continue;
        }
        return null;
      }
      if (ch === "^" && skipWs(src, i + 1) < src.length) {
        const argStart = skipWs(src, i + 1);
        if (src[argStart] === "{") {
          const grp = readBalancedGroup(src, argStart, "{", "}");
          if (!grp) return null;
          const inner = rewriteMacros(grp.content, depth + 1);
          if (inner === null || !inner.trim()) return null;
          out += `^(${inner})`;
          i = grp.nextIndex;
          continue;
        }
      }
      if (ch === "{") {
        const grp = readBalancedGroup(src, i, "{", "}");
        if (!grp) return null;
        const inner = rewriteMacros(grp.content, depth + 1);
        if (inner === null) return null;
        out += `(${inner})`;
        i = grp.nextIndex;
        continue;
      }
      if (ch === "}") return null;
      out += ch;
      i++;
    }
    return out;
  };

  const expanded = rewriteMacros(s);
  if (expanded === null) return null;

  type TokKind = "num" | "id" | "fn" | "lparen" | "rparen" | "op";
  const tokens: Array<{ kind: TokKind; text: string }> = [];
  let p = 0;
  while (p < expanded.length) {
    if (tokens.length > MAX_PARSE_TOKENS) throw new PolyComplexityError();
    const c = expanded[p]!;
    if (/\s/.test(c)) {
      p++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen", text: "(" });
      p++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen", text: ")" });
      p++;
      continue;
    }
    if ("+-*/^".includes(c)) {
      tokens.push({ kind: "op", text: c });
      p++;
      continue;
    }
    const numMatch = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(expanded.slice(p));
    if (numMatch) {
      tokens.push({ kind: "num", text: numMatch[0] });
      p += numMatch[0].length;
      continue;
    }
    const wordMatch = /^[A-Za-z][A-Za-z0-9_]*/.exec(expanded.slice(p));
    if (wordMatch) {
      const word = wordMatch[0];
      p += word.length;
      const afterWordWs = skipWs(expanded, p);
      const isFunctionCall = expanded[afterWordWs] === "(";
      if (LATEX_FN_NAMES.has(word)) {
        tokens.push({ kind: isFunctionCall ? "fn" : "id", text: word });
        continue;
      }
      if (isFunctionCall) {
        if (implicitMulSet.has(word) || (matrixMode && word.length === 1)) {
          tokens.push({ kind: "id", text: word });
          continue;
        }
        tokens.push({ kind: "fn", text: word });
        continue;
      }
      if (preservedSet.has(word) || word.includes("_")) {
        tokens.push({ kind: "id", text: word });
        continue;
      }
      let j = 0;
      while (j < word.length) {
        const rest = word.slice(j);
        const unitMatch = /^[A-Za-z]\d*/.exec(rest);
        if (unitMatch) {
          tokens.push({ kind: "id", text: unitMatch[0] });
          j += unitMatch[0].length;
        } else {
          tokens.push({ kind: "id", text: rest[0]! });
          j++;
        }
      }
      continue;
    }
    tokens.push({ kind: "op", text: c });
    p++;
  }

  let normalized = "";
  for (let idx = 0; idx < tokens.length; idx++) {
    const prev = idx > 0 ? tokens[idx - 1]! : null;
    const curr = tokens[idx]!;
    if (prev) {
      const prevEndsAtom = prev.kind === "num" || prev.kind === "id" || prev.kind === "rparen";
      const currStartsAtom = curr.kind === "num" || curr.kind === "id" || curr.kind === "fn" || curr.kind === "lparen";
      if (prevEndsAtom && currStartsAtom) {
        normalized += "*";
      }
    }
    normalized += curr.text;
  }
  return normalized;
}

export function parseScalarExpr(
  input: ScalarExpr | string | number,
  options?: NormalizeLatexOptions,
): ScalarExpr | null {
  try {
    return parseScalarExprInner(input, options);
  } catch (err) {
    if (err instanceof PolyComplexityError || err instanceof MPolyOverflowError) return null;
    throw err;
  }
}

function parseScalarExprInner(
  input: ScalarExpr | string | number,
  options?: NormalizeLatexOptions & { forceNormalize?: boolean },
): ScalarExpr | null {
  if (typeof input === "number") return Number.isFinite(input) ? parseScalarExprInner(String(input), options) : null;
  if (typeof input !== "string") return input;
  const shouldNormalize =
    Boolean(options?.forceNormalize) ||
    Boolean(options?.matrixImplicitMul) ||
    Boolean(options?.implicitMulIdentifiers && options.implicitMulIdentifiers.length > 0) ||
    /[\\{}]/.test(input);
  const normalizedInput = shouldNormalize ? normalizeLatexExprInner(input, options) : input;
  if (normalizedInput === null) return null;
  const source = normalizedInput.replaceAll("−", "-").trim();
  if (!source) return null;
  precheckParseNestingDepth(source);
  let index = 0;
  let parseDepth = 0;
  let astNodes = 0;
  const makeNode = <T extends ScalarExpr>(node: T): T => {
    astNodes++;
    if (astNodes > MAX_PARSE_AST_NODES) throw new PolyComplexityError();
    return node;
  };
  const withDepth = <T>(fn: () => T): T => {
    parseDepth++;
    if (parseDepth > MAX_PARSE_DEPTH) throw new PolyComplexityError();
    try {
      return fn();
    } finally {
      parseDepth--;
    }
  };
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
      return withDepth(() => {
        const value = addSub();
        if (!value || !consume(")")) return null;
        return value;
      });
    }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(index));
    if (number) {
      index += number[0].length;
      return makeNode({ kind: "const", value: number[0] });
    }
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(source.slice(index));
    if (!name) return null;
    index += name[0].length;
    if (consume("(")) {
      return withDepth(() => {
        const value = addSub();
        if (!value || !consume(")")) return null;
        if (!["sqrt", "abs", "ln", "sin", "cos", "exp"].includes(name[0]!)) return null;
        return makeNode({ kind: name[0] as "sqrt" | "abs" | "ln" | "sin" | "cos" | "exp", value });
      });
    }
    return makeNode({ kind: "variable", name: name[0]! });
  };
  const power = (): ScalarExpr | null => {
    const base = primary();
    if (!base) return null;
    if (!consume("^")) return base;
    return withDepth(() => {
      const expExpr = unary();
      if (!expExpr) return null;
      const exponent = evaluateConstantInt(expExpr);
      if (exponent === null) return null;
      return makeNode({ kind: "pow", base, exponent });
    });
  };
  const unary = (): ScalarExpr | null => {
    skip();
    if (consume("-")) {
      return withDepth(() => {
        const value = unary();
        return value ? makeNode({ kind: "neg", value }) : null;
      });
    }
    if (consume("+")) {
      return withDepth(() => unary());
    }
    return power();
  };
  const mulDiv = (): ScalarExpr | null => {
    let left = unary();
    while (left) {
      if (consume("*")) {
        const right = unary();
        if (!right) return null;
        left = makeNode({ kind: "mul", left, right });
      } else if (consume("/")) {
        const right = unary();
        if (!right) return null;
        left = makeNode({ kind: "div", left, right });
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
        left = makeNode({ kind: "add", left, right });
      } else if (consume("-")) {
        const right = mulDiv();
        if (!right) return null;
        left = makeNode({ kind: "sub", left, right });
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
  try {
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
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { defined: false, reason: "polynomial_complexity_exceeded" };
    }
    throw err;
  }
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
  const out = new Map<bigint, SpanRational>();
  for (const [rad, coeff] of a) {
    checkPolyCoeffBound(coeff);
    out.set(rad, coeff);
  }
  for (const [rad, coeff] of b) {
    checkPolyCoeffBound(coeff);
    const next = sign === 1 ? addRational(out.get(rad) ?? rational(0n), coeff) : subtractRational(out.get(rad) ?? rational(0n), coeff);
    checkPolyCoeffBound(next);
    if (next.n === 0n) out.delete(rad);
    else out.set(rad, next);
  }
  return out;
}

function radicalMultiply(a: RadicalSum, b: RadicalSum): RadicalSum {
  const out = new Map<bigint, SpanRational>();
  for (const [d1, c1] of a) {
    checkPolyCoeffBound(c1);
    for (const [d2, c2] of b) {
      checkPolyCoeffBound(c2);
      const g = bigGcd(d1, d2);
      const d = (d1 / g) * (d2 / g);
      const term = multiplyRational(multiplyRational(c1, c2), rational(g));
      checkPolyCoeffBound(term);
      const next = addRational(out.get(d) ?? rational(0n), term);
      checkPolyCoeffBound(next);
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
  checkPolyCoeffBound(inv);
  const out = new Map<bigint, SpanRational>();
  for (const [k, v] of num) {
    checkPolyCoeffBound(v);
    const scaled = multiplyRational(v, inv);
    checkPolyCoeffBound(scaled);
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

function evaluateRadicalConst(
  expr: ScalarExpr,
  state: { steps: number } = { steps: 0 },
  depth = 0,
): { ok: true; value: RadicalSum } | { ok: false; defined: boolean; reason: string } {
  bumpAstSteps(state, depth);
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (!q) return { ok: false, defined: true, reason: "non_rational_constant" };
      checkPolyCoeffBound(q);
      return { ok: true, value: q.n === 0n ? new Map() : new Map([[1n, q]]) };
    }
    case "variable":
      return { ok: false, defined: true, reason: "contains_variable" };
    case "neg": {
      const inner = evaluateRadicalConst(expr.value, state, depth + 1);
      return inner.ok ? { ok: true, value: radicalAdd(new Map(), inner.value, -1) } : inner;
    }
    case "abs": {
      const inner = evaluateRadicalConst(expr.value, state, depth + 1);
      if (!inner.ok) return inner;
      const sign = radicalSign(inner.value);
      if (sign === null) return { ok: false, defined: true, reason: "ambiguous_radical_sign" };
      return { ok: true, value: sign < 0 ? radicalAdd(new Map(), inner.value, -1) : inner.value };
    }
    case "sqrt": {
      const inner = evaluateRadicalConst(expr.value, state, depth + 1);
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
      const left = evaluateRadicalConst(expr.left, state, depth + 1);
      if (!left.ok) return left;
      const right = evaluateRadicalConst(expr.right, state, depth + 1);
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
      const base = evaluateRadicalConst(expr.base, state, depth + 1);
      if (!base.ok) return base;
      if (expr.exponent === 0) {
        return base.value.size === 0
          ? { ok: false, defined: false, reason: "natural_domain_denominator_zero" }
          : { ok: true, value: new Map([[1n, rational(1n)]]) };
      }
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
  try {
    return simplifyRadicalInner(expr);
  } catch (err) {
    if (err instanceof PolyComplexityError || err instanceof MPolyOverflowError) {
      return expr;
    }
    throw err;
  }
}

function simplifyRadicalInner(expr: ScalarExpr, state: { steps: number } = { steps: 0 }, depth = 0): ScalarExpr {
  bumpAstSteps(state, depth);
  const evaluated = evaluateRadicalConst(expr, state, depth);
  if (evaluated.ok) return radicalSumToExpr(evaluated.value);
  if (expr.kind === "sqrt") {
    const inner = simplifyRadicalInner(expr.value, state, depth + 1);
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
    const left = simplifyRadicalInner(expr.left, state, depth + 1);
    const right = simplifyRadicalInner(expr.right, state, depth + 1);
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
    return { ...expr, left: simplifyRadicalInner(expr.left, state, depth + 1), right: simplifyRadicalInner(expr.right, state, depth + 1) };
  }
  if (expr.kind === "neg") return { kind: "neg", value: simplifyRadicalInner(expr.value, state, depth + 1) };
  if (expr.kind === "pow") return { kind: "pow", base: simplifyRadicalInner(expr.base, state, depth + 1), exponent: expr.exponent };
  if (expr.kind === "abs" || expr.kind === "ln" || expr.kind === "sin" || expr.kind === "cos" || expr.kind === "exp") {
    return { kind: expr.kind, value: simplifyRadicalInner(expr.value, state, depth + 1) };
  }
  return expr;
}

type DomainConstraint =
  | { kind: "nonzero"; poly: Polynomial }
  | { kind: "ge0"; poly: Polynomial }
  | { kind: "gt0"; poly: Polynomial };

type QuadBinomialConstraint = {
  a: RationalForm;
  p: RationalForm;
  b: RationalForm;
  q: RationalForm;
  locus: Polynomial;
};

type UncheckedDomainOp = {
  kind: "nonzero" | "ge0" | "gt0";
  expr: ScalarExpr;
};

type CollectedConstraints = {
  rational: DomainConstraint[];
  quadBinomials: QuadBinomialConstraint[];
  splitPolys: Polynomial[];
  uncheckedOps: UncheckedDomainOp[];
  hasNonRationalDomainOps: boolean;
  alwaysUndefined: boolean;
};

function rfConst(q: SpanRational): RationalForm {
  return {
    numerator: polynomialConstant(q),
    denominator: polynomialConstant(rational(1n)),
    domainDenominators: [],
  };
}

function rfNeg(a: RationalForm): RationalForm {
  return {
    ...a,
    numerator: polynomialScale(a.numerator, rational(-1n)),
  };
}

function rfAdd(a: RationalForm, b: RationalForm, sign: 1 | -1 = 1, budget: PolyMulBudget = { mulSteps: 0 }): RationalForm {
  if (a.unsupported || b.unsupported) {
    return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: a.unsupported ?? b.unsupported };
  }
  const leftTerm = boundedPolyMultiply(a.numerator, b.denominator, budget);
  const rightTerm = boundedPolyMultiply(b.numerator, a.denominator, budget);
  const denominator = boundedPolyMultiply(a.denominator, b.denominator, budget);
  if (!leftTerm || !rightTerm || !denominator) return polyComplexityFailure();
  const numerator = polynomialAdd(leftTerm, rightTerm, sign);
  if (exceedsPolyLimits(numerator)) return polyComplexityFailure();
  return {
    numerator,
    denominator,
    domainDenominators: [...a.domainDenominators, ...b.domainDenominators],
    zeroDenominator: a.zeroDenominator || b.zeroDenominator,
  };
}

function rfMul(a: RationalForm, b: RationalForm, budget: PolyMulBudget = { mulSteps: 0 }): RationalForm {
  if (a.unsupported || b.unsupported) {
    return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: a.unsupported ?? b.unsupported };
  }
  const numerator = boundedPolyMultiply(a.numerator, b.numerator, budget);
  const denominator = boundedPolyMultiply(a.denominator, b.denominator, budget);
  if (!numerator || !denominator) return polyComplexityFailure();
  return {
    numerator,
    denominator,
    domainDenominators: [...a.domainDenominators, ...b.domainDenominators],
    zeroDenominator: a.zeroDenominator || b.zeroDenominator,
  };
}

function rfDiv(a: RationalForm, b: RationalForm, budget: PolyMulBudget = { mulSteps: 0 }): RationalForm {
  if (a.unsupported || b.unsupported) {
    return { numerator: new Map(), denominator: new Map(), domainDenominators: [], unsupported: a.unsupported ?? b.unsupported };
  }
  const numerator = boundedPolyMultiply(a.numerator, b.denominator, budget);
  const denominator = boundedPolyMultiply(a.denominator, b.numerator, budget);
  if (!numerator || !denominator) return polyComplexityFailure();
  return {
    numerator,
    denominator,
    domainDenominators: [...a.domainDenominators, ...b.domainDenominators, b.numerator, b.denominator],
    zeroDenominator: a.zeroDenominator || b.zeroDenominator || b.numerator.size === 0 || b.denominator.size === 0,
  };
}

function rfEqual(a: RationalForm, b: RationalForm): boolean {
  if (a.unsupported || b.unsupported || a.denominator.size === 0 || b.denominator.size === 0) return false;
  const budget: PolyMulBudget = { mulSteps: 0 };
  const left = boundedPolyMultiply(a.numerator, b.denominator, budget);
  const right = boundedPolyMultiply(b.numerator, a.denominator, budget);
  if (!left || !right) return false;
  return polynomialAdd(left, right, -1).size === 0;
}

type LinearRadicalComb = {
  constTerm: RationalForm;
  rads: Array<{ coeff: RationalForm; radicand: RationalForm }>;
};

function extractLinearRadicalCombination(
  expr: ScalarExpr,
  variable: string,
  state: { steps: number } = { steps: 0 },
  depth = 0,
): LinearRadicalComb | null {
  bumpAstSteps(state, depth);
  const rf = rationalForm(expr, variable);
  if (!rf.unsupported) {
    return { constTerm: rf, rads: [] };
  }
  switch (expr.kind) {
    case "neg": {
      const inner = extractLinearRadicalCombination(expr.value, variable, state, depth + 1);
      if (!inner) return null;
      return {
        constTerm: rfNeg(inner.constTerm),
        rads: inner.rads.map((r) => ({ coeff: rfNeg(r.coeff), radicand: r.radicand })),
      };
    }
    case "add":
    case "sub": {
      const l = extractLinearRadicalCombination(expr.left, variable, state, depth + 1);
      const r = extractLinearRadicalCombination(expr.right, variable, state, depth + 1);
      if (!l || !r) return null;
      const sign: 1 | -1 = expr.kind === "add" ? 1 : -1;
      const constTerm = rfAdd(l.constTerm, r.constTerm, sign);
      const rads = l.rads.map((item) => ({ ...item }));
      for (const item of r.rads) {
        const signedCoeff = sign === 1 ? item.coeff : rfNeg(item.coeff);
        const existing = rads.find((x) => rfEqual(x.radicand, item.radicand));
        if (existing) {
          existing.coeff = rfAdd(existing.coeff, signedCoeff, 1);
        } else {
          rads.push({ coeff: signedCoeff, radicand: item.radicand });
        }
      }
      const nonZeroRads = rads.filter((item) => item.coeff.numerator.size > 0);
      if (nonZeroRads.length > 2) return null;
      return { constTerm, rads: nonZeroRads };
    }
    case "mul": {
      const l = extractLinearRadicalCombination(expr.left, variable, state, depth + 1);
      const r = extractLinearRadicalCombination(expr.right, variable, state, depth + 1);
      if (!l || !r) return null;
      if (l.rads.length === 0) {
        return {
          constTerm: rfMul(l.constTerm, r.constTerm),
          rads: r.rads.map((item) => ({ coeff: rfMul(l.constTerm, item.coeff), radicand: item.radicand })),
        };
      }
      if (r.rads.length === 0) {
        return {
          constTerm: rfMul(l.constTerm, r.constTerm),
          rads: l.rads.map((item) => ({ coeff: rfMul(item.coeff, r.constTerm), radicand: item.radicand })),
        };
      }
      return null;
    }
    case "div": {
      const l = extractLinearRadicalCombination(expr.left, variable, state, depth + 1);
      const r = extractLinearRadicalCombination(expr.right, variable, state, depth + 1);
      if (!l || !r || r.rads.length > 0 || r.constTerm.numerator.size === 0) return null;
      return {
        constTerm: rfDiv(l.constTerm, r.constTerm),
        rads: l.rads.map((item) => ({ coeff: rfDiv(item.coeff, r.constTerm), radicand: item.radicand })),
      };
    }
    case "sqrt": {
      const innerRf = rationalForm(expr.value, variable);
      if (innerRf.unsupported) return null;
      return {
        constTerm: rfConst(rational(0n)),
        rads: [{ coeff: rfConst(rational(1n)), radicand: innerRf }],
      };
    }
    default:
      return null;
  }
}

type SignMemo = { pos: WeakMap<object, boolean>; nonneg: WeakMap<object, boolean>; steps: number };

function isProvablyPositiveExpr(
  expr: ScalarExpr,
  memo: SignMemo = { pos: new WeakMap(), nonneg: new WeakMap(), steps: 0 },
  depth = 0,
): boolean {
  const cached = memo.pos.get(expr);
  if (cached !== undefined) return cached;
  bumpAstSteps(memo, depth);
  let result = false;
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      result = q !== null && q.n > 0n;
      break;
    }
    case "exp":
      result = true;
      break;
    case "add":
      result =
        (isProvablyPositiveExpr(expr.left, memo, depth + 1) && isProvablyNonnegExpr(expr.right, memo, depth + 1)) ||
        (isProvablyNonnegExpr(expr.left, memo, depth + 1) && isProvablyPositiveExpr(expr.right, memo, depth + 1));
      break;
    case "mul":
    case "div":
      result = isProvablyPositiveExpr(expr.left, memo, depth + 1) && isProvablyPositiveExpr(expr.right, memo, depth + 1);
      break;
    case "pow":
      result = expr.exponent !== 0 && isProvablyPositiveExpr(expr.base, memo, depth + 1);
      break;
  }
  memo.pos.set(expr, result);
  return result;
}

function isProvablyNonnegExpr(
  expr: ScalarExpr,
  memo: SignMemo = { pos: new WeakMap(), nonneg: new WeakMap(), steps: 0 },
  depth = 0,
): boolean {
  const cached = memo.nonneg.get(expr);
  if (cached !== undefined) return cached;
  bumpAstSteps(memo, depth);
  if (isProvablyPositiveExpr(expr, memo, depth + 1)) {
    memo.nonneg.set(expr, true);
    return true;
  }
  let result = false;
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      result = q !== null && q.n >= 0n;
      break;
    }
    case "abs":
    case "sqrt":
      result = true;
      break;
    case "pow":
      result = expr.exponent >= 0 && expr.exponent % 2 === 0;
      break;
    case "add":
    case "mul":
      result = isProvablyNonnegExpr(expr.left, memo, depth + 1) && isProvablyNonnegExpr(expr.right, memo, depth + 1);
      break;
    case "div":
      result = isProvablyNonnegExpr(expr.left, memo, depth + 1) && isProvablyPositiveExpr(expr.right, memo, depth + 1);
      break;
  }
  memo.nonneg.set(expr, result);
  return result;
}

function collectConstraints(expr: ScalarExpr, variable: string): CollectedConstraints {
  const rationalList: DomainConstraint[] = [];
  const quadBinomials: QuadBinomialConstraint[] = [];
  const splitPolys: Polynomial[] = [];
  const uncheckedOps: UncheckedDomainOp[] = [];
  let hasNonRationalDomainOps = false;
  let alwaysUndefined = false;
  const walkState = { steps: 0 };
  const signMemo: SignMemo = { pos: new WeakMap(), nonneg: new WeakMap(), steps: 0 };

  const pushSplitPoly = (poly: Polynomial) => {
    if (polynomialDegree(poly) >= 1) splitPolys.push(poly);
  };

  const addRfDens = (rf: RationalForm) => {
    if (rf.zeroDenominator) alwaysUndefined = true;
    for (const den of rf.domainDenominators) {
      if (den.size === 0) alwaysUndefined = true;
      else if (polynomialDegree(den) >= 1) rationalList.push({ kind: "nonzero", poly: den });
    }
    if (rf.denominator.size === 0) alwaysUndefined = true;
    else if (polynomialDegree(rf.denominator) >= 1) rationalList.push({ kind: "nonzero", poly: rf.denominator });
  };

  const pushQuadBinomial = (a: RationalForm, p: RationalForm, b: RationalForm, q: RationalForm): boolean => {
    addRfDens(a);
    addRfDens(p);
    addRfDens(b);
    addRfDens(q);
    const locusRf = rfAdd(rfMul(rfMul(a, a), p), rfMul(rfMul(b, b), q), -1);
    if (locusRf.zeroDenominator || locusRf.denominator.size === 0) {
      alwaysUndefined = true;
      return true;
    }
    const locus = locusRf.numerator;
    quadBinomials.push({ a, p, b, q, locus });
    pushSplitPoly(locus);
    pushSplitPoly(a.numerator);
    pushSplitPoly(a.denominator);
    pushSplitPoly(b.numerator);
    pushSplitPoly(b.denominator);
    pushSplitPoly(p.numerator);
    pushSplitPoly(p.denominator);
    pushSplitPoly(q.numerator);
    pushSplitPoly(q.denominator);
    return true;
  };

  const extractDenominatorConstraints = (denExpr: ScalarExpr, depth = 0) => {
    bumpAstSteps(walkState, depth);
    switch (denExpr.kind) {
      case "neg":
      case "abs":
        extractDenominatorConstraints(denExpr.value, depth + 1);
        return;
      case "pow":
        if (denExpr.exponent > 0) extractDenominatorConstraints(denExpr.base, depth + 1);
        return;
      case "mul":
        extractDenominatorConstraints(denExpr.left, depth + 1);
        extractDenominatorConstraints(denExpr.right, depth + 1);
        return;
      case "div":
        extractDenominatorConstraints(denExpr.left, depth + 1);
        return;
      default:
        break;
    }
    const rf = rationalForm(denExpr, variable);
    if (rf.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
    if (!rf.unsupported) {
      addRfDens(rf);
      if (rf.numerator.size === 0) alwaysUndefined = true;
      else if (polynomialDegree(rf.numerator) >= 1) rationalList.push({ kind: "nonzero", poly: rf.numerator });
      return;
    }
    const lin = extractLinearRadicalCombination(denExpr, variable, walkState, depth + 1);
    if (lin) {
      if (lin.rads.length === 0) {
        addRfDens(lin.constTerm);
        if (lin.constTerm.numerator.size === 0) alwaysUndefined = true;
        else if (polynomialDegree(lin.constTerm.numerator) >= 1) {
          rationalList.push({ kind: "nonzero", poly: lin.constTerm.numerator });
        }
        return;
      }
      if (lin.rads.length === 1) {
        pushQuadBinomial(lin.rads[0]!.coeff, lin.rads[0]!.radicand, lin.constTerm, rfConst(rational(1n)));
        return;
      }
      if (lin.rads.length === 2 && lin.constTerm.numerator.size === 0) {
        pushQuadBinomial(lin.rads[0]!.coeff, lin.rads[0]!.radicand, lin.rads[1]!.coeff, lin.rads[1]!.radicand);
        return;
      }
    }
    if (isProvablyPositiveExpr(denExpr, signMemo, depth + 1)) return;
    uncheckedOps.push({ kind: "nonzero", expr: denExpr });
    hasNonRationalDomainOps = true;
  };

  const walk = (node: ScalarExpr, depth = 0) => {
    bumpAstSteps(walkState, depth);
    switch (node.kind) {
      case "const":
      case "variable":
        return;
      case "neg":
      case "sin":
      case "cos":
      case "exp":
        walk(node.value, depth + 1);
        return;
      case "abs": {
        walk(node.value, depth + 1);
        const rf = rationalForm(node.value, variable);
        if (rf.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
        if (!rf.unsupported) {
          addRfDens(rf);
          pushSplitPoly(rf.numerator);
          pushSplitPoly(rf.denominator);
          for (const den of rf.domainDenominators) pushSplitPoly(den);
        } else {
          const lin = extractLinearRadicalCombination(node.value, variable, walkState, depth + 1);
          if (lin && (lin.rads.length === 1 || (lin.rads.length === 2 && lin.constTerm.numerator.size === 0))) {
            const a = lin.rads[0]!.coeff;
            const p = lin.rads[0]!.radicand;
            const b = lin.rads.length === 1 ? lin.constTerm : lin.rads[1]!.coeff;
            const q = lin.rads.length === 1 ? rfConst(rational(1n)) : lin.rads[1]!.radicand;
            const locusRf = rfAdd(rfMul(rfMul(a, a), p), rfMul(rfMul(b, b), q), -1);
            if (!locusRf.zeroDenominator) pushSplitPoly(locusRf.numerator);
          }
        }
        return;
      }
      case "add":
      case "sub":
      case "mul":
        walk(node.left, depth + 1);
        walk(node.right, depth + 1);
        return;
      case "div": {
        walk(node.left, depth + 1);
        walk(node.right, depth + 1);
        extractDenominatorConstraints(node.right, depth + 1);
        return;
      }
      case "pow": {
        walk(node.base, depth + 1);
        if (node.exponent <= 0) {
          extractDenominatorConstraints(node.base, depth + 1);
        }
        return;
      }
      case "sqrt": {
        walk(node.value, depth + 1);
        const rf = rationalForm(node.value, variable);
        if (rf.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
        if (!rf.unsupported) {
          addRfDens(rf);
          const prod = boundedPolyMultiply(rf.numerator, rf.denominator, { mulSteps: 0 });
          if (prod) {
            if (prod.size > 0) rationalList.push({ kind: "ge0", poly: prod });
          } else {
            uncheckedOps.push({ kind: "ge0", expr: node.value });
            hasNonRationalDomainOps = true;
          }
        } else if (!isProvablyNonnegExpr(node.value, signMemo, depth + 1)) {
          uncheckedOps.push({ kind: "ge0", expr: node.value });
          hasNonRationalDomainOps = true;
        }
        return;
      }
      case "ln": {
        walk(node.value, depth + 1);
        if (node.value.kind === "abs") {
          const rfAbs = rationalForm(node.value.value, variable);
          if (rfAbs.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
          if (!rfAbs.unsupported) {
            addRfDens(rfAbs);
            if (rfAbs.numerator.size === 0) alwaysUndefined = true;
            else if (polynomialDegree(rfAbs.numerator) >= 1) rationalList.push({ kind: "nonzero", poly: rfAbs.numerator });
            return;
          }
        }
        const rf = rationalForm(node.value, variable);
        if (rf.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
        if (!rf.unsupported) {
          addRfDens(rf);
          const prod = boundedPolyMultiply(rf.numerator, rf.denominator, { mulSteps: 0 });
          if (prod) {
            if (prod.size === 0) alwaysUndefined = true;
            else rationalList.push({ kind: "gt0", poly: prod });
          } else {
            uncheckedOps.push({ kind: "gt0", expr: node.value });
            hasNonRationalDomainOps = true;
          }
        } else if (!isProvablyPositiveExpr(node.value, signMemo, depth + 1)) {
          uncheckedOps.push({ kind: "gt0", expr: node.value });
          hasNonRationalDomainOps = true;
        }
        return;
      }
    }
  };

  walk(expr);
  return { rational: rationalList, quadBinomials, splitPolys, uncheckedOps, hasNonRationalDomainOps, alwaysUndefined };
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
  | { kind: "isolated"; low: SpanRational; high: SpanRational; master: Polynomial; bracketed?: boolean };

function signAtSampleSite(poly: Polynomial, site: SampleSite): -1 | 0 | 1 {
  if (poly.size === 0) return 0;
  if (site.kind === "rational") return signOfBigint(polynomialEvaluate(poly, site.x).n);
  const g = polynomialGcd(poly, site.master);
  if (
    polynomialDegree(g) >= 1 &&
    sturmCount(g, { left: site.low, right: site.high, leftOpen: true, rightOpen: true }) === 1
  ) {
    return 0;
  }
  const mid = divideRational(addRational(site.low, site.high), rational(2n));
  return signOfBigint(polynomialEvaluate(poly, mid).n);
}

function rationalFormSignAtSite(rf: RationalForm, site: SampleSite): -1 | 0 | 1 | null {
  const denSign = signAtSampleSite(rf.denominator, site);
  if (denSign === 0) return null;
  const numSign = signAtSampleSite(rf.numerator, site);
  return (numSign * denSign) as -1 | 0 | 1;
}

function quadBinomialIsZeroAtSite(qb: QuadBinomialConstraint, site: SampleSite): boolean {
  const sLocus = qb.locus.size === 0 ? 0 : signAtSampleSite(qb.locus, site);
  if (sLocus !== 0) return false;
  const sA = rationalFormSignAtSite(qb.a, site);
  const sB = rationalFormSignAtSite(qb.b, site);
  const sP = rationalFormSignAtSite(qb.p, site);
  const sQ = rationalFormSignAtSite(qb.q, site);
  if (sA === null || sB === null || sP === null || sQ === null) return false;
  if (sA === 0 && sB === 0) return true;
  if (sA === 0 && sQ === 0) return true;
  if (sB === 0 && sP === 0) return true;
  if (sP === 0 && sQ === 0) return true;
  return sA * sB === -1;
}

function constraintsSatisfiedAtSite(
  constraints: Pick<CollectedConstraints, "rational" | "quadBinomials">,
  site: SampleSite,
): boolean {
  for (const c of constraints.rational) {
    const sign = signAtSampleSite(c.poly, site);
    if (c.kind === "nonzero" && sign === 0) return false;
    if (c.kind === "ge0" && sign < 0) return false;
    if (c.kind === "gt0" && sign <= 0) return false;
  }
  for (const qb of constraints.quadBinomials) {
    if (quadBinomialIsZeroAtSite(qb, site)) return false;
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

type CadOpenCell = { left: SpanRational | null; right: SpanRational | null; sample: SpanRational };
type CadPlan = { sites: SampleSite[]; openCells: CadOpenCell[]; unresolvedRootIsolation: boolean; complexityExceeded?: boolean };

function buildCadPlan(
  constraints: readonly DomainConstraint[],
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
  extraSplitPolys: readonly Polynomial[] = [],
): CadPlan {
  try {
    return buildCadPlanInner(constraints, parsedDomain, extraSplitPolys);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { sites: [], openCells: [], unresolvedRootIsolation: true, complexityExceeded: true };
    }
    throw err;
  }
}

function buildCadPlanInner(
  constraints: readonly DomainConstraint[],
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
  extraSplitPolys: readonly Polynomial[] = [],
): CadPlan {
  let master = polynomialConstant(rational(1n));
  const cadBudget: PolyMulBudget = { mulSteps: 0 };
  for (const c of constraints) {
    if (polynomialDegree(c.poly) < 1) continue;
    const sf = polynomialSquareFree(c.poly);
    const g = polynomialGcd(master, sf);
    const factor = polynomialDegree(g) >= 1 ? polynomialDivMod(sf, g).quotient : sf;
    if (polynomialDegree(factor) >= 1) {
      const nextMaster = boundedPolyMultiply(master, factor, cadBudget);
      if (!nextMaster) return { sites: [], openCells: [], unresolvedRootIsolation: true, complexityExceeded: true };
      master = polynomialPrimitivePositive(nextMaster);
    }
  }
  for (const p of extraSplitPolys) {
    if (polynomialDegree(p) < 1) continue;
    const sf = polynomialSquareFree(p);
    const g = polynomialGcd(master, sf);
    const factor = polynomialDegree(g) >= 1 ? polynomialDivMod(sf, g).quotient : sf;
    if (polynomialDegree(factor) >= 1) {
      const nextMaster = boundedPolyMultiply(master, factor, cadBudget);
      if (!nextMaster) return { sites: [], openCells: [], unresolvedRootIsolation: true, complexityExceeded: true };
      master = polynomialPrimitivePositive(nextMaster);
    }
  }

  const sites: SampleSite[] = [];
  const openCells: CadOpenCell[] = [];
  let unresolvedRootIsolation = false;
  const pushRationalSite = (x: SpanRational) => {
    if (!sites.some((s) => s.kind === "rational" && equalRational(s.x, x))) {
      sites.push({ kind: "rational", x });
    }
  };

  for (const iv of parsedDomain.intervals) {
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
      if (
        pointInInterval(candidate, iv) &&
        !parsedDomain.excluded.some((e) => equalRational(e, candidate)) &&
        polynomialEvaluate(master, candidate).n !== 0n
      ) {
        pushRationalSite(candidate);
        openCells.push({ left: leftBound, right: rightBound, sample: candidate });
      } else {
        unresolvedRootIsolation = true;
      }
    };

    if (iv.left !== null && !iv.leftOpen && !parsedDomain.excluded.some((e) => equalRational(e, iv.left!))) {
      pushRationalSite(iv.left);
    }
    if (iv.right !== null && !iv.rightOpen && !parsedDomain.excluded.some((e) => equalRational(e, iv.right!))) {
      pushRationalSite(iv.right);
    }

    const isolated = polynomialDegree(master) >= 1 ? isolateRealRoots(master, iv) : { roots: [], unresolvedRootIsolation: false };
    if (isolated.unresolvedRootIsolation) unresolvedRootIsolation = true;
    const roots = isolated.roots;
    const rootBounds: Array<{ low: SpanRational; high: SpanRational }> = [];
    for (const r of roots) {
      if (r.kind === "exact") {
        if (!parsedDomain.excluded.some((e) => equalRational(e, r.value))) {
          pushRationalSite(r.value);
        }
        rootBounds.push({ low: r.value, high: r.value });
      } else {
        let curLo = r.low;
        let curHi = r.high;
        let leftWitness: SpanRational | null = null;
        let rightWitness: SpanRational | null = null;
        let exactRootMid: SpanRational | null = null;
        for (let step = 0; step < 64 && (leftWitness === null || rightWitness === null); step++) {
          const mid = divideRational(addRational(curLo, curHi), rational(2n));
          if (polynomialEvaluate(master, mid).n === 0n) {
            exactRootMid = mid;
            break;
          }
          const leftCount = sturmCount(master, { left: curLo, right: mid, leftOpen: true, rightOpen: true });
          if (leftCount === 0) {
            if (pointInInterval(mid, iv) && !parsedDomain.excluded.some((e) => equalRational(e, mid))) {
              leftWitness = mid;
            }
            curLo = mid;
          } else if (leftCount === 1) {
            if (pointInInterval(mid, iv) && !parsedDomain.excluded.some((e) => equalRational(e, mid))) {
              rightWitness = mid;
            }
            curHi = mid;
          } else {
            unresolvedRootIsolation = true;
            break;
          }
        }
        if (exactRootMid !== null && sturmCount(master, { left: r.low, right: r.high, leftOpen: true, rightOpen: true }) === 1) {
          if (pointInInterval(exactRootMid, iv) && !parsedDomain.excluded.some((e) => equalRational(e, exactRootMid))) {
            pushRationalSite(exactRootMid);
          }
          emitOpenSample(r.low, exactRootMid);
          emitOpenSample(exactRootMid, r.high);
          rootBounds.push({ low: r.low, high: r.high });
          continue;
        }
        if (exactRootMid === null && (leftWitness === null || rightWitness === null)) {
          unresolvedRootIsolation = true;
        }
        if (leftWitness !== null) {
          pushRationalSite(leftWitness);
          if (compareRational(r.low, curLo) < 0) openCells.push({ left: r.low, right: curLo, sample: leftWitness });
        }
        sites.push({ kind: "isolated", low: curLo, high: curHi, master, bracketed: leftWitness !== null && rightWitness !== null });
        if (rightWitness !== null) {
          pushRationalSite(rightWitness);
          if (compareRational(curHi, r.high) < 0) openCells.push({ left: curHi, right: r.high, sample: rightWitness });
        }
        rootBounds.push({ low: r.low, high: r.high });
      }
    }

    if (rootBounds.length === 0) {
      if (iv.left && iv.right && equalRational(iv.left, iv.right)) {
        if (!parsedDomain.excluded.some((e) => equalRational(e, iv.left!))) {
          pushRationalSite(iv.left);
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
            pushRationalSite(rightPrev);
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
      if (pointInInterval(q, iv) && !parsedDomain.excluded.some((e) => equalRational(e, q))) {
        pushRationalSite(q);
      }
    }
  }
  return { sites, openCells, unresolvedRootIsolation };
}

function evaluateExactRationalExt(
  expr: ScalarExpr,
  x: SpanRational,
  variable: string,
  state: { steps: number } = { steps: 0 },
  depth = 0,
): { status: "value"; value: SpanRational } | { status: "undefined_domain"; reason: string } | { status: "unsupported"; reason: string } {
  bumpAstSteps(state, depth);
  switch (expr.kind) {
    case "const": {
      const v = toRational(expr.value);
      if (!v) return { status: "unsupported", reason: "non_rational_constant" };
      checkPolyCoeffBound(v);
      return { status: "value", value: v };
    }
    case "variable":
      return expr.name === variable ? { status: "value", value: x } : { status: "unsupported", reason: "foreign_variable" };
    case "neg": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      const out = rational(-inner.value.n, inner.value.d);
      checkPolyCoeffBound(out);
      return { status: "value", value: out };
    }
    case "abs": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      const out = inner.value.n < 0n ? rational(-inner.value.n, inner.value.d) : inner.value;
      checkPolyCoeffBound(out);
      return { status: "value", value: out };
    }
    case "sqrt": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      if (inner.value.n < 0n) return { status: "undefined_domain", reason: "even_root_domain" };
      const n = integerSquareRoot(inner.value.n);
      const d = integerSquareRoot(inner.value.d);
      if (n === null || d === null) return { status: "unsupported", reason: "irrational_radical" };
      const out = rational(n, d);
      checkPolyCoeffBound(out);
      return { status: "value", value: out };
    }
    case "ln": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      if (inner.value.n <= 0n) return { status: "undefined_domain", reason: "ln_domain" };
      return inner.value.n === 1n && inner.value.d === 1n ? { status: "value", value: rational(0n) } : { status: "unsupported", reason: "irrational_ln" };
    }
    case "sin": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      return inner.value.n === 0n ? { status: "value", value: rational(0n) } : { status: "unsupported", reason: "irrational_sin" };
    }
    case "cos": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      return inner.value.n === 0n ? { status: "value", value: rational(1n) } : { status: "unsupported", reason: "irrational_cos" };
    }
    case "exp": {
      const inner = evaluateExactRationalExt(expr.value, x, variable, state, depth + 1);
      if (inner.status !== "value") return inner;
      return inner.value.n === 0n ? { status: "value", value: rational(1n) } : { status: "unsupported", reason: "irrational_exp" };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const left = evaluateExactRationalExt(expr.left, x, variable, state, depth + 1);
      const right = evaluateExactRationalExt(expr.right, x, variable, state, depth + 1);
      if (left.status === "undefined_domain") return left;
      if (right.status === "undefined_domain") return right;
      if (expr.kind === "div" && right.status === "value" && right.value.n === 0n) {
        return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
      }
      if (left.status !== "value") return left;
      if (right.status !== "value") return right;
      const out =
        expr.kind === "add"
          ? addRational(left.value, right.value)
          : expr.kind === "sub"
            ? subtractRational(left.value, right.value)
            : expr.kind === "mul"
              ? multiplyRational(left.value, right.value)
              : divideRational(left.value, right.value);
      checkPolyCoeffBound(out);
      return { status: "value", value: out };
    }
    case "pow": {
      const base = evaluateExactRationalExt(expr.base, x, variable, state, depth + 1);
      if (base.status === "undefined_domain") return base;
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) {
        return { status: "unsupported", reason: "power_out_of_bounds" };
      }
      if (base.status !== "value") return base;
      if (expr.exponent <= 0 && base.value.n === 0n) return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
      let val = rational(1n);
      const step = expr.exponent >= 0 ? base.value : rational(base.value.d, base.value.n);
      checkPolyCoeffBound(step);
      for (let i = 0; i < Math.abs(expr.exponent); i++) {
        val = multiplyRational(val, step);
        checkPolyCoeffBound(val);
      }
      return { status: "value", value: val };
    }
  }
}

type FloatEvalResult =
  | { status: "ok"; value: number; err: number; marginOk: boolean; irrational: boolean; exactZero?: boolean }
  | { status: "undefined_domain"; reason: string }
  | { status: "unstable" };

function rationalToFloatArg(q: SpanRational): { fx: number; xRadius: number } | null {
  if (q.n === 0n) return { fx: 0, xRadius: 0 };
  let fx: number;
  const nNum = Number(q.n);
  const dNum = Number(q.d);
  if (Number.isFinite(nNum) && Number.isFinite(dNum)) {
    fx = nNum / dNum;
  } else {
    const sign = q.n < 0n ? -1 : 1;
    const absN = q.n < 0n ? -q.n : q.n;
    const absD = q.d;
    const shift = absN.toString(2).length - absD.toString(2).length;
    if (shift > 1024 || shift < -1075) return null;
    const scaleShift = 60 - shift;
    const scaled = scaleShift >= 0 ? (absN << BigInt(scaleShift)) / absD : absN / (absD << BigInt(-scaleShift));
    const unit = Number(scaled) * 2 ** -60;
    fx = shift < -1022 ? sign * unit * 2 ** -1022 * 2 ** (shift + 1022) : sign * unit * 2 ** shift;
  }
  if (!Number.isFinite(fx) || (q.n !== 0n && fx === 0)) return null;
  const isExactSafeInt = q.d === 1n && Number.isSafeInteger(fx) && BigInt(fx) === q.n;
  const xRadius = isExactSafeInt ? 0 : Math.abs(fx) * 1e-13 + Number.MIN_VALUE;
  return { fx, xRadius };
}

function evaluateFloatSafe(
  expr: ScalarExpr,
  x: number,
  variable: string,
  xRadius = 0,
  state: { steps: number } = { steps: 0 },
  depth = 0,
): FloatEvalResult {
  bumpAstSteps(state, depth);
  const BOUND_EPS = 1e-9;
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (q) {
        const arg = rationalToFloatArg(q);
        if (!arg) return { status: "unstable" };
        return {
          status: "ok",
          value: arg.fx,
          err: arg.xRadius,
          marginOk: true,
          irrational: false,
          exactZero: q.n === 0n,
        };
      }
      const val = Number(expr.value);
      return Number.isFinite(val)
        ? {
            status: "ok",
            value: val,
            err: Number.isSafeInteger(val) ? 0 : Math.abs(val) * 1e-13 + Number.MIN_VALUE,
            marginOk: true,
            irrational: !Number.isInteger(val),
            exactZero: false,
          }
        : { status: "unstable" };
    }
    case "variable": {
      if (expr.name !== variable) return { status: "unstable" };
      const exactInt = xRadius === 0 && Number.isSafeInteger(x);
      const err = exactInt ? 0 : xRadius + Math.abs(x) * 1e-14 + (xRadius > 0 ? 1e-15 : 0);
      return {
        status: "ok",
        value: x,
        err,
        marginOk: xRadius === 0 || Math.abs(x) > BOUND_EPS + err,
        irrational: xRadius > 0,
        exactZero: x === 0 && xRadius === 0,
      };
    }
    case "neg": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      return inner.status === "ok"
        ? {
            status: "ok",
            value: -inner.value,
            err: inner.err,
            marginOk: inner.marginOk,
            irrational: inner.irrational,
            exactZero: inner.exactZero,
          }
        : inner;
    }
    case "abs": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      return inner.status === "ok"
        ? {
            status: "ok",
            value: Math.abs(inner.value),
            err: inner.err,
            marginOk: inner.marginOk && Math.abs(inner.value) > BOUND_EPS + inner.err,
            irrational: inner.irrational,
            exactZero: inner.exactZero,
          }
        : inner;
    }
    case "sqrt": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      if (inner.status !== "ok") return inner;
      if (inner.value + inner.err < -BOUND_EPS) return { status: "undefined_domain", reason: "even_root_domain" };
      if (inner.exactZero && inner.value === 0) {
        return { status: "ok", value: 0, err: 0, marginOk: inner.marginOk, irrational: false, exactZero: true };
      }
      if (inner.value - inner.err < BOUND_EPS) return { status: "unstable" };
      const s = Math.sqrt(inner.value);
      const minInner = inner.value - inner.err;
      const exactInt = !inner.irrational && inner.err === 0 && Number.isSafeInteger(inner.value) && Number.isSafeInteger(s);
      const err = exactInt ? 0 : inner.err / (2 * Math.sqrt(minInner)) + s * 1e-13;
      return Number.isFinite(err)
        ? { status: "ok", value: s, err, marginOk: inner.marginOk, irrational: !exactInt, exactZero: false }
        : { status: "unstable" };
    }
    case "ln": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      if (inner.status !== "ok") return inner;
      if (inner.exactZero || inner.value + inner.err < -BOUND_EPS) {
        return { status: "undefined_domain", reason: "ln_domain" };
      }
      if (inner.value - inner.err <= BOUND_EPS) return { status: "unstable" };
      const exactZero = !inner.irrational && inner.err === 0 && inner.value === 1;
      const val = exactZero ? 0 : Math.log(inner.value);
      const err = exactZero ? 0 : inner.err / (inner.value - inner.err) + Math.abs(val) * 1e-13;
      return Number.isFinite(err)
        ? { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactZero, exactZero }
        : { status: "unstable" };
    }
    case "sin": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      if (inner.status !== "ok") return inner;
      const exactZero = Boolean(inner.exactZero);
      const val = exactZero ? 0 : Math.sin(inner.value);
      const err = exactZero ? 0 : inner.err + Math.abs(val) * 1e-13 + 1e-15;
      return { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactZero, exactZero };
    }
    case "cos": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      if (inner.status !== "ok") return inner;
      const exactOne = Boolean(inner.exactZero);
      const val = exactOne ? 1 : Math.cos(inner.value);
      const err = exactOne ? 0 : inner.err + Math.abs(val) * 1e-13 + 1e-15;
      return { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactOne, exactZero: false };
    }
    case "exp": {
      const inner = evaluateFloatSafe(expr.value, x, variable, xRadius, state, depth + 1);
      if (inner.status !== "ok") return inner;
      if (inner.value + inner.err > 50 || inner.value - inner.err < -50 || inner.err > 10) return { status: "unstable" };
      const exactOne = Boolean(inner.exactZero);
      const val = exactOne ? 1 : Math.exp(inner.value);
      const err = exactOne ? 0 : Math.exp(inner.value + inner.err) - val + val * 1e-13;
      return Number.isFinite(err)
        ? { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactOne, exactZero: false }
        : { status: "unstable" };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const l = evaluateFloatSafe(expr.left, x, variable, xRadius, state, depth + 1);
      const r = evaluateFloatSafe(expr.right, x, variable, xRadius, state, depth + 1);
      if (l.status === "undefined_domain") return l;
      if (r.status === "undefined_domain") return r;
      if (l.status !== "ok") return l;
      if (r.status !== "ok") return r;
      const irrational = l.irrational || r.irrational;
      if (expr.kind === "div") {
        if (r.exactZero) return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
        if (Math.abs(r.value) <= BOUND_EPS + r.err) return { status: "unstable" };
        const val = l.value / r.value;
        const rMin = Math.abs(r.value) - r.err;
        const err = (l.err + Math.abs(l.value) * (r.err / rMin)) / rMin + Math.abs(val) * 1e-13;
        return Number.isFinite(val) && Number.isFinite(err) && Math.abs(val) < 1e10
          ? { status: "ok", value: val, err, marginOk: l.marginOk && r.marginOk, irrational, exactZero: Boolean(l.exactZero) }
          : { status: "unstable" };
      }
      const val = expr.kind === "add" ? l.value + r.value : expr.kind === "sub" ? l.value - r.value : l.value * r.value;
      const exactInt = !irrational && l.err === 0 && r.err === 0 && Number.isSafeInteger(val);
      const err = exactInt
        ? 0
        : expr.kind === "mul"
          ? Math.abs(l.value) * r.err + Math.abs(r.value) * l.err + l.err * r.err + Math.abs(val) * 1e-13
          : l.err + r.err + (Math.abs(l.value) + Math.abs(r.value)) * 1e-14 + Math.abs(val) * 1e-14;
      const exactZero =
        expr.kind === "mul"
          ? Boolean((l.exactZero || r.exactZero) && Number.isFinite(val))
          : Boolean((l.exactZero && r.exactZero) || (exactInt && val === 0));
      return Number.isFinite(val) && Number.isFinite(err) && Math.abs(val) < 1e10
        ? { status: "ok", value: val, err, marginOk: l.marginOk && r.marginOk, irrational, exactZero }
        : { status: "unstable" };
    }
    case "pow": {
      const b = evaluateFloatSafe(expr.base, x, variable, xRadius, state, depth + 1);
      if (b.status !== "ok") return b;
      if (expr.exponent <= 0 && b.exactZero) {
        return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
      }
      if (expr.exponent <= 0 && Math.abs(b.value) <= BOUND_EPS + b.err) return { status: "unstable" };
      const val = b.value ** expr.exponent;
      if (!Number.isFinite(val) || Math.abs(val) >= 1e10) return { status: "unstable" };
      if (expr.exponent === 0) return { status: "ok", value: 1, err: 0, marginOk: b.marginOk, irrational: false, exactZero: false };
      const exactInt = !b.irrational && b.err === 0 && expr.exponent > 0 && Number.isSafeInteger(val);
      const boundBase = expr.exponent > 0 ? Math.abs(b.value) + b.err : Math.abs(b.value) - b.err;
      const boundVal = boundBase ** expr.exponent;
      const err = exactInt ? 0 : Math.abs(boundVal - Math.abs(val)) + Math.abs(val) * 1e-13;
      return Number.isFinite(err)
        ? {
            status: "ok",
            value: val,
            err,
            marginOk: b.marginOk,
            irrational: b.irrational && expr.exponent !== 0,
            exactZero: Boolean(b.exactZero && expr.exponent > 0),
          }
        : { status: "unstable" };
    }
  }
}

function resolveExprDefinedAtSite(
  expr: ScalarExpr,
  site: SampleSite,
  variable: string,
): "defined" | "undefined_domain" | "unresolved" {
  if (site.kind === "rational") {
    const exactVal = evaluateExactRationalExt(expr, site.x, variable);
    if (exactVal.status === "value") return "defined";
    if (exactVal.status === "undefined_domain") return "undefined_domain";
    const arg = rationalToFloatArg(site.x);
    if (!arg) return "unresolved";
    const floatVal = evaluateFloatSafe(expr, arg.fx, variable, arg.xRadius);
    if (floatVal.status === "ok") return "defined";
    if (floatVal.status === "undefined_domain") return "undefined_domain";
    return "unresolved";
  }

  let lo = site.low;
  let hi = site.high;
  let work = polynomialSquareFree(site.master);
  if (polynomialEvaluate(work, lo).n === 0n) {
    work = polynomialDivMod(work, linearFactor(lo)).quotient;
  }
  if (polynomialDegree(work) >= 1 && polynomialEvaluate(work, hi).n === 0n) {
    work = polynomialDivMod(work, linearFactor(hi)).quotient;
  }
  const deg = polynomialDegree(work);
  if (deg <= 0) return "unresolved";
  if (deg === 1) {
    const a1 = work.get(1)!;
    const a0 = work.get(0) ?? rational(0n);
    const root = divideRational(rational(-a0.n, a0.d), a1);
    return compareRational(lo, root) < 0 && compareRational(root, hi) < 0
      ? resolveExprDefinedAtSite(expr, { kind: "rational", x: root }, variable)
      : "unresolved";
  }

  const chain = buildSturmChain(work);
  let vLo = sturmVariationsAtFinite(chain, lo);
  const vHi = sturmVariationsAtFinite(chain, hi);
  if (vLo - vHi !== 1) return "unresolved";

  const minWidth = rational(1n, 1n << 45n);
  for (let step = 0; step < 64 && compareRational(subtractRational(hi, lo), minWidth) > 0; step++) {
    const mid = divideRational(addRational(lo, hi), rational(2n));
    if (polynomialEvaluate(work, mid).n === 0n) {
      return resolveExprDefinedAtSite(expr, { kind: "rational", x: mid }, variable);
    }
    const vMid = sturmVariationsAtFinite(chain, mid);
    if (vLo - vMid === 1) {
      hi = mid;
    } else if (vLo - vMid === 0) {
      lo = mid;
      vLo = vMid;
    } else {
      return "unresolved";
    }
  }

  const loArg = rationalToFloatArg(lo);
  const hiArg = rationalToFloatArg(hi);
  if (!loArg || !hiArg) return "unresolved";
  const midNum = (loArg.fx + hiArg.fx) / 2;
  const radius = Math.abs(hiArg.fx - loArg.fx) / 2 + loArg.xRadius + hiArg.xRadius + Math.abs(midNum) * 1e-14 + 1e-15;
  const floatVal = evaluateFloatSafe(expr, midNum, variable, radius);
  if (floatVal.status === "ok") return "defined";
  if (floatVal.status === "undefined_domain") return "undefined_domain";
  return "unresolved";
}

function collectOpenCellProbes(cell: CadOpenCell, excluded: readonly SpanRational[]): SpanRational[] {
  const candidates: SpanRational[] = [cell.sample];
  const pushIfValid = (q: SpanRational) => {
    if (cell.left !== null && compareRational(q, cell.left) <= 0) return;
    if (cell.right !== null && compareRational(q, cell.right) >= 0) return;
    if (excluded.some((e) => equalRational(e, q))) return;
    if (!candidates.some((c) => equalRational(c, q))) candidates.push(q);
  };

  if (cell.left !== null && cell.right !== null) {
    const span = subtractRational(cell.right, cell.left);
    for (let k = 1n; k <= 7n; k++) {
      pushIfValid(addRational(cell.left, divideRational(multiplyRational(span, rational(k)), rational(8n))));
    }
  } else if (cell.left === null && cell.right !== null) {
    for (const offset of ["0.5", "1", "2", "3", "4", "4.5", "5", "6", "8", "10"]) {
      const q = toRational(offset);
      if (q) pushIfValid(subtractRational(cell.right, q));
    }
  } else if (cell.left !== null && cell.right === null) {
    for (const offset of ["0.5", "1", "2", "3", "4", "4.5", "5", "6", "8", "10"]) {
      const q = toRational(offset);
      if (q) pushIfValid(addRational(cell.left, q));
    }
  } else {
    for (const pt of ["0", "0.5", "-0.5", "1", "-1", "2", "-2", "3", "-3", "4", "-4", "4.5", "-4.5", "5", "-5", "6", "-6", "8", "-8"]) {
      const q = toRational(pt);
      if (q) pushIfValid(q);
    }
  }
  return candidates;
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

class MPolyOverflowError extends Error {
  constructor() {
    super("mpoly_complexity_exceeded");
  }
}

function mpolyAdd(a: MPoly, b: MPoly, sign: 1 | -1 = 1): MPoly {
  const out = new Map<string, SpanRational>();
  for (const [k, v] of a) {
    if (bigAbs(v.n) > MAX_POLY_COEFF_MAGNITUDE || v.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
    out.set(k, v);
  }
  for (const [k, v] of b) {
    if (bigAbs(v.n) > MAX_POLY_COEFF_MAGNITUDE || v.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
    const next = sign === 1 ? addRational(out.get(k) ?? rational(0n), v) : subtractRational(out.get(k) ?? rational(0n), v);
    if (bigAbs(next.n) > MAX_POLY_COEFF_MAGNITUDE || next.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
    if (next.n === 0n) out.delete(k);
    else out.set(k, next);
    if (out.size > 1024) throw new MPolyOverflowError();
  }
  return out;
}

function mpolyConst(q: SpanRational): MPoly {
  if (bigAbs(q.n) > MAX_POLY_COEFF_MAGNITUDE || q.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
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
  if (bigAbs(q.n) > MAX_POLY_COEFF_MAGNITUDE || q.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
  for (const v of p.values()) {
    if (bigAbs(v.n) > MAX_POLY_COEFF_MAGNITUDE || v.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
  }
  if (q.n === 0n || p.size === 0) return new Map();
  const out = new Map<string, SpanRational>();
  for (const [k, v] of p) {
    const next = multiplyRational(v, q);
    if (bigAbs(next.n) > MAX_POLY_COEFF_MAGNITUDE || next.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
    if (next.n !== 0n) out.set(k, next);
  }
  return out;
}

function mpolyContent(p: MPoly): { gcdNum: bigint; lcmDen: bigint; primitive: MPoly } {
  if (p.size === 0) return { gcdNum: 0n, lcmDen: 1n, primitive: new Map() };
  let lcmDen = 1n;
  for (const coeff of p.values()) {
    if (bigAbs(coeff.n) > MAX_POLY_COEFF_MAGNITUDE || coeff.d > MAX_POLY_COEFF_MAGNITUDE) {
      throw new MPolyOverflowError();
    }
    lcmDen = bigLcm(lcmDen, coeff.d);
    if (lcmDen > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
  }
  let gcdNum = 0n;
  for (const coeff of p.values()) gcdNum = bigGcd(gcdNum, bigAbs(coeff.n) * (lcmDen / coeff.d));
  if (gcdNum === 0n) return { gcdNum: 0n, lcmDen: 1n, primitive: new Map() };
  return { gcdNum, lcmDen, primitive: mpolyScale(p, rational(lcmDen, gcdNum)) };
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
    if (bigAbs(ca.n) > MAX_POLY_COEFF_MAGNITUDE || ca.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
    const pa = parseMonomialKey(ka);
    for (const [kb, cb] of b) {
      if (bigAbs(cb.n) > MAX_POLY_COEFF_MAGNITUDE || cb.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
      const pb = parseMonomialKey(kb);
      const combined = new Map(pa);
      for (const [atom, exp] of pb) combined.set(atom, (combined.get(atom) ?? 0) + exp);
      const prodCoeff = multiplyRational(ca, cb);
      if (bigAbs(prodCoeff.n) > MAX_POLY_COEFF_MAGNITUDE || prodCoeff.d > MAX_POLY_COEFF_MAGNITUDE) throw new MPolyOverflowError();
      let term = new Map<string, SpanRational>([["", prodCoeff]]);
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
      if (acc.size > 512) throw new MPolyOverflowError();
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
  const polyBudget: PolyMulBudget = { mulSteps: 0 };
  while (guard++ < 12 && polynomialDegree(rem) >= 2) {
    const g = polynomialGcd(rem, polynomialDerivative(rem));
    if (polynomialDegree(g) <= 0) break;
    const g2 = boundedPolyMultiply(g, g, polyBudget);
    if (!g2) throw new MPolyOverflowError();
    if (polynomialDegree(g2) <= polynomialDegree(rem)) {
      const div1 = polynomialDivMod(rem, g);
      if (div1.remainder.size === 0) {
        const div2 = polynomialDivMod(div1.quotient, g);
        if (div2.remainder.size === 0) {
          const nextSq = boundedPolyMultiply(sq, g, polyBudget);
          if (!nextSq) throw new MPolyOverflowError();
          sq = nextSq;
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
    const nextSq = boundedPolyMultiply(sq, factor, polyBudget);
    if (!nextSq) throw new MPolyOverflowError();
    sq = nextSq;
    rem = check2.quotient;
  }
  return { square: sq, squareFree: rem };
}

type RingRational = { num: MPoly; den: MPoly };

function buildSqrtOfMPoly(p: MPoly, reg: RingAtomRegistry): MPoly | null {
  if (p.size === 0) return new Map();
  const constVal = mpolyIsConst(p);
  if (constVal !== null) {
    if (constVal.n < 0n) return null;
    const { square, rest } = extractSquareFree(constVal.n * constVal.d);
    const coeff = rational(square, constVal.d);
    if (rest === 1n) return mpolyConst(coeff);
    const radKey = `sqrt(${rest})`;
    reg.sqrtDefs.set(radKey, mpolyConst(rational(rest)));
    return mpolyScale(mpolyAtom(radKey), coeff);
  }
  const { gcdNum, lcmDen, primitive } = mpolyContent(p);
  const { square, rest } = extractSquareFree(gcdNum * lcmDen);
  const coeff = rational(square, lcmDen);
  const primKey = `sqrt(${formatMPolyKey(primitive)})`;
  reg.sqrtDefs.set(primKey, primitive);
  let out = mpolyScale(mpolyAtom(primKey), coeff);
  if (rest > 1n) {
    const cKey = `sqrt(${rest})`;
    reg.sqrtDefs.set(cKey, mpolyConst(rational(rest)));
    out = mpolyMultiply(out, mpolyAtom(cKey), reg);
  }
  return out;
}

function ringNormalizeRational(
  expr: ScalarExpr,
  variable: string,
  validSites: readonly SampleSite[],
  reg: RingAtomRegistry,
  activeOpenIntervals: readonly NormalizedInterval[] = [],
): RingRational | null {
  const checkPolySign = (poly: Polynomial): "nonneg" | "nonpos" | "pos" | "neg" | "mixed" => {
    if (poly.size === 0) return "nonneg";
    if (polynomialDegree(poly) === 0) return poly.get(0)!.n > 0n ? "pos" : "neg";
    if (validSites.length === 0) return "mixed";
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
    const oddPoly = factorSquarePolynomial(poly).squareFree;
    if (polynomialDegree(oddPoly) >= 1) {
      for (const iv of activeOpenIntervals) {
        if (sturmCount(oddPoly, iv) > 0) return "mixed";
      }
      for (const site of validSites) {
        if (site.kind !== "isolated") continue;
        const openRoots = sturmCount(oddPoly, { left: site.low, right: site.high, leftOpen: true, rightOpen: true });
        if (openRoots > 0) {
          const sHere = signAtSampleSite(poly, site);
          if (sHere !== 0 || openRoots > 1 || !site.bracketed) return "mixed";
        }
      }
    }
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

  const convertState = { steps: 0 };
  const convert = (node: ScalarExpr, depth = 0): RingRational | null => {
    bumpAstSteps(convertState, depth);
    switch (node.kind) {
      case "const": {
        const q = toRational(node.value);
        return q ? { num: mpolyConst(q), den: mpolyConst(rational(1n)) } : null;
      }
      case "variable":
        return { num: mpolyAtom(node.name), den: mpolyConst(rational(1n)) };
      case "neg": {
        const inner = convert(node.value, depth + 1);
        return inner ? { num: mpolyScale(inner.num, rational(-1n)), den: inner.den } : null;
      }
      case "add":
      case "sub": {
        const l = convert(node.left, depth + 1);
        const r = convert(node.right, depth + 1);
        if (!l || !r) return null;
        return {
          num: mpolyAdd(mpolyMultiply(l.num, r.den, reg), mpolyMultiply(r.num, l.den, reg), node.kind === "add" ? 1 : -1),
          den: mpolyMultiply(l.den, r.den, reg),
        };
      }
      case "mul": {
        const l = convert(node.left, depth + 1);
        const r = convert(node.right, depth + 1);
        if (!l || !r) return null;
        return {
          num: mpolyMultiply(l.num, r.num, reg),
          den: mpolyMultiply(l.den, r.den, reg),
        };
      }
      case "div": {
        const l = convert(node.left, depth + 1);
        const r = convert(node.right, depth + 1);
        if (!l || !r || r.num.size === 0) return null;
        return {
          num: mpolyMultiply(l.num, r.den, reg),
          den: mpolyMultiply(l.den, r.num, reg),
        };
      }
      case "pow": {
        if (!Number.isInteger(node.exponent) || Math.abs(node.exponent) > 12) return null;
        const b = convert(node.base, depth + 1);
        if (!b) return null;
        if (node.exponent <= 0 && b.num.size === 0) return null;
        if (node.exponent === 0) return { num: mpolyConst(rational(1n)), den: mpolyConst(rational(1n)) };
        const stepNum = node.exponent >= 0 ? b.num : b.den;
        const stepDen = node.exponent >= 0 ? b.den : b.num;
        const mpolyDeg = (p: MPoly): number => {
          let max = 0;
          for (const key of p.keys()) {
            let sum = 0;
            for (const exp of parseMonomialKey(key).values()) sum += exp;
            if (sum > max) max = sum;
          }
          return max;
        };
        const absExp = Math.abs(node.exponent);
        if (
          mpolyDeg(stepNum) * absExp > MAX_SYMBOLIC_POLY_DEGREE ||
          mpolyDeg(stepDen) * absExp > MAX_SYMBOLIC_POLY_DEGREE
        ) {
          throw new MPolyOverflowError();
        }
        let num = mpolyConst(rational(1n));
        let den = mpolyConst(rational(1n));
        for (let i = 0; i < absExp; i++) {
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
        const inner = convert(node.value, depth + 1);
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
          const prod = boundedPolyMultiply(rf.numerator, rf.denominator, { mulSteps: 0 });
          if (!prod) throw new MPolyOverflowError();
          return { num: buildSqrtOfPoly(prod), den: absPolyRing(rf.denominator) };
        }
        const inner = convert(node.value, depth + 1);
        if (!inner) return null;
        if (inner.num.size === 0) return { num: new Map(), den: mpolyConst(rational(1n)) };
        if (inner.den.size === 1 && inner.den.has("")) {
          const dVal = inner.den.get("")!;
          if (dVal.n === 0n) return null;
          const scaled = mpolyScale(inner.num, dVal);
          const numSqrt = buildSqrtOfMPoly(scaled, reg);
          if (!numSqrt) return null;
          return { num: numSqrt, den: mpolyConst(rational(bigAbs(dVal.n), dVal.d)) };
        }
        return null;
      }
      case "ln": {
        if (node.value.kind === "exp") return convert(node.value.value, depth + 1);
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
        const inner = convert(node.value, depth + 1);
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
        if (node.value.kind === "ln") return convert(node.value.value, depth + 1);
        const inner = convert(node.value, depth + 1);
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
        const inner = convert(node.value, depth + 1);
        if (!inner) return null;
        if (inner.num.size === 0) {
          return {
            num: node.kind === "sin" ? new Map() : mpolyConst(rational(1n)),
            den: mpolyConst(rational(1n)),
          };
        }
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

  try {
    return convert(expr);
  } catch (err) {
    if (err instanceof MPolyOverflowError || err instanceof PolyComplexityError) return null;
    throw err;
  }
}

function collectVariables(
  expr: ScalarExpr,
  out = new Set<string>(),
): Set<string> {
  const seen = new WeakSet<object>();
  const state = { steps: 0 };
  const stack: ScalarExpr[] = [expr];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    bumpAstSteps(state);
    switch (cur.kind) {
      case "const":
        break;
      case "variable":
        out.add(cur.name);
        break;
      case "neg":
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        stack.push(cur.value);
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
        stack.push(cur.right, cur.left);
        break;
      case "pow":
        stack.push(cur.base);
        break;
    }
  }
  return out;
}

function hasTranscendental(expr: ScalarExpr): boolean {
  const seen = new WeakSet<object>();
  const state = { steps: 0 };
  const stack: ScalarExpr[] = [expr];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    bumpAstSteps(state);
    switch (cur.kind) {
      case "const":
      case "variable":
        break;
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        return true;
      case "neg":
      case "sqrt":
      case "abs":
        stack.push(cur.value);
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
        stack.push(cur.right, cur.left);
        break;
      case "pow":
        stack.push(cur.base);
        break;
    }
  }
  return false;
}

function stringSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function canonicalizeUncheckedOps(
  ops: readonly UncheckedDomainOp[],
  variable: string,
  validSites: readonly SampleSite[],
  activeOpenIntervals: readonly NormalizedInterval[],
): Set<string> | null {
  const keys = new Set<string>();
  const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
  for (const op of ops) {
    const norm = ringNormalizeRational(op.expr, variable, validSites, reg, activeOpenIntervals);
    if (!norm || norm.den.size === 0) return null;
    let poly: MPoly;
    let canonicalKey: string;
    try {
      poly = op.kind === "nonzero" ? norm.num : mpolyMultiply(norm.num, norm.den, reg);
      const c = mpolyIsConst(poly);
      if (c !== null) {
        if (op.kind === "nonzero") {
          if (c.n === 0n) return null;
          continue;
        }
        if (op.kind === "ge0") {
          if (c.n < 0n) return null;
          continue;
        }
        if (c.n <= 0n) return null;
        continue;
      }
      const { primitive } = mpolyContent(poly);
      let canonical = primitive;
      if (op.kind === "nonzero") {
        const entries = [...primitive.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        if (entries[0] && entries[0][1].n < 0n) {
          canonical = mpolyScale(primitive, rational(-1n));
        }
      }
      canonicalKey = `${op.kind}:${formatMPolyKey(canonical)}`;
    } catch (err) {
      if (err instanceof MPolyOverflowError) return null;
      throw err;
    }
    keys.add(canonicalKey);
  }
  return keys;
}

export function verifyScalarEquivalence(
  studentInput: ScalarExpr | string,
  referenceInput: ScalarExpr | string,
  domain?: DomainSpec,
): VerificationResult {
  try {
    return verifyScalarEquivalenceInner(studentInput, referenceInput, domain);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
    }
    throw err;
  }
}

function verifyScalarEquivalenceInner(
  studentInput: ScalarExpr | string,
  referenceInput: ScalarExpr | string,
  domain?: DomainSpec,
): VerificationResult {
  const hasNonComm = Boolean(domain?.nonCommutativeVars && domain.nonCommutativeVars.length > 0);
  const scalarVar =
    domain?.variable && !(domain?.nonCommutativeVars ?? []).includes(domain.variable)
      ? domain.variable
      : !(domain?.nonCommutativeVars ?? []).includes("x")
        ? "x"
        : null;
  const implicitMulIdents = hasNonComm
    ? [...(domain?.nonCommutativeVars ?? []), ...(scalarVar ? [scalarVar] : [])]
    : [];
  const preserved = [
    ...(domain?.variable ? [domain.variable] : []),
    ...(domain?.nonCommutativeVars ?? []),
  ];
  const parseOpts: NormalizeLatexOptions = {
    preservedIdentifiers: preserved,
    ...(implicitMulIdents.length > 0 ? { implicitMulIdentifiers: implicitMulIdents } : {}),
  };
  const hasLatexBegin =
    (typeof studentInput === "string" && studentInput.includes("\\begin")) ||
    (typeof referenceInput === "string" && referenceInput.includes("\\begin"));
  let student: ScalarExpr | null;
  let reference: ScalarExpr | null;
  if (hasLatexBegin) {
    const matrixEntry = tryVerifyOrUnwrapLatexMatrices(studentInput, referenceInput, domain, parseOpts, false);
    if (matrixEntry.kind === "result") return matrixEntry.result;
    if (matrixEntry.kind === "unverified") return { status: "unverified", reason: matrixEntry.reason, domain };
    student = matrixEntry.student;
    reference = matrixEntry.reference;
  } else {
    student = parseScalarExprInner(studentInput, parseOpts);
    reference = parseScalarExprInner(referenceInput, parseOpts);
  }
  if (!student || !reference) return { status: "unverified", reason: "parse_outside_decidable_fragment", domain };
  if (hasNonComm) {
    return verifyNonCommutativeParsed(student, reference, domain, false);
  }

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
    if (!sRad.ok && !sRad.defined && !rRad.ok && !rRad.defined) {
      return { status: "unverified", reason: "empty_natural_domain", domain };
    }
    const sExact = evaluateExactRationalExt(student, rational(0n), variable);
    const rExact = evaluateExactRationalExt(reference, rational(0n), variable);
    if (sExact.status === "value" && rExact.status === "value") {
      return equalRational(sExact.value, rExact.value)
        ? { status: "equivalent", reason: "exact_radical_constant_identity", domain }
        : { status: "inequivalent", reason: "exact_radical_counterexample", witness: { input: "const", detail: "constant values differ" }, domain };
    }
    const sfFloat = evaluateFloatSafe(student, 0, variable);
    const rfFloat = evaluateFloatSafe(reference, 0, variable);
    const sUndefined = sExact.status === "undefined_domain" || sfFloat.status === "undefined_domain";
    const rUndefined = rExact.status === "undefined_domain" || rfFloat.status === "undefined_domain";
    const sDefined = sRad.ok || sExact.status === "value" || sfFloat.status === "ok";
    const rDefined = rRad.ok || rExact.status === "value" || rfFloat.status === "ok";
    if (sUndefined && rDefined) {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "student undefined" }, domain };
    }
    if (rUndefined && sDefined) {
      return { status: "inequivalent", reason: "natural_domain_mismatch", witness: { input: "const", detail: "reference undefined" }, domain };
    }
    if (sUndefined && rUndefined) {
      return { status: "unverified", reason: "empty_natural_domain", domain };
    }
    if (sUndefined || rUndefined) {
      return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
    }
    if (sfFloat.status === "ok" && rfFloat.status === "ok" && sfFloat.marginOk && rfFloat.marginOk) {
      const tol = 1e-6 * Math.max(1, Math.abs(sfFloat.value), Math.abs(rfFloat.value)) + sfFloat.err + rfFloat.err;
      if (Math.abs(sfFloat.value - rfFloat.value) > tol) {
        return { status: "inequivalent", reason: "numeric_counterexample", witness: { input: "const", detail: "constant values differ" }, domain };
      }
    }
    const sConstConstraints = collectConstraints(student, variable);
    const rConstConstraints = collectConstraints(reference, variable);
    if (sConstConstraints.alwaysUndefined !== rConstConstraints.alwaysUndefined) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: "const", detail: sConstConstraints.alwaysUndefined ? "student undefined" : "reference undefined" },
        domain,
      };
    }
    if (sConstConstraints.alwaysUndefined && rConstConstraints.alwaysUndefined) {
      return { status: "unverified", reason: "empty_natural_domain", domain };
    }
    let constUncheckedMatch = !sConstConstraints.hasNonRationalDomainOps && !rConstConstraints.hasNonRationalDomainOps;
    if (!constUncheckedMatch) {
      const sKeys = canonicalizeUncheckedOps(sConstConstraints.uncheckedOps, variable, [], []);
      const rKeys = canonicalizeUncheckedOps(rConstConstraints.uncheckedOps, variable, [], []);
      constUncheckedMatch = sKeys !== null && rKeys !== null && stringSetsEqual(sKeys, rKeys);
    }
    const nonRationalResolved =
      (!sConstConstraints.hasNonRationalDomainOps && !rConstConstraints.hasNonRationalDomainOps) ||
      (sDefined && rDefined);
    if (constUncheckedMatch && nonRationalResolved) {
      const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
      const sn = ringNormalizeRational(student, variable, [], reg);
      const rn = ringNormalizeRational(reference, variable, [], reg);
      if (sn && rn) {
        try {
          const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
          if (diff.size === 0) return { status: "equivalent", reason: "canonical_symbolic_identity", domain };
        } catch (err) {
          if (!(err instanceof MPolyOverflowError)) throw err;
          return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
        }
      }
    }
    return { status: "unverified", reason: "constant_outside_exact_fragment", domain };
  }

  const sf = rationalForm(student, variable);
  const rf = rationalForm(reference, variable);
  if (sf.unsupported === "polynomial_complexity_exceeded" || rf.unsupported === "polynomial_complexity_exceeded") {
    return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
  }
  const sConstraints = collectConstraints(student, variable);
  const rConstraints = collectConstraints(reference, variable);

  if (sConstraints.alwaysUndefined !== rConstraints.alwaysUndefined) {
    const otherExpr = sConstraints.alwaysUndefined ? reference : student;
    const otherRf = sConstraints.alwaysUndefined ? rf : sf;
    const otherConstraints = sConstraints.alwaysUndefined ? rConstraints : sConstraints;
    const cad = buildCadPlan(otherConstraints.rational, parsedDomain, otherConstraints.splitPolys);
    if (cad.complexityExceeded) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    let verifiedWitness: string | null = null;
    const candidateSites: SampleSite[] = [
      ...cad.sites,
      ...cad.openCells.map((cell) => ({ kind: "rational", x: cell.sample }) as SampleSite),
    ];
    for (const site of candidateSites) {
      if (!constraintsSatisfiedAtSite(otherConstraints, site)) continue;
      if (!otherRf.unsupported && site.kind === "rational") {
        const denOk =
          polynomialEvaluate(otherRf.denominator, site.x).n !== 0n &&
          otherRf.domainDenominators.every((den) => polynomialEvaluate(den, site.x).n !== 0n);
        if (denOk) {
          polynomialEvaluate(otherRf.numerator, site.x);
          verifiedWitness = formatRational(site.x);
          break;
        }
      } else {
        const status = resolveExprDefinedAtSite(otherExpr, site, variable);
        if (status === "defined") {
          verifiedWitness = formatSampleSite(site);
          break;
        }
      }
    }
    if (!verifiedWitness) {
      if (otherConstraints.hasNonRationalDomainOps || cad.unresolvedRootIsolation) {
        return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
      }
      return { status: "unverified", reason: "empty_natural_domain", domain };
    }
    return {
      status: "inequivalent",
      reason: "natural_domain_mismatch",
      witness: { input: verifiedWitness, detail: sConstraints.alwaysUndefined ? "student undefined" : "reference undefined" },
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
      if (denDiff.complexityExceeded) {
        return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
      }
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: denDiff.witness,
        domain,
      };
    }

    const crossBudget: PolyMulBudget = { mulSteps: 0 };
    const combinedDen = boundedPolyMultiply(sf.denominator, rf.denominator, crossBudget);
    const leftCross = boundedPolyMultiply(sf.numerator, rf.denominator, crossBudget);
    const rightCross = boundedPolyMultiply(rf.numerator, sf.denominator, crossBudget);
    if (!combinedDen || !leftCross || !rightCross) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    const residual = polynomialAdd(leftCross, rightCross, -1);
    if (exceedsPolyLimits(residual)) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    const { sites, unresolvedRootIsolation, complexityExceeded } = buildCadPlan(
      [...sConstraints.rational, ...rConstraints.rational],
      parsedDomain,
      [...sConstraints.splitPolys, ...rConstraints.splitPolys],
    );
    if (complexityExceeded) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    if (unresolvedRootIsolation) {
      return { status: "unverified", reason: "unresolved_root_isolation", domain };
    }
    const validRationalPoints = sites
      .filter((s): s is { kind: "rational"; x: SpanRational } => s.kind === "rational")
      .map((s) => s.x)
      .filter((x) => polynomialEvaluate(combinedDen, x).n !== 0n);

    if (residual.size === 0) {
      if (validRationalPoints.length === 0) {
        return { status: "unverified", reason: "empty_natural_domain", domain };
      }
      for (const x of validRationalPoints) {
        polynomialEvaluate(sf.numerator, x);
        polynomialEvaluate(sf.denominator, x);
        polynomialEvaluate(rf.numerator, x);
        polynomialEvaluate(rf.denominator, x);
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

    const hasNonDegenerateInterval = parsedDomain.intervals.some(
      (iv) => !(iv.left && iv.right && equalRational(iv.left, iv.right)),
    );
    if (!hasNonDegenerateInterval) {
      if (validRationalPoints.length === 0) {
        return { status: "unverified", reason: "empty_natural_domain", domain };
      }
      return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
    }

    // Residual is nonzero as polynomial: bounded probes on non-degenerate intervals, fail closed if insufficient valid points
    const deg = polynomialDegree(residual);
    const evaluatedKeys = new Set(validRationalPoints.map((x) => formatRational(x)));
    const maxProbes = deg + Math.max(0, polynomialDegree(combinedDen)) + parsedDomain.excluded.length + 5;
    for (const iv of parsedDomain.intervals) {
      if (iv.left && iv.right && equalRational(iv.left, iv.right)) continue;
      let probe = pickRationalBetween(iv.left, iv.right);
      for (let i = 0; i < maxProbes; i++) {
        if (
          pointInInterval(probe, iv) &&
          !parsedDomain.excluded.some((e) => equalRational(e, probe)) &&
          polynomialEvaluate(combinedDen, probe).n !== 0n
        ) {
          if (polynomialEvaluate(residual, probe).n !== 0n) {
            return {
              status: "inequivalent",
              reason: "residual_nonzero",
              witness: { input: formatRational(probe), detail: "exact residual is non-zero" },
              domain,
            };
          }
          evaluatedKeys.add(formatRational(probe));
        }
        probe = iv.right !== null ? divideRational(addRational(probe, iv.right), rational(2n)) : addRational(probe, rational(1n));
      }
    }
    return {
      status: "unverified",
      reason: evaluatedKeys.size < deg + 1 ? "rational_probe_budget_exhausted" : "residual_nonzero_unwitnessed",
      domain,
    };
  }

  // Extended fragment (radicals, abs, ln, sin, cos, exp): 1D CAD domain verification first
  const allRationalConstraints = [...sConstraints.rational, ...rConstraints.rational];
  const { sites, openCells, unresolvedRootIsolation, complexityExceeded } = buildCadPlan(
    allRationalConstraints,
    parsedDomain,
    [...sConstraints.splitPolys, ...rConstraints.splitPolys],
  );
  if (complexityExceeded) {
    return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
  }
  if (unresolvedRootIsolation) {
    return { status: "unverified", reason: "unresolved_root_isolation", domain };
  }
  const validSites: SampleSite[] = [];
  const ambiguousSites: Array<{ site: SampleSite; definedSide: "student" | "reference" }> = [];
  for (const site of sites) {
    const sOk = constraintsSatisfiedAtSite(sConstraints, site);
    const rOk = constraintsSatisfiedAtSite(rConstraints, site);
    if (sOk !== rOk) {
      const okSideHasNonRational = sOk ? sConstraints.hasNonRationalDomainOps : rConstraints.hasNonRationalDomainOps;
      if (!okSideHasNonRational) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatSampleSite(site), detail: sOk ? "reference undefined" : "student undefined" },
          domain,
        };
      }
      ambiguousSites.push({ site, definedSide: sOk ? "student" : "reference" });
      continue;
    }
    if (sOk && rOk) validSites.push(site);
  }

  const ambiguousOpenCells: Array<{ cell: CadOpenCell; definedSide: "student" | "reference" }> = [];
  for (const cell of openCells) {
    const cellSite: SampleSite = { kind: "rational", x: cell.sample };
    const sOk = constraintsSatisfiedAtSite(sConstraints, cellSite);
    const rOk = constraintsSatisfiedAtSite(rConstraints, cellSite);
    if (sOk !== rOk) {
      const okSideHasNonRational = sOk ? sConstraints.hasNonRationalDomainOps : rConstraints.hasNonRationalDomainOps;
      if (!okSideHasNonRational) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatRational(cell.sample), detail: sOk ? "reference undefined" : "student undefined" },
          domain,
        };
      }
      ambiguousOpenCells.push({ cell, definedSide: sOk ? "student" : "reference" });
    }
  }

  let hasUnresolvedDomainMismatch = false;
  for (const amb of ambiguousSites) {
    const definedExpr = amb.definedSide === "student" ? student : reference;
    const resolution = resolveExprDefinedAtSite(definedExpr, amb.site, variable);
    if (resolution === "defined") {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: {
          input: formatSampleSite(amb.site),
          detail: amb.definedSide === "student" ? "reference undefined" : "student undefined",
        },
        domain,
      };
    }
    if (resolution === "unresolved") {
      hasUnresolvedDomainMismatch = true;
    }
  }

  for (const amb of ambiguousOpenCells) {
    const definedExpr = amb.definedSide === "student" ? student : reference;
    for (const probe of collectOpenCellProbes(amb.cell, parsedDomain.excluded)) {
      if (resolveExprDefinedAtSite(definedExpr, { kind: "rational", x: probe }, variable) === "defined") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: {
            input: formatRational(probe),
            detail: amb.definedSide === "student" ? "reference undefined" : "student undefined",
          },
          domain,
        };
      }
    }
    hasUnresolvedDomainMismatch = true;
  }

  if (validSites.length === 0) {
    return {
      status: "unverified",
      reason: hasUnresolvedDomainMismatch ? "unresolved_nonrational_domain" : "empty_natural_domain",
      domain,
    };
  }

  const activeOpenIntervals: NormalizedInterval[] = [];
  for (const cell of openCells) {
    const sampleSite: SampleSite = { kind: "rational", x: cell.sample };
    if (constraintsSatisfiedAtSite(sConstraints, sampleSite) && constraintsSatisfiedAtSite(rConstraints, sampleSite)) {
      activeOpenIntervals.push({ left: cell.left, right: cell.right, leftOpen: true, rightOpen: true });
    }
  }

  // Exact rational evaluation on valid rational sites (handles sqrt/abs/ln(1)/sin(0)/cos(0)/exp(0) counterexamples cleanly)
  const validRationalSamples = validSites
    .filter((s): s is { kind: "rational"; x: SpanRational } => s.kind === "rational")
    .map((s) => s.x);

  let validEvaluatedCount = 0;

  for (const x of validRationalSamples) {
    const sVal = evaluateExactRationalExt(student, x, variable);
    const rVal = evaluateExactRationalExt(reference, x, variable);
    if (sVal.status === "undefined_domain" || rVal.status === "undefined_domain") {
      if (sVal.status === "undefined_domain" && rVal.status === "undefined_domain") {
        continue;
      }
      if (
        (sVal.status === "undefined_domain" && rVal.status === "value") ||
        (rVal.status === "undefined_domain" && sVal.status === "value")
      ) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatRational(x), detail: sVal.status === "undefined_domain" ? "student undefined" : "reference undefined" },
          domain,
        };
      }
      const otherExpr = sVal.status === "undefined_domain" ? reference : student;
      const arg = rationalToFloatArg(x);
      const otherFloat = arg ? evaluateFloatSafe(otherExpr, arg.fx, variable, arg.xRadius) : null;
      if (otherFloat?.status === "ok") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatRational(x), detail: sVal.status === "undefined_domain" ? "student undefined" : "reference undefined" },
          domain,
        };
      }
      if (otherFloat?.status !== "undefined_domain") {
        hasUnresolvedDomainMismatch = true;
      }
      continue;
    }
    if (sVal.status === "value" && rVal.status === "value") {
      validEvaluatedCount++;
      if (!equalRational(sVal.value, rVal.value)) {
        return {
          status: "inequivalent",
          reason: "exact_radical_counterexample",
          witness: { input: formatRational(x), detail: "exact values differ" },
          domain,
        };
      }
    }
  }

  // Numeric domain & clear counterexample check across non-singular sample points inside domain
  const floatCandidates: Array<{ label: string; fx: number; xRadius: number }> = [];
  for (const x of validRationalSamples) {
    const arg = rationalToFloatArg(x);
    if (arg) floatCandidates.push({ label: formatRational(x), ...arg });
  }
  for (const offset of [-3.1, -2.3, -1.7, -0.7, -0.3, 0.3, 0.7, 1.3, 2.3, 3.1]) {
    const q = toRational(String(offset));
    const arg = q ? rationalToFloatArg(q) : null;
    if (q && arg && domainAllows(domain, q)) {
      const site: SampleSite = { kind: "rational", x: q };
      if (constraintsSatisfiedAtSite(sConstraints, site) && constraintsSatisfiedAtSite(rConstraints, site)) {
        floatCandidates.push({ label: String(offset), ...arg });
      }
    }
  }

  for (const cand of floatCandidates) {
    const sfRes = evaluateFloatSafe(student, cand.fx, variable, cand.xRadius);
    const rfRes = evaluateFloatSafe(reference, cand.fx, variable, cand.xRadius);
    if (
      (sfRes.status === "undefined_domain" && rfRes.status === "ok") ||
      (rfRes.status === "undefined_domain" && sfRes.status === "ok")
    ) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: cand.label, detail: sfRes.status === "undefined_domain" ? "student undefined" : "reference undefined" },
        domain,
      };
    }
    if (
      (sfRes.status === "undefined_domain" && rfRes.status === "unstable") ||
      (rfRes.status === "undefined_domain" && sfRes.status === "unstable")
    ) {
      hasUnresolvedDomainMismatch = true;
    }
    if (sfRes.status === "ok" && rfRes.status === "ok") {
      validEvaluatedCount++;
      if (sfRes.marginOk && rfRes.marginOk) {
        const tol = 1e-6 * Math.max(1, Math.abs(sfRes.value), Math.abs(rfRes.value)) + sfRes.err + rfRes.err;
        if (Math.abs(sfRes.value - rfRes.value) > tol) {
          return {
            status: "inequivalent",
            reason: "numeric_counterexample",
            witness: { input: cand.label, detail: "evaluated values differ" },
            domain,
          };
        }
      }
    }
  }

  if (hasUnresolvedDomainMismatch) {
    return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
  }
  if ((sConstraints.hasNonRationalDomainOps || rConstraints.hasNonRationalDomainOps) && validEvaluatedCount === 0) {
    return { status: "unverified", reason: "empty_natural_domain", domain };
  }

  // Symbolic / algebraic ring equivalence over atoms (only when domains matched and non-empty)
  let uncheckedConstraintsMatch = !sConstraints.hasNonRationalDomainOps && !rConstraints.hasNonRationalDomainOps;
  if (!uncheckedConstraintsMatch) {
    const sKeys = canonicalizeUncheckedOps(sConstraints.uncheckedOps, variable, validSites, activeOpenIntervals);
    const rKeys = canonicalizeUncheckedOps(rConstraints.uncheckedOps, variable, validSites, activeOpenIntervals);
    uncheckedConstraintsMatch = sKeys !== null && rKeys !== null && stringSetsEqual(sKeys, rKeys);
  }
  if (uncheckedConstraintsMatch) {
    const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
    const sn = ringNormalizeRational(student, variable, validSites, reg, activeOpenIntervals);
    const rn = ringNormalizeRational(reference, variable, validSites, reg, activeOpenIntervals);
    if (sn && rn) {
      try {
        const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
        if (diff.size === 0) {
          return {
            status: "equivalent",
            reason: hasTranscendental(student) || hasTranscendental(reference) ? "canonical_symbolic_identity" : "canonical_radical_identity",
            domain,
          };
        }
      } catch (err) {
        if (!(err instanceof MPolyOverflowError)) throw err;
        return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
      }
    }
  }

  return { status: "unverified", reason: sf.unsupported ?? rf.unsupported ?? "symbolic_equivalence_unverified", domain };
}

function squareFreeProduct(polys: readonly Polynomial[]): Polynomial | null {
  let acc = polynomialConstant(rational(1n));
  const polyBudget: PolyMulBudget = { mulSteps: 0 };
  for (const p of polys) {
    if (polynomialDegree(p) < 1) continue;
    const sf = polynomialSquareFree(p);
    const g = polynomialGcd(acc, sf);
    const factor = polynomialDegree(g) >= 1 ? polynomialDivMod(sf, g).quotient : sf;
    if (polynomialDegree(factor) >= 1) {
      const next = boundedPolyMultiply(acc, factor, polyBudget);
      if (!next) return null;
      acc = polynomialPrimitivePositive(next);
    }
  }
  return acc;
}

function checkDenominatorSetsEquivalent(
  studentDens: readonly Polynomial[],
  referenceDens: readonly Polynomial[],
  intervals: readonly NormalizedInterval[],
  excluded: readonly SpanRational[],
): { equal: true } | { equal: false; complexityExceeded?: boolean; witness: { input: string; detail: string } } {
  try {
    const sUnion = squareFreeProduct(studentDens);
    const rUnion = squareFreeProduct(referenceDens);
    if (!sUnion || !rUnion) {
      return { equal: false, complexityExceeded: true, witness: { input: "domain", detail: "polynomial_complexity_exceeded" } };
    }
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
        const { roots } = isolateRealRoots(sOnly, iv);
        const first = roots[0];
        const witnessInput = first
          ? first.kind === "exact"
            ? formatRational(first.value)
            : `(${formatRational(first.low)}, ${formatRational(first.high)})`
          : "domain";
        return { equal: false, witness: { input: witnessInput, detail: "student undefined" } };
      }
      if (polynomialDegree(rOnly) >= 1 && sturmCount(rOnly, iv) > 0) {
        const { roots } = isolateRealRoots(rOnly, iv);
        const first = roots[0];
        const witnessInput = first
          ? first.kind === "exact"
            ? formatRational(first.value)
            : `(${formatRational(first.low)}, ${formatRational(first.high)})`
          : "domain";
        return { equal: false, witness: { input: witnessInput, detail: "reference undefined" } };
      }
    }
    return { equal: true };
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { equal: false, complexityExceeded: true, witness: { input: "domain", detail: "polynomial_complexity_exceeded" } };
    }
    throw err;
  }
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

function checkAntiderivativeDefinedOnIntegrandDomain(
  antiderivative: ScalarExpr,
  integrand: ScalarExpr,
  variable: string,
  domain: DomainSpec,
): VerificationResult | null {
  try {
    return checkAntiderivativeDefinedOnIntegrandDomainInner(antiderivative, integrand, variable, domain);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
    }
    throw err;
  }
}

function checkAntiderivativeDefinedOnIntegrandDomainInner(
  antiderivative: ScalarExpr,
  integrand: ScalarExpr,
  variable: string,
  domain: DomainSpec,
): VerificationResult | null {
  const parsedDomain = parseDomainSpec(domain);
  if (!parsedDomain || parsedDomain.empty) return null;
  const sConstraints = collectConstraints(antiderivative, variable);
  const iConstraints = collectConstraints(integrand, variable);
  const { sites, openCells, unresolvedRootIsolation, complexityExceeded } = buildCadPlan(
    [...sConstraints.rational, ...iConstraints.rational],
    parsedDomain,
    [...sConstraints.splitPolys, ...iConstraints.splitPolys],
  );
  if (complexityExceeded) {
    return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
  }
  if (unresolvedRootIsolation) {
    return { status: "unverified", reason: "unresolved_root_isolation", domain };
  }
  let hasUnresolvedDomainMismatch = false;
  const ambiguousSites: SampleSite[] = [];
  for (const site of sites) {
    const iOk = !iConstraints.alwaysUndefined && constraintsSatisfiedAtSite(iConstraints, site);
    const sOk = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, site);
    if (iOk && !sOk) {
      if (!iConstraints.hasNonRationalDomainOps) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatSampleSite(site), detail: "student antiderivative undefined on integrand domain" },
          domain,
        };
      }
      ambiguousSites.push(site);
    }
  }
  const ambiguousOpenCells: CadOpenCell[] = [];
  for (const cell of openCells) {
    const sampleSite: SampleSite = { kind: "rational", x: cell.sample };
    const iOk = !iConstraints.alwaysUndefined && constraintsSatisfiedAtSite(iConstraints, sampleSite);
    const sOk = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, sampleSite);
    if (iOk && !sOk) {
      if (!iConstraints.hasNonRationalDomainOps) {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatRational(cell.sample), detail: "student antiderivative undefined on integrand domain" },
          domain,
        };
      }
      ambiguousOpenCells.push(cell);
    }
  }
  for (const site of ambiguousSites) {
    const resolution = resolveExprDefinedAtSite(integrand, site, variable);
    if (resolution === "defined") {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: formatSampleSite(site), detail: "student antiderivative undefined on integrand domain" },
        domain,
      };
    }
    if (resolution === "unresolved") {
      hasUnresolvedDomainMismatch = true;
    }
  }
  for (const cell of ambiguousOpenCells) {
    for (const probe of collectOpenCellProbes(cell, parsedDomain.excluded)) {
      if (resolveExprDefinedAtSite(integrand, { kind: "rational", x: probe }, variable) === "defined") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatRational(probe), detail: "student antiderivative undefined on integrand domain" },
          domain,
        };
      }
    }
    hasUnresolvedDomainMismatch = true;
  }
  if (hasUnresolvedDomainMismatch) {
    return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
  }
  if (sConstraints.hasNonRationalDomainOps) {
    const validSites: SampleSite[] = [];
    const activeOpenIntervals: NormalizedInterval[] = [];
    for (const site of sites) {
      const iOk = !iConstraints.alwaysUndefined && constraintsSatisfiedAtSite(iConstraints, site);
      const sOk = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, site);
      if (iOk && sOk) {
        validSites.push(site);
        if (
          site.kind === "rational" &&
          resolveExprDefinedAtSite(antiderivative, site, variable) === "undefined_domain" &&
          resolveExprDefinedAtSite(integrand, site, variable) === "defined"
        ) {
          return {
            status: "inequivalent",
            reason: "natural_domain_mismatch",
            witness: { input: formatRational(site.x), detail: "student antiderivative undefined on integrand domain" },
            domain,
          };
        }
      }
    }
    for (const cell of openCells) {
      const sampleSite: SampleSite = { kind: "rational", x: cell.sample };
      const iOk = !iConstraints.alwaysUndefined && constraintsSatisfiedAtSite(iConstraints, sampleSite);
      const sOk = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, sampleSite);
      if (iOk && sOk) {
        activeOpenIntervals.push({ left: cell.left, right: cell.right, leftOpen: true, rightOpen: true });
        for (const probe of collectOpenCellProbes(cell, parsedDomain.excluded)) {
          const probeSite: SampleSite = { kind: "rational", x: probe };
          if (
            resolveExprDefinedAtSite(antiderivative, probeSite, variable) === "undefined_domain" &&
            resolveExprDefinedAtSite(integrand, probeSite, variable) === "defined"
          ) {
            return {
              status: "inequivalent",
              reason: "natural_domain_mismatch",
              witness: { input: formatRational(probe), detail: "student antiderivative undefined on integrand domain" },
              domain,
            };
          }
        }
      }
    }
    if (validSites.length > 0 || activeOpenIntervals.length > 0) {
      const sKeys = canonicalizeUncheckedOps(sConstraints.uncheckedOps, variable, validSites, activeOpenIntervals);
      const iKeys = iConstraints.hasNonRationalDomainOps
        ? canonicalizeUncheckedOps(iConstraints.uncheckedOps, variable, validSites, activeOpenIntervals)
        : new Set<string>();
      const allStudentOpsCertified =
        sKeys !== null &&
        iKeys !== null &&
        [...sKeys].every((key) => {
          if (iKeys.has(key)) return true;
          if (key.startsWith("ge0:") && iKeys.has(`gt0:${key.slice(4)}`)) return true;
          if (key.startsWith("nonzero:") && iKeys.has(`gt0:${key.slice(8)}`)) return true;
          return false;
        });
      if (!allStudentOpsCertified) {
        return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
      }
    }
  }
  return null;
}

export function verifyIndefiniteIntegral(input: IntegralVerificationInput): VerificationResult {
  const effectiveDomain: DomainSpec = {
    ...input.domain,
    variable: input.variable ?? input.domain?.variable ?? "x",
  };
  try {
    return verifyIndefiniteIntegralInner(input);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain: effectiveDomain };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded", domain: effectiveDomain };
    }
    throw err;
  }
}

function verifyIndefiniteIntegralInner(input: IntegralVerificationInput): VerificationResult {
  const preservedVar = input.variable ?? input.domain?.variable;
  const parseOpts: NormalizeLatexOptions | undefined = preservedVar
    ? { preservedIdentifiers: [preservedVar] }
    : undefined;
  const student = parseScalarExprInner(input.student, parseOpts);
  const integrand = parseScalarExprInner(input.integrand, parseOpts);
  if (!student || !integrand) return { status: "unverified", reason: "parse_outside_decidable_fragment" };
  if (input.variable && input.domain?.variable && input.variable !== input.domain.variable) {
    return { status: "unverified", reason: "variable_mismatch", domain: input.domain };
  }
  const variable = input.variable ?? input.domain?.variable ?? "x";
  const effectiveDomain: DomainSpec = { ...input.domain, variable };

  if (input.piecewise) {
    const split = toRational(input.piecewise.split);
    const pwLeft = parseScalarExprInner(input.piecewise.left, parseOpts);
    const pwRight = parseScalarExprInner(input.piecewise.right, parseOpts);
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

    const leftDomainCoverage = checkAntiderivativeDefinedOnIntegrandDomain(pwLeft, integrand, variable, leftDomain);
    if (leftDomainCoverage) return leftDomainCoverage;
    const rightDomainCoverage = checkAntiderivativeDefinedOnIntegrandDomain(pwRight, integrand, variable, rightDomain);
    if (rightDomainCoverage) return rightDomainCoverage;

    if (domainAllows(effectiveDomain, split)) {
      const integrandAtSplit = evaluateExactRationalExt(integrand, split, variable);
      if (integrandAtSplit.status !== "undefined_domain") {
        const splitDomain: DomainSpec = {
          variable,
          intervals: [{ left: formatRational(split), right: formatRational(split) }],
        };
        const splitDomainCoverage = checkAntiderivativeDefinedOnIntegrandDomain(student, integrand, variable, splitDomain);
        if (splitDomainCoverage) return splitDomainCoverage;
        const leftAtSplit = verifyScalarEquivalence(pwLeft, pwRight, splitDomain);
        if (leftAtSplit.status === "inequivalent") {
          return {
            status: "inequivalent",
            reason: "piecewise_antiderivative_discontinuous_at_split",
            witness: { input: formatRational(split), detail: "left and right branches disagree at split" },
            domain: effectiveDomain,
          };
        }
        if (leftAtSplit.status !== "equivalent") {
          return {
            status: "unverified",
            reason: leftAtSplit.reason ?? "piecewise_split_continuity_unverified",
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
  const domainCoverage = checkAntiderivativeDefinedOnIntegrandDomain(student, integrand, variable, effectiveDomain);
  if (domainCoverage) return domainCoverage;
  return derivCheck;
}

export function differentiate(expr: ScalarExpr, variable = "x"): ScalarExpr | null {
  try {
    return differentiateInner(expr, variable);
  } catch (err) {
    if (err instanceof PolyComplexityError || err instanceof MPolyOverflowError) return null;
    throw err;
  }
}

function differentiateInner(
  expr: ScalarExpr,
  variable = "x",
  state: { steps: number } = { steps: 0 },
  depth = 0,
): ScalarExpr | null {
  bumpAstSteps(state, depth);
  switch (expr.kind) {
    case "const":
      return { kind: "const", value: 0 };
    case "variable":
      return { kind: "const", value: expr.name === variable ? 1 : 0 };
    case "neg": {
      const value = differentiateInner(expr.value, variable, state, depth + 1);
      return value ? { kind: "neg", value } : null;
    }
    case "add":
    case "sub": {
      const left = differentiateInner(expr.left, variable, state, depth + 1);
      const right = differentiateInner(expr.right, variable, state, depth + 1);
      return left && right ? { kind: expr.kind, left, right } : null;
    }
    case "mul": {
      const left = differentiateInner(expr.left, variable, state, depth + 1);
      const right = differentiateInner(expr.right, variable, state, depth + 1);
      return left && right
        ? {
            kind: "add",
            left: { kind: "mul", left, right: expr.right },
            right: { kind: "mul", left: expr.left, right },
          }
        : null;
    }
    case "div": {
      const left = differentiateInner(expr.left, variable, state, depth + 1);
      const right = differentiateInner(expr.right, variable, state, depth + 1);
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
      const du = differentiateInner(expr.base, variable, state, depth + 1);
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
      const du = differentiateInner(expr.value, variable, state, depth + 1);
      if (!du) return null;
      return {
        kind: "div",
        left: du,
        right: { kind: "mul", left: { kind: "const", value: 2 }, right: { kind: "sqrt", value: expr.value } },
      };
    }
    case "ln": {
      const inner = expr.value.kind === "abs" ? expr.value.value : expr.value;
      const du = differentiateInner(inner, variable, state, depth + 1);
      if (!du) return null;
      return { kind: "div", left: du, right: inner };
    }
    case "sin": {
      const du = differentiateInner(expr.value, variable, state, depth + 1);
      return du ? { kind: "mul", left: { kind: "cos", value: expr.value }, right: du } : null;
    }
    case "cos": {
      const du = differentiateInner(expr.value, variable, state, depth + 1);
      return du ? { kind: "mul", left: { kind: "neg", value: { kind: "sin", value: expr.value } }, right: du } : null;
    }
    case "exp": {
      const du = differentiateInner(expr.value, variable, state, depth + 1);
      return du ? { kind: "mul", left: { kind: "exp", value: expr.value }, right: du } : null;
    }
    case "abs": {
      const du = differentiateInner(expr.value, variable, state, depth + 1);
      return du ? { kind: "mul", left: { kind: "div", left: expr.value, right: { kind: "abs", value: expr.value } }, right: du } : null;
    }
    default:
      return null;
  }
}

function substituteScalar(
  expr: ScalarExpr,
  variable: string,
  replacement: ScalarExpr,
  state: { steps: number } = { steps: 0 },
  depth = 0,
): ScalarExpr {
  bumpAstSteps(state, depth);
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
      return { kind: expr.kind, value: substituteScalar(expr.value, variable, replacement, state, depth + 1) };
    case "add":
    case "sub":
    case "mul":
    case "div":
      return {
        kind: expr.kind,
        left: substituteScalar(expr.left, variable, replacement, state, depth + 1),
        right: substituteScalar(expr.right, variable, replacement, state, depth + 1),
      };
    case "pow":
      return { kind: "pow", base: substituteScalar(expr.base, variable, replacement, state, depth + 1), exponent: expr.exponent };
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
  try {
    const parseOpts: NormalizeLatexOptions | undefined = input.variable
      ? { preservedIdentifiers: [input.variable] }
      : undefined;
    const substitution = parseScalarExprInner(input.substitution, parseOpts);
    const lower = toRational(input.lower);
    const upper = toRational(input.upper);
    const expectedLower = parseScalarExprInner(input.transformedLower, parseOpts);
    const expectedUpper = parseScalarExprInner(input.transformedUpper, parseOpts);
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
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded" };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded" };
    }
    throw err;
  }
}

type WeightedScalar = {
  expr: ScalarExpr;
  weight: number;
};

type MatrixWeightedWordMap = Map<string, WeightedScalar>;

const MAX_MATRIX_SCALAR_AST_NODES = 4096;

function exprContainsAnyVar(expr: ScalarExpr, targetVars: ReadonlySet<string>): boolean {
  const seen = new WeakSet<object>();
  const state = { steps: 0 };
  const stack: ScalarExpr[] = [expr];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    bumpAstSteps(state);
    switch (cur.kind) {
      case "const":
        break;
      case "variable":
        if (targetVars.has(cur.name)) return true;
        break;
      case "neg":
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        stack.push(cur.value);
        break;
      case "pow":
        stack.push(cur.base);
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
        stack.push(cur.right, cur.left);
        break;
    }
  }
  return false;
}

function measureScalarAstWeight(expr: ScalarExpr, maxNodes = MAX_MATRIX_SCALAR_AST_NODES): number {
  let nodes = 0;
  const stack: ScalarExpr[] = [expr];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    nodes++;
    if (nodes > maxNodes) throw new PolyComplexityError();
    switch (cur.kind) {
      case "const":
      case "variable":
        break;
      case "neg":
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        stack.push(cur.value);
        break;
      case "pow":
        stack.push(cur.base);
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
        stack.push(cur.left, cur.right);
        break;
    }
  }
  return nodes;
}

function isDomainHazardFreeExpr(expr: ScalarExpr, maxSteps = MAX_MATRIX_SCALAR_AST_NODES): boolean {
  let steps = 0;
  const stack: ScalarExpr[] = [expr];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    steps++;
    if (steps > maxSteps) return false;
    switch (cur.kind) {
      case "const":
        if (toRational(cur.value) === null) return false;
        break;
      case "variable":
        break;
      case "neg":
      case "abs":
      case "sin":
      case "cos":
      case "exp":
        stack.push(cur.value);
        break;
      case "add":
      case "sub":
      case "mul":
        stack.push(cur.left, cur.right);
        break;
      case "pow":
        if (!Number.isInteger(cur.exponent) || cur.exponent <= 0) return false;
        stack.push(cur.base);
        break;
      case "div":
      case "sqrt":
      case "ln":
        return false;
    }
  }
  return true;
}

function tryScalarConstRational(expr: ScalarExpr): SpanRational | null {
  if (expr.kind !== "const") return null;
  return toRational(expr.value);
}

function makeWeightedConst(q: SpanRational): WeightedScalar {
  checkPolyCoeffBound(q);
  return { expr: { kind: "const", value: q }, weight: 1 };
}

function makeWeightedLeafScalar(expr: ScalarExpr): WeightedScalar {
  const vars = collectVariables(expr);
  if (vars.size === 0) {
    const evaluated = evaluateExactRationalExt(expr, rational(0n), "__const__");
    if (evaluated.status === "value") {
      return makeWeightedConst(evaluated.value);
    }
  }
  return { expr, weight: measureScalarAstWeight(expr) };
}

function negWeightedScalar(scalar: WeightedScalar, maxNodes = MAX_MATRIX_SCALAR_AST_NODES): WeightedScalar {
  const q = tryScalarConstRational(scalar.expr);
  if (q !== null) return makeWeightedConst(rational(-q.n, q.d));
  const weight = scalar.weight + 1;
  if (weight > maxNodes) throw new PolyComplexityError();
  return { expr: { kind: "neg", value: scalar.expr }, weight };
}

function combineWeightedScalars(
  left: WeightedScalar | undefined,
  right: WeightedScalar,
  op: "add" | "sub",
  maxNodes = MAX_MATRIX_SCALAR_AST_NODES,
): WeightedScalar {
  if (!left) return op === "add" ? right : negWeightedScalar(right, maxNodes);
  const lq = tryScalarConstRational(left.expr);
  const rq = tryScalarConstRational(right.expr);
  if (lq !== null && rq !== null) {
    return makeWeightedConst(op === "add" ? addRational(lq, rq) : subtractRational(lq, rq));
  }
  if (rq !== null && rq.n === 0n) return left;
  if (lq !== null && lq.n === 0n) return op === "add" ? right : negWeightedScalar(right, maxNodes);
  const weight = left.weight + right.weight + 1;
  if (weight > maxNodes) throw new PolyComplexityError();
  return { expr: { kind: op, left: left.expr, right: right.expr }, weight };
}

function mulWeightedScalars(
  left: WeightedScalar,
  right: WeightedScalar,
  maxNodes = MAX_MATRIX_SCALAR_AST_NODES,
): WeightedScalar {
  const lq = tryScalarConstRational(left.expr);
  const rq = tryScalarConstRational(right.expr);
  if (lq !== null && rq !== null) {
    return makeWeightedConst(multiplyRational(lq, rq));
  }
  if (lq !== null) {
    if (lq.n === 1n && lq.d === 1n) return right;
    if (lq.n === -1n && lq.d === 1n) return negWeightedScalar(right, maxNodes);
    if (lq.n === 0n && isDomainHazardFreeExpr(right.expr, maxNodes)) return makeWeightedConst(rational(0n));
  }
  if (rq !== null) {
    if (rq.n === 1n && rq.d === 1n) return left;
    if (rq.n === -1n && rq.d === 1n) return negWeightedScalar(left, maxNodes);
    if (rq.n === 0n && isDomainHazardFreeExpr(left.expr, maxNodes)) return makeWeightedConst(rational(0n));
  }
  const weight = left.weight + right.weight + 1;
  if (weight > maxNodes) throw new PolyComplexityError();
  return { expr: { kind: "mul", left: left.expr, right: right.expr }, weight };
}

function matrixWordDegree(word: string): number {
  return word ? word.split("\u0000").length : 0;
}

function concatMatrixWords(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\u0000${b}`;
}

function sortMatrixWord(word: string): string {
  if (!word) return "";
  if (word.startsWith("__cell_")) {
    const parts = word.split("\u0000");
    return [parts[0]!, ...parts.slice(1).sort()].join("\u0000");
  }
  return word.split("\u0000").sort().join("\u0000");
}

function decomposeMatrixExpr(
  expr: ScalarExpr,
  nonCommVars: ReadonlySet<string>,
  budget: PolyMulBudget,
  walkState: { steps: number } = { steps: 0 },
  depth = 0,
): { ok: true; words: MatrixWeightedWordMap; scalarFactors: ScalarExpr[] } | { ok: false; reason: string } {
  bumpAstSteps(walkState, depth);
  if (!exprContainsAnyVar(expr, nonCommVars)) {
    const scalarFactors = expr.kind === "const" && toRational(expr.value)?.n === 0n ? [] : [expr];
    return { ok: true, words: new Map([["", makeWeightedLeafScalar(expr)]]), scalarFactors };
  }
  switch (expr.kind) {
    case "variable":
      return { ok: true, words: new Map([[expr.name, makeWeightedConst(rational(1n))]]), scalarFactors: [] };
    case "neg": {
      const inner = decomposeMatrixExpr(expr.value, nonCommVars, budget, walkState, depth + 1);
      if (!inner.ok) return inner;
      const words: MatrixWeightedWordMap = new Map();
      for (const [w, coeff] of inner.words) {
        words.set(w, negWeightedScalar(coeff));
      }
      return { ok: true, words, scalarFactors: inner.scalarFactors };
    }
    case "add":
    case "sub": {
      const l = decomposeMatrixExpr(expr.left, nonCommVars, budget, walkState, depth + 1);
      if (!l.ok) return l;
      const r = decomposeMatrixExpr(expr.right, nonCommVars, budget, walkState, depth + 1);
      if (!r.ok) return r;
      const words: MatrixWeightedWordMap = new Map(l.words);
      for (const [w, coeff] of r.words) {
        words.set(w, combineWeightedScalars(words.get(w), coeff, expr.kind));
        if (words.size > MAX_SYMBOLIC_POLY_TERMS) throw new PolyComplexityError();
      }
      return { ok: true, words, scalarFactors: [...l.scalarFactors, ...r.scalarFactors] };
    }
    case "mul": {
      const l = decomposeMatrixExpr(expr.left, nonCommVars, budget, walkState, depth + 1);
      if (!l.ok) return l;
      const r = decomposeMatrixExpr(expr.right, nonCommVars, budget, walkState, depth + 1);
      if (!r.ok) return r;
      const words: MatrixWeightedWordMap = new Map();
      for (const [wl, cl] of l.words) {
        for (const [wr, cr] of r.words) {
          budget.mulSteps++;
          if (budget.mulSteps > MAX_SYMBOLIC_MUL_STEPS) throw new PolyComplexityError();
          const combinedWord = concatMatrixWords(wl, wr);
          if (matrixWordDegree(combinedWord) > MAX_SYMBOLIC_POLY_DEGREE) throw new PolyComplexityError();
          const prodCoeff = mulWeightedScalars(cl, cr);
          words.set(combinedWord, combineWeightedScalars(words.get(combinedWord), prodCoeff, "add"));
          if (words.size > MAX_SYMBOLIC_POLY_TERMS) throw new PolyComplexityError();
        }
      }
      return { ok: true, words, scalarFactors: [...l.scalarFactors, ...r.scalarFactors] };
    }
    case "div": {
      if (exprContainsAnyVar(expr.right, nonCommVars)) {
        return { ok: false, reason: "non_commutative_division_unsupported" };
      }
      const l = decomposeMatrixExpr(expr.left, nonCommVars, budget, walkState, depth + 1);
      if (!l.ok) return l;
      const foldedDen = makeWeightedLeafScalar(expr.right);
      const denConst = tryScalarConstRational(foldedDen.expr);
      const rawDenWeight = denConst !== null && denConst.n !== 0n ? 1 : measureScalarAstWeight(expr.right);
      const words: MatrixWeightedWordMap = new Map();
      for (const [w, coeff] of l.words) {
        const lq = tryScalarConstRational(coeff.expr);
        if (lq !== null && denConst !== null && denConst.n !== 0n) {
          words.set(w, makeWeightedConst(divideRational(lq, denConst)));
          continue;
        }
        const weight = coeff.weight + rawDenWeight + 1;
        if (weight > MAX_MATRIX_SCALAR_AST_NODES) throw new PolyComplexityError();
        words.set(w, { expr: { kind: "div", left: coeff.expr, right: expr.right }, weight });
      }
      const recipFactor: ScalarExpr = { kind: "div", left: { kind: "const", value: 1 }, right: expr.right };
      return { ok: true, words, scalarFactors: [...l.scalarFactors, recipFactor] };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) {
        return { ok: false, reason: "power_out_of_bounds" };
      }
      if (expr.exponent <= 0) {
        return { ok: false, reason: "non_commutative_power_unsupported" };
      }
      const base = decomposeMatrixExpr(expr.base, nonCommVars, budget, walkState, depth + 1);
      if (!base.ok) return base;
      let accWords: MatrixWeightedWordMap = new Map([["", makeWeightedConst(rational(1n))]]);
      for (let i = 0; i < expr.exponent; i++) {
        const next: MatrixWeightedWordMap = new Map();
        for (const [wl, cl] of accWords) {
          for (const [wr, cr] of base.words) {
            budget.mulSteps++;
            if (budget.mulSteps > MAX_SYMBOLIC_MUL_STEPS) throw new PolyComplexityError();
            const combinedWord = concatMatrixWords(wl, wr);
            if (matrixWordDegree(combinedWord) > MAX_SYMBOLIC_POLY_DEGREE) throw new PolyComplexityError();
            const prodCoeff = mulWeightedScalars(cl, cr);
            next.set(combinedWord, combineWeightedScalars(next.get(combinedWord), prodCoeff, "add"));
            if (next.size > MAX_SYMBOLIC_POLY_TERMS) throw new PolyComplexityError();
          }
        }
        accWords = next;
      }
      return { ok: true, words: accWords, scalarFactors: base.scalarFactors };
    }
    default:
      return { ok: false, reason: `${expr.kind}_outside_non_commutative_fragment` };
  }
}

function resolveNonCommutativeVarsAndScalar(
  student: ScalarExpr,
  reference: ScalarExpr,
  domain: DomainSpec | undefined,
  defaultAllNonCommutative: boolean,
): { ok: true; nonCommVars: Set<string>; scalarVar: string | null } | { ok: false; reason: string } {
  const vars = new Set([...collectVariables(student), ...collectVariables(reference)]);
  const declaredNc = domain?.nonCommutativeVars ?? [];
  const declaredScalar = domain?.variable && !declaredNc.includes(domain.variable) ? domain.variable : null;
  if (declaredNc.length > 0) {
    const nonCommVars = new Set(declaredNc);
    let scalarVar = declaredScalar;
    if (!scalarVar) {
      const remaining = [...vars].filter((v) => !nonCommVars.has(v));
      if (defaultAllNonCommutative) {
        if (remaining.length > 1) return { ok: false, reason: "foreign_variable" };
        scalarVar = remaining[0] ?? "x";
      } else {
        scalarVar = !nonCommVars.has("x") ? "x" : null;
        for (const v of remaining) {
          if (v !== scalarVar) return { ok: false, reason: "foreign_variable" };
        }
      }
    } else {
      for (const v of vars) {
        if (!nonCommVars.has(v) && v !== scalarVar) return { ok: false, reason: "foreign_variable" };
      }
    }
    return { ok: true, nonCommVars, scalarVar };
  }
  const nonCommVars = defaultAllNonCommutative
    ? new Set([...vars].filter((v) => v !== declaredScalar))
    : new Set<string>();
  return { ok: true, nonCommVars, scalarVar: declaredScalar };
}

function firstUnverifiedFactorReason(factors: readonly ScalarExpr[], scalarDomain: DomainSpec): string | null {
  for (const factor of factors) {
    const selfRes = verifyScalarEquivalence(factor, factor, scalarDomain);
    if (selfRes.status === "unverified") return selfRes.reason ?? "empty_natural_domain";
  }
  return null;
}

function collectUniqueScalarTerms(decomp: { words: MatrixWeightedWordMap; scalarFactors: ScalarExpr[] }): ScalarExpr[] {
  const seen = new Set<ScalarExpr>();
  const out: ScalarExpr[] = [];
  for (const scalar of decomp.words.values()) {
    if (!seen.has(scalar.expr)) {
      seen.add(scalar.expr);
      out.push(scalar.expr);
    }
  }
  for (const factor of decomp.scalarFactors) {
    if (!seen.has(factor)) {
      seen.add(factor);
      out.push(factor);
    }
  }
  return out;
}

function mergeCollectedConstraints(terms: readonly ScalarExpr[], variable: string): CollectedConstraints {
  const out: CollectedConstraints = {
    rational: [],
    quadBinomials: [],
    splitPolys: [],
    uncheckedOps: [],
    hasNonRationalDomainOps: false,
    alwaysUndefined: false,
  };
  for (const term of terms) {
    const c = collectConstraints(term, variable);
    out.rational.push(...c.rational);
    out.quadBinomials.push(...c.quadBinomials);
    out.splitPolys.push(...c.splitPolys);
    out.uncheckedOps.push(...c.uncheckedOps);
    if (c.hasNonRationalDomainOps) out.hasNonRationalDomainOps = true;
    if (c.alwaysUndefined) out.alwaysUndefined = true;
  }
  return out;
}

function collectJointRationalDens(
  terms: readonly ScalarExpr[],
  variable: string,
): { allRational: true; dens: Polynomial[]; alwaysUndefined: boolean } | { allRational: false } {
  const dens: Polynomial[] = [];
  let alwaysUndefined = false;
  for (const term of terms) {
    const rf = rationalForm(term, variable);
    if (rf.unsupported === "polynomial_complexity_exceeded") throw new PolyComplexityError();
    if (rf.unsupported) return { allRational: false };
    if (rf.zeroDenominator || rf.denominator.size === 0) alwaysUndefined = true;
    for (const den of rf.domainDenominators) {
      if (den.size === 0) alwaysUndefined = true;
      else if (polynomialDegree(den) >= 1) dens.push(den);
    }
    if (polynomialDegree(rf.denominator) >= 1) dens.push(rf.denominator);
  }
  return { allRational: true, dens, alwaysUndefined };
}

function resolveTermsDefinedAtSite(
  terms: readonly ScalarExpr[],
  site: SampleSite,
  variable: string,
): "defined" | "undefined_domain" | "unresolved" {
  let sawUnresolved = false;
  for (const term of terms) {
    const status = resolveExprDefinedAtSite(term, site, variable);
    if (status === "undefined_domain") return "undefined_domain";
    if (status === "unresolved") sawUnresolved = true;
  }
  return sawUnresolved ? "unresolved" : "defined";
}

function tightenWordDomainFromCad(
  scalarDomain: DomainSpec,
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
  cad: CadPlan,
  sConstraints: CollectedConstraints,
  rConstraints: CollectedConstraints,
): DomainSpec {
  const extraExcluded: string[] = [];
  const validRationalKeys = new Set<string>();
  const validRationals: SpanRational[] = [];
  let hasIsolated = false;

  for (const site of cad.sites) {
    if (site.kind === "isolated") {
      hasIsolated = true;
      continue;
    }
    const ok =
      constraintsSatisfiedAtSite(sConstraints, site) && constraintsSatisfiedAtSite(rConstraints, site);
    if (!ok) {
      extraExcluded.push(formatRational(site.x));
    } else {
      const key = formatRational(site.x);
      if (!validRationalKeys.has(key)) {
        validRationalKeys.add(key);
        validRationals.push(site.x);
      }
    }
  }

  const excluded = [...(scalarDomain.excluded ?? []), ...extraExcluded];
  if (hasIsolated) {
    return {
      ...scalarDomain,
      ...(excluded.length > 0 ? { excluded } : {}),
    };
  }

  const activeCells = cad.openCells
    .filter((cell) => {
      const sampleSite: SampleSite = { kind: "rational", x: cell.sample };
      return constraintsSatisfiedAtSite(sConstraints, sampleSite) && constraintsSatisfiedAtSite(rConstraints, sampleSite);
    })
    .sort((a, b) => {
      if (a.left === null && b.left === null) return 0;
      if (a.left === null) return -1;
      if (b.left === null) return 1;
      return compareRational(a.left, b.left);
    });

  const mergedIntervals: DomainInterval[] = [];
  const coveredPoints = new Set<string>();
  const intervalsFromCells: NormalizedInterval[] = [];

  for (const cell of activeCells) {
    const leftValid = cell.left !== null && validRationalKeys.has(formatRational(cell.left));
    const rightValid = cell.right !== null && validRationalKeys.has(formatRational(cell.right));
    const nextIv: NormalizedInterval = {
      left: cell.left,
      right: cell.right,
      leftOpen: !leftValid,
      rightOpen: !rightValid,
    };
    const prev = intervalsFromCells[intervalsFromCells.length - 1];
    if (
      prev &&
      prev.right !== null &&
      nextIv.left !== null &&
      equalRational(prev.right, nextIv.left) &&
      validRationalKeys.has(formatRational(prev.right))
    ) {
      prev.right = nextIv.right;
      prev.rightOpen = nextIv.rightOpen;
    } else {
      intervalsFromCells.push(nextIv);
    }
  }

  for (const iv of intervalsFromCells) {
    for (const pt of validRationals) {
      if (pointInInterval(pt, iv)) coveredPoints.add(formatRational(pt));
    }
    mergedIntervals.push({
      ...(iv.left !== null ? { left: formatRational(iv.left), leftOpen: iv.leftOpen } : {}),
      ...(iv.right !== null ? { right: formatRational(iv.right), rightOpen: iv.rightOpen } : {}),
    });
  }

  for (const pt of validRationals) {
    const key = formatRational(pt);
    if (!coveredPoints.has(key) && parsedDomain.intervals.some((iv) => pointInInterval(pt, iv))) {
      mergedIntervals.push({ left: key, right: key });
    }
  }

  if (mergedIntervals.length === 0) {
    return {
      ...scalarDomain,
      ...(excluded.length > 0 ? { excluded } : {}),
    };
  }
  return {
    ...scalarDomain,
    intervals: mergedIntervals,
    ...(excluded.length > 0 ? { excluded } : {}),
  };
}

function verifyMatchedDomainRationalWord(
  sCoeff: ScalarExpr,
  rCoeff: ScalarExpr,
  variable: string,
  validJointSites: readonly SampleSite[],
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
  domain: DomainSpec | undefined,
): VerificationResult | null {
  const sRf = rationalForm(sCoeff, variable);
  const rRf = rationalForm(rCoeff, variable);
  if (sRf.unsupported || rRf.unsupported) return null;
  const crossBudget: PolyMulBudget = { mulSteps: 0 };
  const combinedDen = boundedPolyMultiply(sRf.denominator, rRf.denominator, crossBudget);
  const leftCross = boundedPolyMultiply(sRf.numerator, rRf.denominator, crossBudget);
  const rightCross = boundedPolyMultiply(rRf.numerator, sRf.denominator, crossBudget);
  if (!combinedDen || !leftCross || !rightCross) {
    return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
  }
  const residual = polynomialAdd(leftCross, rightCross, -1);
  if (exceedsPolyLimits(residual)) {
    return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
  }
  if (residual.size === 0) {
    return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
  }
  for (const site of validJointSites) {
    if (site.kind !== "rational") continue;
    if (polynomialEvaluate(combinedDen, site.x).n === 0n) continue;
    if (polynomialEvaluate(residual, site.x).n !== 0n) {
      return {
        status: "inequivalent",
        reason: "residual_nonzero",
        witness: { input: formatRational(site.x), detail: "exact residual is non-zero" },
        domain,
      };
    }
  }
  const deg = polynomialDegree(residual);
  const hasNonDegenerateInterval = parsedDomain.intervals.some(
    (iv) => !(iv.left && iv.right && equalRational(iv.left, iv.right)),
  );
  if (!hasNonDegenerateInterval) {
    return { status: "equivalent", reason: "exact_rational_identity_on_locked_domain", domain };
  }
  const maxProbes = deg + Math.max(0, polynomialDegree(combinedDen)) + parsedDomain.excluded.length + 5;
  for (const iv of parsedDomain.intervals) {
    if (iv.left && iv.right && equalRational(iv.left, iv.right)) continue;
    let probe = pickRationalBetween(iv.left, iv.right);
    for (let i = 0; i < maxProbes; i++) {
      if (
        pointInInterval(probe, iv) &&
        !parsedDomain.excluded.some((e) => equalRational(e, probe)) &&
        polynomialEvaluate(combinedDen, probe).n !== 0n
      ) {
        if (polynomialEvaluate(residual, probe).n !== 0n) {
          return {
            status: "inequivalent",
            reason: "residual_nonzero",
            witness: { input: formatRational(probe), detail: "exact residual is non-zero" },
            domain,
          };
        }
      }
      probe = iv.right !== null ? divideRational(addRational(probe, iv.right), rational(2n)) : addRational(probe, rational(1n));
    }
  }
  return { status: "unverified", reason: "residual_nonzero_unwitnessed", domain };
}

function areWordDenominatorsCoveredByJoint(
  sCoeff: ScalarExpr,
  rCoeff: ScalarExpr,
  variable: string,
  sJointUnion: Polynomial,
  rJointUnion: Polynomial,
  wordParsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
): boolean {
  const sWordRf = rationalForm(sCoeff, variable);
  const rWordRf = rationalForm(rCoeff, variable);
  if (sWordRf.unsupported === "polynomial_complexity_exceeded" || rWordRf.unsupported === "polynomial_complexity_exceeded") {
    throw new PolyComplexityError();
  }
  if (sWordRf.unsupported || rWordRf.unsupported) return false;
  const sWordDens = [
    ...sWordRf.domainDenominators,
    ...(polynomialDegree(sWordRf.denominator) >= 1 ? [sWordRf.denominator] : []),
  ];
  const rWordDens = [
    ...rWordRf.domainDenominators,
    ...(polynomialDegree(rWordRf.denominator) >= 1 ? [rWordRf.denominator] : []),
  ];
  const sWordUnion = squareFreeProduct(sWordDens);
  const rWordUnion = squareFreeProduct(rWordDens);
  if (!sWordUnion || !rWordUnion) throw new PolyComplexityError();
  const common = polynomialGcd(sWordUnion, rWordUnion);
  const sOnly = polynomialDegree(common) >= 1 ? polynomialDivMod(sWordUnion, common).quotient : sWordUnion;
  const rOnly = polynomialDegree(common) >= 1 ? polynomialDivMod(rWordUnion, common).quotient : rWordUnion;
  if (polynomialDegree(sOnly) >= 1) {
    const covR = checkDenominatorSetsEquivalent(
      [sOnly, rJointUnion],
      [rJointUnion],
      wordParsedDomain.intervals,
      wordParsedDomain.excluded,
    );
    if (!covR.equal) {
      if (covR.complexityExceeded) throw new PolyComplexityError();
      return false;
    }
  }
  if (polynomialDegree(rOnly) >= 1) {
    const covS = checkDenominatorSetsEquivalent(
      [rOnly, sJointUnion],
      [sJointUnion],
      wordParsedDomain.intervals,
      wordParsedDomain.excluded,
    );
    if (!covS.equal) {
      if (covS.complexityExceeded) throw new PolyComplexityError();
      return false;
    }
  }
  return true;
}

function isMixedWitnessPositivelyDefined(
  res: VerificationResult,
  sTerms: readonly ScalarExpr[],
  rTerms: readonly ScalarExpr[],
  sConstraints: CollectedConstraints,
  rConstraints: CollectedConstraints,
  cadSites: readonly SampleSite[],
  variable: string,
  positivelyDefinedSites: readonly SampleSite[] = [],
  cadOpenCells: readonly CadOpenCell[] = [],
  excluded: readonly SpanRational[] = [],
): boolean {
  const wInput = res.witness?.input;
  if (!wInput) return false;
  const checkAtSite = (site: SampleSite): boolean => {
    const sCon = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, site);
    const rCon = !rConstraints.alwaysUndefined && constraintsSatisfiedAtSite(rConstraints, site);
    const sDef = sCon ? resolveTermsDefinedAtSite(sTerms, site, variable) : "undefined_domain";
    const rDef = rCon ? resolveTermsDefinedAtSite(rTerms, site, variable) : "undefined_domain";
    if (res.reason === "natural_domain_mismatch") {
      return (sDef === "defined" && rDef === "undefined_domain") || (rDef === "defined" && sDef === "undefined_domain");
    }
    return sDef === "defined" && rDef === "defined";
  };
  if (wInput === "const") {
    for (const site of positivelyDefinedSites) {
      if (checkAtSite(site)) return true;
    }
    for (const site of cadSites) {
      if (checkAtSite(site)) return true;
    }
    for (const cell of cadOpenCells) {
      for (const probe of collectOpenCellProbes(cell, excluded)) {
        if (checkAtSite({ kind: "rational", x: probe })) return true;
      }
    }
    return false;
  }
  const q = toRational(wInput);
  if (q !== null) {
    return checkAtSite({ kind: "rational", x: q });
  }
  const openMatch = /^\(([^,]+),\s*([^)]+)\)$/.exec(wInput.trim());
  if (!openMatch) return false;
  const low = toRational(openMatch[1]!);
  const high = toRational(openMatch[2]!);
  if (!low || !high) return false;
  let verifiedOne = false;
  for (const site of cadSites) {
    if (site.kind !== "isolated") continue;
    if (compareRational(site.high, low) <= 0 || compareRational(high, site.low) <= 0) continue;
    const sCon = !sConstraints.alwaysUndefined && constraintsSatisfiedAtSite(sConstraints, site);
    const rCon = !rConstraints.alwaysUndefined && constraintsSatisfiedAtSite(rConstraints, site);
    if (!sCon && !rCon) return false;
    const sDef = sCon ? resolveTermsDefinedAtSite(sTerms, site, variable) : "undefined_domain";
    const rDef = rCon ? resolveTermsDefinedAtSite(rTerms, site, variable) : "undefined_domain";
    if (sDef === "undefined_domain" && rDef === "undefined_domain") return false;
    if (res.reason === "natural_domain_mismatch") {
      if ((sDef === "defined" && rDef === "undefined_domain") || (rDef === "defined" && sDef === "undefined_domain")) {
        verifiedOne = true;
      }
    } else if (sDef === "defined" && rDef === "defined") {
      verifiedOne = true;
    }
  }
  return verifiedOne;
}

const MATRIX_LITERAL_ENVS = new Set(["pmatrix", "bmatrix", "matrix", "vmatrix"]);
const MAX_LITERAL_MATRIX_CELLS = 64;

function countBackslashesBefore(src: string, idx: number): number {
  let count = 0;
  let p = idx - 1;
  while (p >= 0 && src[p] === "\\") {
    count++;
    p--;
  }
  return count;
}

function findUnescapedCommandAt(src: string, idx: number, cmd: "begin" | "end"): string | null {
  if (src[idx] !== "\\" || countBackslashesBefore(src, idx) % 2 !== 0) return null;
  const prefix = `\\${cmd}{`;
  if (!src.startsWith(prefix, idx)) return null;
  const closeIdx = src.indexOf("}", idx + prefix.length);
  if (closeIdx < 0) return null;
  const name = src.slice(idx + prefix.length, closeIdx).trim();
  if (!/^[A-Za-z]+$/.test(name)) return null;
  return name;
}

function findMatchingEndEnv(src: string, bodyStart: number, rootEnv: string): { bodyEnd: number; afterEnd: number } | null {
  const stack: string[] = [rootEnv];
  let i = bodyStart;
  while (i < src.length) {
    if (src[i] === "\\" && countBackslashesBefore(src, i) % 2 === 0) {
      const beginName = findUnescapedCommandAt(src, i, "begin");
      if (beginName) {
        stack.push(beginName);
        i = src.indexOf("}", i) + 1;
        continue;
      }
      const endName = findUnescapedCommandAt(src, i, "end");
      if (endName) {
        const popped = stack.pop();
        if (popped !== endName) return null;
        const afterEnd = src.indexOf("}", i) + 1;
        if (stack.length === 0) {
          return { bodyEnd: i, afterEnd };
        }
        i = afterEnd;
        continue;
      }
    }
    i++;
  }
  return null;
}

function splitMatrixBody(body: string): string[][] | null {
  const rows: string[][] = [];
  let curRow: string[] = [];
  let cellStart = 0;
  let braceDepth = 0;
  let envDepth = 0;
  let i = 0;

  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "\\" && countBackslashesBefore(body, i) % 2 === 0) {
      const beginName = findUnescapedCommandAt(body, i, "begin");
      if (beginName) {
        envDepth++;
        i = body.indexOf("}", i) + 1;
        continue;
      }
      const endName = findUnescapedCommandAt(body, i, "end");
      if (endName) {
        if (envDepth === 0) return null;
        envDepth--;
        i = body.indexOf("}", i) + 1;
        continue;
      }
      if (body[i + 1] === "\\" && braceDepth === 0 && envDepth === 0) {
        curRow.push(body.slice(cellStart, i).trim());
        rows.push(curRow);
        curRow = [];
        i += 2;
        while (i < body.length && (body[i] === " " || body[i] === "\t" || body[i] === "\r" || body[i] === "\n")) i++;
        if (body[i] === "[") {
          const skipMatch = /^\[[+-]?\d+(?:\.\d+)?\s*(?:pt|em|ex|mm|cm|in|pc)\]/.exec(body.slice(i));
          if (skipMatch) i += skipMatch[0].length;
        }
        cellStart = i;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === "{" && countBackslashesBefore(body, i) % 2 === 0) {
      braceDepth++;
    } else if (ch === "}" && countBackslashesBefore(body, i) % 2 === 0) {
      if (braceDepth === 0) return null;
      braceDepth--;
    } else if (ch === "&" && braceDepth === 0 && envDepth === 0 && countBackslashesBefore(body, i) % 2 === 0) {
      curRow.push(body.slice(cellStart, i).trim());
      cellStart = i + 1;
    }
    i++;
  }

  if (braceDepth !== 0 || envDepth !== 0) return null;
  curRow.push(body.slice(cellStart).trim());
  rows.push(curRow);

  if (rows.length === 0 || rows[0]!.length === 0) return null;
  const cols = rows[0]!.length;
  for (const row of rows) {
    if (row.length !== cols) return null;
    for (const cell of row) {
      if (!cell) return null;
    }
  }
  return rows;
}

function expandDeterminantExpr(grid: ScalarExpr[][]): ScalarExpr {
  const n = grid.length;
  if (n === 1) return grid[0]![0]!;
  if (n === 2) {
    return {
      kind: "sub",
      left: { kind: "mul", left: grid[0]![0]!, right: grid[1]![1]! },
      right: { kind: "mul", left: grid[0]![1]!, right: grid[1]![0]! },
    };
  }
  let acc: ScalarExpr | null = null;
  for (let col = 0; col < n; col++) {
    const minor: ScalarExpr[][] = [];
    for (let r = 1; r < n; r++) {
      const mRow: ScalarExpr[] = [];
      for (let c = 0; c < n; c++) {
        if (c !== col) mRow.push(grid[r]![c]!);
      }
      minor.push(mRow);
    }
    const term: ScalarExpr = { kind: "mul", left: grid[0]![col]!, right: expandDeterminantExpr(minor) };
    if (col === 0) {
      acc = term;
    } else {
      acc = { kind: col % 2 === 1 ? "sub" : "add", left: acc!, right: term };
    }
  }
  return acc!;
}

type MatrixPreprocessContext = {
  matrixLiterals: Map<string, ScalarExpr[][]>;
  scalarLiterals: Map<string, ScalarExpr>;
  vmatrixVars: Set<string>;
  litCounter: number;
  fullInput: string;
};

type GridEvalValue =
  | { kind: "scalar"; expr: ScalarExpr }
  | { kind: "matrix"; rows: number; cols: number; cells: ScalarExpr[][] };

function substituteScalarLiteralsIterative(
  expr: ScalarExpr,
  scalarLiterals: ReadonlyMap<string, ScalarExpr>,
): ScalarExpr {
  if (scalarLiterals.size === 0) return expr;
  const cache = new Map<ScalarExpr, ScalarExpr>();
  const stack: Array<{ node: ScalarExpr; expanded: boolean }> = [{ node: expr, expanded: false }];
  let steps = 0;
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const cur = top.node;
    if (cache.has(cur)) {
      stack.pop();
      continue;
    }
    if (!top.expanded) {
      top.expanded = true;
      steps++;
      if (steps > MAX_PARSE_AST_NODES * 4) throw new PolyComplexityError();
      switch (cur.kind) {
        case "const":
        case "variable":
          break;
        case "neg":
        case "sqrt":
        case "abs":
        case "ln":
        case "sin":
        case "cos":
        case "exp":
          stack.push({ node: cur.value, expanded: false });
          continue;
        case "pow":
          stack.push({ node: cur.base, expanded: false });
          continue;
        case "add":
        case "sub":
        case "mul":
        case "div":
          stack.push({ node: cur.right, expanded: false }, { node: cur.left, expanded: false });
          continue;
      }
    }
    stack.pop();
    switch (cur.kind) {
      case "const":
        cache.set(cur, cur);
        break;
      case "variable":
        cache.set(cur, scalarLiterals.get(cur.name) ?? cur);
        break;
      case "neg":
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        cache.set(cur, { kind: cur.kind, value: cache.get(cur.value)! });
        break;
      case "pow":
        cache.set(cur, { kind: "pow", base: cache.get(cur.base)!, exponent: cur.exponent });
        break;
      case "add":
      case "sub":
      case "mul":
      case "div":
        cache.set(cur, { kind: cur.kind, left: cache.get(cur.left)!, right: cache.get(cur.right)! });
        break;
    }
  }
  return cache.get(expr)!;
}

function preprocessAndParseLatexExpr(
  rawInput: string,
  parseOpts: NormalizeLatexOptions,
  ctx: MatrixPreprocessContext,
  depth = 0,
): { ok: true; value: GridEvalValue; hadVmatrix: boolean; cellScalarOnly: boolean } | { ok: false; reason: string } {
  if (depth > MAX_PARSE_DEPTH) throw new PolyComplexityError();
  let rewritten = "";
  let i = 0;
  let hadVmatrix = false;
  let hadMatrixGrid = false;
  const localSyntheticIdents: string[] = [];

  const allocIdent = (prefix: "MatLit" | "ScMatLit"): string => {
    while (true) {
      const candidate = `${prefix}${ctx.litCounter++}`;
      if (!ctx.fullInput.includes(candidate) && !ctx.matrixLiterals.has(candidate) && !ctx.scalarLiterals.has(candidate)) {
        localSyntheticIdents.push(candidate);
        return candidate;
      }
    }
  };

  while (i < rawInput.length) {
    if (rawInput[i] === "\\" && countBackslashesBefore(rawInput, i) % 2 === 0) {
      const envName = findUnescapedCommandAt(rawInput, i, "begin");
      if (envName) {
        if (!MATRIX_LITERAL_ENVS.has(envName)) {
          return { ok: false, reason: "parse_outside_decidable_fragment" };
        }
        const openBraceClose = rawInput.indexOf("}", i);
        const matched = findMatchingEndEnv(rawInput, openBraceClose + 1, envName);
        if (!matched) return { ok: false, reason: "parse_outside_decidable_fragment" };
        const body = rawInput.slice(openBraceClose + 1, matched.bodyEnd);
        const cellStrings = splitMatrixBody(body);
        if (!cellStrings) return { ok: false, reason: "parse_outside_decidable_fragment" };
        const rows = cellStrings.length;
        const cols = cellStrings[0]!.length;
        if (rows * cols > MAX_LITERAL_MATRIX_CELLS) throw new PolyComplexityError();

        const cellExprs: ScalarExpr[][] = [];
        for (let r = 0; r < rows; r++) {
          const rowExprs: ScalarExpr[] = [];
          for (let c = 0; c < cols; c++) {
            const cellParsed = preprocessAndParseLatexExpr(cellStrings[r]![c]!, parseOpts, ctx, depth + 1);
            if (!cellParsed.ok) return cellParsed;
            if (cellParsed.value.kind !== "scalar") {
              return { ok: false, reason: "parse_outside_decidable_fragment" };
            }
            if (envName === "vmatrix") {
              for (const v of collectVariables(cellParsed.value.expr)) ctx.vmatrixVars.add(v);
            }
            rowExprs.push(cellParsed.value.expr);
          }
          cellExprs.push(rowExprs);
        }

        if (envName === "vmatrix") {
          if (rows !== cols || rows > 4) {
            return { ok: false, reason: "parse_outside_decidable_fragment" };
          }
          hadVmatrix = true;
          const detExpr = expandDeterminantExpr(cellExprs);
          const ident = allocIdent("ScMatLit");
          ctx.scalarLiterals.set(ident, detExpr);
          rewritten += ` ${ident} `;
        } else {
          hadMatrixGrid = true;
          const ident = allocIdent("MatLit");
          ctx.matrixLiterals.set(ident, cellExprs);
          rewritten += ` ${ident} `;
        }
        i = matched.afterEnd;
        continue;
      }
    }
    rewritten += rawInput[i]!;
    i++;
  }

  const mergedOpts: NormalizeLatexOptions & { forceNormalize?: boolean } = {
    ...parseOpts,
    forceNormalize: true,
    preservedIdentifiers: [...(parseOpts.preservedIdentifiers ?? []), ...localSyntheticIdents],
    implicitMulIdentifiers: [...(parseOpts.implicitMulIdentifiers ?? []), ...localSyntheticIdents],
  };
  const outerAst = parseScalarExprInner(rewritten, mergedOpts);
  if (!outerAst) return { ok: false, reason: "parse_outside_decidable_fragment" };

  if (!hadMatrixGrid && ctx.matrixLiterals.size === 0) {
    return {
      ok: true,
      value: { kind: "scalar", expr: substituteScalarLiteralsIterative(outerAst, ctx.scalarLiterals) },
      hadVmatrix,
      cellScalarOnly: !outerAstHasNonLocalVars(outerAst, localSyntheticIdents),
    };
  }

  const evalState = { nodes: 0 };
  const bumpGridNodes = (add: number) => {
    evalState.nodes += add;
    if (evalState.nodes > MAX_PARSE_AST_NODES * 2) throw new PolyComplexityError();
  };

  const evalGridAst = (node: ScalarExpr, astDepth = 0): { ok: true; value: GridEvalValue } | { ok: false; reason: string } => {
    if (astDepth > MAX_AST_WALK_DEPTH) throw new PolyComplexityError();
    switch (node.kind) {
      case "const":
        bumpGridNodes(1);
        return { ok: true, value: { kind: "scalar", expr: node } };
      case "variable": {
        const sc = ctx.scalarLiterals.get(node.name);
        if (sc) return { ok: true, value: { kind: "scalar", expr: sc } };
        const grid = ctx.matrixLiterals.get(node.name);
        if (grid) {
          bumpGridNodes(grid.length * grid[0]!.length);
          return {
            ok: true,
            value: { kind: "matrix", rows: grid.length, cols: grid[0]!.length, cells: grid.map((r) => [...r]) },
          };
        }
        bumpGridNodes(1);
        return { ok: true, value: { kind: "scalar", expr: node } };
      }
      case "neg": {
        const inner = evalGridAst(node.value, astDepth + 1);
        if (!inner.ok) return inner;
        if (inner.value.kind === "scalar") {
          bumpGridNodes(1);
          return { ok: true, value: { kind: "scalar", expr: { kind: "neg", value: inner.value.expr } } };
        }
        const cells = inner.value.cells.map((row) =>
          row.map((cell) => {
            bumpGridNodes(1);
            return { kind: "neg" as const, value: cell };
          }),
        );
        return { ok: true, value: { kind: "matrix", rows: inner.value.rows, cols: inner.value.cols, cells } };
      }
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp": {
        const inner = evalGridAst(node.value, astDepth + 1);
        if (!inner.ok) return inner;
        if (inner.value.kind !== "scalar") return { ok: false, reason: "parse_outside_decidable_fragment" };
        bumpGridNodes(1);
        return { ok: true, value: { kind: "scalar", expr: { kind: node.kind, value: inner.value.expr } } };
      }
      case "add":
      case "sub": {
        const l = evalGridAst(node.left, astDepth + 1);
        if (!l.ok) return l;
        const r = evalGridAst(node.right, astDepth + 1);
        if (!r.ok) return r;
        if (l.value.kind === "scalar" && r.value.kind === "scalar") {
          bumpGridNodes(1);
          return { ok: true, value: { kind: "scalar", expr: { kind: node.kind, left: l.value.expr, right: r.value.expr } } };
        }
        if (l.value.kind !== "matrix" || r.value.kind !== "matrix") {
          return { ok: false, reason: "matrix_dimension_mismatch" };
        }
        const lMat = l.value;
        const rMat = r.value;
        if (lMat.rows !== rMat.rows || lMat.cols !== rMat.cols) {
          return { ok: false, reason: "matrix_dimension_mismatch" };
        }
        const cells = lMat.cells.map((row, ri) =>
          row.map((cell, ci) => {
            bumpGridNodes(1);
            return { kind: node.kind, left: cell, right: rMat.cells[ri]![ci]! };
          }),
        );
        return { ok: true, value: { kind: "matrix", rows: lMat.rows, cols: lMat.cols, cells } };
      }
      case "mul": {
        const l = evalGridAst(node.left, astDepth + 1);
        if (!l.ok) return l;
        const r = evalGridAst(node.right, astDepth + 1);
        if (!r.ok) return r;
        if (l.value.kind === "scalar" && r.value.kind === "scalar") {
          bumpGridNodes(1);
          return { ok: true, value: { kind: "scalar", expr: { kind: "mul", left: l.value.expr, right: r.value.expr } } };
        }
        if (l.value.kind === "scalar" && r.value.kind === "matrix") {
          const scalarExpr = l.value.expr;
          const cells = r.value.cells.map((row) =>
            row.map((cell) => {
              bumpGridNodes(1);
              return { kind: "mul" as const, left: scalarExpr, right: cell };
            }),
          );
          return { ok: true, value: { kind: "matrix", rows: r.value.rows, cols: r.value.cols, cells } };
        }
        if (l.value.kind === "matrix" && r.value.kind === "scalar") {
          const scalarExpr = r.value.expr;
          const cells = l.value.cells.map((row) =>
            row.map((cell) => {
              bumpGridNodes(1);
              return { kind: "mul" as const, left: cell, right: scalarExpr };
            }),
          );
          return { ok: true, value: { kind: "matrix", rows: l.value.rows, cols: l.value.cols, cells } };
        }
        if (l.value.kind === "matrix" && r.value.kind === "matrix") {
          if (l.value.cols !== r.value.rows) {
            return { ok: false, reason: "matrix_dimension_mismatch" };
          }
          const outCells: ScalarExpr[][] = [];
          for (let row = 0; row < l.value.rows; row++) {
            const outRow: ScalarExpr[] = [];
            for (let col = 0; col < r.value.cols; col++) {
              let acc: ScalarExpr | null = null;
              for (let k = 0; k < l.value.cols; k++) {
                bumpGridNodes(2);
                const prod: ScalarExpr = {
                  kind: "mul",
                  left: l.value.cells[row]![k]!,
                  right: r.value.cells[k]![col]!,
                };
                acc = acc ? { kind: "add", left: acc, right: prod } : prod;
              }
              outRow.push(acc!);
            }
            outCells.push(outRow);
          }
          return { ok: true, value: { kind: "matrix", rows: l.value.rows, cols: r.value.cols, cells: outCells } };
        }
        return { ok: false, reason: "matrix_dimension_mismatch" };
      }
      case "div": {
        const l = evalGridAst(node.left, astDepth + 1);
        if (!l.ok) return l;
        const r = evalGridAst(node.right, astDepth + 1);
        if (!r.ok) return r;
        if (r.value.kind !== "scalar") {
          return { ok: false, reason: "parse_outside_decidable_fragment" };
        }
        if (l.value.kind === "scalar") {
          bumpGridNodes(1);
          return { ok: true, value: { kind: "scalar", expr: { kind: "div", left: l.value.expr, right: r.value.expr } } };
        }
        const den = r.value.expr;
        const cells = l.value.cells.map((row) =>
          row.map((cell) => {
            bumpGridNodes(1);
            return { kind: "div" as const, left: cell, right: den };
          }),
        );
        return { ok: true, value: { kind: "matrix", rows: l.value.rows, cols: l.value.cols, cells } };
      }
      case "pow": {
        const b = evalGridAst(node.base, astDepth + 1);
        if (!b.ok) return b;
        if (!Number.isInteger(node.exponent) || Math.abs(node.exponent) > 12) {
          return { ok: false, reason: "power_out_of_bounds" };
        }
        if (b.value.kind === "scalar") {
          bumpGridNodes(1);
          return { ok: true, value: { kind: "scalar", expr: { kind: "pow", base: b.value.expr, exponent: node.exponent } } };
        }
        if (b.value.rows !== b.value.cols) {
          return { ok: false, reason: "matrix_dimension_mismatch" };
        }
        if (node.exponent <= 0) {
          return { ok: false, reason: "non_commutative_power_unsupported" };
        }
        let acc = b.value;
        for (let p = 1; p < node.exponent; p++) {
          const outCells: ScalarExpr[][] = [];
          for (let row = 0; row < acc.rows; row++) {
            const outRow: ScalarExpr[] = [];
            for (let col = 0; col < b.value.cols; col++) {
              let sum: ScalarExpr | null = null;
              for (let k = 0; k < acc.cols; k++) {
                bumpGridNodes(2);
                const prod: ScalarExpr = { kind: "mul", left: acc.cells[row]![k]!, right: b.value.cells[k]![col]! };
                sum = sum ? { kind: "add", left: sum, right: prod } : prod;
              }
              outRow.push(sum!);
            }
            outCells.push(outRow);
          }
          acc = { kind: "matrix", rows: acc.rows, cols: b.value.cols, cells: outCells };
        }
        return { ok: true, value: acc };
      }
    }
  };

  const evaluated = evalGridAst(outerAst);
  if (!evaluated.ok) return evaluated;
  return { ok: true, value: evaluated.value, hadVmatrix, cellScalarOnly: true };
}

function outerAstHasNonLocalVars(expr: ScalarExpr, localSyntheticIdents: readonly string[]): boolean {
  const localSet = new Set(localSyntheticIdents);
  for (const v of collectVariables(expr)) {
    if (!localSet.has(v)) return true;
  }
  return false;
}

function evalMultivarRational(expr: ScalarExpr, env: ReadonlyMap<string, SpanRational>, depth = 0): { status: "value"; value: SpanRational } | { status: "undefined_domain" } | { status: "unsupported" } {
  if (depth > MAX_AST_WALK_DEPTH) throw new PolyComplexityError();
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      return q ? { status: "value", value: q } : { status: "unsupported" };
    }
    case "variable": {
      const val = env.get(expr.name);
      return val ? { status: "value", value: val } : { status: "unsupported" };
    }
    case "neg": {
      const inner = evalMultivarRational(expr.value, env, depth + 1);
      return inner.status === "value" ? { status: "value", value: rational(-inner.value.n, inner.value.d) } : inner;
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const l = evalMultivarRational(expr.left, env, depth + 1);
      const r = evalMultivarRational(expr.right, env, depth + 1);
      if (l.status === "undefined_domain" || r.status === "undefined_domain") return { status: "undefined_domain" };
      if (l.status !== "value" || r.status !== "value") return { status: "unsupported" };
      if (expr.kind === "div" && r.value.n === 0n) return { status: "undefined_domain" };
      const out =
        expr.kind === "add"
          ? addRational(l.value, r.value)
          : expr.kind === "sub"
            ? subtractRational(l.value, r.value)
            : expr.kind === "mul"
              ? multiplyRational(l.value, r.value)
              : divideRational(l.value, r.value);
      checkPolyCoeffBound(out);
      return { status: "value", value: out };
    }
    case "pow": {
      if (!Number.isInteger(expr.exponent) || Math.abs(expr.exponent) > 12) return { status: "unsupported" };
      const b = evalMultivarRational(expr.base, env, depth + 1);
      if (b.status !== "value") return b;
      if (expr.exponent <= 0 && b.value.n === 0n) return { status: "undefined_domain" };
      let val = rational(1n);
      const step = expr.exponent >= 0 ? b.value : rational(b.value.d, b.value.n);
      for (let i = 0; i < Math.abs(expr.exponent); i++) {
        val = multiplyRational(val, step);
        checkPolyCoeffBound(val);
      }
      return { status: "value", value: val };
    }
    default:
      return { status: "unsupported" };
  }
}

function collectMultivarDivDens(expr: ScalarExpr): ScalarExpr[] {
  const dens: ScalarExpr[] = [];
  const stack: ScalarExpr[] = [expr];
  let steps = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    steps++;
    if (steps > MAX_AST_WALK_STEPS) throw new PolyComplexityError();
    switch (cur.kind) {
      case "const":
      case "variable":
        break;
      case "neg":
      case "sqrt":
      case "abs":
      case "ln":
      case "sin":
      case "cos":
      case "exp":
        stack.push(cur.value);
        break;
      case "pow":
        if (cur.exponent <= 0) dens.push(cur.base);
        stack.push(cur.base);
        break;
      case "add":
      case "sub":
      case "mul":
        stack.push(cur.right, cur.left);
        break;
      case "div":
        dens.push(cur.right);
        stack.push(cur.right, cur.left);
        break;
    }
  }
  return dens;
}

type MultivarEvalResult =
  | { status: "exact"; value: SpanRational }
  | { status: "float"; value: number; err: number; marginOk: boolean }
  | { status: "undefined_domain" }
  | { status: "unsupported" };

function evalMultivarFloat(
  expr: ScalarExpr,
  env: ReadonlyMap<string, SpanRational>,
  depth = 0,
): FloatEvalResult {
  if (depth > MAX_AST_WALK_DEPTH) throw new PolyComplexityError();
  const BOUND_EPS = 1e-9;
  switch (expr.kind) {
    case "const": {
      const q = toRational(expr.value);
      if (q) {
        const arg = rationalToFloatArg(q);
        if (!arg) return { status: "unstable" };
        return {
          status: "ok",
          value: arg.fx,
          err: arg.xRadius,
          marginOk: true,
          irrational: false,
          exactZero: q.n === 0n,
        };
      }
      const val = Number(expr.value);
      return Number.isFinite(val)
        ? {
            status: "ok",
            value: val,
            err: Number.isSafeInteger(val) ? 0 : Math.abs(val) * 1e-13 + Number.MIN_VALUE,
            marginOk: true,
            irrational: !Number.isInteger(val),
            exactZero: false,
          }
        : { status: "unstable" };
    }
    case "variable": {
      const q = env.get(expr.name);
      if (!q) return { status: "unstable" };
      const arg = rationalToFloatArg(q);
      if (!arg) return { status: "unstable" };
      return {
        status: "ok",
        value: arg.fx,
        err: arg.xRadius,
        marginOk: arg.xRadius === 0 || Math.abs(arg.fx) > BOUND_EPS + arg.xRadius,
        irrational: arg.xRadius > 0,
        exactZero: q.n === 0n,
      };
    }
    case "neg": {
      const inner = evalMultivarFloat(expr.value, env, depth + 1);
      return inner.status === "ok"
        ? {
            status: "ok",
            value: -inner.value,
            err: inner.err,
            marginOk: inner.marginOk,
            irrational: inner.irrational,
            exactZero: inner.exactZero,
          }
        : inner;
    }
    case "abs": {
      const inner = evalMultivarFloat(expr.value, env, depth + 1);
      return inner.status === "ok"
        ? {
            status: "ok",
            value: Math.abs(inner.value),
            err: inner.err,
            marginOk: inner.marginOk && Math.abs(inner.value) > BOUND_EPS + inner.err,
            irrational: inner.irrational,
            exactZero: inner.exactZero,
          }
        : inner;
    }
    case "sqrt": {
      const inner = evalMultivarFloat(expr.value, env, depth + 1);
      if (inner.status !== "ok") return inner;
      if (inner.value + inner.err < -BOUND_EPS) return { status: "undefined_domain", reason: "even_root_domain" };
      if (inner.exactZero && inner.value === 0) {
        return { status: "ok", value: 0, err: 0, marginOk: inner.marginOk, irrational: false, exactZero: true };
      }
      if (inner.value - inner.err < BOUND_EPS) return { status: "unstable" };
      const s = Math.sqrt(inner.value);
      const err = inner.err / (2 * Math.sqrt(inner.value - inner.err)) + s * 1e-13;
      return Number.isFinite(err)
        ? { status: "ok", value: s, err, marginOk: inner.marginOk, irrational: true, exactZero: false }
        : { status: "unstable" };
    }
    case "ln": {
      const inner = evalMultivarFloat(expr.value, env, depth + 1);
      if (inner.status !== "ok") return inner;
      if (inner.exactZero || inner.value + inner.err < -BOUND_EPS) return { status: "undefined_domain", reason: "ln_domain" };
      if (inner.value - inner.err <= BOUND_EPS) return { status: "unstable" };
      const exactOne = !inner.irrational && inner.err === 0 && inner.value === 1;
      const val = exactOne ? 0 : Math.log(inner.value);
      const err = exactOne ? 0 : inner.err / (inner.value - inner.err) + Math.abs(val) * 1e-13;
      return Number.isFinite(err)
        ? { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactOne, exactZero: exactOne }
        : { status: "unstable" };
    }
    case "sin":
    case "cos":
    case "exp": {
      const inner = evalMultivarFloat(expr.value, env, depth + 1);
      if (inner.status !== "ok") return inner;
      if (expr.kind === "exp" && (inner.value + inner.err > 50 || inner.value - inner.err < -50 || inner.err > 10)) {
        return { status: "unstable" };
      }
      const exactZero = expr.kind === "sin" ? Boolean(inner.exactZero) : false;
      const exactConst = expr.kind === "sin" ? exactZero : Boolean(inner.exactZero);
      const val =
        expr.kind === "sin"
          ? exactZero
            ? 0
            : Math.sin(inner.value)
          : expr.kind === "cos"
            ? exactConst
              ? 1
              : Math.cos(inner.value)
            : exactConst
              ? 1
              : Math.exp(inner.value);
      const err = exactConst
        ? 0
        : expr.kind === "exp"
          ? Math.exp(inner.value + inner.err) - val + val * 1e-13
          : inner.err + Math.abs(val) * 1e-13 + 1e-15;
      return Number.isFinite(err)
        ? { status: "ok", value: val, err, marginOk: inner.marginOk, irrational: !exactConst, exactZero }
        : { status: "unstable" };
    }
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const l = evalMultivarFloat(expr.left, env, depth + 1);
      const r = evalMultivarFloat(expr.right, env, depth + 1);
      if (l.status === "undefined_domain") return l;
      if (r.status === "undefined_domain") return r;
      if (l.status !== "ok" || r.status !== "ok") return { status: "unstable" };
      const irrational = l.irrational || r.irrational;
      if (expr.kind === "div") {
        if (r.exactZero) return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
        if (Math.abs(r.value) <= BOUND_EPS + r.err) return { status: "unstable" };
        const val = l.value / r.value;
        const rMin = Math.abs(r.value) - r.err;
        const err = (l.err + Math.abs(l.value) * (r.err / rMin)) / rMin + Math.abs(val) * 1e-13;
        return Number.isFinite(val) && Number.isFinite(err) && Math.abs(val) < 1e10
          ? { status: "ok", value: val, err, marginOk: l.marginOk && r.marginOk, irrational, exactZero: Boolean(l.exactZero) }
          : { status: "unstable" };
      }
      const val = expr.kind === "add" ? l.value + r.value : expr.kind === "sub" ? l.value - r.value : l.value * r.value;
      const exactInt = !irrational && l.err === 0 && r.err === 0 && Number.isSafeInteger(val);
      const err = exactInt
        ? 0
        : expr.kind === "mul"
          ? Math.abs(l.value) * r.err + Math.abs(r.value) * l.err + l.err * r.err + Math.abs(val) * 1e-13
          : l.err + r.err + (Math.abs(l.value) + Math.abs(r.value)) * 1e-14 + Math.abs(val) * 1e-14;
      const exactZero =
        expr.kind === "mul"
          ? Boolean((l.exactZero || r.exactZero) && Number.isFinite(val))
          : Boolean((l.exactZero && r.exactZero) || (exactInt && val === 0));
      return Number.isFinite(val) && Number.isFinite(err) && Math.abs(val) < 1e10
        ? { status: "ok", value: val, err, marginOk: l.marginOk && r.marginOk, irrational, exactZero }
        : { status: "unstable" };
    }
    case "pow": {
      const b = evalMultivarFloat(expr.base, env, depth + 1);
      if (b.status !== "ok") return b;
      if (expr.exponent <= 0 && b.exactZero) {
        return { status: "undefined_domain", reason: "natural_domain_denominator_zero" };
      }
      if (expr.exponent <= 0 && Math.abs(b.value) <= BOUND_EPS + b.err) return { status: "unstable" };
      const val = b.value ** expr.exponent;
      if (!Number.isFinite(val) || Math.abs(val) >= 1e10) return { status: "unstable" };
      if (expr.exponent === 0) return { status: "ok", value: 1, err: 0, marginOk: b.marginOk, irrational: false, exactZero: false };
      const boundBase = expr.exponent > 0 ? Math.abs(b.value) + b.err : Math.abs(b.value) - b.err;
      const err =
        !b.irrational && b.err === 0 && expr.exponent > 0 && Number.isSafeInteger(val)
          ? 0
          : Math.abs(boundBase ** expr.exponent - Math.abs(val)) + Math.abs(val) * 1e-13;
      return Number.isFinite(err)
        ? {
            status: "ok",
            value: val,
            err,
            marginOk: b.marginOk,
            irrational: b.irrational && expr.exponent !== 0,
            exactZero: Boolean(b.exactZero && expr.exponent > 0),
          }
        : { status: "unstable" };
    }
  }
}

function evalMultivarPoint(expr: ScalarExpr, env: ReadonlyMap<string, SpanRational>): MultivarEvalResult {
  const exact = evalMultivarRational(expr, env);
  if (exact.status === "value") return { status: "exact", value: exact.value };
  if (exact.status === "undefined_domain") return { status: "undefined_domain" };
  const flt = evalMultivarFloat(expr, env);
  if (flt.status === "undefined_domain") return { status: "undefined_domain" };
  if (flt.status === "ok") return { status: "float", value: flt.value, err: flt.err, marginOk: flt.marginOk };
  return { status: "unsupported" };
}

function multivarValuesDiffer(sv: MultivarEvalResult, rv: MultivarEvalResult): "different" | "equal" | "uncertain" {
  if (sv.status === "exact" && rv.status === "exact") {
    return equalRational(sv.value, rv.value) ? "equal" : "different";
  }
  const toF = (res: MultivarEvalResult): { value: number; err: number; marginOk: boolean } | null => {
    if (res.status === "float") return res;
    if (res.status === "exact") {
      const arg = rationalToFloatArg(res.value);
      return arg ? { value: arg.fx, err: arg.xRadius, marginOk: true } : null;
    }
    return null;
  };
  const sf = toF(sv);
  const rf = toF(rv);
  if (!sf || !rf || !sf.marginOk || !rf.marginOk) return "uncertain";
  const tol = 1e-6 * Math.max(1, Math.abs(sf.value), Math.abs(rf.value)) + sf.err + rf.err;
  return Math.abs(sf.value - rf.value) > tol ? "different" : "equal";
}

function verifyMultivariateScalarPairs(
  pairs: Array<{ sExpr: ScalarExpr; rExpr: ScalarExpr }>,
  domain: DomainSpec | undefined,
): VerificationResult {
  const allVars = new Set<string>();
  let anyDivOrNonRat = false;
  const univarDenRoots = new Map<string, SpanRational[]>();
  const addDenRoot = (v: string, q: SpanRational) => {
    const list = univarDenRoots.get(v) ?? [];
    if (list.length < 6 && !list.some((x) => equalRational(x, q))) {
      list.push(q);
      univarDenRoots.set(v, list);
    }
  };
  const collectDenRoots = (expr: ScalarExpr) => {
    for (const den of collectMultivarDivDens(expr)) {
      const dVars = collectVariables(den);
      if (dVars.size !== 1) continue;
      const v = [...dVars][0]!;
      const rf = rationalForm(den, v);
      if (!rf.unsupported && polynomialDegree(rf.numerator) >= 1) {
        const { roots } = isolateRealRoots(rf.numerator, { left: null, right: null, leftOpen: true, rightOpen: true });
        for (const root of roots) {
          if (root.kind === "exact") addDenRoot(v, root.value);
        }
      }
    }
  };

  for (const { sExpr, rExpr } of pairs) {
    for (const v of collectVariables(sExpr)) allVars.add(v);
    for (const v of collectVariables(rExpr)) allVars.add(v);
    if (collectMultivarDivDens(sExpr).length > 0 || collectMultivarDivDens(rExpr).length > 0) {
      anyDivOrNonRat = true;
      collectDenRoots(sExpr);
      collectDenRoots(rExpr);
    }
    if (hasTranscendental(sExpr) || hasTranscendental(rExpr)) anyDivOrNonRat = true;
    const hasSqrtOrAbs = (e: ScalarExpr): boolean => {
      const st: ScalarExpr[] = [e];
      while (st.length > 0) {
        const cur = st.pop()!;
        switch (cur.kind) {
          case "sqrt":
          case "abs":
            return true;
          case "neg":
          case "ln":
          case "sin":
          case "cos":
          case "exp":
            st.push(cur.value);
            break;
          case "pow":
            st.push(cur.base);
            break;
          case "add":
          case "sub":
          case "mul":
          case "div":
            st.push(cur.left, cur.right);
            break;
          default:
            break;
        }
      }
      return false;
    };
    if (hasSqrtOrAbs(sExpr) || hasSqrtOrAbs(rExpr)) anyDivOrNonRat = true;
  }
  const varList = [...allVars].sort();

  const buildSampleEnvs = (): Array<Map<string, SpanRational>> => {
    const envs: Array<Map<string, SpanRational>> = [];
    const seenKeys = new Set<string>();
    const pushEnv = (env: Map<string, SpanRational>) => {
      const key = varList.map((v) => formatRational(env.get(v)!)).join(",");
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        envs.push(env);
      }
    };
    for (const v of varList) {
      addDenRoot(v, rational(0n));
      addDenRoot(v, rational(1n));
      addDenRoot(v, rational(-1n));
    }
    for (const [targetVar, roots] of univarDenRoots) {
      for (const root of roots) {
        for (const fill of [1n, 2n, -1n]) {
          const env = new Map<string, SpanRational>();
          for (const v of varList) {
            env.set(v, v === targetVar ? root : rational(fill));
          }
          pushEnv(env);
        }
      }
    }
    for (let sampleIdx = 0; sampleIdx < 24; sampleIdx++) {
      const env = new Map<string, SpanRational>();
      varList.forEach((v, vi) => {
        const raw = ((sampleIdx + vi * 3) % 7) - 3;
        env.set(v, rational(BigInt(raw)));
      });
      pushEnv(env);
    }
    return envs;
  };

  const sampleEnvs = buildSampleEnvs();
  const formatEnv = (env: ReadonlyMap<string, SpanRational>): string =>
    varList.map((v) => `${v}=${formatRational(env.get(v)!)}`).join(",");

  let jointMatrixDefinedCount = 0;
  let hasUnresolved = false;

  for (const env of sampleEnvs) {
    const sVals = pairs.map((p) => evalMultivarPoint(p.sExpr, env));
    const rVals = pairs.map((p) => evalMultivarPoint(p.rExpr, env));
    const sAnyUndef = sVals.some((v) => v.status === "undefined_domain");
    const rAnyUndef = rVals.some((v) => v.status === "undefined_domain");
    const sAnyUnsup = sVals.some((v) => v.status === "unsupported");
    const rAnyUnsup = rVals.some((v) => v.status === "unsupported");

    if (sAnyUndef && rAnyUndef) {
      continue;
    }
    if (sAnyUndef && !rAnyUndef && !rAnyUnsup) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: formatEnv(env), detail: "student undefined" },
        domain,
      };
    }
    if (rAnyUndef && !sAnyUndef && !sAnyUnsup) {
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: { input: formatEnv(env), detail: "reference undefined" },
        domain,
      };
    }
    if (sAnyUndef || rAnyUndef || sAnyUnsup || rAnyUnsup) {
      hasUnresolved = true;
      continue;
    }

    jointMatrixDefinedCount++;
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      const sv = sVals[pIdx]!;
      const rv = rVals[pIdx]!;
      if (multivarValuesDiffer(sv, rv) === "different") {
        const isExact = sv.status === "exact" && rv.status === "exact";
        return {
          status: "inequivalent",
          reason: isExact ? "exact_radical_counterexample" : "numeric_counterexample",
          witness: { input: formatEnv(env), detail: "multivariate values differ" },
          domain,
        };
      }
    }
  }

  if (jointMatrixDefinedCount === 0) {
    return {
      status: "unverified",
      reason: hasUnresolved ? "unresolved_nonrational_domain" : "empty_natural_domain",
      domain,
    };
  }

  if (anyDivOrNonRat) {
    return { status: "unverified", reason: "foreign_variable", domain };
  }

  for (const { sExpr, rExpr } of pairs) {
    const reg: RingAtomRegistry = { sqrtDefs: new Map(), absDefs: new Map(), sinPairs: new Map(), expExps: new Map() };
    const sn = ringNormalizeRational(sExpr, "__mv__", [], reg, []);
    const rn = ringNormalizeRational(rExpr, "__mv__", [], reg, []);
    if (!sn || !rn) return { status: "unverified", reason: "foreign_variable", domain };
    const diff = mpolyAdd(mpolyMultiply(sn.num, rn.den, reg), mpolyMultiply(rn.num, sn.den, reg), -1);
    if (diff.size !== 0) {
      return {
        status: "inequivalent",
        reason: "non_commutative_residual_nonzero",
        witness: { input: "expression", detail: "multivariate expressions differ" },
        domain,
      };
    }
  }
  return { status: "equivalent", reason: "canonical_symbolic_identity", domain };
}

function tryVerifyOrUnwrapLatexMatrices(
  studentInput: ScalarExpr | string,
  referenceInput: ScalarExpr | string,
  domain: DomainSpec | undefined,
  parseOpts: NormalizeLatexOptions,
  matrixMode: boolean,
):
  | { kind: "result"; result: VerificationResult }
  | { kind: "unverified"; reason: string }
  | { kind: "scalar"; student: ScalarExpr; reference: ScalarExpr } {
  const ctx: MatrixPreprocessContext = {
    matrixLiterals: new Map(),
    scalarLiterals: new Map(),
    vmatrixVars: new Set(),
    litCounter: 0,
    fullInput: `${typeof studentInput === "string" ? studentInput : ""}\n${typeof referenceInput === "string" ? referenceInput : ""}`,
  };
  const parseOne = (inp: ScalarExpr | string) => {
    if (typeof inp !== "string") return { ok: true as const, value: { kind: "scalar" as const, expr: inp }, hadVmatrix: false, cellScalarOnly: true };
    return preprocessAndParseLatexExpr(inp, parseOpts, ctx);
  };
  const sParsed = parseOne(studentInput);
  if (!sParsed.ok) return { kind: "unverified", reason: sParsed.reason };
  const rParsed = parseOne(referenceInput);
  if (!rParsed.ok) return { kind: "unverified", reason: rParsed.reason };

  if (sParsed.value.kind === "scalar" && rParsed.value.kind === "scalar") {
    const sExpr = sParsed.value.expr;
    const rExpr = rParsed.value.expr;
    const allVars = new Set([...collectVariables(sExpr), ...collectVariables(rExpr)]);
    const ncSet = new Set(domain?.nonCommutativeVars ?? []);
    if (ncSet.size === 0 && (sParsed.hadVmatrix || rParsed.hadVmatrix)) {
      const freeOutsideVmatrix = [...allVars].filter((v) => !ctx.vmatrixVars.has(v));
      if (freeOutsideVmatrix.length === 0 || allVars.size <= 1) {
        if (allVars.size <= 1) {
          const singleVar = domain?.variable ?? ([...allVars][0] ?? "x");
          if (domain?.variable && allVars.size === 1 && !allVars.has(domain.variable)) {
            return { kind: "unverified", reason: "foreign_variable" };
          }
          if (matrixMode) {
            return { kind: "result", result: verifyScalarEquivalenceInner(sExpr, rExpr, { ...domain, variable: singleVar }) };
          }
          return { kind: "scalar", student: sExpr, reference: rExpr };
        }
        if (!domain?.variable && !domain?.intervals?.length && !domain?.excluded?.length) {
          return { kind: "result", result: verifyMultivariateScalarPairs([{ sExpr, rExpr }], domain) };
        }
      }
    }
    return { kind: "scalar", student: sExpr, reference: rExpr };
  }

  if (sParsed.value.kind !== rParsed.value.kind) {
    return {
      kind: "result",
      result: {
        status: "inequivalent",
        reason: "matrix_dimension_mismatch",
        witness: { input: "dimensions", detail: "matrix vs scalar mismatch" },
        domain,
      },
    };
  }

  const sGrid = sParsed.value as Extract<GridEvalValue, { kind: "matrix" }>;
  const rGrid = rParsed.value as Extract<GridEvalValue, { kind: "matrix" }>;
  if (sGrid.rows !== rGrid.rows || sGrid.cols !== rGrid.cols) {
    return {
      kind: "result",
      result: {
        status: "inequivalent",
        reason: "matrix_dimension_mismatch",
        witness: { input: "dimensions", detail: `student ${sGrid.rows}x${sGrid.cols} vs reference ${rGrid.rows}x${rGrid.cols}` },
        domain,
      },
    };
  }

  const ncSet = new Set(domain?.nonCommutativeVars ?? []);
  const sWords: MatrixWeightedWordMap = new Map();
  const rWords: MatrixWeightedWordMap = new Map();
  const sFactors: ScalarExpr[] = [];
  const rFactors: ScalarExpr[] = [];
  const allVars = new Set<string>();
  const mvPairs: Array<{ sExpr: ScalarExpr; rExpr: ScalarExpr }> = [];

  for (let r = 0; r < sGrid.rows; r++) {
    for (let c = 0; c < sGrid.cols; c++) {
      const se = sGrid.cells[r]![c]!;
      const re = rGrid.cells[r]![c]!;
      for (const v of collectVariables(se)) allVars.add(v);
      for (const v of collectVariables(re)) allVars.add(v);
      if (ncSet.size > 0 && ([...collectVariables(se)].some((v) => ncSet.has(v)) || [...collectVariables(re)].some((v) => ncSet.has(v)))) {
        return { kind: "unverified", reason: "parse_outside_decidable_fragment" };
      }
      mvPairs.push({ sExpr: se, rExpr: re });
      const key = `__cell_${r}_${c}`;
      const isZero = (e: ScalarExpr) => e.kind === "const" && toRational(e.value)?.n === 0n;
      sWords.set(key, makeWeightedLeafScalar(se));
      rWords.set(key, makeWeightedLeafScalar(re));
      if (!isZero(se)) sFactors.push(se);
      if (!isZero(re)) rFactors.push(re);
    }
  }

  const nonNcVars = [...allVars].filter((v) => !ncSet.has(v));
  if (nonNcVars.length > 1) {
    if (!domain?.variable && !domain?.intervals?.length && !domain?.excluded?.length) {
      return { kind: "result", result: verifyMultivariateScalarPairs(mvPairs, domain) };
    }
    return { kind: "unverified", reason: "foreign_variable" };
  }

  const parsedDomain = parseDomainSpec(domain);
  if (!parsedDomain) return { kind: "unverified", reason: "invalid_domain" };
  if (parsedDomain.empty) return { kind: "unverified", reason: "empty_domain" };

  let scalarVar: string | null = null;
  if (domain?.variable) {
    if (ncSet.has(domain.variable)) return { kind: "unverified", reason: "foreign_variable" };
    if (nonNcVars.some((v) => v !== domain.variable)) return { kind: "unverified", reason: "foreign_variable" };
    scalarVar = domain.variable;
  } else {
    scalarVar = nonNcVars.length === 1 ? nonNcVars[0]! : "x";
  }

  return {
    kind: "result",
    result: verifyDecomposedMatrix(
      { words: sWords, scalarFactors: sFactors },
      { words: rWords, scalarFactors: rFactors },
      scalarVar,
      parsedDomain,
      domain,
      false,
    ),
  };
}

function verifyDecomposedMatrix(
  sDecomp: { words: MatrixWeightedWordMap; scalarFactors: ScalarExpr[] },
  rDecomp: { words: MatrixWeightedWordMap; scalarFactors: ScalarExpr[] },
  scalarVar: string | null,
  parsedDomain: { intervals: NormalizedInterval[]; excluded: SpanRational[] },
  domain: DomainSpec | undefined,
  allowCommutativeCollapse = true,
): VerificationResult {
  const effectiveScalarVar = scalarVar ?? "x";
  const scalarDomain: DomainSpec = {
    variable: effectiveScalarVar,
    ...(domain?.intervals ? { intervals: domain.intervals } : {}),
    ...(domain?.excluded ? { excluded: domain.excluded } : {}),
  };

  const sUnverifiedFactor = firstUnverifiedFactorReason(sDecomp.scalarFactors, scalarDomain);
  const rUnverifiedFactor = firstUnverifiedFactorReason(rDecomp.scalarFactors, scalarDomain);
  if (sUnverifiedFactor && rUnverifiedFactor) {
    return { status: "unverified", reason: sUnverifiedFactor, domain };
  }

  const sTerms = collectUniqueScalarTerms(sDecomp);
  const rTerms = collectUniqueScalarTerms(rDecomp);
  const sJointRat = collectJointRationalDens(sTerms, effectiveScalarVar);
  const rJointRat = collectJointRationalDens(rTerms, effectiveScalarVar);
  const sConstraints = mergeCollectedConstraints(sTerms, effectiveScalarVar);
  const rConstraints = mergeCollectedConstraints(rTerms, effectiveScalarVar);

  if (sConstraints.alwaysUndefined && rConstraints.alwaysUndefined) {
    return { status: "unverified", reason: "empty_natural_domain", domain };
  }
  if (sConstraints.alwaysUndefined !== rConstraints.alwaysUndefined) {
    if (sUnverifiedFactor || rUnverifiedFactor) {
      return { status: "unverified", reason: sUnverifiedFactor ?? rUnverifiedFactor!, domain };
    }
    const otherConstraints = sConstraints.alwaysUndefined ? rConstraints : sConstraints;
    const otherTerms = sConstraints.alwaysUndefined ? rTerms : sTerms;
    const cad = buildCadPlan(otherConstraints.rational, parsedDomain, otherConstraints.splitPolys);
    if (cad.complexityExceeded) return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    let verifiedWitness: string | null = null;
    const candidateSites: SampleSite[] = [
      ...cad.sites,
      ...cad.openCells.map((cell) => ({ kind: "rational", x: cell.sample }) as SampleSite),
    ];
    for (const site of candidateSites) {
      if (!constraintsSatisfiedAtSite(otherConstraints, site)) continue;
      if (!otherConstraints.hasNonRationalDomainOps || resolveTermsDefinedAtSite(otherTerms, site, effectiveScalarVar) === "defined") {
        verifiedWitness = formatSampleSite(site);
        break;
      }
    }
    if (!verifiedWitness) {
      return {
        status: "unverified",
        reason: otherConstraints.hasNonRationalDomainOps || cad.unresolvedRootIsolation ? "unresolved_nonrational_domain" : "empty_natural_domain",
        domain,
      };
    }
    return {
      status: "inequivalent",
      reason: "natural_domain_mismatch",
      witness: { input: verifiedWitness, detail: sConstraints.alwaysUndefined ? "student undefined" : "reference undefined" },
      domain,
    };
  }

  let wordDomain: DomainSpec = scalarDomain;
  let validJointSites: SampleSite[] = [];
  let cadSitesForCheck: SampleSite[] = [];
  let cadOpenCellsForCheck: CadOpenCell[] = [];
  const positivelyDefinedSites: SampleSite[] = [];
  let jointMatchedPureRational = false;
  let hasUnresolvedJointDomain = false;
  let sJointUnionForWords: Polynomial | null = null;
  let rJointUnionForWords: Polynomial | null = null;

  if (sJointRat.allRational && rJointRat.allRational) {
    if (sUnverifiedFactor || rUnverifiedFactor) {
      return { status: "unverified", reason: sUnverifiedFactor ?? rUnverifiedFactor!, domain };
    }
    const denDiff = checkDenominatorSetsEquivalent(
      sJointRat.dens,
      rJointRat.dens,
      parsedDomain.intervals,
      parsedDomain.excluded,
    );
    if (!denDiff.equal) {
      if (denDiff.complexityExceeded) {
        return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
      }
      return {
        status: "inequivalent",
        reason: "natural_domain_mismatch",
        witness: denDiff.witness,
        domain,
      };
    }
    const jointUnion = squareFreeProduct([...sJointRat.dens, ...rJointRat.dens]);
    if (!jointUnion) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    const cad = buildCadPlan(
      [...sConstraints.rational, ...rConstraints.rational],
      parsedDomain,
      [...sConstraints.splitPolys, ...rConstraints.splitPolys],
    );
    if (cad.complexityExceeded) return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    if (cad.unresolvedRootIsolation) return { status: "unverified", reason: "unresolved_root_isolation", domain };
    cadSitesForCheck = cad.sites;
    cadOpenCellsForCheck = cad.openCells;
    validJointSites = cad.sites.filter(
      (site) => constraintsSatisfiedAtSite(sConstraints, site) && constraintsSatisfiedAtSite(rConstraints, site),
    );
    if (validJointSites.length === 0) {
      return { status: "unverified", reason: "empty_natural_domain", domain };
    }
    const extraExcluded: string[] = [];
    if (polynomialDegree(jointUnion) >= 1) {
      for (const iv of parsedDomain.intervals) {
        const { roots } = isolateRealRoots(jointUnion, iv);
        for (const root of roots) {
          if (root.kind === "exact") extraExcluded.push(formatRational(root.value));
        }
      }
    }
    if (extraExcluded.length > 0) {
      wordDomain = {
        ...scalarDomain,
        excluded: [...(scalarDomain.excluded ?? []), ...extraExcluded],
      };
    }
    jointMatchedPureRational = true;
  } else {
    if (sUnverifiedFactor || rUnverifiedFactor) {
      return { status: "unverified", reason: sUnverifiedFactor ?? rUnverifiedFactor!, domain };
    }
    const cad = buildCadPlan(
      [...sConstraints.rational, ...rConstraints.rational],
      parsedDomain,
      [...sConstraints.splitPolys, ...rConstraints.splitPolys],
    );
    if (cad.complexityExceeded) return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    if (cad.unresolvedRootIsolation) return { status: "unverified", reason: "unresolved_root_isolation", domain };
    cadSitesForCheck = cad.sites;
    cadOpenCellsForCheck = cad.openCells;

    const ambiguousSites: Array<{ site: SampleSite; definedSide: "student" | "reference" }> = [];
    for (const site of cad.sites) {
      const sOk = constraintsSatisfiedAtSite(sConstraints, site);
      const rOk = constraintsSatisfiedAtSite(rConstraints, site);
      if (sOk !== rOk) {
        const okSideHasNonRational = sOk ? sConstraints.hasNonRationalDomainOps : rConstraints.hasNonRationalDomainOps;
        if (!okSideHasNonRational) {
          return {
            status: "inequivalent",
            reason: "natural_domain_mismatch",
            witness: { input: formatSampleSite(site), detail: sOk ? "reference undefined" : "student undefined" },
            domain,
          };
        }
        ambiguousSites.push({ site, definedSide: sOk ? "student" : "reference" });
      } else if (sOk && rOk) {
        validJointSites.push(site);
      }
    }
    for (const amb of ambiguousSites) {
      const definedTerms = amb.definedSide === "student" ? sTerms : rTerms;
      const status = resolveTermsDefinedAtSite(definedTerms, amb.site, effectiveScalarVar);
      if (status === "defined") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: {
            input: formatSampleSite(amb.site),
            detail: amb.definedSide === "student" ? "reference undefined" : "student undefined",
          },
          domain,
        };
      }
      if (status === "unresolved") hasUnresolvedJointDomain = true;
    }

    const mixedNonRational = sConstraints.hasNonRationalDomainOps || rConstraints.hasNonRationalDomainOps;
    let jointDefinedCount = 0;

    for (const site of validJointSites) {
      if (!mixedNonRational) continue;
      const sStatus = resolveTermsDefinedAtSite(sTerms, site, effectiveScalarVar);
      const rStatus = resolveTermsDefinedAtSite(rTerms, site, effectiveScalarVar);
      if (sStatus === "undefined_domain" && rStatus === "defined") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatSampleSite(site), detail: "student undefined" },
          domain,
        };
      }
      if (rStatus === "undefined_domain" && sStatus === "defined") {
        return {
          status: "inequivalent",
          reason: "natural_domain_mismatch",
          witness: { input: formatSampleSite(site), detail: "reference undefined" },
          domain,
        };
      }
      if ((sStatus === "undefined_domain" && rStatus === "unresolved") || (rStatus === "undefined_domain" && sStatus === "unresolved")) {
        hasUnresolvedJointDomain = true;
      }
      if (sStatus === "defined" && rStatus === "defined") {
        jointDefinedCount++;
        positivelyDefinedSites.push(site);
      }
    }

    for (const cell of cad.openCells) {
      const sampleSite: SampleSite = { kind: "rational", x: cell.sample };
      const sOk = constraintsSatisfiedAtSite(sConstraints, sampleSite);
      const rOk = constraintsSatisfiedAtSite(rConstraints, sampleSite);
      if (sOk !== rOk) {
        const okSideHasNonRational = sOk ? sConstraints.hasNonRationalDomainOps : rConstraints.hasNonRationalDomainOps;
        if (!okSideHasNonRational) {
          return {
            status: "inequivalent",
            reason: "natural_domain_mismatch",
            witness: { input: formatRational(cell.sample), detail: sOk ? "reference undefined" : "student undefined" },
            domain,
          };
        }
        const definedTerms = sOk ? sTerms : rTerms;
        for (const probe of collectOpenCellProbes(cell, parsedDomain.excluded)) {
          if (resolveTermsDefinedAtSite(definedTerms, { kind: "rational", x: probe }, effectiveScalarVar) === "defined") {
            return {
              status: "inequivalent",
              reason: "natural_domain_mismatch",
              witness: { input: formatRational(probe), detail: sOk ? "reference undefined" : "student undefined" },
              domain,
            };
          }
        }
        hasUnresolvedJointDomain = true;
      } else if (sOk && rOk && mixedNonRational) {
        for (const probe of collectOpenCellProbes(cell, parsedDomain.excluded)) {
          const probeSite: SampleSite = { kind: "rational", x: probe };
          const sStatus = resolveTermsDefinedAtSite(sTerms, probeSite, effectiveScalarVar);
          const rStatus = resolveTermsDefinedAtSite(rTerms, probeSite, effectiveScalarVar);
          if (sStatus === "undefined_domain" && rStatus === "defined") {
            return {
              status: "inequivalent",
              reason: "natural_domain_mismatch",
              witness: { input: formatRational(probe), detail: "student undefined" },
              domain,
            };
          }
          if (rStatus === "undefined_domain" && sStatus === "defined") {
            return {
              status: "inequivalent",
              reason: "natural_domain_mismatch",
              witness: { input: formatRational(probe), detail: "reference undefined" },
              domain,
            };
          }
          if ((sStatus === "undefined_domain" && rStatus === "unresolved") || (rStatus === "undefined_domain" && sStatus === "unresolved")) {
            hasUnresolvedJointDomain = true;
          }
          if (sStatus === "defined" && rStatus === "defined") {
            jointDefinedCount++;
            positivelyDefinedSites.push(probeSite);
          }
        }
      }
    }

    if (validJointSites.length === 0 || (mixedNonRational && jointDefinedCount === 0)) {
      return {
        status: "unverified",
        reason: hasUnresolvedJointDomain ? "unresolved_nonrational_domain" : "empty_natural_domain",
        domain,
      };
    }
    wordDomain = tightenWordDomainFromCad(scalarDomain, parsedDomain, cad, sConstraints, rConstraints);
    sJointUnionForWords = squareFreeProduct(sConstraints.rational.filter((c) => c.kind === "nonzero").map((c) => c.poly));
    rJointUnionForWords = squareFreeProduct(rConstraints.rational.filter((c) => c.kind === "nonzero").map((c) => c.poly));
    if (!sJointUnionForWords || !rJointUnionForWords) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
  }

  const wordParsedDomain = parseDomainSpec(wordDomain);
  if (!wordParsedDomain) return { status: "unverified", reason: "invalid_domain", domain };
  if (wordParsedDomain.empty) return { status: "unverified", reason: "empty_natural_domain", domain };

  const allWords = new Set([...sDecomp.words.keys(), ...rDecomp.words.keys()]);
  const zeroConst: ScalarExpr = { kind: "const", value: 0 };
  const inequivalentResults: VerificationResult[] = [];
  for (const word of allWords) {
    const sCoeff = sDecomp.words.get(word)?.expr ?? zeroConst;
    const rCoeff = rDecomp.words.get(word)?.expr ?? zeroConst;
    let res = verifyScalarEquivalence(sCoeff, rCoeff, wordDomain);
    if (
      res.status === "inequivalent" &&
      res.reason === "natural_domain_mismatch" &&
      (jointMatchedPureRational ||
        (sJointUnionForWords !== null &&
          rJointUnionForWords !== null &&
          areWordDenominatorsCoveredByJoint(
            sCoeff,
            rCoeff,
            effectiveScalarVar,
            sJointUnionForWords,
            rJointUnionForWords,
            wordParsedDomain,
          )))
    ) {
      const matched = verifyMatchedDomainRationalWord(
        sCoeff,
        rCoeff,
        effectiveScalarVar,
        validJointSites,
        wordParsedDomain,
        wordDomain,
      );
      if (matched) res = matched;
    }
    if (
      res.status === "inequivalent" &&
      !jointMatchedPureRational &&
      !isMixedWitnessPositivelyDefined(
        res,
        sTerms,
        rTerms,
        sConstraints,
        rConstraints,
        cadSitesForCheck,
        effectiveScalarVar,
        positivelyDefinedSites,
        cadOpenCellsForCheck,
        parsedDomain.excluded,
      )
    ) {
      return {
        status: "unverified",
        reason:
          res.reason === "natural_domain_mismatch"
            ? "unresolved_nonrational_domain"
            : (res.reason ?? "symbolic_equivalence_unverified"),
        domain,
      };
    }
    if (res.status === "unverified") {
      return { status: "unverified", reason: res.reason, domain };
    }
    if (res.status === "inequivalent") {
      inequivalentResults.push(res);
    }
  }

  if (inequivalentResults.length === 0) {
    if (hasUnresolvedJointDomain) {
      return { status: "unverified", reason: "unresolved_nonrational_domain", domain };
    }
    return {
      status: "equivalent",
      reason: scalarVar ? "domain_aware_non_commutative_identity" : "non_commutative_ring_identity",
      domain,
    };
  }

  if (allowCommutativeCollapse) {
    // Check if the nonzero discrepancy disappears under commutative word sorting (pure commutation error)
    const collapsedWords = new Map<string, WeightedScalar>();
    for (const word of allWords) {
      const sCoeff = sDecomp.words.get(word);
      const rCoeff = rDecomp.words.get(word);
      const sorted = sortMatrixWord(word);
      if (sCoeff) {
        collapsedWords.set(
          sorted,
          combineWeightedScalars(collapsedWords.get(sorted), sCoeff, "add", MAX_AST_WALK_STEPS),
        );
      }
      if (rCoeff) {
        collapsedWords.set(
          sorted,
          combineWeightedScalars(collapsedWords.get(sorted), rCoeff, "sub", MAX_AST_WALK_STEPS),
        );
      }
    }
    let allCollapsedEquivalent = collapsedWords.size > 0;
    for (const diffScalar of collapsedWords.values()) {
      const chk = verifyScalarEquivalence(diffScalar.expr, zeroConst, wordDomain);
      if (chk.status !== "equivalent") {
        allCollapsedEquivalent = false;
        break;
      }
    }
    if (allCollapsedEquivalent) {
      return {
        status: "inequivalent",
        reason: "non_commutative_mismatch",
        witness: { input: "factor_order", detail: "non-commutative multiplication order differs" },
        domain,
      };
    }
  }
  if (inequivalentResults.every((r) => r.reason === "natural_domain_mismatch")) {
    return {
      status: "inequivalent",
      reason: "natural_domain_mismatch",
      witness: inequivalentResults[0]?.witness ?? { input: "expression", detail: "natural domain mismatch" },
      domain,
    };
  }
  return {
    status: "inequivalent",
    reason: "non_commutative_residual_nonzero",
    witness: inequivalentResults[0]?.witness ?? { input: "expression", detail: "non-commutative expressions differ" },
    domain,
  };
}

function verifyNonCommutativeParsed(
  student: ScalarExpr,
  reference: ScalarExpr,
  domain: DomainSpec | undefined,
  defaultAllNonCommutative: boolean,
): VerificationResult {
  try {
    const parsedDomain = parseDomainSpec(domain);
    if (!parsedDomain) return { status: "unverified", reason: "invalid_domain", domain };
    if (parsedDomain.empty) return { status: "unverified", reason: "empty_domain", domain };
    const resolved = resolveNonCommutativeVarsAndScalar(student, reference, domain, defaultAllNonCommutative);
    if (!resolved.ok) return { status: "unverified", reason: resolved.reason, domain };

    const { nonCommVars, scalarVar } = resolved;
    const budget: PolyMulBudget = { mulSteps: 0 };
    const sDecomp = decomposeMatrixExpr(student, nonCommVars, budget);
    if (!sDecomp.ok) return { status: "unverified", reason: sDecomp.reason, domain };
    const rDecomp = decomposeMatrixExpr(reference, nonCommVars, budget);
    if (!rDecomp.ok) return { status: "unverified", reason: rDecomp.reason, domain };

    return verifyDecomposedMatrix(sDecomp, rDecomp, scalarVar, parsedDomain, domain, true);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
    }
    throw err;
  }
}

export function verifyMatrixExpressionEquivalence(
  studentInput: ScalarExpr | string,
  referenceInput: ScalarExpr | string,
  domain?: DomainSpec,
): VerificationResult {
  try {
    const parsedDomain = parseDomainSpec(domain);
    if (!parsedDomain) return { status: "unverified", reason: "invalid_domain", domain };
    if (parsedDomain.empty) return { status: "unverified", reason: "empty_domain", domain };
    const implicitMulIdents = [
      ...(domain?.nonCommutativeVars ?? []),
      ...(domain?.variable ? [domain.variable] : []),
    ];
    const preserved = [...implicitMulIdents];
    const parseOpts: NormalizeLatexOptions = {
      preservedIdentifiers: preserved,
      implicitMulIdentifiers: implicitMulIdents,
      matrixImplicitMul: true,
    };
    const hasLatexBegin =
      (typeof studentInput === "string" && studentInput.includes("\\begin")) ||
      (typeof referenceInput === "string" && referenceInput.includes("\\begin"));
    let student: ScalarExpr | null;
    let reference: ScalarExpr | null;
    if (hasLatexBegin) {
      const matrixEntry = tryVerifyOrUnwrapLatexMatrices(studentInput, referenceInput, domain, parseOpts, true);
      if (matrixEntry.kind === "result") return matrixEntry.result;
      if (matrixEntry.kind === "unverified") return { status: "unverified", reason: matrixEntry.reason, domain };
      student = matrixEntry.student;
      reference = matrixEntry.reference;
    } else {
      student = parseScalarExprInner(studentInput, parseOpts);
      reference = parseScalarExprInner(referenceInput, parseOpts);
    }
    if (!student || !reference) return { status: "unverified", reason: "parse_outside_decidable_fragment", domain };
    return verifyNonCommutativeParsed(student, reference, domain, true);
  } catch (err) {
    if (err instanceof PolyComplexityError) {
      return { status: "unverified", reason: "polynomial_complexity_exceeded", domain };
    }
    if (err instanceof MPolyOverflowError) {
      return { status: "unverified", reason: "symbolic_complexity_exceeded", domain };
    }
    throw err;
  }
}

export const checkScalarEquivalence = verifyScalarEquivalence;
export const canonicalizeRadical = simplifyRadical;
export const checkSubstitutionBounds = verifySubstitutionBounds;
export const verifyCalculus = verifyIndefiniteIntegral;
