import { describe, expect, it } from "vitest";
import {
  MATRIX_TRANSFORM_MAX_ABS,
  MATRIX_TRANSFORM_MAX_DIM,
  matrixTransformInteractionParamsSchema,
  matrixTransformParamsSchema,
} from "./teaching-math-model";

describe("teaching-math-model contracts (T10)", () => {
  it("round-trips well-formed 2×2 + vector; applies defaults", () => {
    const parsed = matrixTransformParamsSchema.parse({
      matrixA: [
        [1, 0],
        [0, 1],
      ],
      vectorX: [3, -2],
      labelA: "A",
      labelX: "x",
      expression: "y = Ax",
    });
    expect(parsed.version).toBe(1);
    expect(parsed.stepMode).toBe("by_column");
    expect(parsed.autoplay).toBe(false);
    expect(parsed.matrixA).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(parsed.vectorX).toEqual([3, -2]);
    expect(parsed.expression).toBe("y = Ax");
  });

  it("strict() strips / rejects unknown keys", () => {
    const result = matrixTransformParamsSchema.safeParse({
      matrixA: [[1]],
      vectorX: [1],
      inventAnimator: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-rectangular matrix", () => {
    const result = matrixTransformParamsSchema.safeParse({
      matrixA: [
        [1, 2],
        [3],
      ],
      vectorX: [1, 0],
    });
    expect(result.success).toBe(false);
  });

  it("rejects dim mismatch cols(A) ≠ len(x)", () => {
    const result = matrixTransformParamsSchema.safeParse({
      matrixA: [
        [1, 0],
        [0, 1],
      ],
      vectorX: [1],
    });
    expect(result.success).toBe(false);
  });

  it("rejects over-cap dimension (> MAX_DIM)", () => {
    const row = Array.from({ length: MATRIX_TRANSFORM_MAX_DIM + 1 }, () => 0);
    const big = Array.from({ length: MATRIX_TRANSFORM_MAX_DIM + 1 }, () => [
      ...row,
    ]);
    const result = matrixTransformParamsSchema.safeParse({
      matrixA: big,
      vectorX: row,
    });
    expect(result.success).toBe(false);
  });

  it("rejects abs > MAX_ABS", () => {
    const result = matrixTransformParamsSchema.safeParse({
      matrixA: [[MATRIX_TRANSFORM_MAX_ABS + 1]],
      vectorX: [1],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-finite (NaN / Infinity) and non-number", () => {
    expect(
      matrixTransformParamsSchema.safeParse({
        matrixA: [[Number.NaN]],
        vectorX: [1],
      }).success,
    ).toBe(false);
    expect(
      matrixTransformParamsSchema.safeParse({
        matrixA: [[Number.POSITIVE_INFINITY]],
        vectorX: [1],
      }).success,
    ).toBe(false);
    expect(
      matrixTransformParamsSchema.safeParse({
        matrixA: [["1" as unknown as number]],
        vectorX: [1],
      }).success,
    ).toBe(false);
  });

  it("soft interactionParams sketch accepts partial / empty", () => {
    expect(matrixTransformInteractionParamsSchema.parse({})).toEqual({});
    expect(
      matrixTransformInteractionParamsSchema.parse({
        paused: true,
        stepIndex: 2,
        showTextAlt: false,
      }),
    ).toEqual({ paused: true, stepIndex: 2, showTextAlt: false });
    expect(
      matrixTransformInteractionParamsSchema.safeParse({
        paused: true,
        evil: 1,
      }).success,
    ).toBe(false);
  });
});
