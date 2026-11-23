import type { ExamAttempt, ExamPack, ExamQuestion, ExamRun, ExamSprintState } from "@aistudy/contracts";
import {
  buildExamSprintDecisionSnapshot, buildExamSprintForecastBlueprint, createExamSprintState,
  evaluateExamSprintActionRoi, forecastExamSprintScore, simulateExamSprintPaper, toExamSprintForecastEvidence,
} from "@aistudy/domain";
import { describe, expect, it } from "vitest";
import { IELTS_ACADEMIC_V1_BLUEPRINT, validateExamBlueprint, type WholePaperCalibrationRecord } from "../../exam-forecast";
import { EXAM_SPRINT_PACK } from "./catalog";

const startedAt = "2026-11-20T10:00:00Z";
const answeredAt = "2026-11-20T10:01:00Z";
const submittedAt = "2026-11-20T10:02:00Z";
const examAtMs = Date.parse("2026-11-23T10:00:00Z");
const question = (id: string, overrides: Partial<ExamQuestion> = {}): ExamQuestion => ({
  id, topicId: "topic", skillId: "skill", familyId: id, lessonId: "lesson", pool: "training",
  difficulty: "foundation", prompt: id, options: [{ id: "A", label: "A" }, { id: "B", label: "B" }],
  answer: "A", explanation: "Private answer explanation", hint: "Private hint", estimatedMinutes: 2, ...overrides,
});
const pack: ExamPack = {
  id: "fixture", version: "1", title: "Fixture", description: "", topics: [], lessons: [], sourceItems: [],
  weekPlan: [], limitations: [],
  questions: [
    ...["practice", "assisted", "retracted", "unknown", "revised", "restored", "active", "future"].map(id => question(id)),
    question("repeat", { familyId: "practice" }),
    question("mock-first", { pool: "mock-a" }),
    question("mock-second", { pool: "mock-a", estimatedMinutes: 3 }),
  ],
};

function record(state: ExamSprintState, id: string, attempt: Partial<ExamAttempt> = {}, run: Partial<ExamRun> = {}) {
  state.runs.push({
    id, mode: "practice", questionIds: [id], startedAt, completedAt: submittedAt, deadlineAt: null, ...run,
  });
  state.attempts.push({
    id, runId: id, questionId: id, presentedAt: startedAt, answeredAt, answer: "A", correct: true,
    confidence: 3, durationSeconds: 60, help: [], errorCause: null, ...attempt,
  });
}

const base = { pack, workspaceId: "workspace", learnerId: "learner", examAtMs, numDraws: 64 };

