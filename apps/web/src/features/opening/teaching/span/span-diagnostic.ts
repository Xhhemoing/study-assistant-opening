import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { verifySpanAnswer } from "@aistudy/domain";

export type SpanDiagnosticNextStep = { label: string; action: string };

/** Selects one deterministic, answer-preserving next step from the exact span result. */
export function spanDiagnosticNextStep(record: LearningObservation, attempt?: LearningAttempt): SpanDiagnosticNextStep | null {
  const evaluation = record.serverEvaluation;
  if (!attempt?.spanExercise || !evaluation || evaluation.evaluatorVersion !== "span-exact-v1" || evaluation.decision !== "incorrect"
    || attempt.spanValidation?.reasonCode?.startsWith("restored_identity_")) return null;
  const verified = verifySpanAnswer(attempt.spanExercise, record.answer);
  if (verified.outcome === "unknown") return null;
  const firstCoordinate = verified.failedCoordinates[0];
  if (firstCoordinate !== undefined) return { label: "先回到原题重算", action: `第${firstCoordinate + 1}个坐标没对上，请回到原题重算这一坐标。` };
  const labels: Partial<Record<keyof typeof verified.skills, string>> = {
    equation: "向量等式还没对上。请先把系数乘到向量后再相加。",
    coefficients: "系数代入后还没对上。请在原题上重新解出并代回检查。",
    allCoordinates: "逐坐标验算还没完成。请把每个坐标都代回原题检查。",
    noSolutionProof: "无解理由还没写完整。请补上不能同时满足的那一步。",
    geometry: "几何表征还没对上。请先检查所有组合落在哪条直线或平面上。",
    systemConsistency: "方程组表征还没对上。请重新检查解的结构。",
  };
  const skill = (Object.keys(labels) as Array<keyof typeof labels>).find(key => verified.skills[key] === "incorrect");
  return skill && labels[skill] ? { label: "回到原题检查", action: labels[skill]! } : null;
}
