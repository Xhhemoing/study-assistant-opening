import { vi } from "vitest";
import { createOpeningAiGradingRepository } from "@aistudy/database";
import * as aiEvaluation from "../../packages/domain/src/opening/ai-evaluation";

/** Test-only synthetic checker for the two course fixtures, not AI calibration.
 * Keep real apply/revision/qualification/transaction flows; substitute only the
 * correctness leaf for registered, server-saved rank-nullity questions.
 */
export function controlledCourseGrading() {
  const checked = new Map<string, { itemVersionId: string | null | undefined; problemId: string | null | undefined; requirementKey: string | null | undefined; outcome: "correct" | "incorrect" }>();
  const realEvaluate = aiEvaluation.evaluateAiCorrectness;
  const spy = vi.spyOn(aiEvaluation, "evaluateAiCorrectness").mockImplementation((observation, evaluation, reasons) => {
    const actual = realEvaluate(observation, evaluation, reasons);
    const fixture = observation.attemptId ? checked.get(observation.attemptId) : undefined;
    if (!fixture || !reasons.has("ai_evaluation_uncalibrated")
      || fixture.itemVersionId !== observation.itemVersionId || fixture.problemId !== observation.problemId
      || fixture.requirementKey !== observation.requirementKey || fixture.outcome !== observation.outcome) return actual;
    reasons.delete("ai_evaluation_uncalibrated");
    reasons.add(fixture.outcome === "correct" ? "deterministic_correct" : "deterministic_incorrect");
    return fixture.outcome === "correct" ? "yes" : "no";
  });
  type Repository = ReturnType<typeof createOpeningAiGradingRepository>;
  return {
    restore: () => spy.mockRestore(),
    async apply(repository: Repository, ...args: Parameters<Repository["apply"]>) {
      const [scope, input, proposal, modelLabel] = args;
      if (modelLabel !== "controlled-fixture") throw new Error("Unexpected course fixture identity");
      const context = await repository.context(scope, input);
      const match = /^一个3×(\d+)矩阵的秩为(\d+)，零空间维数是多少？$/u.exec(context.stem);
      if (!match || !context.observation.attemptId) throw new Error("Unexpected saved course fixture question");
      const answer = context.observation.answer.trim();
      const outcome = /^-?\d+$/u.test(answer) && Number(answer) === Number(match[1]) - Number(match[2]) ? "correct" : "incorrect";
      if (proposal.outcome !== outcome) throw new Error("Proposal contradicts independently checked saved answer");
      checked.set(context.observation.attemptId, {
        itemVersionId: context.observation.itemVersionId, problemId: context.observation.problemId,
        requirementKey: context.observation.requirementKey, outcome,
      });
      return repository.apply(...args);
    },
  };
}
