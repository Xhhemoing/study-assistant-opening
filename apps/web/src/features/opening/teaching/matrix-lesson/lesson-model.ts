import { applyMap } from "@aistudy/domain";
import type { LearningSummary } from "@aistudy/contracts";

export type PlaneVector = readonly [number, number];
export type PlaneMatrix = readonly [PlaneVector, PlaneVector];
export const OBSERVATION_MATRIX: PlaneMatrix = [[2, 1], [0, 1]];
export const CHALLENGE_MATRIX: PlaneMatrix = [[1, -1], [2, 0]];
export const CHALLENGE_VECTOR: PlaneVector = [2, 1];
export const MATRIX_LESSON_SECTIONS = ["观察", "建立关系", "自己尝试", "对照反馈", "回顾与迁移"] as const;
export const MATRIX_LESSON_REQUIREMENT = "matrix:matrix-arithmetic-v1:multiplication";
export const PLANE_PRESETS: ReadonlyArray<{ label: string; matrix: PlaneMatrix }> = [
  { label: "先看这个：拉伸再错切", matrix: OBSERVATION_MATRIX },
  { label: "保持原样", matrix: [[1, 0], [0, 1]] },
  { label: "逆时针转 90°", matrix: [[0, -1], [1, 0]] },
  { label: "压到一条线上", matrix: [[1, 1], [0, 0]] },
];

/** Geometry and displayed arithmetic use the same domain operation as matrix_transform. */
export function transformPlaneVector(matrix: PlaneMatrix, vector: PlaneVector): PlaneVector {
  const result = applyMap(matrix.map(row => [...row]), [...vector]);
  if (!result.ok || result.y.length !== 2) throw new Error("二维矩阵参数不匹配");
  return [result.y[0]!, result.y[1]!];
}
export function planeDecomposition(matrix: PlaneMatrix, vector: PlaneVector) {
  const first = transformPlaneVector(matrix, [vector[0], 0]);
  const second = transformPlaneVector(matrix, [0, vector[1]]);
  return { first, second, result: transformPlaneVector(matrix, vector) };
}
export const vectorText = (vector: PlaneVector) => `(${vector[0]}, ${vector[1]})`;
export const matrixText = (matrix: PlaneMatrix) => `[[${matrix[0].join(", ")}], [${matrix[1].join(", ")}]]`;

export function matrixLessonPracticeStatus(rows: readonly LearningSummary[]): string {
  const matching = rows.filter(row => row.requirementKey === MATRIX_LESSON_REQUIREMENT);
  if (!matching.length) return "尚未读到本课程的内置矩阵乘法记录。";
  const count = matching.reduce((sum, row) => sum + row.sampleCount, 0);
  const statuses = new Set(matching.map(row => row.status));
  if (statuses.has("needs_review")) return `已有 ${count} 条矩阵乘法记录，其中有待复查的表现。`;
  if (statuses.has("needs_check")) return `已有 ${count} 条矩阵乘法记录，其中有待核对的答案。`;
  if (statuses.has("observed_independent")) return `已有 ${count} 条矩阵乘法记录，包含独立作答；这仍不等于稳固掌握或已完成延迟复测。`;
  return "已读到矩阵乘法主题，尚无可据此判断掌握的有效作答证据。";
}
