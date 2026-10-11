/**
 * V2-15 teaching math model — pure parse / caps / apply / step / text-alt.
 * No DOM, no provider I/O. Aligns with contracts teaching-math-model (Data).
 */
import {
  MATRIX_TRANSFORM_DISPLAY_DECIMALS,
  MATRIX_TRANSFORM_MAX_ABS,
  MATRIX_TRANSFORM_MAX_DIM,
  matrixTransformInteractionParamsSchema,
  matrixTransformParamsSchema,
  type Matrix,
  type MatrixTransformInteractionParams,
  type MatrixTransformParams,
  type MatrixTransformStepMode,
} from "@aistudy/contracts";

export {
  MATRIX_TRANSFORM_DISPLAY_DECIMALS,
  MATRIX_TRANSFORM_MAX_ABS,
  MATRIX_TRANSFORM_MAX_DIM,
};
export type {
  Matrix,
  MatrixTransformInteractionParams,
  MatrixTransformParams,
  MatrixTransformStepMode,
};

export type ParseMatrixTransformResult =
  | { ok: true; value: MatrixTransformParams }
  | { ok: false; errors: string[] };

export type MatrixTransformStep = {
  index: number;
  kind: "column" | "entry" | "result";
  /** Column index for by_column / by_entry. */
  col?: number;
  /** Row index for by_entry. */
  row?: number;
  /** Running / final output vector after this step. */
  partialY: number[];
  label: string;
};

export type StaticFallbackModel = {
  rowsA: string[][];
  rowX: string[];
  rowY: string[];
  prose: string;
  title?: string;
  expression?: string;
  labelA: string;
  labelX: string;
  labelY: string;
};

function zodIssuesToMessages(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
}

/** Parse + cap + dim-check via contracts schema. */
export function parseMatrixTransformParams(
  raw: unknown,
): ParseMatrixTransformResult {
  const result = matrixTransformParamsSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: zodIssuesToMessages(result.error) };
  }
  return { ok: true, value: result.data };
}

/** Soft parse of checkpoint interactionParams[blockId] — empty default OK. */
export function parseMatrixTransformInteractionParams(
  raw: unknown,
): MatrixTransformInteractionParams {
  const result = matrixTransformInteractionParamsSchema.safeParse(raw ?? {});
  if (!result.success) return {};
  return result.data;
}

export function dimsCompatible(A: number[][], x: number[]): boolean {
  if (!Array.isArray(A) || A.length === 0) return false;
  const cols = A[0]?.length ?? 0;
  if (cols === 0) return false;
  for (const row of A) {
    if (!Array.isArray(row) || row.length !== cols) return false;
  }
  return Array.isArray(x) && x.length === cols;
}

/**
 * Apply linear map y = A·x. Returns err string on mismatch; never invents dims.
 */
export function applyMap(
  A: number[][],
  x: number[],
): { ok: true; y: number[] } | { ok: false; error: string } {
  if (!dimsCompatible(A, x)) {
    const cols = A[0]?.length ?? 0;
    return {
      ok: false,
      error: `dim mismatch: cols(A)=${cols}, len(x)=${Array.isArray(x) ? x.length : "n/a"}`,
    };
  }
  const y: number[] = [];
  for (let i = 0; i < A.length; i++) {
    let sum = 0;
    const row = A[i]!;
    for (let j = 0; j < row.length; j++) {
      sum += row[j]! * x[j]!;
    }
    y.push(sum);
  }
  return { ok: true, y };
}

/** Alias — Plan sketch name applyLinearMap. */
export function applyLinearMap(
  A: number[][],
  x: number[],
): { ok: true; y: number[] } | { ok: false; error: string } {
  return applyMap(A, x);
}

/** Resolve output vector: explicit vectorY if present, else A·x. */
export function resolveOutputVector(
  params: MatrixTransformParams,
): { ok: true; y: number[] } | { ok: false; error: string } {
  if (params.vectorY !== undefined) {
    return { ok: true, y: [...params.vectorY] };
  }
  return applyMap(params.matrixA, params.vectorX);
}

function roundDisplay(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const factor = 10 ** MATRIX_TRANSFORM_DISPLAY_DECIMALS;
  const rounded = Math.round(n * factor) / factor;
  // Trim trailing zeros while keeping integer look stable.
  let s = rounded.toFixed(MATRIX_TRANSFORM_DISPLAY_DECIMALS);
  if (s.includes(".")) {
    s = s.replace(/\.?0+$/, "");
  }
  return s === "-0" ? "0" : s;
}

