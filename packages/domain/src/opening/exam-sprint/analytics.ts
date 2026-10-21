import type { ExamAttempt, ExamBktReport, ExamPack, ExamPredictionSnapshot, ExamSprintState } from "@aistudy/contracts";
import { examAttemptExposureQualification } from "./exposure-qualification";
import { predictClassicalBkt, predictSmoothedFrequency } from "../measurement/models";

const timestamp = (value: string) => Date.parse(value);
const isMock = (mode: string) => mode === "mock-a" || mode === "mock-b";

/** Every exposure contaminates that family, including unanswered and assisted exposures. */
function independentAnswered(state: ExamSprintState, pack: ExamPack, index: number, cutoff: number): boolean {
  const attempt = state.attempts[index]!;
  const question = pack.questions.find(item => item.id === attempt.questionId);
  const run = state.runs.find(item => item.id === attempt.runId);
  const exposure = examAttemptExposureQualification(attempt, state, pack);
  if (!question || !run || attempt.help.length > 0 || exposure.exposureHistoryUncertain || exposure.lessonAssistance !== false || exposure.firstFamilyExposure !== true || attempt.answeredAt === null
    || typeof attempt.correct !== "boolean" || !question.options.some(option => option.id === attempt.answer)
    || attempt.correct !== (attempt.answer === question.answer)) return false;
  const presented = timestamp(attempt.presentedAt);
  const answered = timestamp(attempt.answeredAt);
  if (!Number.isFinite(presented) || !Number.isFinite(answered) || answered < presented || answered > cutoff) return false;
  if (isMock(run.mode) && (run.completedAt === null || timestamp(run.completedAt) > cutoff)) return false;
  return true;
}

function historyFor(
  state: ExamSprintState, pack: ExamPack, skillId: string, beforeIndex: number, cutoff: number,
  allowed?: ReadonlySet<string>,
): ExamAttempt[] {
  return state.attempts.slice(0, beforeIndex).filter((attempt, index) =>
    (!allowed || allowed.has(attempt.id))
    && pack.questions.find(question => question.id === attempt.questionId)?.skillId === skillId
    && independentAnswered(state, pack, index, cutoff));
}

/** Called exactly when presenting a new item; old attempts never receive a retroactive prediction. */
export function snapshotExamPrediction(
  state: ExamSprintState, pack: ExamPack, questionId: string, predictedAt: string,
  eligibleAttemptIds?: readonly string[],
): ExamPredictionSnapshot {
  const question = pack.questions.find(item => item.id === questionId);
  if (!question) throw new Error("Cannot predict a missing exam question");
  const history = historyFor(state, pack, question.skillId, state.attempts.length, timestamp(predictedAt),
    eligibleAttemptIds ? new Set(eligibleAttemptIds) : undefined);
  const answers = history.map(attempt => attempt.correct!);
  return {
    predictedAt, skillId: question.skillId, historyAttemptIds: history.map(attempt => attempt.id),
    modelVersion: "classical-bkt-v1", calibrated: false,
    bktCorrect: predictClassicalBkt(answers), baselineCorrect: predictSmoothedFrequency(answers),
  };
}

function validFrozenPrediction(
  state: ExamSprintState, pack: ExamPack, index: number, allowed?: ReadonlySet<string>,
): boolean {
  const attempt = state.attempts[index]!;
  const prediction = attempt.prediction;
  const question = pack.questions.find(item => item.id === attempt.questionId);
  if (!prediction || !question || prediction.modelVersion !== "classical-bkt-v1" || prediction.calibrated !== false
    || prediction.skillId !== question.skillId || prediction.predictedAt !== attempt.presentedAt
    || ![prediction.bktCorrect, prediction.baselineCorrect].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  const possible = historyFor(state, pack, question.skillId, index, timestamp(prediction.predictedAt), allowed);
  const possibleIds = new Set(possible.map(item => item.id));
  // A later retraction invalidates a prediction that depended on that evidence. Do not refit its score.
  return new Set(prediction.historyAttemptIds).size === prediction.historyAttemptIds.length
    && prediction.historyAttemptIds.every(id => possibleIds.has(id));
}

export function reportExamBkt(state: ExamSprintState, pack: ExamPack, eligibleAttemptIds?: readonly string[]): ExamBktReport {
  const allowed = eligibleAttemptIds ? new Set(eligibleAttemptIds) : undefined;
  const eligible = state.attempts.filter((attempt, index) => (!allowed || allowed.has(attempt.id))
    && independentAnswered(state, pack, index, Infinity) && validFrozenPrediction(state, pack, index, allowed));
  const brier = (field: "bktCorrect" | "baselineCorrect") => eligible.length
    ? eligible.reduce((sum, attempt) => sum + (attempt.prediction![field] - Number(attempt.correct)) ** 2, 0) / eligible.length
    : null;
  const skillIds = [...new Set(pack.questions.map(question => question.skillId))];
  return {
    calibrated: false, eligible: eligible.length,
    excluded: state.attempts.filter(attempt => attempt.answeredAt !== null).length - eligible.length,
    bktBrier: brier("bktCorrect"), baselineBrier: brier("baselineCorrect"),
    skills: skillIds.map(skillId => {
      const history = historyFor(state, pack, skillId, state.attempts.length, Infinity, allowed);
      return {
        skillId, eligible: eligible.filter(attempt => attempt.prediction!.skillId === skillId).length,
        nextCorrectProbability: history.length ? predictClassicalBkt(history.map(attempt => attempt.correct!)) : null,
      };
    }),
    message: "BKT与频率基线均为未校准的影子估计，Brier只比较题目呈现前已冻结的预测与后续独立作答；分数越低误差越小。帮助、重复题族、未交模拟、缺失或失效预测不计入。每技能下一题成功率可使用合格旧作答，但旧作答不会补造前瞻分数。样本量有限，不能据此宣布模型优胜，也不代表掌握度或正式考试得分。",
  };
}
