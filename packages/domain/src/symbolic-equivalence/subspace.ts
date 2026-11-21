import { addRational, divideRational, equalRational, multiplyRational, rational, subtractRational, type SpanRational } from "../opening/span-rational";
import { formatRational, toRational, type VerificationResult } from "./types";

export type RationalMatrixInput = readonly (readonly (string | number | bigint | SpanRational)[])[];
export type PivotTrace = { pivotRow: number; pivotColumn: number; operation: "swap" | "scale" | "eliminate"; row?: number; factor?: string };
export type RrefResult = { matrix: SpanRational[][]; rank: number; pivots: number[]; trace: PivotTrace[] };
export type SubspaceResult = VerificationResult & { rankReference: number; rankStudent: number; rankCombined: number; pivotTrace: PivotTrace[]; dependency?: string[] };

function parseMatrix(input: RationalMatrixInput): SpanRational[][] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) return null;
  const rows = input.map((row) => Array.isArray(row) ? row.map(toRational) : []);
  if (rows.some((row) => row.length === 0 || row.some((value) => value === null))) return null;
  const width = rows[0]!.length;
  return rows.every((row) => row.length === width) ? rows as SpanRational[][] : null;
}

export function rref(input: RationalMatrixInput): RrefResult | null {
  const rows = parseMatrix(input); if (!rows) return null;
  const trace: PivotTrace[] = []; const pivots: number[] = []; let pivotRow = 0;
  for (let column = 0; column < rows[0]!.length && pivotRow < rows.length; column++) {
    const candidate = rows.findIndex((row, index) => index >= pivotRow && row[column]!.n !== 0n);
    if (candidate < 0) continue;
    if (candidate !== pivotRow) { [rows[candidate], rows[pivotRow]] = [rows[pivotRow]!, rows[candidate]!]; trace.push({ pivotRow, pivotColumn: column, operation: "swap", row: candidate }); }
    const pivot = rows[pivotRow]![column]!;
    if (!equalRational(pivot, rational(1n))) { for (let j = 0; j < rows[pivotRow]!.length; j++) rows[pivotRow]![j] = divideRational(rows[pivotRow]![j]!, pivot); trace.push({ pivotRow, pivotColumn: column, operation: "scale", factor: formatRational(divideRational(rational(1n), pivot)) }); }
    for (let row = 0; row < rows.length; row++) {
      if (row === pivotRow) continue;
      const factor = rows[row]![column]!; if (factor.n === 0n) continue;
      for (let j = 0; j < rows[row]!.length; j++) rows[row]![j] = subtractRational(rows[row]![j]!, multiplyRational(factor, rows[pivotRow]![j]!));
      trace.push({ pivotRow, pivotColumn: column, operation: "eliminate", row, factor: formatRational(factor) });
    }
    pivots.push(column); pivotRow++;
  }
  return { matrix: rows, rank: pivots.length, pivots, trace };
}

function transpose(input: SpanRational[][]): SpanRational[][] {
  return Array.from({ length: input[0]?.length ?? 0 }, (_, column) => input.map((row) => row[column]!));
}
function concatRows(left: SpanRational[][], right: SpanRational[][]): SpanRational[][] {
  const leftRows = transpose(left), rightRows = transpose(right); return transpose([...leftRows, ...rightRows]);
}
function matrixVector(matrix: SpanRational[][], vector: SpanRational[]): SpanRational[] { return matrix.map((row) => row.reduce((sum, value, i) => addRational(sum, multiplyRational(value, vector[i]!)), rational(0n))); }
function zeroVector(length: number): SpanRational[] { return Array.from({ length }, () => rational(0n)); }

export function findLinearDependency(input: RationalMatrixInput): { dependent: boolean; coefficients?: string[]; pivotTrace: PivotTrace[] } | null {
  const matrix = parseMatrix(input); if (!matrix) return null;
  const columns = transpose(matrix); const reduced = rref(columns);
  if (!reduced) return null;
  if (reduced.rank === matrix.length) return { dependent: false, pivotTrace: reduced.trace };
  const vectorCount = matrix.length;
  const free = Array.from({ length: vectorCount }, (_, i) => i).find((i) => !reduced.pivots.includes(i));
  if (free === undefined) return { dependent: false, pivotTrace: reduced.trace };
  const coefficients = zeroVector(vectorCount); coefficients[free] = rational(1n);
  reduced.pivots.forEach((pivot, row) => { coefficients[pivot] = multiplyRational(rational(-1n), reduced.matrix[row]![free]!); });
  return { dependent: true, coefficients: coefficients.map(formatRational), pivotTrace: reduced.trace };
}

