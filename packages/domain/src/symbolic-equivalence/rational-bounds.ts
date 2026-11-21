import {
  addRational as rawAddRational,
  equalRational,
  multiplyRational as rawMultiplyRational,
  rational as rawRational,
  type SpanRational,
} from "../opening/span-rational";

export { equalRational, type SpanRational };

export class PolyComplexityError extends Error {
  constructor() {
    super("polynomial_complexity_exceeded");
  }
}

export const MAX_POLY_COEFF_BITS = 4096;
export const MAX_POLY_COEFF_MAGNITUDE = 1n << BigInt(MAX_POLY_COEFF_BITS);
export const MAX_RATIONAL_DECIMAL_DIGITS = 1235;

export function bigAbs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function bigIntBitLength(n: bigint): number {
  const abs = n < 0n ? -n : n;
  if (abs === 0n) return 0;
  const hex = abs.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(Number.parseInt(hex[0]!, 16)));
}

export function checkPolyCoeffBound(coeff: SpanRational): void {
  if (bigAbs(coeff.n) > MAX_POLY_COEFF_MAGNITUDE || coeff.d > MAX_POLY_COEFF_MAGNITUDE) {
    throw new PolyComplexityError();
  }
}

export function bigGcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function bigLcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  const reducedA = bigAbs(a) / bigGcd(a, b);
  if (bigIntBitLength(reducedA) + bigIntBitLength(b) > MAX_POLY_COEFF_BITS + 1) {
    throw new PolyComplexityError();
  }
  const out = bigAbs(reducedA * b);
  if (out > MAX_POLY_COEFF_MAGNITUDE) throw new PolyComplexityError();
  return out;
}

export function rational(n: bigint, d = 1n): SpanRational {
  if (d === 0n) throw new RangeError("Zero denominator");
  if (bigIntBitLength(n) > MAX_POLY_COEFF_BITS * 4 || bigIntBitLength(d) > MAX_POLY_COEFF_BITS * 4) {
    throw new PolyComplexityError();
  }
  const out = rawRational(n, d);
  checkPolyCoeffBound(out);
  return out;
}

export function addRational(a: SpanRational, b: SpanRational): SpanRational {
  checkPolyCoeffBound(a);
  checkPolyCoeffBound(b);
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const g = bigGcd(a.d, b.d);
  const da = a.d / g;
  const db = b.d / g;
  if (bigIntBitLength(da) + bigIntBitLength(db) > MAX_POLY_COEFF_BITS + 1) {
    throw new PolyComplexityError();
  }
  const leftTermBits = bigIntBitLength(a.n) + bigIntBitLength(db);
  const rightTermBits = bigIntBitLength(b.n) + bigIntBitLength(da);
  if (
    g === 1n &&
    Math.abs(leftTermBits - rightTermBits) >= 2 &&
    Math.max(leftTermBits, rightTermBits) > MAX_POLY_COEFF_BITS + 2
  ) {
    throw new PolyComplexityError();
  }
  if (Math.max(leftTermBits, rightTermBits) > MAX_POLY_COEFF_BITS * 2 + 2) {
    throw new PolyComplexityError();
  }
  const out = rawAddRational(a, b);
  checkPolyCoeffBound(out);
  return out;
}

export function subtractRational(a: SpanRational, b: SpanRational): SpanRational {
  return addRational(a, { n: -b.n, d: b.d });
}

export function multiplyRational(a: SpanRational, b: SpanRational): SpanRational {
  checkPolyCoeffBound(a);
  checkPolyCoeffBound(b);
  if (a.n === 0n || b.n === 0n) return rawRational(0n);
  const g1 = bigGcd(bigAbs(a.n), b.d);
  const g2 = bigGcd(bigAbs(b.n), a.d);
  const an = a.n / g1;
  const bd = b.d / g1;
  const bn = b.n / g2;
  const ad = a.d / g2;
  if (
    bigIntBitLength(an) + bigIntBitLength(bn) > MAX_POLY_COEFF_BITS + 1 ||
    bigIntBitLength(ad) + bigIntBitLength(bd) > MAX_POLY_COEFF_BITS + 1
  ) {
    throw new PolyComplexityError();
  }
  const out = rawMultiplyRational({ n: an, d: ad }, { n: bn, d: bd });
  checkPolyCoeffBound(out);
  return out;
}

export function divideRational(a: SpanRational, b: SpanRational): SpanRational {
  if (b.n === 0n) throw new RangeError("Zero denominator");
  const invB: SpanRational = b.n < 0n ? { n: -b.d, d: -b.n } : { n: b.d, d: b.n };
  return multiplyRational(a, invB);
}
