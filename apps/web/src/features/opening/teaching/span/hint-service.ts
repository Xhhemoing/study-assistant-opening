import { spanHintRequestSchema, type Scope, type SpanHintLevel, type SpanHintResponse, type SpanProblem, type SpanSolution } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import type { Sql } from "postgres";
import { createSpanFeedbackService } from "./feedback-service";

/** Reviewed explanations for the immutable v1 catalog, including reserved items.
 * This server module is never imported by the lesson's client bundle. */
const WORKED_STEPS: Record<string, string> = {
  "span-example-2d": "From coordinate 1, α=3. From coordinate 2, 2β=−1, so β=−1/2. Check: 3(1,0)+(−1/2)(0,2)=(3,−1)=u.",
  "span-faded-3d": "From coordinates 1 and 2, α=2 and β=−1. Check coordinate 3: α+β=2−1=1. Thus 2(1,0,1)−(0,1,1)=(2,−1,1)=u.",
  "span-independent-3d": "Coordinates 1 and 2 force α=2 and α+β=3, hence β=1. Coordinate 3 requires β=2. The same β cannot be both 1 and 2; the system is inconsistent.",
  "span-contrast-dependent": "The equations are α−2β=3 and −2α+4β=−6. The second is −2 times the first. Let β=t; then α=3+2t. Check: (3+2t)(1,−2)+t(−2,4)=(3,−6)=u for every real t.",
  "span-geometry-transfer": "Coordinates 1 and 2 force α=1 and β=2. Coordinate 3 would give α+β=3, but u has third coordinate 4. Thus every combination satisfies z=x+y, while this u does not.",
  "span-simulation-dependent": "Every combination has equal coordinates: α(1,1)+β(2,2)=(α+2β,α+2β). The target requires α+2β=3 and α+2β=1 simultaneously, an impossibility.",
  "span-reserved-fraction": "The first two equations give 2α=1 and 3β=−2, hence α=1/2 and β=−2/3. Check coordinate 3: α−β=1/2+2/3=7/6. The resulting vector is (1,−2,7/6)=u.",
  "span-reserved-dependent": "The second equation is α+3β=−2; the first is twice this equation and the third is its negative. Let β=t, α=−2−3t. Substitution gives (2α+6β,α+3β,−α−3β)=(−4,−2,2)=u.",
  "span-reserved-transfer": "Coordinate 1 gives α−2β=1/2. Coordinate 2 gives −α+2β=1, so α−2β=−1. These contradict each other. Already the first two coordinates exclude any common coefficients.",
};

function coordinateEquation(problem: SpanProblem, coordinate: number): string {
  return `(${problem.vectors[0][coordinate]})α+(${problem.vectors[1][coordinate]})β=${problem.target[coordinate]}`;
}

function workedExplanation(problem: SpanProblem, solution: SpanSolution): string {
  const derivation = problem.version === "1" ? WORKED_STEPS[problem.id] : undefined;
  if (!derivation || solution.kind === "unknown") throw Object.assign(new Error("本题版本的完整示范尚未核对，请保留原答案。"), { code: "VALIDATION" });
  const conclusion = solution.kind === "none" ? "u ∉ span{v,w}. 方程组无解，所以不属于。"
    : solution.kind === "unique" ? `α=${solution.coefficients[0]}, β=${solution.coefficients[1]}; u ∈ span{v,w}. 全部坐标使用同一组系数，且都满足。`
      : `(α,β)=(${solution.particular.join(",")})${solution.directions.map((direction, index) => `+t${index + 1}(${direction.join(",")})`).join("")}; u ∈ span{v,w}. 系数不唯一，仍然属于。`;
  return `Sol.\n1. Write αv+βw=u. The coordinate equations are ${problem.target.map((_, index) => coordinateEquation(problem, index)).join("; ")}.\n2. ${derivation}\n3. ${conclusion}\n本题解法已交付；同题后续作答会保留这次帮助，不能作为新的无提示作答。`;
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
    const problem = attempt.spanExercise;
    if (!problem) throw Object.assign(new Error("这条作答不是 span 练习。"), { code: "VALIDATION" });
    if (level === 4) {
      if (problem.version !== "1" || !WORKED_STEPS[problem.id]) throw Object.assign(new Error("本题版本的完整示范尚未核对。"), { code: "VALIDATION" });
      // Reuse the existing sealed-original guard, source/version recheck and
      // solution exposure transaction. Never fabricate or submit an answer here.
      const feedback = await createSpanFeedbackService(sql).read(scope, { attemptId });
      return { attemptId, level, text: workedExplanation(problem, feedback.result.solution), exposureReceipt: feedback.exposureReceipt };
    }
    const text = partialHint(problem, level);
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, {
      releaseKey: `span-hint-v1:${attempt.id}:${level}`, contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId, courseId: attempt.courseId, purpose: "learning_help" },
      sessionId: attempt.sessionId, origin: "assistant", kind: "hint", level: "hinted", supportDomain: "math",
    });
    return { attemptId, level, text, exposureReceipt };
  } };
}
