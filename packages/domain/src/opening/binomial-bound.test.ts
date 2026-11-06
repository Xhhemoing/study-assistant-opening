import { describe, expect, it } from "vitest";
import { binomialRatio, binomialUpper95 } from "./binomial-bound";

// Verbatim copy of the former private upper95 in packages/ai/src/opening/grading-evaluation.ts (665bbefe).
function legacyUpper95(k: number, n: number): number | null {
  if (!n) return null;
  if (k === n) return 1;
  if (!k) return -Math.expm1(Math.log(0.05) / n);
  let low = k / n, high = 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const p = (low + high) / 2;
    let logTerm = n * Math.log1p(-p), logSum = logTerm;
    for (let j = 1; j <= k; j += 1) {
      logTerm += Math.log(n - j + 1) - Math.log(j) + Math.log(p) - Math.log1p(-p);
      const maximum = Math.max(logSum, logTerm);
      logSum = maximum + Math.log(Math.exp(logSum - maximum) + Math.exp(logTerm - maximum));
    }
    if (logSum > Math.log(0.05)) low = p;
    else high = p;
  }
  return high;
}
function legacyRatio(numerator: number, denominator: number) {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null, upper95: legacyUpper95(numerator, denominator) };
}

// Exact P(Binomial(n,p) <= k) = 0.05 roots, i.e. scipy.stats.beta.ppf(0.95, k + 1, n - k).
// Computed with Python decimal (80 digits, 140 bisection steps) because scipy is not installed here.
const REFERENCE: ReadonlyArray<[number, number, number]> = [
  [0, 149, 0.019904816220685084],
  [1, 50, 0.09139813071969739],
  [3, 100, 0.07571079374983006],
  [5, 200, 0.05184333912029053],
  [10, 30, 0.49943869717595274],
  [2, 149, 0.04164864793729948],
  [1, 1000, 0.004734993575499778],
];

describe("binomialUpper95", () => {
  it("uses the closed form 1 - 0.05^(1/n) when k = 0", () => {
    for (const n of [1, 2, 10, 59, 149, 1000]) expect(binomialUpper95(0, n)).toBeCloseTo(1 - 0.05 ** (1 / n), 15);
  });

  it("returns 1 when every trial is an event and null without trials", () => {
    for (const n of [1, 7, 149]) expect(binomialUpper95(n, n)).toBe(1);
    expect(binomialUpper95(0, 0)).toBeNull();
  });

  it("bounds zero errors in 149 samples just below 2%", () => {
    const bound = binomialUpper95(0, 149)!;
    expect(bound).toBeCloseTo(0.0199, 4);
    expect(bound).toBeLessThan(0.02);
    expect(binomialUpper95(0, 148)!).toBeGreaterThan(0.02);
  });

  it("matches exact Clopper–Pearson reference values within 1e-9", () => {
    for (const [k, n, expected] of REFERENCE) expect(Math.abs(binomialUpper95(k, n)! - expected)).toBeLessThan(1e-9);
  });

  it("returns exactly the same numbers as the former grading-evaluation implementation", () => {
    const points: Array<[number, number]> = [[0, 0], [0, 1], [1, 1], [0, 149], [1, 149], [2, 149], [3, 100], [5, 200],
      [10, 30], [29, 30], [1, 2], [50, 100], [1, 1000], [17, 400]];
    for (const [k, n] of points) {
      expect(binomialUpper95(k, n)).toBe(legacyUpper95(k, n));
      expect(binomialRatio(k, n)).toStrictEqual(legacyRatio(k, n));
    }
  });
});

describe("binomialRatio", () => {
  it("reports the point estimate and bound, both null for an empty denominator", () => {
    expect(binomialRatio(0, 0)).toStrictEqual({ numerator: 0, denominator: 0, rate: null, upper95: null });
    expect(binomialRatio(3, 100)).toMatchObject({ numerator: 3, denominator: 100, rate: 0.03 });
  });
});
