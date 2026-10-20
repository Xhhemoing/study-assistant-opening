/** Bounded exact rational arithmetic. The bounds protect answer parsing, not precision. */
export type SpanRational = { n: bigint; d: bigint };
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};
export function rational(n: bigint, d = 1n): SpanRational {
  if (d === 0n) throw new RangeError("Zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
export function parseSpanRational(raw: unknown): SpanRational | null {
  if (typeof raw !== "string" || raw.length > 160) return null;
  const value = raw.trim().replaceAll("−", "-");
  if (/^[+-]?\d+(?:\s*\/\s*[+-]?\d+)?$/.test(value)) {
    const [numerator, denominator] = value.split("/").map((part) => part.trim());
    const d = BigInt(denominator ?? "1");
    return d === 0n ? null : rational(BigInt(numerator!), d);
  }
  const decimal = /^([+-]?)(\d*)\.(\d+)$/.exec(value);
  if (!decimal) return null;
  const sign = decimal[1] === "-" ? -1n : 1n;
  return rational(sign * BigInt(`${decimal[2] || "0"}${decimal[3]}`), 10n ** BigInt(decimal[3]!.length));
}
export const addRational = (a: SpanRational, b: SpanRational): SpanRational => rational(a.n * b.d + b.n * a.d, a.d * b.d);
export const multiplyRational = (a: SpanRational, b: SpanRational): SpanRational => rational(a.n * b.n, a.d * b.d);
export const subtractRational = (a: SpanRational, b: SpanRational): SpanRational => addRational(a, rational(-b.n, b.d));
export const divideRational = (a: SpanRational, b: SpanRational): SpanRational => rational(a.n * b.d, a.d * b.n);
export const equalRational = (a: SpanRational, b: SpanRational): boolean => a.n === b.n && a.d === b.d;
export const formatSpanRational = (a: SpanRational): string => a.d === 1n ? String(a.n) : `${a.n}/${a.d}`;
