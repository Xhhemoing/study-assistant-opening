/**
 * Pure, bounded worked examples, not an expression parser or an eligibility rule.
 * Only signed definite integrals of rational-coefficient polynomials are supported.
 * No general substitution, integration by parts, geometric area or volume claims.
 * Deliberately not exported through the domain barrel; wiring belongs to the caller.
 */
import {
  addRational, formatSpanRational, rational, subtractRational,
  type SpanRational,
} from "./span-rational";

export const CALCULUS_INTEGRAL_EXAMPLE_VERSION = "polynomial-definite-v1";
export const CALCULUS_INTEGRAL_LIMITS = {
  maxDegree: 5, maxCoefficientNumerator: 1000, maxCoefficientDenominator: 1000,
  maxAbsBound: 10, maxSeed: 999, capacity: 12,
} as const;

export type IntegralCoefficient = { numerator: number; denominator: number };
export type PolynomialIntegralParameters = {
  family: "polynomial-definite";
  /** Ascending powers: coefficients[k] multiplies x^k; 1..6 entries. */
  coefficients: readonly IntegralCoefficient[];
  lower: number;
  upper: number;
};
export type IntegralExampleGenerationInput = {
  family: "polynomial-definite";
  seed: number;
  index: number;
};
/** JSON-safe exact values, reduced, denominator positive; never rounded numbers. */
export type IntegralExactRational = { numerator: string; denominator: string };
export type PolynomialIntegralExample = {
  version: typeof CALCULUS_INTEGRAL_EXAMPLE_VERSION;
  family: "polynomial-definite";
  /** Content identity excludes seed/ordinal and removes redundant trailing zeros. */
  parameterIdentity: string;
  parameters: {
    coefficients: IntegralExactRational[];
    lower: number;
    upper: number;
  };
  prompt: string;
  answer: IntegralExactRational;
  answerText: string;
  /** Ascending powers, with constant of integration chosen as zero. */
  antiderivativeCoefficients: IntegralExactRational[];
  upperValue: IntegralExactRational;
  lowerValue: IntegralExactRational;
  steps: string[];
  generationIdentity?: IntegralExampleGenerationInput & {
    version: typeof CALCULUS_INTEGRAL_EXAMPLE_VERSION;
  };
};
export type IntegralExampleResult =
  | { status: "supported"; example: PolynomialIntegralExample }
  | { status: "unsupported"; reason: "unsupported_family" | "invalid_parameters" | "invalid_generation_identity"; message: string };

const unsupported = (reason: Extract<IntegralExampleResult, { status: "unsupported" }>["reason"]): IntegralExampleResult => ({
  status: "unsupported", reason,
  message: "仅支持有界有理系数多项式定积分：次数0..5，整数上下限绝对值≤10，系数分子绝对值≤1000、分母绝对值1..1000；不支持任意表达式或其他积分方法。",
});
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedInteger = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= max;
const exact = (value: SpanRational): IntegralExactRational => ({ numerator: String(value.n), denominator: String(value.d) });

function polynomialText(coefficients: readonly SpanRational[]): string {
  let text = "";
  for (let degree = coefficients.length - 1; degree >= 0; degree--) {
    const coefficient = coefficients[degree]!;
    if (coefficient.n === 0n) continue;
    const magnitude = rational(coefficient.n < 0n ? -coefficient.n : coefficient.n, coefficient.d);
    const scalar = formatSpanRational(magnitude);
    const term = degree === 0 ? scalar
      : `${scalar === "1" ? "" : `${scalar}*`}x${degree === 1 ? "" : `^${degree}`}`;
    text += text ? `${coefficient.n < 0n ? " - " : " + "}${term}` : `${coefficient.n < 0n ? "-" : ""}${term}`;
  }
  return text || "0";
}

function valueAt(coefficients: readonly SpanRational[], bound: number): SpanRational {
  let result = rational(0n);
  const x = BigInt(bound);
  for (let degree = 0; degree < coefficients.length; degree++) {
    const coefficient = coefficients[degree]!;
    result = addRational(result, rational(coefficient.n * x ** BigInt(degree), coefficient.d));
  }
  return result;
}