describe("Opening common-clock exam forecast", () => {
  it("builds a weighted short-mock blueprint from the actual sprint catalog", () => {
    const blueprint = buildExamSprintForecastBlueprint(EXAM_SPRINT_PACK);
    expect(validateExamBlueprint(blueprint)).toEqual([]);
    expect(blueprint).toMatchObject({ clockMode: "shared_full_paper", scoreRange: [0, 10], aggregationMode: "weighted_sum" });
    const items = blueprint.sections.flatMap(section => section.items ?? []);
    expect(items.map(item => item.itemId)).toEqual(EXAM_SPRINT_PACK.questions.filter(item => item.pool === "mock-a").map(item => item.id));
    expect(items.every(item => !("answer" in item) && !("explanation" in item))).toBe(true);
  });

  it("admits first-family practice and submitted mock evidence at the time it becomes usable", () => {
    const state = createExamSprintState(startedAt);
    record(state, "practice", {}, { completedAt: null });
    record(state, "repeat");
    record(state, "assisted", { help: [{ kind: "external", at: startedAt }] });
    record(state, "unknown", { firstFamilyExposure: null });
    record(state, "retracted");
    record(state, "revised");
    record(state, "active", {}, { mode: "mock-b", completedAt: null });
    record(state, "future", {}, { mode: "mock-b", completedAt: "2026-11-25T10:00:00Z" });
    record(state, "restored", {}, { mode: "mock-b", restoredUngraded: true });
    record(state, "mock-first", { answer: "B", correct: false }, { mode: "mock-a" });
    const context = { ruleEvidence: {
      retracted: { usable: false, independent: false, assisted: false, correct: null },
      revised: { usable: true, independent: true, assisted: false, correct: false },
    } };
    const records = toExamSprintForecastEvidence({ ...base, state, context });
    expect(records).toEqual([
      expect.objectContaining({ evidenceId: "practice", observedAtMs: Date.parse(answeredAt), evidenceKind: "diagnostic_item", countsTowardMastery: true }),
      expect.objectContaining({ evidenceId: "mock-first", observedAtMs: Date.parse(submittedAt), evidenceKind: "independent_mock", correct: false }),
    ]);
  });

  it("changes simulation with eligible answers and keeps an uncalibrated snapshot advisory", () => {
    const failed = createExamSprintState(startedAt);
    record(failed, "practice", { answer: "B", correct: false });
    const passed = createExamSprintState(startedAt);
    record(passed, "practice");
    const options = { ...base, numDraws: 128, seed: 21 };
    const withFailure = simulateExamSprintPaper({ ...options, state: failed });
    expect(withFailure.examAtMs).toBe(examAtMs);
    expect(simulateExamSprintPaper({ ...options, state: passed }).timedExpectedScore).toBeGreaterThan(withFailure.timedExpectedScore);
    const input = { ...base, state: failed, decisionId: "decision", crnSeed: 21, horizonHours: 72 };
    const snapshot = buildExamSprintDecisionSnapshot(input);
    expect(snapshot.forecast).toMatchObject({ status: "insufficient_independent_evidence", calibrationCount: 0, missingSections: [] });
    expect(snapshot.rankedActions).toHaveLength(1);
    expect(snapshot.selectedActionIds).toEqual([]);
    const action = { actionId: "no-change", title: "No change", durationHours: 1, kind: "skill_repair" } as const;
    expect(evaluateExamSprintActionRoi({ ...input, candidateAction: action })).toMatchObject({ pairedMeanGain: 0, monteCarloSe: 0, roiBandPerHour: 0 });
    expect(buildExamSprintDecisionSnapshot(input)).toEqual(snapshot);
  });

  it("does not propose skill repair after two independent wins separated by a day", () => {
    const state = createExamSprintState(startedAt);
    record(state, "practice");
    const later = "2026-11-22T10:00:00Z";
    record(state, "revised", { presentedAt: later, answeredAt: later }, { startedAt: later, completedAt: later });
    const snapshot = buildExamSprintDecisionSnapshot({ ...base, state, decisionId: "secure", crnSeed: 21, horizonHours: 72 });
    expect(snapshot.forecast).toMatchObject({ missingSections: [] });
    expect(snapshot.rankedActions).toEqual([]);
  });

  it("calibrates with independent external whole-paper records and excludes assisted, exposed and same-learner observations", () => {
    const state = createExamSprintState(startedAt);
    record(state, "practice");
    const blueprint = buildExamSprintForecastBlueprint(pack);
    const calibrationRecords = Array.from({ length: 4 }, (_, index): WholePaperCalibrationRecord => ({
      recordId: `record-${index}`, learnerId: `peer-${index}`, paperFamilyId: `form-${index}`,
      blueprintId: blueprint.blueprintId, targetKind: "same_blueprint_mock", evidenceKind: "independent_mock",
      assisted: false, countsTowardMastery: true,
      predictedQuantiles: { q10: 0, q50: 1, q90: 2 }, observedScore: { kind: "exact", score: 1 },
      recordedAtMs: Date.parse(submittedAt),
    }));
    const extra = calibrationRecords[0]!;
    const options = { ...base, state, blueprint, seed: 21,
      calibrationRecords: [...calibrationRecords, { ...extra, recordId: "self", learnerId: base.learnerId },
        { ...extra, recordId: "assisted", learnerId: "assisted", assisted: true },
        { ...extra, recordId: "exposed", learnerId: "exposed", exposed: true },
        { ...extra, recordId: "same-form", learnerId: "other", paperFamilyId: blueprint.blueprintId }] };
    const forecast = forecastExamSprintScore(options);
    expect(forecast).toMatchObject({
      blueprintId: blueprint.blueprintId, status: "calibrated_forecast_ready", examAtMs,
      officialExamCalibrated: false, calibrationReceipt: { n: 4, k: 4, nonconformityRadius: -1 },
    });
    expect(buildExamSprintDecisionSnapshot({ ...options, decisionId: "calibrated", crnSeed: 21, horizonHours: 72 }).forecast)
      .toEqual(forecast);
    expect(forecastExamSprintScore({ ...options, blueprint: IELTS_ACADEMIC_V1_BLUEPRINT })).toMatchObject({
      blueprintId: IELTS_ACADEMIC_V1_BLUEPRINT.blueprintId, status: "insufficient_independent_evidence", calibrationCount: 0,
    });
  });

  it("uses explicit IELTS sections and requires separate rubric evidence for writing and speaking", () => {
    const blueprint = IELTS_ACADEMIC_V1_BLUEPRINT;
    const ieltsPack = { ...pack, questions: ["listening", "reading"].map(sectionId => {
      const item = blueprint.sections.find(section => section.sectionId === sectionId)!.items![0]!;
      return question(sectionId, { skillId: item.skillIds[0]! });
    }) };
    const state = createExamSprintState(startedAt);
    record(state, "listening");
    record(state, "reading");
    const options = { ...base, state, pack: ieltsPack, blueprint };
    expect(forecastExamSprintScore(options)).toMatchObject({ missingSections: ["writing", "speaking"] });
    const supplementalEvidence = ["writing", "speaking"].map(sectionId => ({
      evidenceId: sectionId, sectionId, learnerId: base.learnerId, assisted: false, countsTowardMastery: true,
      observedAtMs: Date.parse(submittedAt), evidenceKind: "rubric_assessment" as const,
      rubricScore: { kind: "exact" as const, score: 6 },
    }));
    expect(forecastExamSprintScore({ ...options, supplementalEvidence })).toMatchObject({
      status: "insufficient_independent_evidence", missingSections: [], calibrationCount: 0,
    });
  });
});
