import { matrixExerciseSpecSchema, type MatrixExerciseSpec } from "@aistudy/contracts";

export const MATRIX_EVALUATOR_VERSION = "matrix-exact-v1" as const;
type Rational = { n: bigint; d: bigint };
export type MatrixEvaluation = {
  decision: "correct" | "incorrect" | "abstain";
  outcome: "correct" | "incorrect" | "unverified";
  reasonCodes: string[];
  evaluatorVersion: typeof MATRIX_EVALUATOR_VERSION;
};
const result = (decision: MatrixEvaluation["decision"], reason: string): MatrixEvaluation => ({
  decision, outcome: decision === "abstain" ? "unverified" : decision,
  reasonCodes: [reason], evaluatorVersion: MATRIX_EVALUATOR_VERSION,
});

/** Canonical decimal coefficient and power of ten, without expanding exponents. */
function decimalParts(token: string): { coefficient: string; power: number } {
  const [, sign, whole, fraction = "", exponent = "0"] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  const digits = (whole! + fraction).replace(/^0+/, "");
  if (!digits.length) return { coefficient: "0", power: 0 };
  let last = digits.length;
  while (digits[last - 1] === "0") last -= 1;
  return { coefficient: sign + digits.slice(0, last), power: Number(exponent) - fraction.length + digits.length - last };
}

/** JSON.parse validates syntax. Scan only unquoted numeric tokens for rounding. */
function preservesNumericLiterals(answer: string): boolean {
  const tokens = /\\[\s\S]|"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  let quoted = false;
  for (const [token] of answer.matchAll(tokens)) {
    if (token === '"') quoted = !quoted;
    if (quoted || token === '"' || token.startsWith("\\")) continue;

    const number = Number(token);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) return false;
    const literal = decimalParts(token);
    const decoded = decimalParts(String(number));
    if (literal.coefficient !== decoded.coefficient || literal.power !== decoded.power) return false;
  }
  return true;
}

function rational(value: unknown): Rational | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) return null;
    // The lexical guard ensures this decimal is exactly the learner's value.
    const { coefficient, power } = decimalParts(String(value));
    const n = BigInt(coefficient);
    return power < 0 ? { n, d: 10n ** BigInt(-power) } : { n: n * 10n ** BigInt(power), d: 1n };
  }
  if (typeof value !== "string") return null;
  const match = /^([+-]?\d{1,7})(?:\/([+-]?\d{1,7}))?$/.exec(value.trim());
  if (!match) return null;
  const n = BigInt(match[1]!), d = BigInt(match[2] ?? "1");
  return d === 0n ? null : d < 0n ? { n: -n, d: -d } : { n, d };
}
const add = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const multiply = (a: Rational, b: Rational): Rational => ({ n: a.n * b.n, d: a.d * b.d });
const equal = (a: Rational, b: Rational) => a.n * b.d === b.n * a.d;

/** A finite catalogue keeps operands and interpretation outside user/model control. */
export function createMatrixExerciseSpec(exerciseKey: MatrixExerciseSpec["exerciseKey"], variant = 0): MatrixExerciseSpec {
  if (!Number.isInteger(variant) || variant < 0 || variant > 8) throw new Error("matrix variant out of range");
  const shift = (base: number, row: number, col: number) => ((base + variant * (row + col + 1)) % 9 + 9) % 9 - 4;
  const matrix = (values: number[][]) => values.map((row, r) => row.map((v, c) => shift(v + 4, r, c)));
  const common = { kind: "matrix_arithmetic" as const, specVersion: "matrix-arithmetic-v1" as const, exerciseKey, variant };
  if (exerciseKey === "dimensions") return { ...common, matrixA: matrix([[1, -2, 3], [0, 4, 2]]) };
  if (exerciseKey === "addition") return { ...common, matrixA: matrix([[1, -2], [3, 0]]), matrixB: matrix([[2, 4], [-1, 4]]) };
  if (exerciseKey === "scalar") return { ...common, matrixA: matrix([[1, -2], [3, 0]]), scalar: variant % 2 === 0 ? "1/2" : "-2" };
  return { ...common, matrixA: matrix([[1, 2, -1], [0, 3, 2]]), matrixB: matrix([[2, 0], [-1, 1], [3, 2]]) };
}

