import type { SpanAnswer, SpanProblem, SpanRepairClarificationReason, SpanRepairPlan, SpanRepairTarget, SpanTargetedExplanation, SpanVerification } from "@aistudy/contracts";
import { addRational, equalRational, formatSpanRational, multiplyRational, parseSpanRational } from "./span-rational";
import { solveSpanProblemWithSteps, verifySpanAnswer } from "./span-verifier";
import { spanProblemContentKey } from "./span-generated-items";

/** Server plan construction only: teaching identities, never validation/retest/research candidates. */
export function chooseSpanRepairTeaching(problem: SpanProblem, history: { contentKeys: Set<string>; unknownHistory: boolean }, teachingCandidates: readonly SpanProblem[]) {
  if (history.unknownHistory) return null;
  const excluded = new Set([...history.contentKeys, spanProblemContentKey(problem)]);
  const candidates = teachingCandidates.filter(candidate => candidate.familyId === problem.familyId
    && candidate.target.length === problem.target.length && !excluded.has(spanProblemContentKey(candidate))
    && !["none", "unknown"].includes(solveSpanProblemWithSteps(candidate).solution.kind));
  const teachingExample = candidates[0];
  const practiceVariant = teachingExample && candidates.find(candidate => spanProblemContentKey(candidate) !== spanProblemContentKey(teachingExample));
  return teachingExample && practiceVariant ? { teachingExample, practiceVariant } : null;
}

const core: SpanRepairTarget[] = ["equation", "coefficients", "allCoordinates"];
export type SpanRepairDiagnosis = { status: "ready"; targetSkill: SpanRepairTarget; checkMismatchCoordinates: number[] }
  | { status: "needs_clarification"; reasonCode: SpanRepairClarificationReason };
const clarify = (reasonCode: SpanRepairClarificationReason): SpanRepairDiagnosis => ({ status: "needs_clarification", reasonCode });

/** Operation dependency, not a claim about the learner's psychological cause or external prerequisites. */
export function diagnoseSpanRepair(problem: SpanProblem, answer: unknown, recorded: Pick<SpanVerification, "skills" | "outcome">): SpanRepairDiagnosis {
  const verified = verifySpanAnswer(problem, answer);
  if (verified.outcome === "unknown") return clarify("evidence_unavailable");
  if (verified.solution.kind === "none") return clarify("unsupported_target");
  if (verified.outcome !== recorded.outcome || [...core, "noSolutionProof", "geometry", "systemConsistency"].some(key =>
    verified.skills[key as keyof typeof verified.skills] !== recorded.skills[key as keyof typeof recorded.skills])) return clarify("verification_mismatch");
  const branches = [verified.skills.noSolutionProof, verified.skills.geometry, verified.skills.systemConsistency];
  const index = core.findIndex(key => verified.skills[key] === "incorrect");
  if (branches.includes("incorrect")) return clarify(index >= 0 ? "ambiguous_branch" : "unsupported_target");
  if (index < 0) return clarify("no_verified_error");
  if (core.slice(0, index).some(key => verified.skills[key] !== "correct")) return clarify("predecessor_unobserved");
  return { status: "ready", targetSkill: core[index]!, checkMismatchCoordinates: spanRepairCheckMismatches(problem, answer) };
}

/** check-vs-computed only; verifier.failedCoordinates is computed-vs-target and is deliberately NOT used. */
export function spanRepairCheckMismatches(problem: SpanProblem, raw: unknown): number[] {
  if (verifySpanAnswer(problem, raw).outcome === "unknown") return [];
  const answer = (typeof raw === "string" ? JSON.parse(raw) : raw) as SpanAnswer;
  if (!answer.coefficients || !answer.coordinateChecks) return [];
  const [a, b] = answer.coefficients.map(value => parseSpanRational(value)!);
  return answer.coordinateChecks.flatMap((value, index) => {
    const computed = addRational(multiplyRational(a!, parseSpanRational(problem.vectors[0][index]!)!),
      multiplyRational(b!, parseSpanRational(problem.vectors[1][index]!)!));
    return equalRational(parseSpanRational(value)!, computed) ? [] : [index];
  });
}

