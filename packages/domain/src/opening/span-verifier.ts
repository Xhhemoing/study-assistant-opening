import type { SpanAnswer, SpanProblem, SpanSolution, SpanVerification } from "@aistudy/contracts";
import { addRational, divideRational, equalRational, formatSpanRational, multiplyRational, parseSpanRational, rational, subtractRational, type SpanRational } from "./span-rational";

type ParsedProblem = { vectors: [SpanRational[], SpanRational[]]; target: SpanRational[] };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function parseVector(raw: unknown): SpanRational[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return null;
  const parsed = raw.map(parseSpanRational);
  return parsed.every((entry) => entry !== null) ? parsed as SpanRational[] : null;
}
function parseProblem(raw: unknown): ParsedProblem | null {
  if (!isRecord(raw) || !Array.isArray(raw.vectors) || raw.vectors.length !== 2) return null;
  const v = parseVector(raw.vectors[0]);
  const w = parseVector(raw.vectors[1]);
  const target = parseVector(raw.target);
  if (!v || !w || !target || v.length !== target.length || w.length !== target.length) return null;
  return { vectors: [v, w], target };
}

/** RREF on an augmented n×3 matrix, using BigInt fractions throughout. */
function solveParsed(problem: ParsedProblem): Exclude<SpanSolution, { kind: "unknown" }> {
  const rows = problem.target.map((u, i) => [problem.vectors[0][i]!, problem.vectors[1][i]!, u]);
  const pivots: number[] = [];
  let rank = 0;
  for (let column = 0; column < 2; column++) {
    const candidate = rows.findIndex((row, index) => index >= rank && row[column]!.n !== 0n);
    if (candidate < 0) continue;
    [rows[rank], rows[candidate]] = [rows[candidate]!, rows[rank]!];
    const divisor = rows[rank]![column]!;
    rows[rank] = rows[rank]!.map((cell) => divideRational(cell, divisor));
    for (let row = 0; row < rows.length; row++) {
      if (row === rank) continue;
      const factor = rows[row]![column]!;
      rows[row] = rows[row]!.map((cell, j) => subtractRational(cell, multiplyRational(factor, rows[rank]![j]!)));
    }
    pivots.push(column);
    rank++;
  }
  if (rows.some((row) => row[0]!.n === 0n && row[1]!.n === 0n && row[2]!.n !== 0n)) return { kind: "none" };
  const particular = [rational(0n), rational(0n)];
  pivots.forEach((column, row) => { particular[column] = rows[row]![2]!; });
  const pair = (values: SpanRational[]): [string, string] => [formatSpanRational(values[0]!), formatSpanRational(values[1]!)];
  if (rank === 2) return { kind: "unique", coefficients: pair(particular) };
  const directions: [string, string][] = [];
  for (let column = 0; column < 2; column++) {
    if (pivots.includes(column)) continue;
    const direction = [rational(0n), rational(0n)];
    direction[column] = rational(1n);
    pivots.forEach((pivot, row) => { direction[pivot] = multiplyRational(rational(-1n), rows[row]![column]!); });
    directions.push(pair(direction));
  }
  return { kind: "infinite", particular: pair(particular), directions };
}

export function solveSpanProblem(problem: SpanProblem): SpanSolution {
  const parsed = parseProblem(problem);
  return parsed ? solveParsed(parsed) : { kind: "unknown", reason: "invalid_problem" };
}