/** Stored JSON is a trust boundary; unsupported or altered operands never acquire a verdict. */
export function parseCanonicalMatrixExercise(raw: unknown): MatrixExerciseSpec | null {
  const parsed = matrixExerciseSpecSchema.safeParse(raw);
  if (!parsed.success) return null;
  const expected = createMatrixExerciseSpec(parsed.data.exerciseKey, parsed.data.variant);
  return JSON.stringify(parsed.data) === JSON.stringify(expected) ? expected : null;
}

export function matrixExerciseRequirement(spec: MatrixExerciseSpec): string {
  return `matrix:${spec.specVersion}:${spec.exerciseKey}`;
}
export function matrixExerciseSkillLabel(key: MatrixExerciseSpec["exerciseKey"]): string {
  return { dimensions: "矩阵维数", addition: "矩阵加法", scalar: "矩阵标量乘法", multiplication: "矩阵乘法" }[key];
}
export function matrixExerciseStem(spec: MatrixExerciseSpec): string {
  const a = `A=${JSON.stringify(spec.matrixA)}`;
  if (spec.exerciseKey === "dimensions") return `${a}。写出矩阵A的行数与列数，答案格式：[行数,列数]。`;
  if (spec.exerciseKey === "scalar") return `${a}。计算(${spec.scalar})A。答案用二维数组，每个分数加引号，例如[["1/2",2],[3,4]]。`;
  return `${a}，B=${JSON.stringify(spec.matrixB)}。计算${spec.exerciseKey === "addition" ? "A+B" : "AB"}。答案用二维数组，例如[[1,2],[3,4]]。`;
}

/** Exact integer/rational arithmetic; JSON only, no expression execution or float tolerance. */
export function evaluateMatrixAnswer(rawSpec: unknown, answer: string): MatrixEvaluation {
  const spec = parseCanonicalMatrixExercise(rawSpec);
  if (!spec) return result("abstain", "missing_or_unsupported_spec");
  if (answer.length > 2000) return result("abstain", "resource_limit");
  let decoded: unknown;
  try { decoded = JSON.parse(answer); } catch { return result("abstain", "ambiguous_input"); }
  if (!preservesNumericLiterals(answer)) return result("abstain", "unsupported_number");
  if (spec.exerciseKey === "dimensions") {
    if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every(Number.isSafeInteger)) return result("abstain", "ambiguous_input");
    return result(decoded[0] === spec.matrixA.length && decoded[1] === spec.matrixA[0]!.length ? "correct" : "incorrect", "dimensions_compared");
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 4
    || !decoded.every(row => Array.isArray(row) && row.length > 0 && row.length <= 4)) return result("abstain", "ambiguous_input");
  if (!decoded.every(row => row.length === decoded[0].length)) return result("abstain", "ambiguous_input");
  const actual = (decoded as unknown[][]).map(row => row.map(rational));
  if (actual.some(row => row.some(cell => cell === null))) return result("abstain", "unsupported_number");
  const a = spec.matrixA.map(row => row.map(value => rational(value)!));
  const b = spec.matrixB?.map(row => row.map(value => rational(value)!));
  const expected = spec.exerciseKey === "scalar" ? a.map(row => row.map(cell => multiply(cell, rational(spec.scalar)!)))
    : spec.exerciseKey === "addition" ? a.map((row, r) => row.map((cell, c) => add(cell, b![r]![c]!)))
    : a.map(row => b![0]!.map((_, c) => row.reduce((sum, cell, k) => add(sum, multiply(cell, b![k]![c]!)), { n: 0n, d: 1n })));
  if (actual.length !== expected.length || actual[0]!.length !== expected[0]!.length) return result("incorrect", "matrix_shape_mismatch");
  return result(actual.every((row, r) => row.every((cell, c) => equal(cell!, expected[r]![c]!))) ? "correct" : "incorrect", "matrix_entries_compared");
}
