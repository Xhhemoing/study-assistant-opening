import { describe, expect, it } from "vitest";
import {
  generateCalculusDerivativeExample,
  solveCalculusDerivativeExample,
  type CalculusExactRational,
  type CalculusProblem,
  type CalculusWorkedExample,
} from "./calculus-derivative-examples";

const r = (numerator: number, denominator = 1) => ({ numerator, denominator });
const e = (numerator: number | string, denominator: number | string = 1): CalculusExactRational =>
  ({ numerator: String(numerator), denominator: String(denominator) });
const polynomial: CalculusProblem = {
  function: { family: "polynomial", coefficients: [r(1), r(-3), r(2)] }, task: "derivative",
};
const chain: CalculusProblem = {
  function: { family: "affine-power", scale: r(3, 2), slope: r(2), offset: r(-1), power: 3 }, task: "derivative",
};
function solve(problem: unknown): CalculusWorkedExample {
  const result = solveCalculusDerivativeExample(problem);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.reason);
  return result.example;
}
function generate(original: CalculusProblem, seed = 0, previous: CalculusProblem[] = []): CalculusWorkedExample {
  const result = generateCalculusDerivativeExample({ original, seed, previous });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.reason);
  return result.example;
}

describe("bounded exact calculus worked examples", () => {
  it("actually differentiates a polynomial and emits a complete worked body", () => {
    const result = solve(polynomial);
    expect(result.derivativeCoefficients).toEqual([e(-3), e(4)]);
    expect(result.stem).toBe("求函数 f(x)=2*x^2 - 3*x + 1 的导数。");
    expect(result.answer).toBe("f'(x)=4*x - 3");
    expect(result.familyId).toBe("polynomial-derivative-v1");
    expect(result.tangent).toBeNull();
    expect(result.steps.join("\n")).toContain("常数项导数为 0");
    expect(result.text).toContain(result.stem);
    expect(result.text).toContain(`答案：${result.answer}`);
    expect(result.text).toContain("不是独立作答、未见题或掌握证据");
    expect(result.purpose).toBe("teaching-only");
  });

  it("uses the chain rule, including the inner slope and rational outer scale", () => {
    const result = solve(chain);
    expect(result.derivativeCoefficients).toEqual([e(9), e(-36), e(36)]);
    expect(result.answer).toBe("f'(x)=36*x^2 - 36*x + 9");
    expect(result.steps.join("\n")).toContain("u'=2");
    expect(result.steps.join("\n")).toContain("链式法则");
  });

  it("computes rational tangent point, value, slope and intercept without rounding", () => {
    const result = solve({ function: polynomial.function, task: "tangent", at: r(1, 3) });
    expect(result.tangent).toEqual({ at: e(1, 3), value: e(2, 9), slope: e(-5, 3), intercept: e(7, 9) });
    expect(result.answer).toBe("y=-5/3*x + 7/9");
    expect(result.stem).toContain("x=1/3");
    expect(result.steps.join("\n")).toContain("y-f(x0)=f'(x0)*(x-x0)");
  });

  it("supports horizontal chain tangents and constants, including the zero polynomial", () => {
    expect(solve({ function: chain.function, task: "tangent", at: r(1, 2) }).tangent)
      .toEqual({ at: e(1, 2), value: e(0), slope: e(0), intercept: e(0) });
    expect(solve({ function: chain.function, task: "tangent", at: r(1, 2) }).answer).toBe("y=0");
    for (const constant of [0, -7]) {
      const fn = { family: "polynomial", coefficients: [r(constant)] };
      expect(solve({ function: fn, task: "derivative" }).derivativeCoefficients).toEqual([e(0)]);
      expect(solve({ function: fn, task: "tangent", at: r(-2) }).answer).toBe(`y=${constant}`);
    }
  });

  it("handles boundary degree/coefficient values and negative inner slopes", () => {
    expect(solve({ function: { family: "polynomial", coefficients: [r(0), r(0), r(0), r(0), r(0), r(12)] }, task: "derivative" })
      .derivativeCoefficients).toEqual([e(0), e(0), e(0), e(0), e(60)]);
    const negative = solve({ function: { family: "affine-power", scale: r(-1, 2), slope: r(-2), offset: r(1), power: 2 }, task: "tangent", at: r(-1, 2) });
    expect(negative.derivativeCoefficients).toEqual([e(2), e(-4)]);
    expect(negative.tangent).toEqual({ at: e(-1, 2), value: e(-2), slope: e(4), intercept: e(0) });
  });

  it.each([polynomial, chain])("provides six different real bodies per task, deterministic replay, then exhaustion", original => {
    for (const task of ["derivative", "tangent"] as const) {
      const source: CalculusProblem = task === "tangent" ? { function: original.function, task, at: r(1, 2) } : original;
      const history: CalculusProblem[] = [];
      const stems = new Set<string>(), answers = new Set<string>(), ids = new Set<string>();
      for (let seed = 0; seed < 6; seed++) {
        const first = generate(source, seed);
        expect(generate(source, seed)).toEqual(first);
        const next = generate(source, 0, history);
        expect(next.parameterIdentity).not.toBe(solve(source).parameterIdentity);
        expect(next.stem).not.toBe(solve(source).stem);
        expect(next.text).toContain(next.steps[0]);
        expect(next.text).toContain(next.answer);
        stems.add(next.stem); answers.add(next.answer); ids.add(next.parameterIdentity);
        history.push(next.problem);
      }
      expect(stems.size).toBe(6);
      expect(answers.size).toBe(6);
      expect(ids.size).toBe(6);
      expect(generateCalculusDerivativeExample({ original: source, previous: history, seed: 0 }))
        .toEqual({ status: "unsupported", reason: "exhausted" });
    }
  });

  it("skips mathematically identical originals/history, not just metadata or spelling", () => {
    // Seed 0 polynomial is (1/2)x^2+x-2; unreduced fractions and trailing zeros are equivalent.
    const equivalent: CalculusProblem = { function: { family: "polynomial", coefficients: [r(-4, 2), r(2, 2), r(2, 4), r(0)] }, task: "derivative" };
    expect(generate(equivalent).parameterIdentity).not.toBe(solve(equivalent).parameterIdentity);
    expect(generate(polynomial, 0, [equivalent])).toEqual(generate(polynomial, 1));
    const square: CalculusProblem = { function: { family: "polynomial", coefficients: [r(4), r(-4), r(1)] }, task: "derivative" };
    // Seed 0 affine power is (x-2)^2: expanded representation has the same identity.
    expect(generate(chain, 0, [square])).toEqual(generate(chain, 1));
    expect(solve({ function: square.function, task: "tangent", at: r(2, 4) }).parameterIdentity)
      .toBe(solve({ function: square.function, task: "tangent", at: r(1, 2) }).parameterIdentity);
  });

  it("does not mutate requests or share mutable output across replays", () => {
    const request = { original: polynomial, previous: [], seed: 0 };
    const before = JSON.stringify(request), first = generateCalculusDerivativeExample(request);
    expect(JSON.stringify(request)).toBe(before);
    if (first.status !== "ok") throw new Error("unsupported");
    first.example.steps.push("changed");
    first.example.derivativeCoefficients[0]!.numerator = "999";
    expect(generateCalculusDerivativeExample(request)).toEqual(generateCalculusDerivativeExample(request));
    expect(generate(polynomial).steps).not.toContain("changed");
    expect(JSON.stringify(generate(polynomial))).not.toContain("999");
  });

  it.each([null, "求导 sin(x)", [], {}, { ...polynomial, task: "integral" },
    { ...polynomial, function: { family: "sin" } },
    { ...polynomial, function: { family: "polynomial", coefficients: [] } },
    { ...polynomial, function: { family: "polynomial", coefficients: Array(2) } },
    { ...polynomial, function: { family: "polynomial", coefficients: [r(1), r(1), r(1), r(1), r(1), r(1), r(1)] } },
    { ...polynomial, at: r(1) }, { function: polynomial.function, task: "tangent" },
    { ...chain, function: { ...chain.function, power: -1 } },
    { ...chain, function: { ...chain.function, power: 1.5 } },
    { ...chain, function: { ...chain.function, power: 6 } },
    { ...chain, function: { ...chain.function, slope: r(0) } },
    { ...chain, function: { ...chain.function, scale: r(0) } },
    { ...chain, function: { ...chain.function, text: "eval('x')" } },
  ])("honestly refuses malformed or unsupported problems %#", raw => {
    expect(solveCalculusDerivativeExample(raw).status).toBe("unsupported");
  });

  it.each([NaN, Infinity, -Infinity, 0.1, "2", undefined, 13, -13, Number.MAX_SAFE_INTEGER])(
    "rejects invalid/beyond-bound rational numerators %s in every trust-boundary position", numerator => {
      const bad = { numerator, denominator: 1 };
      const cases = [
        { ...polynomial, function: { family: "polynomial", coefficients: [bad] } },
        ...["scale", "slope", "offset"].map(key => ({ ...chain, function: { ...chain.function, [key]: bad } })),
        { function: polynomial.function, task: "tangent", at: bad },
      ];
      for (const value of cases) expect(solveCalculusDerivativeExample(value).status).toBe("unsupported");
    },
  );
  it.each([0, -1, 13, NaN, Infinity, 0.5, "2"])("rejects invalid denominators %s", denominator => {
    expect(solveCalculusDerivativeExample({ ...polynomial, function: { family: "polynomial", coefficients: [{ numerator: 1, denominator }] } }).status)
      .toBe("unsupported");
  });
  it.each([NaN, Infinity, -Infinity, 0.5, -1, 6, "0"])("rejects non-finite/out-of-range seeds %s", seed => {
    expect(generateCalculusDerivativeExample({ original: polynomial, previous: [], seed }).status).toBe("unsupported");
  });
  it("validates the entire history and reports specific unsupported reasons without fallback", () => {
    expect(solveCalculusDerivativeExample({ ...polynomial, function: { family: "log" } }))
      .toEqual({ status: "unsupported", reason: "unsupported_family" });
    expect(solveCalculusDerivativeExample({ ...polynomial, task: "integral" }))
      .toEqual({ status: "unsupported", reason: "unsupported_task" });
    for (const previous of [null, [null], Array(1), ["old prose"], Array(129).fill(polynomial)]) {
      expect(generateCalculusDerivativeExample({ original: polynomial, previous, seed: 0 }).status).toBe("unsupported");
    }
    expect(generateCalculusDerivativeExample({ original: polynomial, previous: [], seed: 0, paidFallback: true }).status).toBe("unsupported");
  });
});

