import { addRational, divideRational, equalRational, multiplyRational, rational, subtractRational, type SpanRational } from "../opening/span-rational";
import { formatRational, toRational, type VerificationResult } from "./types";

export type RationalMatrixInput = readonly (readonly (string | number | bigint | SpanRational)[])[];
export type PivotTrace = { pivotRow: number; pivotColumn: number; operation: "swap" | "scale" | "eliminate"; row?: number; factor?: string };
export type RrefResult = { matrix: SpanRational[][]; rank: number; pivots: number[]; trace: PivotTrace[] };
export type SubspaceResult = VerificationResult & { rankReference: number; rankStudent: number; rankCombined: number; pivotTrace: PivotTrace[]; dependency?: string[] };

const MAX_MATRIX_DIM = 32;

function parseMatrix(input: RationalMatrixInput, options: { allowEmpty?: boolean } = {}): SpanRational[][] | null {
  if (!Array.isArray(input) || input.length > MAX_MATRIX_DIM) return null;
  if (input.length === 0) return options.allowEmpty ? [] : null;
  const rows: SpanRational[][] = [];
  for (const rawRow of input) {
    if (!Array.isArray(rawRow) || rawRow.length === 0 || rawRow.length > MAX_MATRIX_DIM) return null;
    const parsedRow: SpanRational[] = [];
    for (const entry of rawRow) {
      const q = toRational(entry);
      if (!q) return null;
      parsedRow.push(q);
    }
    rows.push(parsedRow);
  }
  const width = rows[0]!.length;
  return rows.every((row) => row.length === width) ? rows : null;
}

function rrefParsed(inputRows: readonly (readonly SpanRational[])[]): RrefResult {
  if (inputRows.length === 0) return { matrix: [], rank: 0, pivots: [], trace: [] };
  const rows = inputRows.map((row) => row.map((cell) => rational(cell.n, cell.d)));
  const width = rows[0]!.length;
  const trace: PivotTrace[] = [];
  const pivots: number[] = [];
  let pivotRow = 0;
  for (let column = 0; column < width && pivotRow < rows.length; column++) {
    const candidate = rows.findIndex((row, index) => index >= pivotRow && row[column]!.n !== 0n);
    if (candidate < 0) continue;
    if (candidate !== pivotRow) {
      [rows[candidate], rows[pivotRow]] = [rows[pivotRow]!, rows[candidate]!];
      trace.push({ pivotRow, pivotColumn: column, operation: "swap", row: candidate });
    }
    const pivot = rows[pivotRow]![column]!;
    if (!equalRational(pivot, rational(1n))) {
      for (let j = 0; j < width; j++) rows[pivotRow]![j] = divideRational(rows[pivotRow]![j]!, pivot);
      trace.push({ pivotRow, pivotColumn: column, operation: "scale", factor: formatRational(divideRational(rational(1n), pivot)) });
    }
    for (let row = 0; row < rows.length; row++) {
      if (row === pivotRow) continue;
      const factor = rows[row]![column]!;
      if (factor.n === 0n) continue;
      for (let j = 0; j < width; j++) rows[row]![j] = subtractRational(rows[row]![j]!, multiplyRational(factor, rows[pivotRow]![j]!));
      trace.push({ pivotRow, pivotColumn: column, operation: "eliminate", row, factor: formatRational(factor) });
    }
    pivots.push(column);
    pivotRow++;
  }
  return { matrix: rows, rank: pivots.length, pivots, trace };
}

export function rref(input: RationalMatrixInput): RrefResult | null {
  const rows = parseMatrix(input);
  return rows ? rrefParsed(rows) : null;
}

function transpose(input: SpanRational[][]): SpanRational[][] {
  return Array.from({ length: input[0]?.length ?? 0 }, (_, column) => input.map((row) => row[column]!));
}

function matrixVector(matrix: SpanRational[][], vector: SpanRational[]): SpanRational[] {
  return matrix.map((row) => row.reduce((sum, value, i) => addRational(sum, multiplyRational(value, vector[i]!)), rational(0n)));
}

function zeroVector(length: number): SpanRational[] {
  return Array.from({ length }, () => rational(0n));
}

function isZeroVector(vector: readonly SpanRational[]): boolean {
  return vector.every((entry) => entry.n === 0n);
}

export function findLinearDependency(input: RationalMatrixInput): { dependent: boolean; coefficients?: string[]; pivotTrace: PivotTrace[] } | null {
  const matrix = parseMatrix(input, { allowEmpty: true });
  if (!matrix) return null;
  if (matrix.length === 0) return { dependent: false, pivotTrace: [] };
  const columns = transpose(matrix);
  const reduced = rrefParsed(columns);
  if (reduced.rank === matrix.length) return { dependent: false, pivotTrace: reduced.trace };
  const vectorCount = matrix.length;
  const free = Array.from({ length: vectorCount }, (_, i) => i).find((i) => !reduced.pivots.includes(i));
  if (free === undefined) return { dependent: false, pivotTrace: reduced.trace };
  const coefficients = zeroVector(vectorCount);
  coefficients[free] = rational(1n);
  reduced.pivots.forEach((pivot, row) => {
    coefficients[pivot] = multiplyRational(rational(-1n), reduced.matrix[row]![free]!);
  });
  return { dependent: true, coefficients: coefficients.map(formatRational), pivotTrace: reduced.trace };
}

