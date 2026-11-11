/** Finite, teaching-only calculus examples. No text solver, provider or assessment bank.
 * Coefficients/points: integer numerator |n| <= 12, integer denominator 1..12.
 * Dense polynomials: degree <= 5 (constant first). Affine powers: exponent 2..5.
 * Inputs are validated even for typed callers; outputs use JSON-safe exact fractions.
 */
export type CalculusRationalInput = { numerator: number; denominator: number };
export type CalculusExactRational = { numerator: string; denominator: string };
export type CalculusFunction =
  | { family: "polynomial"; coefficients: readonly CalculusRationalInput[] }
  | { family: "affine-power"; scale: CalculusRationalInput; slope: CalculusRationalInput;
      offset: CalculusRationalInput; power: number };
export type CalculusProblem =
  | { function: CalculusFunction; task: "derivative" }
  | { function: CalculusFunction; task: "tangent"; at: CalculusRationalInput };
export type CalculusExampleRequest = {
  original: CalculusProblem;
  previous: readonly CalculusProblem[];
  /** Finite seed 0..5 rotates the six candidates; the same complete request replays identically. */
  seed: number;
};
export type CalculusWorkedExample = {
  problem: CalculusProblem;
  familyId: "polynomial-derivative-v1" | "polynomial-tangent-v1" | "affine-power-derivative-v1" | "affine-power-tangent-v1";
  /** Canonical mathematical identity, including task and tangent point, not a freshness claim. */
  parameterIdentity: string;
  stem: string;
  answer: string;
  steps: string[];
  text: string;
  skillLabel: string;
  /** Ascending coefficients of the exact expanded derivative. */
  derivativeCoefficients: CalculusExactRational[];
  tangent: { at: CalculusExactRational; value: CalculusExactRational;
    slope: CalculusExactRational; intercept: CalculusExactRational } | null;
  purpose: "teaching-only";
};
export type CalculusUnsupportedReason = "invalid_input" | "out_of_bounds" | "unsupported_family" | "unsupported_task" | "exhausted";
export type CalculusExampleResult =
  | { status: "ok"; example: CalculusWorkedExample }
  | { status: "unsupported"; reason: CalculusUnsupportedReason };