// Independent numerical oracle: compare exact returned polynomials at integer points
// to the direct power rule/chain rule on the structured function, not production helpers.
function gcd(a: bigint, b: bigint): bigint { return b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b); }
type Fraction = [bigint, bigint];
function reduce(n: bigint, d = 1n): Fraction { const g = gcd(n, d); return [n / g, d / g]; }
function plus(a: Fraction, b: Fraction): Fraction { return reduce(a[0] * b[1] + b[0] * a[1], a[1] * b[1]); }
function times(a: Fraction, b: Fraction): Fraction { return reduce(a[0] * b[0], a[1] * b[1]); }
function power(a: Fraction, n: number): Fraction { return reduce(a[0] ** BigInt(n), a[1] ** BigInt(n)); }
function fraction(a: { numerator: number | string; denominator: number | string }): Fraction { return [BigInt(a.numerator), BigInt(a.denominator)]; }
function direct(problem: CalculusProblem, x: Fraction, derivative: boolean): Fraction {
  const fn = problem.function;
  if (fn.family === "polynomial") {
    return fn.coefficients.reduce<Fraction>((sum, c, n) => {
      if (derivative && n === 0) return sum;
      return plus(sum, times(fraction(c), times([BigInt(derivative ? n : 1), 1n], power(x, derivative ? n - 1 : n))));
    }, [0n, 1n]);
  }
  const u = plus(times(fraction(fn.slope), x), fraction(fn.offset));
  return times(fraction(fn.scale), derivative
    ? times([BigInt(fn.power), 1n], times(fraction(fn.slope), power(u, fn.power - 1))) : power(u, fn.power));
}
it("cross-checks every candidate derivative and tangent using direct exact formulas", () => {
  for (const source of [polynomial, chain]) for (let seed = 0; seed < 6; seed++) {
    const example = generate({ function: source.function, task: "tangent", at: r(1) }, seed);
    for (const x of [-2, 0, 3]) {
      const computed = example.derivativeCoefficients.reduce<Fraction>((sum, c, n) =>
        plus(sum, times(fraction(c), power([BigInt(x), 1n], n))), [0n, 1n]);
      expect(computed).toEqual(direct(example.problem, [BigInt(x), 1n], true));
    }
    const tangent = example.tangent!;
    expect(fraction(tangent.value)).toEqual(direct(example.problem, fraction(tangent.at), false));
    expect(fraction(tangent.slope)).toEqual(direct(example.problem, fraction(tangent.at), true));
    expect(plus(times(fraction(tangent.slope), fraction(tangent.at)), fraction(tangent.intercept)))
      .toEqual(fraction(tangent.value));
  }
});
