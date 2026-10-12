import { describe, expect, it } from "vitest";
import {
  MATRIX_TRANSFORM_MAX_ABS,
  MATRIX_TRANSFORM_MAX_DIM,
  applyMap,
  buildTextAlternative,
  dimsCompatible,
  formatMatrixCells,
  parseMatrixTransformInteractionParams,
  parseMatrixTransformParams,
  staticFallbackModel,
  stepApply,
  stepPlan,
  type MatrixTransformParams,
} from "./teaching-math-model";

function mustParse(raw: unknown): MatrixTransformParams {
  const result = parseMatrixTransformParams(raw);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

describe("teaching-math-model domain", () => {
  it("T1: parse accepts well-formed 2×2 + vector; rejects non-rectangular", () => {
    const ok = parseMatrixTransformParams({
      matrixA: [
        [2, -1],
        [0.5, 3],
      ],
      vectorX: [1, 2],
    });
    expect(ok.ok).toBe(true);

    const bad = parseMatrixTransformParams({
      matrixA: [
        [1, 2, 3],
        [4, 5],
      ],
      vectorX: [1, 2, 3],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/rectangular|length/i);
  });

  it("T2: zero matrix → y = 0 vector", () => {
    const params = mustParse({
      matrixA: [
        [0, 0],
        [0, 0],
      ],
      vectorX: [7, -3],
    });
    const applied = applyMap(params.matrixA, params.vectorX);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.y).toEqual([0, 0]);
  });

  it("T3: identity → y = x", () => {
    const x = [1.5, -2, 0.25];
    const params = mustParse({
      matrixA: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      vectorX: x,
    });
    const applied = applyMap(params.matrixA, params.vectorX);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.y).toEqual(x);
  });

  it("T4: rank-1 A=(1,1;0,0) — kernel → 0; non-kernel → expected", () => {
    const A = [
      [1, 1],
      [0, 0],
    ];
    // Kernel: x + y = 0
    for (let t = -5; t <= 5; t++) {
      const x = [t, -t];
      const applied = applyMap(A, x);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(applied.y).toEqual([0, 0]);
    }
    // Non-kernel
    for (const x of [
      [1, 2],
      [-4, 1],
      [0, 0],
    ] as number[][]) {
      const applied = applyMap(A, x);
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.y).toEqual([1 * x[0]! + 1 * x[1]!, 0]);
      }
    }
  });

  it("T5: negatives / decimals within caps; display rounding stable", () => {
    const params = mustParse({
      matrixA: [
        [-1.5, 0.3333333],
        [2.25, -0.125],
      ],
      vectorX: [-2, 4],
    });
    const applied = applyMap(params.matrixA, params.vectorX);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      // y0 = -1.5*-2 + 0.3333333*4 = 3 + 1.3333332 = 4.3333332
      // y1 = 2.25*-2 + -0.125*4 = -4.5 - 0.5 = -5
      expect(applied.y[0]).toBeCloseTo(4.3333332, 6);
      expect(applied.y[1]).toBeCloseTo(-5, 10);
    }
    const cells = formatMatrixCells(params.matrixA);
    expect(cells[0]![1]).toMatch(/0\.333333/);
    const again = formatMatrixCells(params.matrixA);
    expect(again).toEqual(cells);
  });

  it("T6: dim mismatch (cols(A) ≠ len(x)) → ok:false", () => {
    expect(dimsCompatible([[1, 0], [0, 1]], [1])).toBe(false);
    const parsed = parseMatrixTransformParams({
      matrixA: [
        [1, 0],
        [0, 1],
      ],
      vectorX: [1],
    });
    expect(parsed.ok).toBe(false);

    const applied = applyMap(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      [1, 2],
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.error).toMatch(/dim mismatch/i);
  });

  it("T7: param caps — 5×5 or abs>MAX_ABS → reject", () => {
    const n = MATRIX_TRANSFORM_MAX_DIM + 1;
    const row = Array.from({ length: n }, () => 0);
    const big = Array.from({ length: n }, () => [...row]);
    expect(parseMatrixTransformParams({ matrixA: big, vectorX: row }).ok).toBe(
      false,
    );

    expect(
      parseMatrixTransformParams({
        matrixA: [[MATRIX_TRANSFORM_MAX_ABS + 1]],
        vectorX: [0],
      }).ok,
    ).toBe(false);

    expect(
      parseMatrixTransformParams({
        matrixA: [[1]],
        vectorX: [-(MATRIX_TRANSFORM_MAX_ABS + 1)],
      }).ok,
    ).toBe(false);
  });

  it("T8: expression/labels → buildTextAlternative contains labels + numeric cells", () => {
    const params = mustParse({
      matrixA: [
        [1, 1],
        [0, 0],
      ],
      vectorX: [2, -2],
      labelA: "A",
      labelX: "x",
      labelY: "Ax",
      expression: "y = Ax",
      prose: "Rank-1 map; kernel vectors go to zero.",
      title: "Linear map demo",
    });
    const text = buildTextAlternative(params);
    expect(text).toContain("A");
    expect(text).toContain("x");
    expect(text).toContain("Ax");
    expect(text).toContain("y = Ax");
    expect(text).toContain("1");
    expect(text).toContain("2");
    expect(text).toContain("Linear map demo");
    expect(text).toContain("Rank-1 map");
    // Same params → y = 0
    expect(text).toMatch(/Ax = \[ 0 {2}0 \]/);

    const fallback = staticFallbackModel(params);
    expect(fallback.labelA).toBe("A");
    expect(fallback.expression).toBe("y = Ax");
    expect(fallback.rowY).toEqual(["0", "0"]);
    expect(fallback.rowsA[0]).toEqual(["1", "1"]);
  });

  it("T9: stepPlan length ≥ 1; reset semantics idempotent", () => {
    const params = mustParse({
      matrixA: [
        [1, 2],
        [3, 4],
      ],
      vectorX: [1, 0],
      stepMode: "by_column",
    });
    const steps = stepPlan(params);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[steps.length - 1]!.kind).toBe("result");
    expect(steps[steps.length - 1]!.partialY).toEqual([1, 3]);

    const resetA = stepApply(params, 0);
    const resetB = stepApply(params, 0);
    expect(resetA.stepIndex).toBe(0);
    expect(resetB.stepIndex).toBe(0);
    expect(resetA.step).toEqual(resetB.step);

    const allAtOnce = mustParse({
      matrixA: [[2]],
      vectorX: [5],
      stepMode: "all_at_once",
    });
    expect(stepPlan(allAtOnce)).toHaveLength(1);
    expect(stepPlan(allAtOnce)[0]!.partialY).toEqual([10]);

    const byEntry = mustParse({
      matrixA: [
        [1, 0],
        [0, 1],
      ],
      vectorX: [3, 4],
      stepMode: "by_entry",
    });
    expect(stepPlan(byEntry).length).toBeGreaterThan(1);
  });

  it("autoplay defaults false; soft interaction params empty OK", () => {
    const params = mustParse({
      matrixA: [[1]],
      vectorX: [1],
    });
    expect(params.autoplay).toBe(false);
    expect(parseMatrixTransformInteractionParams(undefined)).toEqual({});
    expect(parseMatrixTransformInteractionParams({ paused: true })).toEqual({
      paused: true,
    });
    expect(
      parseMatrixTransformInteractionParams({ paused: true, junk: 1 }),
    ).toEqual({});
  });
});