export const SPAN_REPAIR_FOCUS: Record<SpanRepairTarget, string> = {
  equation: "本题步骤：把向量关系逐坐标写成同一个系数等式。",
  coefficients: "本题步骤：从已写对的等式求出满足全部坐标的系数。",
  allCoordinates: "本题步骤：把已求对的同一组系数逐坐标代回验算。",
};
export function spanRepairPublicContext(plan: SpanRepairPlan) {
  return plan.status === "ready"
    ? { status: "ready" as const, version: plan.version, contentVersion: plan.contentVersion, targetSkill: plan.targetSkill,
      focusSummary: SPAN_REPAIR_FOCUS[plan.targetSkill], prerequisiteStatus: "unknown" as const }
    : { status: "needs_clarification" as const, version: plan.version, reasonCode: plan.reasonCode,
      message: "当前证据不足以唯一定位本题步骤，请回原题补写或核对；尚未识别外部先修。", prerequisiteStatus: "unknown" as const };
}

/** Every number comes from the currently issued canonical example and the exact RREF solver. */
export function buildSpanTargetedExplanation(problem: SpanProblem, targetSkill: SpanRepairTarget): SpanTargetedExplanation | null {
  const worked = solveSpanProblemWithSteps(problem);
  if (worked.solution.kind === "unknown") return null;
  const equations = problem.target.map((value, index) => ({ label: `第 ${index + 1} 坐标`,
    math: `(${problem.vectors[0][index]})α + (${problem.vectors[1][index]})β = ${value}` }));
  const stopCondition = "只补这一块；接着完成同族变式，再用另一道新题确认。本题步骤依赖不等于已识别外部先修。";
  if (targetSkill === "equation") return { targetSkill, brief: "αv + βw = u 表示每个坐标都相等，所有坐标必须共用同一组 α、β。", workedSteps: equations, stopCondition };
  if (targetSkill === "coefficients") return { targetSkill, brief: "把已写出的坐标等式作为一个方程组求解，不为每个坐标另选系数。增广矩阵的行操作必须作用于整行。",
    workedSteps: [{ label: "原增广矩阵", math: JSON.stringify(worked.initialMatrix) },
      ...worked.steps.map(step => ({ label: step.operation.kind === "swap" ? `交换第 ${step.operation.rows[0] + 1}、${step.operation.rows[1] + 1} 行`
        : step.operation.kind === "scale" ? `第 ${step.operation.row + 1} 行乘 ${step.operation.factor}`
          : `第 ${step.operation.row + 1} 行减去 ${step.operation.factor} × 第 ${step.operation.sourceRow + 1} 行`, math: JSON.stringify(step.matrix) })),
      { label: "精确解", math: JSON.stringify(worked.solution) }], stopCondition };
  if (worked.solution.kind === "none") return null;
  const coefficients = worked.solution.kind === "unique" ? worked.solution.coefficients : worked.solution.particular;
  const [a, b] = coefficients.map(value => parseSpanRational(value)!);
  return { targetSkill, brief: "逐坐标计算左边，再与右边比较；算对某两个坐标不能代替其余坐标的验算。",
    workedSteps: problem.target.map((value, index) => {
      const computed = addRational(multiplyRational(a!, parseSpanRational(problem.vectors[0][index]!)!), multiplyRational(b!, parseSpanRational(problem.vectors[1][index]!)!));
      return { label: `第 ${index + 1} 坐标`, math: `(${coefficients[0]})×(${problem.vectors[0][index]}) + (${coefficients[1]})×(${problem.vectors[1][index]}) = ${formatSpanRational(computed)}；目标 ${value}` };
    }), stopCondition };
}