export function verifySubspaceEquality(referenceInput: RationalMatrixInput, studentInput: RationalMatrixInput, options: { basisRequired?: boolean } = {}): SubspaceResult {
  const reference = parseMatrix(referenceInput), student = parseMatrix(studentInput);
  if (!reference || !student || reference[0]!.length !== student[0]!.length) return { status: "unverified", reason: "invalid_matrix", rankReference: 0, rankStudent: 0, rankCombined: 0, pivotTrace: [] };
  const refRref = rref(transpose(reference)), studentRref = rref(transpose(student)), combined = rref(concatRows(reference, student));
  if (!refRref || !studentRref || !combined) return { status: "unverified", reason: "invalid_matrix", rankReference: 0, rankStudent: 0, rankCombined: 0, pivotTrace: [] };
  const dependency = options.basisRequired && student.length > studentRref.rank ? findLinearDependency(student)?.coefficients : undefined;
  const equal = refRref.rank === studentRref.rank && studentRref.rank === combined.rank && (!options.basisRequired || student.length === studentRref.rank);
  return { status: equal ? "equivalent" : "inequivalent", reason: equal ? "rank_and_span_verified" : options.basisRequired && student.length !== studentRref.rank ? "student_vectors_dependent" : "rank_or_span_mismatch", rankReference: refRref.rank, rankStudent: studentRref.rank, rankCombined: combined.rank, pivotTrace: [...refRref.trace, ...studentRref.trace, ...combined.trace], dependency };
}

export function verifySubspaceBasis(reference: RationalMatrixInput, student: RationalMatrixInput): SubspaceResult { return verifySubspaceEquality(reference, student, { basisRequired: true }); }

export type NullspaceResult = VerificationResult & { rank: number; nullity: number; pivotTrace: PivotTrace[]; basis?: string[][] };
export function verifyNullspace(matrixInput: RationalMatrixInput, basisInput: RationalMatrixInput): NullspaceResult {
  const matrix = parseMatrix(matrixInput), basis = parseMatrix(basisInput);
  if (!matrix || !basis || basis[0]!.length !== matrix[0]!.length) return { status: "unverified", reason: "invalid_matrix", rank: 0, nullity: 0, pivotTrace: [] };
  const reduced = rref(matrix); if (!reduced) return { status: "unverified", reason: "invalid_matrix", rank: 0, nullity: 0, pivotTrace: [] };
  const vectors = basis; const products = vectors.map((vector) => matrixVector(matrix, vector));
  const nullity = matrix[0]!.length - reduced.rank;
  const valid = products.every((product) => product.every((entry) => entry.n === 0n)) && basis.length === nullity && (rref(vectors)?.rank ?? -1) === nullity;
  return { status: valid ? "equivalent" : "inequivalent", reason: valid ? "nullspace_and_rank_nullity_verified" : "nullspace_dimension_or_equation_mismatch", rank: reduced.rank, nullity, pivotTrace: reduced.trace, basis: basis.map((row) => row.map(formatRational)) };
}

export type EigenspaceInput = { matrix: RationalMatrixInput; eigenvalue: string | number | bigint | SpanRational; vectors: RationalMatrixInput };
export function verifyEigenspace(input: EigenspaceInput): VerificationResult & { pivotTrace: PivotTrace[] } {
  const matrix = parseMatrix(input.matrix), vectors = parseMatrix(input.vectors), eigenvalue = toRational(input.eigenvalue);
  if (!matrix || !vectors || !eigenvalue || matrix.length !== matrix[0]!.length || vectors[0]!.length !== matrix.length) return { status: "unverified", reason: "invalid_eigenspace_input", pivotTrace: [] };
  const shifted = matrix.map((row, i) => row.map((value, j) => i === j ? subtractRational(value, eigenvalue) : value));
  const products = vectors.map((vector) => matrixVector(shifted, vector));
  const valid = vectors.every((vector, i) => vector.some((entry) => entry.n !== 0n) && products[i]!.every((entry) => entry.n === 0n));
  return { status: valid ? "equivalent" : "inequivalent", reason: valid ? "eigenvector_equations_verified" : "zero_or_non_eigenvector", pivotTrace: rref(shifted)?.trace ?? [] };
}
export const verifySubspace = verifySubspaceEquality;
export const checkNullspace = verifyNullspace;
export const checkEigenspace = verifyEigenspace;
export const checkSubspaceEquality = verifySubspaceEquality;
