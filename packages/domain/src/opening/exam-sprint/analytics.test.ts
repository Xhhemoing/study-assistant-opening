import { describe, expect, it } from "vitest";
import type { ExamAttempt, ExamPack, ExamPredictionSnapshot, ExamSprintState } from "@aistudy/contracts";
import { predictClassicalBkt, predictSmoothedFrequency } from "../measurement/models";
import { reportExamBkt, snapshotExamPrediction } from "./analytics";
import { applyExamSprintCommand, createExamSprintState, examSprintOverview } from "./engine";

const NOW = "2026-10-17T08:00:00.000Z";
const time = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const pack: ExamPack = {
  id: "bkt-pack", version: "1", title: "BKT", description: "test", topics: [{ id: "topic", title: "Topic" }],
  lessons: [{ id: "skill", topicId: "topic", title: "Skill", summary: "", steps: [], workedExample: "", pitfalls: [] }],
  questions: ["q1", "q2", "q3", "q4", "a1", "a2"].map(id => ({
    id, topicId: "topic", skillId: "skill", lessonId: "skill", familyId: id, pool: id.startsWith("a") ? "mock-a" : "training",
    difficulty: "foundation", prompt: id, options: ["A", "B", "C", "D"].map(option => ({ id: option, label: option })),
    answer: "A", hint: "hint", explanation: "explanation", estimatedMinutes: 2,
  })), sourceItems: [], weekPlan: [], limitations: [],
};

function append(state: ExamSprintState, questionId: string, correct = true, override: Partial<ExamAttempt> = {}): ExamSprintState {
  const n = state.attempts.length;
  const presentedAt = time(n * 10);
  const answeredAt = time(n * 10 + 5);
  const runId = `run-${n}`;
  return {
    ...state,
    runs: [...state.runs, { id: runId, mode: "practice", questionIds: [questionId], startedAt: presentedAt, completedAt: answeredAt, deadlineAt: null }],
    attempts: [...state.attempts, { id: `attempt-${n}`, questionId, runId, presentedAt, answeredAt,
      answer: correct ? "A" : "B", correct, confidence: 3, durationSeconds: 5, help: [], errorCause: null,
      prediction: snapshotExamPrediction(state, pack, questionId, presentedAt), ...override }],
  };
}