function parseAnswer(raw: unknown): SpanAnswer | null {
  if (typeof raw === "string") {
    if (raw.length > 8000) return null;
    try { raw = JSON.parse(raw) as unknown; } catch { return null; }
  }
  if (!isRecord(raw) || (raw.membership !== "in_span" && raw.membership !== "not_in_span")) return null;
  if (raw.recognition !== undefined && raw.recognition !== "confirmed" && raw.recognition !== "uncertain") return null;
  if (raw.coefficients !== undefined && (!Array.isArray(raw.coefficients) || raw.coefficients.length !== 2 || !raw.coefficients.every((value) => parseSpanRational(value) !== null))) return null;
  if (raw.coordinateChecks !== undefined && !parseVector(raw.coordinateChecks)) return null;
  if (raw.equation !== undefined && !parseProblem(raw.equation)) return null;
  if (raw.noSolutionWitness !== undefined && !parseVector(raw.noSolutionWitness)) return null;
  if (raw.coefficientDerivationCoordinates !== undefined && (!Array.isArray(raw.coefficientDerivationCoordinates) || raw.coefficientDerivationCoordinates.length !== 2 || !raw.coefficientDerivationCoordinates.every((value) => Number.isInteger(value) && value >= 0 && value < 8))) return null;
  if (raw.representations !== undefined) {
    if (!isRecord(raw.representations)) return null;
    const { system, geometry } = raw.representations;
    if (system !== undefined && system !== "unique" && system !== "infinite" && system !== "none") return null;
    if (geometry !== undefined && geometry !== "plane" && geometry !== "line" && geometry !== "point") return null;
    // No free-form constraint is implicitly validated by these two structural checks.
    if (Object.keys(raw.representations).some((key) => key !== "system" && key !== "geometry")) return null;
  }
  return raw as SpanAnswer;
}
const emptySkills = (): SpanVerification["skills"] => ({ equation: "unobserved", coefficients: "unobserved", allCoordinates: "unobserved" });
const unknown = (reason: string, solution: SpanSolution): SpanVerification => ({ outcome: "unknown", membershipOutcome: "unobserved", coreEvidenceComplete: false, reason, solution, skills: emptySkills(), failedCoordinates: [], countsAsStudentError: false });

/**
 * Inspect a structured, confirmed transcription. Never treats OCR/parse failure as a
 * learner error, and never gives process credit for an absent process. The caller
 * resolves the authoritative problem by item ID/version and persists this result.
 */