export function verifySubspaceEquality(
  referenceInput: RationalMatrixInput,
  studentInput: RationalMatrixInput,
  options: { basisRequired?: boolean } = {},
): SubspaceResult {
  const reference = parseMatrix(referenceInput, { allowEmpty: true });
  const student = parseMatrix(studentInput, { allowEmpty: true });
  if (!reference || !student || (reference.length > 0 && student.length > 0 && reference[0]!.length !== student[0]!.length)) {
    return { status: "unverified", reason: "invalid_matrix", rankReference: 0, rankStudent: 0, rankCombined: 0, pivotTrace: [] };
  }
  const refRref = rrefParsed(reference);
  const studentRref = rrefParsed(student);
  const combined = rrefParsed([...reference, ...student]);
  const dependency = options.basisRequired && student.length > studentRref.rank ? findLinearDependency(studentInput)?.coefficients : undefined;
  const equal =
    refRref.rank === studentRref.rank &&
    studentRref.rank === combined.rank &&
    (!options.basisRequired || student.length === studentRref.rank);
  return {
    status: equal ? "equivalent" : "inequivalent",
    reason: equal
      ? "rank_and_span_verified"
      : options.basisRequired && student.length !== studentRref.rank
        ? "student_vectors_dependent"
        : "rank_or_span_mismatch",
    rankReference: refRref.rank,
    rankStudent: studentRref.rank,
    rankCombined: combined.rank,
    pivotTrace: [...refRref.trace, ...studentRref.trace, ...combined.trace],
    dependency,
  };
}

export function verifySubspaceBasis(reference: RationalMatrixInput, student: RationalMatrixInput): SubspaceResult {
  return verifySubspaceEquality(reference, student, { basisRequired: true });
}

export type NullspaceResult = VerificationResult & { rank: number; nullity: number; pivotTrace: PivotTrace[]; basis?: string[][] };
export function verifyNullspace(matrixInput: RationalMatrixInput, basisInput: RationalMatrixInput): NullspaceResult {
  const matrix = parseMatrix(matrixInput);
  const basis = parseMatrix(basisInput, { allowEmpty: true });
  if (!matrix || !basis || (basis.length > 0 && basis[0]!.length !== matrix[0]!.length)) {
    return { status: "unverified", reason: "invalid_matrix", rank: 0, nullity: 0, pivotTrace: [] };
  }
  const reduced = rrefParsed(matrix);
  const nullity = matrix[0]!.length - reduced.rank;
  const products = basis.map((vector) => matrixVector(matrix, vector));
  const inKernel = products.every((product) => product.every((entry) => entry.n === 0n));
  const basisRank = rrefParsed(basis).rank;
  const valid =
    nullity === 0
      ? inKernel && basisRank === 0 && (basis.length === 0 || (basis.length === 1 && isZeroVector(basis[0]!)))
      : inKernel && basis.length === nullity && basisRank === nullity;
  return {
    status: valid ? "equivalent" : "inequivalent",
    reason: valid ? "nullspace_and_rank_nullity_verified" : "nullspace_dimension_or_equation_mismatch",
    rank: reduced.rank,
    nullity,
    pivotTrace: reduced.trace,
    basis: basis.map((row) => row.map(formatRational)),
  };
}

export type EigenspaceInput = { matrix: RationalMatrixInput; eigenvalue: string | number | bigint | SpanRational; vectors: RationalMatrixInput };
export function verifyEigenspace(input: EigenspaceInput): VerificationResult & { pivotTrace: PivotTrace[] } {
  const matrix = parseMatrix(input.matrix);
  const vectors = parseMatrix(input.vectors, { allowEmpty: true });
  const eigenvalue = toRational(input.eigenvalue);
  if (
    !matrix ||
    !vectors ||
    !eigenvalue ||
    matrix.length !== matrix[0]!.length ||
    (vectors.length > 0 && vectors[0]!.length !== matrix.length)
  ) {
    return { status: "unverified", reason: "invalid_eigenspace_input", pivotTrace: [] };
  }
  const n = matrix.length;
  const shifted = matrix.map((row, i) => row.map((value, j) => (i === j ? subtractRational(value, eigenvalue) : value)));
  const shiftedRref = rrefParsed(shifted);
  const geometricMultiplicity = n - shiftedRref.rank;
  if (geometricMultiplicity < 1) {
    return { status: "inequivalent", reason: "not_an_eigenvalue", pivotTrace: shiftedRref.trace };
  }
  if (vectors.length === 0) {
    return { status: "inequivalent", reason: "incomplete_eigenspace", pivotTrace: shiftedRref.trace };
  }
  const products = vectors.map((vector) => matrixVector(shifted, vector));
  const allEigenvectors = vectors.every((vector, i) => !isZeroVector(vector) && products[i]!.every((entry) => entry.n === 0n));
  if (!allEigenvectors) {
    return { status: "inequivalent", reason: "zero_or_non_eigenvector", pivotTrace: shiftedRref.trace };
  }
  const vecRref = rrefParsed(vectors);
  if (vecRref.rank !== vectors.length) {
    return { status: "inequivalent", reason: "dependent_eigenvectors", pivotTrace: shiftedRref.trace };
  }
  if (vecRref.rank !== geometricMultiplicity) {
    return { status: "inequivalent", reason: "incomplete_eigenspace", pivotTrace: shiftedRref.trace };
  }
  return { status: "equivalent", reason: "eigenspace_basis_verified", pivotTrace: shiftedRref.trace };
}

export const verifySubspace = verifySubspaceEquality;
export const checkNullspace = verifyNullspace;
export const checkEigenspace = verifyEigenspace;
export const checkSubspaceEquality = verifySubspaceEquality;
