/**
 * One-sided 95% Clopper–Pearson upper bound for k events in n independent
 * Bernoulli trials: solves P(Binomial(n, p) <= k) = 0.05 in log space.
 * Edges: n = 0 -> null; k = n -> 1; k = 0 -> closed form 1 - 0.05^(1/n).
 * Independence is an assumption of the bound, not something it checks.
 * Precondition (not validated, unchanged from the original): integers with 0 <= k <= n.
 */
export function binomialUpper95(k: number, n: number): number | null {
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

export type BinomialRatio = { numerator: number; denominator: number; rate: number | null; upper95: number | null };

/** Point estimate plus one-sided 95% upper bound; both null when the denominator is 0. */
export function binomialRatio(numerator: number, denominator: number): BinomialRatio {
  return { numerator, denominator, rate: denominator ? numerator / denominator : null, upper95: binomialUpper95(numerator, denominator) };
}
