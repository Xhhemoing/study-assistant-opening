import { describe, expect, it } from "vitest";
import {
  CALCULUS_INTEGRAL_LIMITS, generatePolynomialIntegralExample, solvePolynomialIntegralExample,
  type IntegralExampleResult, type PolynomialIntegralExample, type PolynomialIntegralParameters,
} from "./calculus-integral-examples";

const family = "polynomial-definite" as const;
const coefficient = (numerator: number, denominator = 1) => ({ numerator, denominator });
const parameters = (coefficients = [coefficient(1)], lower = 0, upper = 1): PolynomialIntegralParameters =>
  ({ family, coefficients, lower, upper });
function supported(result: IntegralExampleResult): PolynomialIntegralExample {
  expect(result.status).toBe("supported");
  if (result.status !== "supported") throw new Error(result.reason);
  return result.example;
}
const solve = (coefficients: number[], lower = 0, upper = 1) =>
  supported(solvePolynomialIntegralExample(parameters(coefficients.map(value => coefficient(value)), lower, upper)));

/** Independent oracle: accumulate unreduced fractions then compare by cross-product. */
function assertExactIntegral(example: PolynomialIntegralExample) {
  let numerator = 0n, denominator = 1n;
  const { coefficients, lower, upper } = example.parameters;
  for (const [degree, c] of coefficients.entries()) {
    const power = BigInt(degree + 1);
    const n = BigInt(c.numerator) * (BigInt(upper) ** power - BigInt(lower) ** power);
    const d = BigInt(c.denominator) * power;
    numerator = numerator * d + n * denominator;
    denominator *= d;
    // Differentiate the emitted structured antiderivative, not its prose.
    const antiderivative = example.antiderivativeCoefficients[degree + 1]!;
    expect(BigInt(antiderivative.numerator) * power * BigInt(c.denominator)).toBe(
      BigInt(c.numerator) * BigInt(antiderivative.denominator));
  }
  expect(BigInt(example.answer.numerator) * denominator).toBe(numerator * BigInt(example.answer.denominator));
  expect(BigInt(example.answer.denominator)).toBeGreaterThan(0n);
}

describe("bounded exact polynomial integral examples", () => {
  it.each([
    [[1], 0, 1, "1"], [[0], -10, 10, "0"], [[0, 1], 0, 1, "1/2"],
    [[0, 0, 1], -1, 1, "2/3"], [[0, 0, 0, 1], -2, 2, "0"],
    [[1, 2, 3, 4, 5, 6], 0, 1, "6"], [[3, -2, 1], -1, 2, "9"],
    [[0, 0, 0, 0, 0, 1], -10, 0, "-500000/3"],
  ] as const)("computes %j over [%s,%s] exactly", (coefficients, lower, upper, answer) => {
    const example = solve([...coefficients], lower, upper);
    expect(example.answerText).toBe(answer);
    assertExactIntegral(example);
  });

  it("reduces rational coefficients and signs, including negative denominators", () => {
    const example = supported(solvePolynomialIntegralExample(parameters([
      coefficient(2, -4), coefficient(-6, -8), coefficient(0, -999),
    ])));
    expect(example.parameters.coefficients).toEqual([
      { numerator: "-1", denominator: "2" }, { numerator: "3", denominator: "4" },
    ]);
    expect(example.answer).toEqual({ numerator: "-1", denominator: "8" });
    expect(example.answerText).toBe("-1/8");
    expect(example.upperValue).toEqual(example.answer);
    expect(example.lowerValue).toEqual({ numerator: "0", denominator: "1" });
    assertExactIntegral(example);
  });

  it("reverses sign for exchanged bounds and returns canonical zero for equal bounds", () => {
    const coefficients = [coefficient(-4, 3), coefficient(7, -9), coefficient(2, 5), coefficient(3, 8)];
    const forward = supported(solvePolynomialIntegralExample(parameters(coefficients, -3, 7)));
    const reverse = supported(solvePolynomialIntegralExample(parameters(coefficients, 7, -3)));
    expect(reverse.answer.numerator).toBe(String(-BigInt(forward.answer.numerator)));
    expect(reverse.answer.denominator).toBe(forward.answer.denominator);
    expect(reverse.parameterIdentity).not.toBe(forward.parameterIdentity);
    for (const bound of [-10, -1, 0, 10]) {
      const equal = supported(solvePolynomialIntegralExample(parameters(coefficients, bound, bound)));
      expect(equal.answer).toEqual({ numerator: "0", denominator: "1" });
      expect(equal.upperValue).toEqual(equal.lowerValue);
      assertExactIntegral(equal);
    }
  });

  it("accepts boundary values without any floating-point intermediate or rounded answer", () => {
    const example = supported(solvePolynomialIntegralExample(parameters([
      coefficient(1000, 997), coefficient(-1000, 991), coefficient(1000, 983),
      coefficient(-1000, 977), coefficient(1000, 971), coefficient(-1000, 967),
    ], -9, 10)));
    assertExactIntegral(example);
    expect(BigInt(example.answer.numerator) > BigInt(Number.MAX_SAFE_INTEGER)
      || BigInt(example.answer.numerator) < -BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(() => JSON.stringify(example)).not.toThrow();
    expect(solve([1000, 1000, 1000, 1000, 1000, 1000], -10, 10).answerText).toBe("122060000/3");
  });

  it("has canonical content identity for equivalent representations without mutation", () => {
    const input = parameters([coefficient(2, -4), coefficient(0, 7)], -0, 2);
    const before = JSON.stringify(input);
    const first = supported(solvePolynomialIntegralExample(input));
    const equivalent = supported(solvePolynomialIntegralExample(parameters([coefficient(-1, 2)], 0, 2)));
    expect(first).toEqual(equivalent);
    expect(first).toEqual(supported(solvePolynomialIntegralExample(input)));
    expect(JSON.stringify(input)).toBe(before);
    first.steps.push("caller change");
    first.parameters.coefficients[0]!.numerator = "123";
    expect(supported(solvePolynomialIntegralExample(input))).toEqual(equivalent);
  });

  it("emits a real prompt, exact answer and concrete derivation rather than a provenance-only copy", () => {
    const example = solve([-1, 0, 1], 0, 2);
    expect(example.prompt).toContain("∫[0, 2] (x^2 - 1) dx");
    expect(example.answerText).toBe("2/3");
    expect(example.steps[1]).toContain("F(x) = 1/3*x^3 - x");
    expect(example.steps[2]).toContain("F(2) = 2/3");
    expect(example.steps[3]).toContain("= (2/3) - (0) = 2/3");
    expect(example.antiderivativeCoefficients[0]).toEqual({ numerator: "0", denominator: "1" });
  });

  it.each([
    null, undefined, "∫x dx", [], 1,
    { family: "substitution" }, { family: "integration-parts" }, { family: "solid-of-revolution" },
    { ...parameters(), expression: "globalThis.process.exit()" },
    { ...parameters(), coefficients: [] }, { ...parameters(), coefficients: Array(7).fill(coefficient(0)) },
    { ...parameters(), coefficients: new Array(2) },
    { ...parameters(), coefficients: [null] }, { ...parameters(), coefficients: [1] },
    { ...parameters(), coefficients: [coefficient(1, 0)] },
    { ...parameters(), coefficients: [coefficient(1001)] },
    { ...parameters(), coefficients: [coefficient(-1001)] },
    { ...parameters(), coefficients: [coefficient(1, 1001)] },
    { ...parameters(), coefficients: [coefficient(1, -1001)] },
    { ...parameters(), coefficients: [coefficient(1.5)] },
    { ...parameters(), coefficients: [{ numerator: "1", denominator: 2 }] },
    { ...parameters(), coefficients: [{ ...coefficient(1), expression: "x" }] },
    { ...parameters(), lower: -11 }, { ...parameters(), upper: 11 },
    { ...parameters(), lower: 0.5 }, { ...parameters(), upper: "1" },
    ...[NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
      { ...parameters(), lower: value }, { ...parameters(), upper: value },
      parameters([coefficient(value)]), parameters([coefficient(1, value)]),
    ]),
  ])("explicitly rejects unsupported or malformed input %#", input => {
    expect(solvePolynomialIntegralExample(input)).toMatchObject({ status: "unsupported" });
  });
});

