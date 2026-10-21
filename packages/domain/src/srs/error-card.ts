import { parseCanonicalMatrixExercise } from "../opening/evaluation/matrix-evaluator";
import { addRational, formatSpanRational, multiplyRational, parseSpanRational, rational } from "../opening/span-rational";

/** Derive a reference only from the immutable server catalogue, never from submitted work. */
export function matrixErrorCardReference(rawSpec: unknown): string | null {
  const spec = parseCanonicalMatrixExercise(rawSpec);
  if (!spec) return null;
  if (spec.exerciseKey === "dimensions") return `矩阵有 ${spec.matrixA.length} 行、${spec.matrixA[0]!.length} 列。\n答案：${JSON.stringify([spec.matrixA.length, spec.matrixA[0]!.length])}`;
  const a = spec.matrixA.map(row => row.map(value => parseSpanRational(String(value))!));
  const b = spec.matrixB?.map(row => row.map(value => parseSpanRational(String(value))!));
  const result = spec.exerciseKey === "scalar" ? a.map(row => row.map(cell => multiplyRational(cell, parseSpanRational(spec.scalar)!)))
    : spec.exerciseKey === "addition" ? a.map((row, r) => row.map((cell, c) => addRational(cell, b![r]![c]!)))
      : a.map(row => b![0]!.map((_, c) => row.reduce((sum, cell, k) => addRational(sum, multiplyRational(cell, b![k]![c]!)), rational(0n))));
  const rule = { scalar: "标量乘每一个元素。", addition: "只有形状相同时才可将对应位置相加。", multiplication: "结果每一项等于左矩阵对应行与右矩阵对应列的内积。" }[spec.exerciseKey];
  return `${rule}\n答案：${JSON.stringify(result.map(row => row.map(formatSpanRational)))}`;
}
