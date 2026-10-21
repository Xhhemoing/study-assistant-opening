import { spanHintRequestSchema, type Scope, type SpanHintLevel, type SpanHintResponse, type SpanProblem } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { getSpanProblem, solveSpanProblemWithSteps, type SpanRowOperation, type SpanWorkedSolution } from "@aistudy/domain";
import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import type { Sql } from "postgres";
import { createSpanFeedbackService } from "./feedback-service";

/** Only the server's canonical, immutable catalog can authorize hint content. */
function canonicalProblem(problem: SpanProblem): SpanProblem {
  const known = getSpanProblem(problem.id, problem.version) ?? getSpanReservedProblem(problem.id, problem.version);
  const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
  if (!known || problem.familyId !== known.familyId || !same(problem.target, known.target) ||
      !same(problem.vectors[0], known.vectors[0]) || !same(problem.vectors[1], known.vectors[1]) ||
      !same(problem.knowledgeComponents, known.knowledgeComponents)) {
    throw Object.assign(new Error("本题身份、版本或内容与题库不一致，请保留原答案。"), { code: "VALIDATION" });
  }
  return known;
}

function coordinateEquation(problem: SpanProblem, coordinate: number): string {
  return `(${problem.vectors[0][coordinate]})α+(${problem.vectors[1][coordinate]})β=${problem.target[coordinate]}`;
}

function rowOperation(operation: SpanRowOperation): string {
  if (operation.kind === "swap") return `R${operation.rows[0] + 1} ↔ R${operation.rows[1] + 1}`;
  if (operation.kind === "scale") return `R${operation.row + 1} ← (${operation.factor})R${operation.row + 1}`;
  return `R${operation.row + 1} ← R${operation.row + 1} − (${operation.factor})R${operation.sourceRow + 1}`;
}
function workedExplanation(problem: SpanProblem, working: SpanWorkedSolution): string {
  const { solution, steps, reducedMatrix } = working;
  if (solution.kind === "unknown") throw Object.assign(new Error("本题版本的完整示范尚未核对，请保留原答案。"), { code: "VALIDATION" });
  const equations = (rows: [string, string, string][]) => rows.map(([a, b, u]) => `(${a})α+(${b})β=${u}`).join("; ");
  const derivation = steps.length
    ? steps.map(step => `${rowOperation(step.operation)} ⇒ ${equations(step.matrix)}.`).join("\n")
    : "The equations are already reduced. 方程组已经是简化形式。";
  const contradiction = reducedMatrix.find(([a, b, u]) => a === "0" && b === "0" && u !== "0");
  const conclusion = solution.kind === "none" ? `A reduced equation gives 0=${contradiction![2]}, a contradiction. u ∉ span{v,w}. 方程组无解，所以不属于。`
    : solution.kind === "unique" ? `α=${solution.coefficients[0]}, β=${solution.coefficients[1]}; u ∈ span{v,w}. 全部坐标使用同一组系数，且都满足。\nCheck: ${problem.target.map((target, i) => `(${solution.coefficients[0]})(${problem.vectors[0][i]})+(${solution.coefficients[1]})(${problem.vectors[1][i]})=${target}`).join("; ")}.`
      : `(α,β)=(${solution.particular.join(",")})${solution.directions.map((direction, index) => `+t${index + 1}(${direction.join(",")})`).join("")}; u ∈ span{v,w}. 每个 t 为任意实数；这些系数组合满足全部简化方程，等价地满足原方程。系数不唯一，仍然属于。`;
  return `Sol.\n1. Write αv+βw=u. The coordinate equations are ${problem.target.map((_, index) => coordinateEquation(problem, index)).join("; ")}.\n2. Row reduction. 每次行变换同时作用于 α、β 的系数和等号右侧，保持同一个方程组的解：\n${derivation}\n3. ${conclusion}\n本题解法已交付；同题后续作答会保留这次帮助，不能作为新的无提示作答。`;
}

function partialHint(problem: SpanProblem, level: Exclude<SpanHintLevel, 4>): string {
  if (level === 1) return "Direction. 先设 αv+βw=u。把向量等式拆成坐标方程，寻找同一组 α、β。看过本提示后，这次作答按含数学提示记录。";
  if (level === 2) return "Definition. u∈span{v,w} 当且仅当存在实数 α、β，使 αv+βw=u 的每个坐标同时成立。只满足部分坐标不够；系数有多组也可以属于。";
  return `First step. 第一个坐标给出 ${coordinateEquation(problem, 0)}。先保留这条等式，再写出剩余 ${problem.target.length - 1} 个坐标方程；用同一组 α、β 检查它们。`;
}

export function createSpanHintService(sql: Sql) {
  return { async read(scope: Scope, raw: unknown): Promise<SpanHintResponse> {
    const { attemptId, level } = spanHintRequestSchema.parse(raw);
    const attempt = await createOpeningLearningAttemptRepository(sql).assertAccess(scope, attemptId);
    const storedProblem = attempt.spanExercise;
    if (!storedProblem) throw Object.assign(new Error("这条作答不是 span 练习。"), { code: "VALIDATION" });
    const problem = canonicalProblem(storedProblem);
    if (level === 4) {
      const text = workedExplanation(problem, solveSpanProblemWithSteps(problem));
      // Reuse the existing sealed-original guard, source/version recheck and
      // solution exposure transaction. Never fabricate or submit an answer here.
      const feedback = await createSpanFeedbackService(sql).read(scope, { attemptId });
      return { attemptId, level, text, exposureReceipt: feedback.exposureReceipt };
    }
    const text = partialHint(problem, level);
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, {
      releaseKey: `span-hint-v1:${attempt.id}:${level}`, contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId, courseId: attempt.courseId, purpose: "learning_help" },
      sessionId: attempt.sessionId, origin: "assistant", kind: "hint", level: "hinted", supportDomain: "math",
    });
    return { attemptId, level, text, exposureReceipt };
  } };
}