export function formatMatrixCells(A: number[][]): string[][] {
  return A.map((row) => row.map((cell) => roundDisplay(cell)));
}

export function formatVectorCells(v: number[]): string[] {
  return v.map((cell) => roundDisplay(cell));
}

/**
 * Discrete step plan for UI stepper (not a free animator).
 * by_column: one step per column contribution + final result
 * by_entry: one step per A[i][j]*x[j] accumulation + final
 * all_at_once: single result step
 */
export function stepPlan(params: MatrixTransformParams): MatrixTransformStep[] {
  const A = params.matrixA;
  const x = params.vectorX;
  const applied = applyMap(A, x);
  const finalY = applied.ok
    ? applied.y
    : Array.from({ length: A.length }, () => 0);
  const mode = params.stepMode;
  const steps: MatrixTransformStep[] = [];

  if (mode === "all_at_once") {
    steps.push({
      index: 0,
      kind: "result",
      partialY: [...finalY],
      label: "Apply A·x",
    });
    return steps;
  }

  const cols = A[0]?.length ?? 0;
  const rows = A.length;
  const acc = Array.from({ length: rows }, () => 0);

  if (mode === "by_column") {
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < rows; i++) {
        acc[i]! += A[i]![j]! * x[j]!;
      }
      steps.push({
        index: steps.length,
        kind: "column",
        col: j,
        partialY: [...acc],
        label: `Column ${j}: accumulate A[:,${j}]·x[${j}]`,
      });
    }
  } else {
    // by_entry
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < rows; i++) {
        acc[i]! += A[i]![j]! * x[j]!;
        steps.push({
          index: steps.length,
          kind: "entry",
          row: i,
          col: j,
          partialY: [...acc],
          label: `Entry (${i},${j}): + A[${i}][${j}]·x[${j}]`,
        });
      }
    }
  }

  steps.push({
    index: steps.length,
    kind: "result",
    partialY: [...finalY],
    label: "Result y = A·x",
  });
  return steps;
}

/** Advance one step; clamps index. Idempotent reset → index 0. */
export function stepApply(
  params: MatrixTransformParams,
  stepIndex: number,
): { stepIndex: number; step: MatrixTransformStep | null; steps: MatrixTransformStep[] } {
  const steps = stepPlan(params);
  if (steps.length === 0) {
    return { stepIndex: 0, step: null, steps };
  }
  const idx = Math.max(0, Math.min(stepIndex, steps.length - 1));
  return { stepIndex: idx, step: steps[idx]!, steps };
}

export function buildTextAlternative(params: MatrixTransformParams): string {
  const labelA = params.labelA ?? "A";
  const labelX = params.labelX ?? "x";
  const labelY = params.labelY ?? "y";
  const yResult = resolveOutputVector(params);
  const y = yResult.ok ? yResult.y : [];
  const lines: string[] = [];
  if (params.title) lines.push(params.title);
  if (params.expression) lines.push(params.expression);
  lines.push(`${labelA} =`);
  for (const row of formatMatrixCells(params.matrixA)) {
    lines.push(`  [ ${row.join("  ")} ]`);
  }
  lines.push(`${labelX} = [ ${formatVectorCells(params.vectorX).join("  ")} ]`);
  lines.push(`${labelY} = [ ${formatVectorCells(y).join("  ")} ]`);
  if (params.prose) lines.push(params.prose);
  return lines.join("\n");
}

export function staticFallbackModel(
  params: MatrixTransformParams,
): StaticFallbackModel {
  const labelA = params.labelA ?? "A";
  const labelX = params.labelX ?? "x";
  const labelY = params.labelY ?? "y";
  const yResult = resolveOutputVector(params);
  const y = yResult.ok ? yResult.y : Array.from({ length: params.matrixA.length }, () => 0);
  return {
    rowsA: formatMatrixCells(params.matrixA),
    rowX: formatVectorCells(params.vectorX),
    rowY: formatVectorCells(y),
    prose: params.prose ?? buildTextAlternative(params),
    title: params.title,
    expression: params.expression,
    labelA,
    labelX,
    labelY,
  };
}

/** Caps helpers for callers that check without full parse. */
export function withinDimCaps(rows: number, cols: number): boolean {
  return (
    rows >= 1 &&
    cols >= 1 &&
    rows <= MATRIX_TRANSFORM_MAX_DIM &&
    cols <= MATRIX_TRANSFORM_MAX_DIM
  );
}

export function withinAbsCap(n: number): boolean {
  return Number.isFinite(n) && Math.abs(n) <= MATRIX_TRANSFORM_MAX_ABS;
}