export function verifySpanAnswer(problem: SpanProblem, rawAnswer: unknown): SpanVerification {
  const parsed = parseProblem(problem);
  const solution = parsed ? solveParsed(parsed) : { kind: "unknown" as const, reason: "invalid_problem" };
  if (!parsed) return unknown("invalid_problem", solution);
  if (isRecord(rawAnswer) && rawAnswer.recognition === "uncertain") return unknown("recognition_uncertain", solution);
  const answer = parseAnswer(rawAnswer);
  if (!answer) return unknown("answer_unparseable", solution);
  if (answer.recognition === "uncertain") return unknown("recognition_uncertain", solution);
  if (answer.membership === "in_span" && !answer.coefficients) return unknown("coefficients_missing", solution);
  if (answer.coordinateChecks && !answer.coefficients) return unknown("coordinate_checks_need_coefficients", solution);
  if (answer.coordinateChecks && answer.coordinateChecks.length !== parsed.target.length) return unknown("coordinate_checks_incomplete", solution);
  if (answer.equation && parseProblem(answer.equation)?.target.length !== parsed.target.length) return unknown("equation_dimension_mismatch", solution);
  if (answer.noSolutionWitness && answer.noSolutionWitness.length !== parsed.target.length) return unknown("witness_dimension_mismatch", solution);
  if (answer.coefficientDerivationCoordinates?.some((index) => index >= parsed.target.length)) return unknown("derivation_coordinate_out_of_range", solution);
  const skills = emptySkills();
  if (answer.representations?.system) skills.systemConsistency = answer.representations.system === solution.kind ? "correct" : "incorrect";
  if (answer.representations?.geometry) {
    const homogeneous = solveParsed({ ...parsed, target: parsed.target.map(() => rational(0n)) });
    const rank = homogeneous.kind === "unique" ? 2 : homogeneous.kind === "infinite" ? 2 - homogeneous.directions.length : 0;
    const geometry = rank === 2 ? "plane" : rank === 1 ? "line" : "point";
    skills.geometry = answer.representations.geometry === geometry ? "correct" : "incorrect";
  }
  if (answer.equation) {
    const equation = parseProblem(answer.equation)!;
    skills.equation = equation.target.every((value, i) => equalRational(value, parsed.target[i]!)) &&
      equation.vectors.every((vector, j) => vector.every((value, i) => equalRational(value, parsed.vectors[j]![i]!))) ? "correct" : "incorrect";
  }
  let failedCoordinates: number[] = [];
  let computed: SpanRational[] | null = null;
  if (answer.coefficients) {
    const [alpha, beta] = answer.coefficients.map((value) => parseSpanRational(value)!);
    computed = parsed.target.map((_, i) => addRational(multiplyRational(alpha!, parsed.vectors[0][i]!), multiplyRational(beta!, parsed.vectors[1][i]!)));
    failedCoordinates = computed.flatMap((value, i) => equalRational(value, parsed.target[i]!) ? [] : [i]);
    // For a no-solution claim these are candidate coefficients, not a claimed
    // nonexistent global solution. Their derivation is checked separately below.
    skills.coefficients = answer.membership === "not_in_span" ? "unobserved" : failedCoordinates.length === 0 ? "correct" : "incorrect";
  }
  if (answer.coordinateChecks && computed) {
    skills.allCoordinates = answer.coordinateChecks.every((value, i) => equalRational(parseSpanRational(value)!, computed![i]!)) ? "correct" : "incorrect";
  }
  if (answer.noSolutionWitness) {
    const y = answer.noSolutionWitness.map((value) => parseSpanRational(value)!);
    const dot = (vector: SpanRational[]) => vector.reduce((sum, value, i) => addRational(sum, multiplyRational(value, y[i]!)), rational(0n));
    skills.noSolutionProof = parsed.vectors.every((vector) => dot(vector).n === 0n) && dot(parsed.target).n !== 0n ? "correct" : "incorrect";
  }
  if (answer.coefficientDerivationCoordinates) {
    const [i, j] = answer.coefficientDerivationCoordinates;
    const determinant = subtractRational(multiplyRational(parsed.vectors[0][i]!, parsed.vectors[1][j]!), multiplyRational(parsed.vectors[0][j]!, parsed.vectors[1][i]!));
    const valid = computed !== null && i !== j && determinant.n !== 0n && equalRational(computed[i]!, parsed.target[i]!) && equalRational(computed[j]!, parsed.target[j]!) && failedCoordinates.length > 0 && skills.allCoordinates === "correct";
    const proof = valid ? "correct" : "incorrect";
    if (answer.membership === "not_in_span") skills.coefficients = proof;
    skills.noSolutionProof = skills.noSolutionProof === "incorrect" || proof === "incorrect" ? "incorrect" : "correct";
  }
  const membershipCorrect = (answer.membership === "in_span") === (solution.kind !== "none");
  // An inconsistent candidate is a valid witness to a failed candidate, but cannot
  // by itself prove no solution. RREF checks the no-solution conclusion independently.
  const coefficientsRequiredAndWrong = answer.membership === "in_span" && skills.coefficients === "incorrect";
  const processWrong = Object.entries(skills).some(([key, skill]) => skill === "incorrect" && !(key === "coefficients" && answer.membership === "not_in_span"));
  const noSolutionProofMissing = answer.membership === "not_in_span" && membershipCorrect && skills.noSolutionProof !== "correct" && !processWrong;
  const coreEvidenceComplete = skills.equation === "correct" && (answer.membership === "in_span" ? skills.coefficients === "correct" && skills.allCoordinates === "correct" : skills.noSolutionProof === "correct");
  const correct = membershipCorrect && !coefficientsRequiredAndWrong && !processWrong;
  return { outcome: noSolutionProofMissing ? "unknown" : correct ? "correct" : "incorrect", membershipOutcome: membershipCorrect ? "correct" : "incorrect", coreEvidenceComplete, reason: !membershipCorrect ? "membership_incorrect" : coefficientsRequiredAndWrong ? "coefficients_do_not_satisfy_all_coordinates" : processWrong ? "process_incorrect" : noSolutionProofMissing ? "no_solution_proof_unobserved" : "verified_exactly", solution, skills, failedCoordinates, countsAsStudentError: !correct };
}