/** Validates the untrusted parameter boundary before any BigInt conversion/power. */
export function solvePolynomialIntegralExample(input: unknown): IntegralExampleResult {
  if (!record(input)) return unsupported("invalid_parameters");
  if (input.family !== "polynomial-definite") return unsupported("unsupported_family");
  if (!onlyKeys(input, ["family", "coefficients", "lower", "upper"])
    || !boundedInteger(input.lower, CALCULUS_INTEGRAL_LIMITS.maxAbsBound)
    || !boundedInteger(input.upper, CALCULUS_INTEGRAL_LIMITS.maxAbsBound)
    || !Array.isArray(input.coefficients) || input.coefficients.length < 1
    || input.coefficients.length > CALCULUS_INTEGRAL_LIMITS.maxDegree + 1) return unsupported("invalid_parameters");
  const coefficients: SpanRational[] = [];
  for (const coefficient of input.coefficients) {
    if (!record(coefficient) || !onlyKeys(coefficient, ["numerator", "denominator"])
      || !boundedInteger(coefficient.numerator, CALCULUS_INTEGRAL_LIMITS.maxCoefficientNumerator)
      || !boundedInteger(coefficient.denominator, CALCULUS_INTEGRAL_LIMITS.maxCoefficientDenominator)
      || coefficient.denominator === 0) return unsupported("invalid_parameters");
    coefficients.push(rational(BigInt(coefficient.numerator), BigInt(coefficient.denominator)));
  }
  while (coefficients.length > 1 && coefficients.at(-1)!.n === 0n) coefficients.pop();
  const lower = input.lower === 0 ? 0 : input.lower;
  const upper = input.upper === 0 ? 0 : input.upper;
  const antiderivative = [rational(0n), ...coefficients.map((coefficient, degree) =>
    rational(coefficient.n, coefficient.d * BigInt(degree + 1)))];
  const upperValue = valueAt(antiderivative, upper), lowerValue = valueAt(antiderivative, lower);
  const answer = subtractRational(upperValue, lowerValue);
  const answerText = formatSpanRational(answer);
  const integrand = polynomialText(coefficients);
  return { status: "supported", example: {
    version: CALCULUS_INTEGRAL_EXAMPLE_VERSION, family: "polynomial-definite",
    parameterIdentity: `${CALCULUS_INTEGRAL_EXAMPLE_VERSION}:${JSON.stringify([coefficients.map(formatSpanRational), lower, upper])}`,
    parameters: { coefficients: coefficients.map(exact), lower, upper },
    prompt: `计算定积分 ∫[${lower}, ${upper}] (${integrand}) dx（带符号积分，不是几何面积）。`,
    answer: exact(answer), answerText,
    antiderivativeCoefficients: antiderivative.map(exact), upperValue: exact(upperValue), lowerValue: exact(lowerValue),
    steps: [
      `多项式在整个积分区间连续，逐项使用 ∫c*x^k dx = c*x^(k+1)/(k+1) + C。`,
      `取原函数 F(x) = ${polynomialText(antiderivative)}；逐项求导即得原被积多项式。`,
      `代入上限：F(${upper}) = ${formatSpanRational(upperValue)}；代入下限：F(${lower}) = ${formatSpanRational(lowerValue)}。`,
      `由微积分基本定理，原定积分 = F(${upper}) - F(${lower}) = (${formatSpanRational(upperValue)}) - (${formatSpanRational(lowerValue)}) = ${answerText}。`,
    ],
  } };
}

/**
 * Deterministic finite supply: 1000 seeds × 12 ordinals, no model/clock/randomness.
 * Constant seed+1 identifies seed; degree and ordered bounds identify ordinal.
 * Thus every supported seed/ordinal pair changes actual mathematics, not just IDs.
 * This does not establish novelty relative to arbitrary external/source questions.
 */
export function generatePolynomialIntegralExample(input: unknown): IntegralExampleResult {
  if (!record(input)) return unsupported("invalid_generation_identity");
  if (input.family !== "polynomial-definite") return unsupported("unsupported_family");
  if (!onlyKeys(input, ["family", "seed", "index"])
    || !boundedInteger(input.seed, CALCULUS_INTEGRAL_LIMITS.maxSeed) || input.seed < 0
    || !boundedInteger(input.index, CALCULUS_INTEGRAL_LIMITS.capacity - 1) || input.index < 0) return unsupported("invalid_generation_identity");
  const degree = input.index % (CALCULUS_INTEGRAL_LIMITS.maxDegree + 1);
  const coefficients: IntegralCoefficient[] = [{ numerator: input.seed + 1, denominator: 1 }];
  for (let power = 1; power <= degree; power++) {
    const magnitude = 1 + (input.seed + power + input.index) % 9;
    coefficients.push({ numerator: power % 2 === 0 ? magnitude : -magnitude, denominator: 1 + power % 4 });
  }
  const lower = Math.floor(input.index / 6) - 2;
  const result = solvePolynomialIntegralExample({ family: input.family, coefficients, lower, upper: lower + 3 } satisfies PolynomialIntegralParameters);
  if (result.status === "unsupported") return result;
  return { status: "supported", example: { ...result.example,
    generationIdentity: { family: input.family, seed: input.seed, index: input.index, version: CALCULUS_INTEGRAL_EXAMPLE_VERSION },
  } };
}