describe("exam BKT prospective shadow evaluation", () => {
  it("freezes probabilities before each answer and computes Brier from those exact values", () => {
    let state = append(createExamSprintState(NOW), "q1");
    expect(state.attempts[0]!.prediction).toEqual({
      predictedAt: NOW, skillId: "skill", historyAttemptIds: [], modelVersion: "classical-bkt-v1", calibrated: false,
      bktCorrect: predictClassicalBkt([]), baselineCorrect: 0.5,
    });
    state = append(state, "q2", false);
    expect(state.attempts[1]!.prediction).toMatchObject({ historyAttemptIds: ["attempt-0"], bktCorrect: predictClassicalBkt([true]), baselineCorrect: 2 / 3 });
    const frozen = structuredClone(state.attempts[1]!.prediction!);
    state = append(state, "q3");
    expect(state.attempts[1]!.prediction).toEqual(frozen);
    const report = reportExamBkt(state, pack);
    expect(report).toMatchObject({ calibrated: false, eligible: 3, excluded: 0 });
    expect(report.bktBrier).toBeCloseTo(state.attempts.reduce((sum, attempt) => sum + (attempt.prediction!.bktCorrect - Number(attempt.correct)) ** 2, 0) / 3, 12);
    expect(report.baselineBrier).toBeCloseTo(((0.5 - 1) ** 2 + (2 / 3) ** 2 + (0.5 - 1) ** 2) / 3, 12);
    expect(report.skills[0]!.nextCorrectProbability).toBe(predictClassicalBkt([true, false, true]));
  });

  it("never retrofits legacy scores, while valid legacy answers may inform a new prediction", () => {
    let state = append(createExamSprintState(NOW), "q1", true, { prediction: undefined });
    expect(reportExamBkt(state, pack)).toMatchObject({ eligible: 0, excluded: 1, bktBrier: null, baselineBrier: null });
    state = append(state, "q2", false);
    expect(state.attempts[0]).not.toHaveProperty("prediction", expect.any(Object));
    expect(state.attempts[1]!.prediction!.historyAttemptIds).toEqual(["attempt-0"]);
    expect(reportExamBkt(state, pack)).toMatchObject({ eligible: 1, excluded: 1 });
  });

  it("excludes every assisted or repeated family, even if the first exposure was unanswered", () => {
    let state = append(createExamSprintState(NOW), "q1", true, { answer: null, answeredAt: null, correct: null });
    state = append(state, "q1");
    state = append(state, "q2", true, { help: [{ kind: "hint", at: time(21) }] });
    state = append(state, "q2");
    state = append(state, "q3");
    expect(state.attempts[4]!.prediction!.historyAttemptIds).toEqual([]);
    expect(reportExamBkt(state, pack)).toMatchObject({ eligible: 1, excluded: 3 });
    expect(reportExamBkt(state, pack).skills[0]!.nextCorrectProbability).toBe(predictClassicalBkt([true]));
  });

  it("excludes stale model versions, inconsistent answers, future timestamps and contaminated history", () => {
    let state = append(createExamSprintState(NOW), "q1");
    state.attempts[0]!.prediction!.modelVersion = "old-bkt" as ExamPredictionSnapshot["modelVersion"];
    state = append(state, "q2", true, { answer: "B" });
    state = append(state, "q3", true, { answeredAt: time(19) });
    state = append(state, "q4");
    state.attempts[3]!.prediction!.historyAttemptIds = [state.attempts[3]!.id];
    expect(reportExamBkt(state, pack)).toMatchObject({ eligible: 0, excluded: 4 });
    const snapshot = snapshotExamPrediction(state, pack, "q1", time(4));
    expect(snapshot.historyAttemptIds).toEqual([]);
  });

  it("respects canonical eligibility without deleting prior family exposures", () => {
    let state = append(createExamSprintState(NOW), "q1");
    state = append(state, "q2");
    // q2 was predicted using q1, whose evidence has since been retracted.
    expect(reportExamBkt(state, pack, ["attempt-1"])).toMatchObject({ eligible: 0, excluded: 2 });
    expect(reportExamBkt(state, pack, []).skills[0]!.nextCorrectProbability).toBeNull();
    const snapshot = snapshotExamPrediction(state, pack, "q3", time(30), ["attempt-1"]);
    expect(snapshot.historyAttemptIds).toEqual(["attempt-1"]);
    expect(snapshot.baselineCorrect).toBe(predictSmoothedFrequency([true]));
    const duplicate = append(state, "q1");
    expect(reportExamBkt(duplicate, pack, ["attempt-2"])).toMatchObject({ eligible: 0 });
  });

  it("keeps all unsubmitted mock results out of next-item prediction and every public channel", () => {
    const command = { action: "start", clientKey: "mock-start", mode: "mock-a" } as const;
    const opened = applyExamSprintCommand(createExamSprintState(NOW), command, pack, NOW);
    const completeFirst = (answer: "A" | "B") => {
      const answered = applyExamSprintCommand(opened, { action: "answer", clientKey: "mock-answer", attemptId: opened.attempts[0]!.id, answer, confidence: 3 }, pack, time(5));
      return applyExamSprintCommand(answered, { action: "next", clientKey: "mock-next", runId: opened.runs[0]!.id }, pack, time(10));
    };
    const correct = completeFirst("A");
    const wrong = completeFirst("B");
    expect(correct.attempts[1]!.prediction).toEqual(wrong.attempts[1]!.prediction);
    expect(correct.attempts[1]!.prediction!.historyAttemptIds).toEqual([]);
    expect(reportExamBkt(correct, pack)).toEqual(reportExamBkt(wrong, pack));
    expect(reportExamBkt(correct, pack)).toMatchObject({ eligible: 0, excluded: 1 });
    for (const view of [examSprintOverview(correct, pack, time(10)), examSprintOverview(wrong, pack, time(10))]) {
      expect(view.attempts.every(attempt => !Object.hasOwn(attempt, "prediction"))).toBe(true);
      expect(view.currentAttempt).not.toHaveProperty("prediction");
    }
    const closed = applyExamSprintCommand(correct, { action: "finish", clientKey: "mock-finish", runId: opened.runs[0]!.id }, pack, time(20));
    expect(reportExamBkt(closed, pack).eligible).toBe(1);
    expect(examSprintOverview(closed, pack, time(20)).attempts[0]).toHaveProperty("prediction");
  });
});
