import type { SpanProblem } from "@aistudy/contracts";

export const SPAN_SKILL_LABEL = "线性组合与 span";
export const SPAN_REQUIREMENT_KEY = "span:linear-combination:v1";
export const SPAN_KNOWLEDGE_COMPONENTS = ["span:vector-equation", "span:solve-coefficients", "span:check-all-coordinates"] as const;
/** Teaching content only. This module deliberately does not import the reserved bank. */
const teachingProblems: readonly SpanProblem[] = [
  { id: "span-example-2d", version: "1", familyId: "span:independent-2d", vectors: [["1", "0"], ["0", "2"]], target: ["3", "-1"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-faded-3d", version: "1", familyId: "span:consistent-3d", vectors: [["1", "0", "1"], ["0", "1", "1"]], target: ["2", "-1", "1"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-independent-3d", version: "1", familyId: "span:inconsistent-3d", vectors: [["1", "1", "0"], ["0", "1", "1"]], target: ["2", "3", "2"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS] },
  { id: "span-contrast-dependent", version: "1", familyId: "span:dependent-generators", vectors: [["1", "-2"], ["-2", "4"]], target: ["3", "-6"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS], transfer: { fromFamilyId: "span:independent-2d", changes: ["生成向量线性相关；从唯一解变为多个系数表示"] } },
  { id: "span-geometry-transfer", version: "1", familyId: "span:geometry-plane", vectors: [["1", "0", "1"], ["0", "1", "1"]], target: ["1", "2", "4"], knowledgeComponents: [...SPAN_KNOWLEDGE_COMPONENTS, "linear-system:consistency", "geometry:plane-equation"], transfer: { fromFamilyId: "span:consistent-3d", changes: ["从求系数转为解释平面约束 z=x+y，说明目标为何不在平面上；文字解释需另行核对"] } },
];
export function listSpanTeachingProblems(): SpanProblem[] {
  return teachingProblems.map(copyProblem);
}
export function copyProblem(problem: SpanProblem): SpanProblem {
  return { ...problem, vectors: [[...problem.vectors[0]], [...problem.vectors[1]]], target: [...problem.target], knowledgeComponents: [...problem.knowledgeComponents], ...(problem.transfer ? { transfer: { fromFamilyId: problem.transfer.fromFamilyId, changes: [...problem.transfer.changes] } } : {}) };
}
/** Server resolves an immutable identity; callers never supply their own operands. */
export function getSpanProblem(id: string, version: string | number = "1"): SpanProblem | null {
  const problem = teachingProblems.find((candidate) => candidate.id === id && candidate.version === String(version));
  return problem ? copyProblem(problem) : null;
}
export function spanProblemStem(problem: SpanProblem): string {
  const vector = (entries: string[]) => `(${entries.join(", ")})`;
  return `给定 v=${vector(problem.vectors[0])}，w=${vector(problem.vectors[1])}，u=${vector(problem.target)}。判断 u 是否属于 span{v,w}。若属于，请给出满足 αv+βw=u 的任意一组系数，并检查全部坐标；若不属于，请说明方程组为何不相容。`;
}