type Q = { n: bigint; d: bigint };
type Parsed<T> = { value: T } | { reason: CalculusUnsupportedReason };
const zero: Q = { n: 0n, d: 1n };
const one: Q = { n: 1n, d: 1n };
function q(n: bigint, d = 1n): Q {
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const negate = (a: Q): Q => ({ n: -a.n, d: a.d });
const fromInput = (a: CalculusRationalInput): Q => q(BigInt(a.numerator), BigInt(a.denominator));
const exact = (a: Q): CalculusExactRational => ({ numerator: String(a.n), denominator: String(a.d) });
const input = (a: Q): CalculusRationalInput => ({ numerator: Number(a.n), denominator: Number(a.d) });
const show = (a: Q): string => a.d === 1n ? String(a.n) : `${a.n}/${a.d}`;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function rational(value: unknown): Parsed<CalculusRationalInput> {
  if (!record(value) || !keys(value, ["numerator", "denominator"]) ||
      typeof value.numerator !== "number" || typeof value.denominator !== "number" ||
      !Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)) {
    return { reason: "invalid_input" };
  }
  if (Math.abs(value.numerator) > 12 || value.denominator < 1 || value.denominator > 12) {
    return { reason: "out_of_bounds" };
  }
  return { value: input(q(BigInt(value.numerator), BigInt(value.denominator))) };
}
function parseProblem(raw: unknown): Parsed<CalculusProblem> {
  if (!record(raw)) return { reason: "invalid_input" };
  if (raw.task !== "derivative" && raw.task !== "tangent") return { reason: "unsupported_task" };
  if (!keys(raw, raw.task === "tangent" ? ["function", "task", "at"] : ["function", "task"])) {
    return { reason: "invalid_input" };
  }
  const fn = raw.function;
  if (!record(fn)) return { reason: "invalid_input" };
  let parsedFunction: CalculusFunction;
  if (fn.family === "polynomial") {
    if (!keys(fn, ["family", "coefficients"]) || !Array.isArray(fn.coefficients)) return { reason: "invalid_input" };
    if (fn.coefficients.length < 1 || fn.coefficients.length > 6) return { reason: "out_of_bounds" };
    const coefficients: CalculusRationalInput[] = [];
    // for..of also sees holes as undefined; sparse arrays cannot bypass validation.
    for (const coefficient of fn.coefficients) {
      const result = rational(coefficient);
      if ("reason" in result) return result;
      coefficients.push(result.value);
    }
    while (coefficients.length > 1 && coefficients[coefficients.length - 1]!.numerator === 0) coefficients.pop();
    parsedFunction = { family: "polynomial", coefficients };
  } else if (fn.family === "affine-power") {
    if (!keys(fn, ["family", "scale", "slope", "offset", "power"]) ||
        typeof fn.power !== "number" || !Number.isSafeInteger(fn.power)) return { reason: "invalid_input" };
    if (fn.power < 2 || fn.power > 5) return { reason: "out_of_bounds" };
    const scale = rational(fn.scale), slope = rational(fn.slope), offset = rational(fn.offset);
    if ("reason" in scale) return scale;
    if ("reason" in slope) return slope;
    if ("reason" in offset) return offset;
    if (scale.value.numerator === 0 || slope.value.numerator === 0) return { reason: "out_of_bounds" };
    parsedFunction = { family: "affine-power", scale: scale.value, slope: slope.value, offset: offset.value, power: fn.power };
  } else return { reason: "unsupported_family" };
  if (raw.task === "derivative") return { value: { function: parsedFunction, task: "derivative" } };
  const at = rational(raw.at);
  if ("reason" in at) return at;
  return { value: { function: parsedFunction, task: "tangent", at: at.value } };
}
function trim(coefficients: Q[]): Q[] {
  while (coefficients.length > 1 && coefficients[coefficients.length - 1]!.n === 0n) coefficients.pop();
  return coefficients;
}
function multiply(a: readonly Q[], b: readonly Q[]): Q[] {
  const result = Array<Q>(a.length + b.length - 1).fill(zero);
  a.forEach((x, i) => b.forEach((y, j) => { result[i + j] = add(result[i + j]!, mul(x, y)); }));
  return trim(result);
}
function expand(fn: CalculusFunction): Q[] {
  if (fn.family === "polynomial") return fn.coefficients.map(fromInput);
  let result = [one];
  for (let i = 0; i < fn.power; i++) result = multiply(result, [fromInput(fn.offset), fromInput(fn.slope)]);
  return result.map(value => mul(fromInput(fn.scale), value));
}
function differentiate(coefficients: readonly Q[]): Q[] {
  return trim(coefficients.length === 1 ? [zero] : coefficients.slice(1).map((value, i) => mul(value, q(BigInt(i + 1)))));
}
function evaluate(coefficients: readonly Q[], at: Q): Q {
  return coefficients.reduceRight((acc, value) => add(mul(acc, at), value), zero);
}
function polynomial(coefficients: readonly Q[]): string {
  let result = "";
  for (let power = coefficients.length - 1; power >= 0; power--) {
    const value = coefficients[power]!;
    if (value.n === 0n) continue;
    const magnitude = show(value.n < 0n ? negate(value) : value);
    const term = power === 0 ? magnitude : `${magnitude === "1" ? "" : magnitude + "*"}x${power === 1 ? "" : "^" + power}`;
    result += (result ? (value.n < 0n ? " - " : " + ") : (value.n < 0n ? "-" : "")) + term;
  }
  return result || "0";
}
function expression(fn: CalculusFunction): string {
  if (fn.family === "polynomial") return polynomial(expand(fn));
  return `${show(fromInput(fn.scale))}*(${polynomial([fromInput(fn.offset), fromInput(fn.slope)])})^${fn.power}`;
}
function identity(problem: CalculusProblem): string {
  return `${problem.task}|${expand(problem.function).map(show).join(",")}${problem.task === "tangent" ? "|at=" + show(fromInput(problem.at)) : ""}`;
}
function build(problem: CalculusProblem): CalculusWorkedExample {
  const fn = problem.function, coefficients = expand(fn), derivative = differentiate(coefficients);
  const derivativeText = polynomial(derivative);
  const steps = fn.family === "polynomial"
    ? ["逐项使用 (c*x^n)'=c*n*x^(n-1)，常数项导数为 0。", `合并各项：f'(x)=${derivativeText}。`]
    : [`令 u=${polynomial([fromInput(fn.offset), fromInput(fn.slope)])}，则 u'=${show(fromInput(fn.slope))}。`,
      `链式法则：(c*u^n)'=c*n*u^(n-1)*u'，本题 c=${show(fromInput(fn.scale))}，n=${fn.power}。`,
      `代入并展开合并：f'(x)=${derivativeText}。`];
  let tangent: CalculusWorkedExample["tangent"] = null;
  let answer = `f'(x)=${derivativeText}`;
  const stem = problem.task === "derivative"
    ? `求函数 f(x)=${expression(fn)} 的导数。`
    : `求曲线 y=f(x)=${expression(fn)} 在 x=${show(fromInput(problem.at))} 处的切线方程。`;
  if (problem.task === "tangent") {
    const at = fromInput(problem.at), value = evaluate(coefficients, at), slope = evaluate(derivative, at);
    const intercept = add(value, negate(mul(slope, at)));
    tangent = { at: exact(at), value: exact(value), slope: exact(slope), intercept: exact(intercept) };
    steps.push(`代入 x0=${show(at)}：f(x0)=${show(value)}，f'(x0)=${show(slope)}。`,
      `用 y-f(x0)=f'(x0)*(x-x0)，整理得到 y=${polynomial([intercept, slope])}。`);
    answer = `y=${polynomial([intercept, slope])}`;
  }
  const familyId = `${fn.family}-${problem.task}-v1` as CalculusWorkedExample["familyId"];
  return { problem, familyId, parameterIdentity: identity(problem), stem, answer, steps,
    text: `${stem}\n\n${steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\n答案：${answer}\n这是已展示解法的学习例题，不是独立作答、未见题或掌握证据。`,
    skillLabel: fn.family === "polynomial" ? "多项式求导与切线" : "线性内函数幂的链式求导与切线",
    derivativeCoefficients: derivative.map(exact), tangent, purpose: "teaching-only" };
}

