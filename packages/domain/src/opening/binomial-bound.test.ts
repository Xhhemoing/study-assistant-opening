import { describe, expect, it } from "vitest";
import { binomialRatio, binomialUpper95 } from "./binomial-bound";

// Exact P(Binomial(n,p) <= k) = 0.05 roots, i.e. scipy.stats.beta.ppf(0.95, k + 1, n - k).
// Computed with Python decimal (80 digits, 140 bisection steps).
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
});

describe("binomialRatio", () => {
  it("reports the point estimate and bound, both null for an empty denominator", () => {
    expect(binomialRatio(0, 0)).toStrictEqual({ numerator: 0, denominator: 0, rate: null, upper95: null });
    expect(binomialRatio(3, 100)).toMatchObject({ numerator: 3, denominator: 100, rate: 0.03 });
  });
});
