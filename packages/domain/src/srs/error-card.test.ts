import { expect, it } from "vitest";
import { createMatrixExerciseSpec, evaluateMatrixAnswer } from "../opening/evaluation/matrix-evaluator";
import { matrixErrorCardReference } from "./error-card";
it.each(["dimensions", "addition", "scalar", "multiplication"] as const)("derives a valid reference for canonical %s exercises", key => {
  for (let variant = 0; variant <= 8; variant++) {
    const spec = createMatrixExerciseSpec(key, variant), text = matrixErrorCardReference(spec)!;
    expect(evaluateMatrixAnswer(spec, text.split("答案：")[1]!).outcome).toBe("correct");
  }
});
it("rejects an altered catalogue spec", () => {
  expect(matrixErrorCardReference({ ...createMatrixExerciseSpec("dimensions"), matrixA: [[900]] })).toBeNull();
});