/** Solve only the explicitly typed bounded grammar; never infer a function from prose. */
export function solveCalculusDerivativeExample(problem: unknown): CalculusExampleResult {
  const parsed = parseProblem(problem);
  return "reason" in parsed ? { status: "unsupported", reason: parsed.reason } : { status: "ok", example: build(parsed.value) };
}
const integer = (numerator: number): CalculusRationalInput => ({ numerator, denominator: 1 });
function candidate(original: CalculusProblem, index: number): CalculusProblem {
  // Six real, distinct teaching bodies per family/task, no reserved variant pool.
  const fn: CalculusFunction = original.function.family === "polynomial"
    ? { family: "polynomial", coefficients: [integer(index - 2), integer(index + 1), { numerator: index + 1, denominator: 2 }, integer(index % 2)] }
    : { family: "affine-power", scale: integer(index % 2 === 0 ? 1 : -1), slope: integer(index + 1), offset: integer(index - 2), power: 2 + index % 4 };
  return original.task === "derivative" ? { function: fn, task: "derivative" }
    : { function: fn, task: "tangent", at: { numerator: index - 2, denominator: 2 } };
}

/** Pure replay: seed + original + previous problems fully determine the result.
 * The caller owns persistence/idempotency keys. Invalid history is rejected, not ignored.
 * Exhaustion is explicit; this function never falls back to a paid model or another family.
 */
export function generateCalculusDerivativeExample(request: unknown): CalculusExampleResult {
  if (!record(request) || !keys(request, ["original", "previous", "seed"]) ||
      !Array.isArray(request.previous) || typeof request.seed !== "number" || !Number.isSafeInteger(request.seed)) {
    return { status: "unsupported", reason: "invalid_input" };
  }
  if (request.seed < 0 || request.seed > 5 || request.previous.length > 128) return { status: "unsupported", reason: "out_of_bounds" };
  const original = parseProblem(request.original);
  if ("reason" in original) return { status: "unsupported", reason: original.reason };
  const seen = new Set([identity(original.value)]);
  for (const previous of request.previous) {
    const parsed = parseProblem(previous);
    if ("reason" in parsed) return { status: "unsupported", reason: parsed.reason };
    seen.add(identity(parsed.value));
  }
  for (let offset = 0; offset < 6; offset++) {
    const parsed = parseProblem(candidate(original.value, (request.seed + offset) % 6));
    if ("reason" in parsed) return { status: "unsupported", reason: parsed.reason };
    if (!seen.has(identity(parsed.value))) return { status: "ok", example: build(parsed.value) };
  }
  return { status: "unsupported", reason: "exhausted" };
}
