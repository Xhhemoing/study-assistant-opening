import type {
  CalculusExampleRequest,
  CalculusExampleResult,
  CalculusProblem,
  CalculusRationalInput,
} from "./calculus-derivative-examples";
import type {
  IntegralExampleGenerationInput,
  IntegralExampleResult,
  PolynomialIntegralParameters,
} from "./calculus-integral-examples";

export type CalculusExampleBody = {
  text: string; stem: string; answer: string; steps: string[]; skillLabel: string;
};
export type CalculusExampleGenerators = {
  derivative: (request: CalculusExampleRequest) => CalculusExampleResult;
  solveIntegral: (parameters: PolynomialIntegralParameters) => IntegralExampleResult;
  integral: (identity: IntegralExampleGenerationInput) => IntegralExampleResult;
};
const integer = (numerator: number): CalculusRationalInput => ({ numerator, denominator: 1 });
function rational(text: string, max = 12): CalculusRationalInput | null {
  if (!/^[+-]?\d{1,4}(?:\/\d{1,4})?$/.test(text)) return null;
  const [numerator, denominator = 1] = text.split("/").map(Number);
  if (Math.abs(numerator!) > max || denominator < 1 || denominator > max) return null;
  return { numerator: numerator!, denominator };
}

/** A deliberately small explicit polynomial grammar, not a general text solver. */
function polynomial(text: string, max = 12): Extract<CalculusProblem["function"], { family: "polynomial" }> | null {
  const expression = text.replace(/\s/g, "");
  const terms = expression.match(/[+-]?[^+-]+/g);
  if (!terms || terms.join("") !== expression || terms.length > 6) return null;
  const coefficients = Array.from({ length: 6 }, () => integer(0));
  const powers = new Set<number>();
  for (const term of terms) {
    const variable = /^([+-]?)(?:(\d{1,4}(?:\/\d{1,4})?)\*?)?x(?:\^([0-5]))?$/.exec(term);
    const power = variable ? Number(variable[3] ?? 1) : 0;
    const coefficient = variable ? rational(`${variable[1]}${variable[2] ?? 1}`, max) : rational(term, max);
    // Repeated powers are rejected rather than silently interpreting ambiguous prose.
    if (!coefficient || powers.has(power)) return null;
    coefficients[power] = coefficient;
    powers.add(power);
  }
  while (coefficients.length > 1 && coefficients.at(-1)!.numerator === 0) coefficients.pop();
  return { family: "polynomial", coefficients };
}

/** Parse only a complete first-line stem; the remainder may be the old solution. */
function derivativeProblem(body: string): CalculusProblem | null {
  const stem = body.trim().split(/\r?\n/)[0]!.trim();
  const derivative = /^求函数\s*f\(x\)\s*=\s*(.+?)\s*的导数[。.?？]?$/.exec(stem);
  const tangent = /^求曲线\s*y\s*=\s*f\(x\)\s*=\s*(.+?)\s*在\s*x\s*=\s*([+-]?\d{1,2}(?:\/\d{1,2})?)\s*处的切线方程[。.?？]?$/.exec(stem);
  const match = derivative ?? tangent;
  if (!match) return null;
  const fn = polynomial(match[1]!);
  if (!fn) return null;
  if (derivative) return { function: fn, task: "derivative" };
  const at = rational(tangent![2]!);
  return at ? { function: fn, task: "tangent", at } : null;
}

/** Match only the first-line signed definite-integral stem, not a solution line. */
function integralProblem(body: string): PolynomialIntegralParameters | null {
  const stem = body.trim().split(/\r?\n/)[0]!.trim();
  const match = /^计算定积分\s*∫\[\s*([+-]?\d{1,2})\s*,\s*([+-]?\d{1,2})\s*\]\s*\(([^()]+)\)\s*dx(?:（带符号积分，不是几何面积）)?[。.?？]?$/.exec(stem);
  if (!match) return null;
  const fn = polynomial(match[3]!, 1000);
  const lower = Number(match[1]), upper = Number(match[2]);
  if (!fn || Math.abs(lower) > 10 || Math.abs(upper) > 10) return null;
  return { family: "polynomial-definite", coefficients: fn.coefficients, lower, upper };
}

function integralExample(
  original: PolynomialIntegralParameters,
  previousBodies: readonly string[],
  generators: CalculusExampleGenerators,
): CalculusExampleBody | null {
  const solved = generators.solveIntegral(original);
  if (solved.status !== "supported") return null;
  const seen = new Set([solved.example.parameterIdentity]);
  for (const body of previousBodies) {
    const parameters = integralProblem(body);
    if (!parameters) continue;
    const previous = generators.solveIntegral(parameters);
    if (previous.status !== "supported") return null;
    seen.add(previous.example.parameterIdentity);
  }
  // A deliberately finite teaching-only slice of the author's supply. No paid
  // fallback or seed rotation when this slice is exhausted.
  for (let index = 0; index < 12; index++) {
    const result = generators.integral({ family: "polynomial-definite", seed: 0, index });
    if (result.status !== "supported") return null;
    const example = result.example;
    if (seen.has(example.parameterIdentity)) continue;
    return { stem: example.prompt, answer: example.answerText, steps: example.steps,
      skillLabel: "多项式定积分（带符号）",
      text: `${example.prompt}\n\n${example.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\n答案：${example.answerText}\n这是已展示解法的学习例题，不是独立作答、未见题或掌握证据。` };
  }
  return null;
}

/**
 * Existing free-example text -> bounded typed teaching generators. No provider,
 * paid fallback, publication, provenance, help, independence or mastery writes.
 * Only polynomial derivative/tangent and signed polynomial definite integrals;
 * original arithmetic stays owned by the existing caller.
 */
export function dispatchCalculusExample(
  original: string,
  previousBodies: readonly string[],
  generators: CalculusExampleGenerators,
): CalculusExampleBody | null {
  const problem = derivativeProblem(original);
  if (!problem) {
    const integral = integralProblem(original);
    return integral ? integralExample(integral, previousBodies, generators) : null;
  }
  const previous = previousBodies.map(derivativeProblem).filter((value): value is CalculusProblem => value !== null);
  const result = generators.derivative({ original: problem, previous, seed: 0 });
  return result.status === "ok" ? result.example : null;
}