describe("deterministic integral example supply", () => {
  it("is idempotent, creates genuinely different mathematics and does not mutate its input", () => {
    const input = { family, seed: 42, index: 5 };
    const first = supported(generatePolynomialIntegralExample(input));
    expect(generatePolynomialIntegralExample(input)).toEqual({ status: "supported", example: first });
    expect(input).toEqual({ family, seed: 42, index: 5 });
    const next = supported(generatePolynomialIntegralExample({ ...input, index: 6 }));
    const anotherSeed = supported(generatePolynomialIntegralExample({ ...input, seed: 43 }));
    for (const other of [next, anotherSeed]) {
      expect(other.parameters).not.toEqual(first.parameters);
      expect(other.prompt).not.toBe(first.prompt);
      expect(other.parameterIdentity).not.toBe(first.parameterIdentity);
    }
    expect(first.generationIdentity).toMatchObject(input);
    assertExactIntegral(first);
  });

  it("checks all bounded seed/ordinal pairs for distinct content and prompts", () => {
    const identities = new Set<string>(), prompts = new Set<string>();
    for (let seed = 0; seed <= CALCULUS_INTEGRAL_LIMITS.maxSeed; seed++) {
      for (let index = 0; index < CALCULUS_INTEGRAL_LIMITS.capacity; index++) {
        const example = supported(generatePolynomialIntegralExample({ family, seed, index }));
        identities.add(example.parameterIdentity);
        prompts.add(example.prompt);
      }
    }
    const capacity = (CALCULUS_INTEGRAL_LIMITS.maxSeed + 1) * CALCULUS_INTEGRAL_LIMITS.capacity;
    expect(identities.size).toBe(capacity);
    expect(prompts.size).toBe(capacity);
  });

  it("checks exact answers and derivative reconstruction across all degrees and generator bounds", () => {
    for (const seed of [0, 1, 42, 998, 999]) {
      for (let index = 0; index < 12; index++) {
        assertExactIntegral(supported(generatePolynomialIntegralExample({ family, seed, index })));
      }
    }
  });

  it.each([
    null, undefined, "x^2", {}, { family: "substitution", seed: 0, index: 0 },
    { family, seed: 0, index: 0, expression: "x" },
    ...[-1, 1000, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map(seed => ({ family, seed, index: 0 })),
    ...[-1, 12, 0.5, NaN, -Infinity, Number.MAX_VALUE, "1"].map(index => ({ family, seed: 0, index })),
  ])("rejects unsupported generation identities without fallback or clamping %#", input => {
    expect(generatePolynomialIntegralExample(input)).toMatchObject({ status: "unsupported" });
  });
});
