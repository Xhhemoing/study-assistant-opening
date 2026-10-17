import { expect, it } from "vitest";
import { createMatrixExerciseSpec, evaluateMatrixAnswer, matrixExerciseRequirement, parseCanonicalMatrixExercise } from "./matrix-evaluator";

it.each([
  ["dimensions", "[2,3]"],
  ["addition", "[[3,2],[2,4]]"],
  ["scalar", '[["1/2",-1],["3/2",0]]'],
  ["multiplication", "[[-3,0],[3,7]]"],
] as const)("correctly evaluates the independently hand-calculated %s fixture", (key, answer) => {
  expect(evaluateMatrixAnswer(createMatrixExerciseSpec(key), answer)).toMatchObject({ decision: "correct", outcome: "correct" });
});
it("accepts exact equivalent fractions, signs, whitespace and numeric zero", () => {
  expect(evaluateMatrixAnswer(createMatrixExerciseSpec("scalar"), ' [ ["2/4", "1/-1"], ["-3/-2", 0] ] ')).toMatchObject({ decision: "correct" });
});
it("separates an understood wrong answer from unsupported input", () => {
  expect(evaluateMatrixAnswer(createMatrixExerciseSpec("multiplication"), "[[3,0],[3,7]]").decision).toBe("incorrect");
  expect(evaluateMatrixAnswer(createMatrixExerciseSpec("addition"), "[[3,2,0],[2,4,0]]")).toMatchObject({ decision: "incorrect", reasonCodes: ["matrix_shape_mismatch"] });
  expect(evaluateMatrixAnswer(createMatrixExerciseSpec("dimensions"), "[3,2]").decision).toBe("incorrect");
});
it.each(["", "1+2", "[[1/2]]", '[["1/0"]]', "[[0.5]]", "[[1e999]]", "[[1],[2,3]]", "{}", "null", '[["Infinity"]]', "[[1000001]]", '[["123456789/1"]]', "[[0,0,0,0,0]]", '["2","3"]'])(
  "abstains on unsupported or ambiguous answer %s", answer => {
    expect(evaluateMatrixAnswer(createMatrixExerciseSpec("scalar"), answer)).toMatchObject({ decision: "abstain", outcome: "unverified" });
  });
it("rejects altered operands, missing specs, unknown versions and oversized answers", () => {
  const spec = createMatrixExerciseSpec("addition");
  expect(parseCanonicalMatrixExercise(spec)).toEqual(spec);
  expect(evaluateMatrixAnswer({ ...spec, matrixA: [[0]] }, "[[0]]").decision).toBe("abstain");
  expect(evaluateMatrixAnswer({ ...spec, specVersion: "unreviewed-v2" }, "[]").decision).toBe("abstain");
  expect(evaluateMatrixAnswer(null, "[]").decision).toBe("abstain");
  expect(evaluateMatrixAnswer(spec, " ".repeat(2001)).reasonCodes).toEqual(["resource_limit"]);
});
it("keeps catalogue variants finite and requirement identity consistent across variants", () => {
  const specs = Array.from({ length: 9 }, (_, variant) => createMatrixExerciseSpec("multiplication", variant));
  expect(new Set(specs.map(spec => JSON.stringify(spec.matrixA))).size).toBe(9);
  expect(new Set(specs.map(matrixExerciseRequirement)).size).toBe(1);
  expect(() => createMatrixExerciseSpec("multiplication", -1)).toThrow();
  expect(() => createMatrixExerciseSpec("multiplication", 9)).toThrow();
});
