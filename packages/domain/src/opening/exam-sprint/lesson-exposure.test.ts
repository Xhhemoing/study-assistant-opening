import { describe, expect, it } from "vitest";
import type { ExamExposureCoverage, ExamLesson, ExamPack, ExamSprintCommand, ExamSprintState } from "@aistudy/contracts";
import { reportExamBkt } from "./analytics";
import { applyExamSprintCommand, createExamSprintState, examAttemptExposureQualification, examSprintOverview } from "./engine";
import { validExamLessonExposure } from "./lesson-exposure-mapping";
import { EXAM_LESSONS } from "./lessons";
import { EXAM_TRAINING_QUESTIONS } from "./training-questions";

const NOW = "2026-10-17T08:00:00.000Z";
const LATER = "2026-10-18T08:00:00.000Z";
const clientKey = "lesson-request-0001";
const lesson: ExamLesson = structuredClone(EXAM_LESSONS[0]!);
lesson.exposure = validExamLessonExposure(lesson)!;
const pack: ExamPack = {
  id: "lessons", version: "v1", title: "Sprint", description: "test", topics: [{ id: "topic", title: "Topic" }], lessons: [lesson],
  questions: ["q1", "q2", "q3", "mock"].map((id, index) => ({
    id, topicId: lesson.topicId, skillId: "skill", familyId: index === 2 ? lesson.exposure!.displayedFamilyIds[0]! : `family-${id}`, lessonId: lesson.id,
    pool: id === "mock" ? "mock-a" : "training", difficulty: "foundation", prompt: id,
    options: [{ id: "A", label: "A" }], answer: "A", explanation: "Answer", hint: "Hint", estimatedMinutes: 2,
  })), sourceItems: [], weekPlan: [], limitations: [],
};
const apply = (state: ExamSprintState, command: Omit<Extract<ExamSprintCommand, { action: "start" }>, "clientKey"> | Omit<Extract<ExamSprintCommand, { action: "next" | "finish" }>, "clientKey">, now = NOW) =>
  applyExamSprintCommand(state, { ...command, clientKey }, pack, now);
const start = (state = createExamSprintState(NOW)) => apply(state, { action: "start", mode: "practice" });
const openCommand = (state: ExamSprintState): Extract<ExamSprintCommand, { action: "open_lesson" }> => {
  const active = state.runs.find(run => run.completedAt === null);
  return { action: "open_lesson", clientKey, lessonId: lesson.id, expectedRunId: active?.id ?? null,
    expectedAttemptId: active ? state.attempts.filter(attempt => attempt.runId === active.id).at(-1)?.id ?? null : null,
    packVersion: pack.version, contentFingerprint: lesson.exposure!.contentFingerprint, mappingVersion: lesson.exposure!.mappingVersion };
};
const open = (state: ExamSprintState, now = NOW) => applyExamSprintCommand(state, openCommand(state), pack, now);
const answer = (state: ExamSprintState) => applyExamSprintCommand(state, { action: "answer", clientKey, attemptId: state.attempts.at(-1)!.id, answer: "A", confidence: 3 }, pack, NOW);
const next = (state: ExamSprintState) => apply(state, { action: "next", runId: state.runs.at(-1)!.id });
const finish = (state: ExamSprintState) => apply(state, { action: "finish", runId: state.runs.at(-1)!.id });

describe("persisted lesson authorizations and frozen attempt qualification", () => {
  it("returns only metadata until an exact-content authorization exists, and deduplicates reopenings", () => {
    const initial = createExamSprintState(NOW);
    const before = examSprintOverview(initial, pack, NOW);
    expect(before.lessonContents).toEqual([]);
    expect(before.pack.lessons[0]).not.toHaveProperty("steps");
    expect(before.pack.lessons[0]).not.toHaveProperty("workedExample");
    expect(before.pack.lessons[0]).not.toHaveProperty("pitfalls");
    const state = open(initial);
    expect(initial.lessonExposures).toEqual([]);
    expect(state.lessonExposures).toHaveLength(1);
    expect(open(state, LATER).lessonExposures).toEqual(state.lessonExposures);
    expect(examSprintOverview(state, pack, NOW).lessonContents).toEqual([{ exposureId: state.lessonExposures![0]!.id, lesson }]);
  });

  it("rejects stale context, wrong identity, unavailable legacy content and mock access", () => {
    const initial = createExamSprintState(NOW);
    const command = openCommand(initial);
    const running = start(initial);
    expect(() => applyExamSprintCommand(running, command, pack, NOW)).toThrow("上下文");
    for (const field of ["packVersion", "contentFingerprint", "mappingVersion"] as const) {
      expect(() => applyExamSprintCommand(initial, { ...command, [field]: "wrong" }, pack, NOW)).toThrow("版本");
    }
    const legacy = { ...pack, lessons: pack.lessons.map(({ exposure: _exposure, ...body }) => body) };
    expect(examSprintOverview(initial, legacy, NOW).pack.lessons[0]!.exposureIdentity).not.toBeNull();
    expect(applyExamSprintCommand(initial, command, legacy, NOW).lessonExposures).toHaveLength(1);
    const unknownLegacy = { ...legacy, lessons: legacy.lessons.map(item => ({ ...item, title: "Unreviewed legacy prose" })) };
    expect(examSprintOverview(initial, unknownLegacy, NOW).pack.lessons[0]!.exposureIdentity).toBeNull();
    expect(() => applyExamSprintCommand(initial, command, unknownLegacy, NOW)).toThrow("没有已审核");
    const changed = { ...pack, lessons: [{ ...lesson, workedExample: "Different content" }] };
    expect(() => applyExamSprintCommand(initial, command, changed, NOW)).toThrow("没有已审核");
    const authorized = open(initial);
    const mock = apply(authorized, { action: "start", mode: "mock-a" });
    expect(examSprintOverview(mock, pack, NOW).lessonContents).toEqual([]);
    expect(() => open(mock)).toThrow("交卷");
  });

  it.each(["before practice", "in a finished run"])("requires current-run authorization after complex-arithmetic was opened %s", priorContext => {
    const complexLesson = structuredClone(EXAM_LESSONS.find(item => item.id === "complex-arithmetic")!);
    const mapping = validExamLessonExposure(complexLesson)!;
    const modulusQuestion = EXAM_TRAINING_QUESTIONS.find(item => item.id === "train-complex-modulus")!;
    const modulusPack: ExamPack = { ...pack, lessons: [complexLesson], questions: [modulusQuestion] };
    const command = (state: ExamSprintState, value: ExamSprintCommand) => applyExamSprintCommand(state, value, modulusPack, NOW);
    const openComplex = (state: ExamSprintState) => {
      const run = state.runs.find(item => item.completedAt === null);
      return command(state, { action: "open_lesson", clientKey, lessonId: complexLesson.id,
        expectedRunId: run?.id ?? null, expectedAttemptId: run ? state.attempts.at(-1)!.id : null,
        packVersion: modulusPack.version, contentFingerprint: mapping.contentFingerprint, mappingVersion: mapping.mappingVersion });
    };
    let prior = createExamSprintState(NOW);
    if (priorContext === "in a finished run") prior = command(prior, { action: "start", clientKey, mode: "practice" });
    prior = openComplex(prior);
    if (priorContext === "in a finished run") prior = command(prior, { action: "finish", clientKey, runId: prior.runs[0]!.id });
    expect(examSprintOverview(prior, modulusPack, NOW).lessonContents).toHaveLength(1);

    const running = command(prior, { action: "start", clientKey, mode: "practice" });
    const attempt = running.attempts.at(-1)!;
    expect(attempt.questionId).toBe("train-complex-modulus");
    expect(attempt.lessonExposureIds).toEqual([]);
    expect(examSprintOverview(running, modulusPack, NOW).lessonContents).toEqual([]);
    const withoutReopening = command(running, { action: "answer", clientKey, attemptId: attempt.id, answer: modulusQuestion.answer, confidence: 3 });
    // A question already presented in the finished run remains a repeated exposure.
    expect(examSprintOverview(withoutReopening, modulusPack, NOW).currentAttempt!.independent).toBe(priorContext === "before practice");

    const reopened = openComplex(running);
    const currentExposure = reopened.lessonExposures!.at(-1)!;
    expect(currentExposure.runId).toBe(attempt.runId);
    expect(currentExposure.id).not.toBe(prior.lessonExposures![0]!.id);
    expect(examSprintOverview(reopened, modulusPack, NOW).lessonContents).toEqual([{ exposureId: currentExposure.id, lesson: complexLesson }]);
    expect(reopened.attempts.at(-1)!.lessonExposureIds).toEqual([currentExposure.id]);
    const supported = command(reopened, { action: "answer", clientKey, attemptId: attempt.id, answer: modulusQuestion.answer, confidence: 3 });
    expect(examSprintOverview(supported, modulusPack, NOW).currentAttempt!.independent).toBe(false);
  });

  it("keeps unanswered help and lesson support out of failures, recovery sequences, and retest clocks", () => {
    const running = start();
    const helped = applyExamSprintCommand(running, { action: "help", clientKey, attemptId: running.attempts[0]!.id, kind: "hint" }, pack, NOW);
    const supported = open(helped);
    expect(supported.attempts[0]!.help.map(item => item.kind)).toEqual(["hint"]);
    expect(supported.attempts[0]!.lessonExposureIds).toEqual([supported.lessonExposures![0]!.id]);
    const view = examSprintOverview(supported, pack, NOW);
    expect(view.skills[0]).toMatchObject({ status: "untested", attempted: 0, dueAt: null });
    expect(reportExamBkt(supported, pack).eligible).toBe(0);
    const submitted = answer(supported);
    expect(examSprintOverview(submitted, pack, NOW).skills[0]).toMatchObject({ status: "weak", attempted: 1, independentCorrect: 0, dueAt: LATER });
    expect(reportExamBkt(submitted, pack).eligible).toBe(0);
  });

  it("freezes submitted evidence and makes subsequent questions in the same run consume same-lesson assistance", () => {
    const submitted = answer(start());
    expect(examSprintOverview(submitted, pack, NOW).currentAttempt!.independent).toBe(true);
    const opened = open(submitted);
    expect(opened.attempts[0]).toEqual(submitted.attempts[0]);
    expect(examSprintOverview(opened, pack, NOW).currentAttempt!.independent).toBe(true);
    expect(reportExamBkt(opened, pack).eligible).toBe(1);
    const following = next(opened);
    expect(following.attempts[1]!.lessonExposureIds).toEqual([opened.lessonExposures![0]!.id]);
    expect(following.attempts[1]!.seenExampleExposureIds).toEqual([]);
    expect(following.attempts[1]!.firstFamilyExposure).toBe(true);
    expect(examSprintOverview(answer(following), pack, NOW).currentAttempt!.independent).toBe(false);
  });

  it("tracks explicit example families across runs without making the whole skill permanently assisted", () => {
    const first = open(start());
    const second = start(finish(first));
    expect(second.attempts.at(-1)!.questionId).toBe("q2");
    expect(second.attempts.at(-1)!.lessonExposureIds).toEqual([]);
    expect(examSprintOverview(answer(second), pack, NOW).currentAttempt!.independent).toBe(true);
    const mapped = next(answer(second));
    expect(mapped.attempts.at(-1)!.questionId).toBe("q3");
    expect(mapped.attempts.at(-1)!.lessonExposureIds).toEqual([]);
    expect(mapped.attempts.at(-1)!.seenExampleExposureIds).toEqual([first.lessonExposures![0]!.id]);
    expect(examAttemptExposureQualification(mapped.attempts.at(-1)!, mapped, pack)).toEqual({ lessonAssistance: false, seenExample: true, partialExample: false, firstFamilyExposure: false, exposureHistoryUncertain: false });
    expect(examSprintOverview(answer(mapped), pack, NOW).currentAttempt!.independent).toBe(false);
  });

  it("updates an unanswered explicit example but never contaminates old submitted attempts from a later ledger", () => {
    const running = start();
    const atExample = next(answer(next(answer(running))));
    expect(atExample.attempts.at(-1)!.firstFamilyExposure).toBe(true);
    const supported = open(atExample);
    expect(supported.attempts.at(-1)!.firstFamilyExposure).toBe(false);
    expect(supported.attempts.at(-1)!.seenExampleExposureIds).toHaveLength(1);
    const legacy = answer(atExample);
    delete legacy.attempts.at(-1)!.firstFamilyExposure;
    delete legacy.attempts.at(-1)!.lessonExposureIds;
    delete legacy.attempts.at(-1)!.seenExampleExposureIds;
    const after = open(legacy);
    expect(after.attempts.at(-1)).toEqual(legacy.attempts.at(-1));
    expect(examSprintOverview(after, pack, NOW).currentAttempt!.independent).toBe(true);
  });

  it("marks confirmed partial answers as prior exposure, while malformed references remain unknown", () => {
    const curve = structuredClone(EXAM_LESSONS.find(item => item.id === "curve-analysis")!);
    curve.exposure = validExamLessonExposure(curve)!;
    const partialPack: ExamPack = { ...pack, lessons: [lesson, curve], questions: pack.questions.map(item => item.id === "q3"
      ? { ...item, lessonId: curve.id, familyId: curve.exposure!.partialFamilyIds![0]! } : item) };
    const initial = createExamSprintState(NOW);
    const authorized = applyExamSprintCommand(initial, { ...openCommand(initial), lessonId: curve.id,
      contentFingerprint: curve.exposure.contentFingerprint, mappingVersion: curve.exposure.mappingVersion }, partialPack, NOW);
    const q3Only = { ...partialPack, questions: partialPack.questions.filter(item => item.id === "q3") };
    const presented = applyExamSprintCommand(authorized, { action: "start", clientKey, mode: "practice" }, q3Only, NOW);
    expect(examAttemptExposureQualification(presented.attempts[0]!, presented, q3Only)).toEqual({
      lessonAssistance: false, seenExample: false, partialExample: true, firstFamilyExposure: false, exposureHistoryUncertain: false,
    });
    const submitted = applyExamSprintCommand(presented, { action: "answer", clientKey, attemptId: presented.attempts[0]!.id, answer: "A", confidence: 3 }, q3Only, NOW);
    expect(examSprintOverview(submitted, q3Only, NOW).currentAttempt!.independent).toBe(false);
    expect(examSprintOverview(submitted, q3Only, NOW).skills[0]).toMatchObject({ status: "weak", independentCorrect: 0, dueAt: LATER });
    expect(reportExamBkt(submitted, q3Only).eligible).toBe(0);
    const damaged = structuredClone(submitted);
    damaged.attempts[0]!.partialExampleExposureIds = ["missing-partial-exposure"];
    expect(examAttemptExposureQualification(damaged.attempts[0]!, damaged, q3Only).partialExample).toBeNull();
    expect(examSprintOverview(damaged, q3Only, NOW).skills[0]).toMatchObject({ status: "untested", independentCorrect: 0, dueAt: null });
    const fresh = applyExamSprintCommand(initial, { action: "start", clientKey, mode: "practice" }, q3Only, NOW);
    const independentlyAnswered = applyExamSprintCommand(fresh, { action: "answer", clientKey, attemptId: fresh.attempts[0]!.id, answer: "A", confidence: 3 }, q3Only, NOW);
    const readAfterAnswer = applyExamSprintCommand(independentlyAnswered, { ...openCommand(independentlyAnswered), lessonId: curve.id,
      contentFingerprint: curve.exposure.contentFingerprint, mappingVersion: curve.exposure.mappingVersion }, q3Only, NOW);
    expect(readAfterAnswer.attempts[0]).toEqual(independentlyAnswered.attempts[0]);
    expect(examSprintOverview(readAfterAnswer, q3Only, NOW).currentAttempt!.independent).toBe(true);
    const invalid = answer(start());
    invalid.attempts[0]!.lessonExposureIds = ["missing-exposure"];
    expect(examAttemptExposureQualification(invalid.attempts[0]!, invalid, pack).lessonAssistance).toBeNull();
    expect(examSprintOverview(invalid, pack, NOW).currentAttempt!.independent).toBe(false);
    const tampered = open(start());
    tampered.lessonExposures![0]!.mappingVersion = "forged-map";
    expect(examAttemptExposureQualification(tampered.attempts[0]!, tampered, pack).lessonAssistance).toBeNull();
  });


  it.each(["legacy_untracked_source", "unverifiable_source"] as const)("freezes %s on new attempts without inventing help, exposure receipts, or weakness", kind => {
    const exposureCoverage: ExamExposureCoverage = { kind, packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 0 };
    const presented = applyExamSprintCommand(createExamSprintState(NOW), { action: "start", clientKey, mode: "practice" }, pack, NOW, { exposureCoverage });
    expect(presented.attempts[0]!.exposureCoverage).toEqual(exposureCoverage);
    expect(presented.attempts[0]!.firstFamilyExposure).toBeNull();
    expect(examAttemptExposureQualification(presented.attempts[0]!, presented, pack)).toMatchObject({
      lessonAssistance: false, seenExample: false, partialExample: false, exposureHistoryUncertain: true, firstFamilyExposure: null,
    });
    const submitted = answer(presented);
    expect(submitted.attempts[0]!.exposureCoverage).toEqual(exposureCoverage);
    expect(submitted.attempts[0]!.help).toEqual([]);
    expect(submitted.lessonExposures).toEqual([]);
    expect(examSprintOverview(submitted, pack, NOW).currentAttempt!.independent).toBe(false);
    expect(examSprintOverview(submitted, pack, NOW).skills[0]).toMatchObject({ status: "untested", attempted: 1, independentCorrect: 0, dueAt: null });
    expect(reportExamBkt(submitted, pack).eligible).toBe(0);
  });

  it("captures pending source uncertainty before submission and keeps its first provenance monotonically", () => {
    const exposureCoverage: ExamExposureCoverage = { kind: "legacy_untracked_source", packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 0 };
    const pending = start();
    const submitted = applyExamSprintCommand(pending, { action: "answer", clientKey, attemptId: pending.attempts[0]!.id, answer: "A", confidence: 3 }, pack, NOW, { exposureCoverage });
    expect(pending.attempts[0]!.exposureCoverage).toBeUndefined();
    expect(submitted.attempts[0]!.exposureCoverage).toEqual(exposureCoverage);
    expect(submitted.attempts[0]!.firstFamilyExposure).toBeNull();
    const captured = applyExamSprintCommand(pending, openCommand(pending), pack, NOW, { exposureCoverage });
    const differentSource: ExamExposureCoverage = { kind: "unverifiable_source", packSourceId: "22222222-2222-4222-8222-222222222222", sourceVersion: 3 };
    const recaptured = applyExamSprintCommand(captured, openCommand(captured), pack, NOW, { exposureCoverage: differentSource });
    expect(recaptured.attempts[0]!.exposureCoverage).toEqual(exposureCoverage);
    expect(answer(recaptured).attempts[0]!.exposureCoverage).toEqual(exposureCoverage);
  });

  it("never adds source uncertainty to submitted history, and preserves real failure facts", () => {
    const exposureCoverage: ExamExposureCoverage = { kind: "legacy_untracked_source", packSourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 0 };
    const old = answer(start());
    const authorized = applyExamSprintCommand(old, openCommand(old), pack, NOW, { exposureCoverage });
    expect(authorized.attempts[0]).toEqual(old.attempts[0]);
    expect(examSprintOverview(authorized, pack, NOW).currentAttempt!.independent).toBe(true);
    expect(reportExamBkt(authorized, pack).eligible).toBe(1);
    const wrongAnswerPack = { ...pack, questions: pack.questions.map(question => ({ ...question, options: [...question.options, { id: "B", label: "B" }] })) };
    const pending = applyExamSprintCommand(createExamSprintState(NOW), { action: "start", clientKey, mode: "practice" }, wrongAnswerPack, NOW, { exposureCoverage });
    const failed = applyExamSprintCommand(pending, { action: "answer", clientKey, attemptId: pending.attempts[0]!.id, answer: "B", confidence: 3 }, wrongAnswerPack, NOW);
    expect(examSprintOverview(failed, wrongAnswerPack, NOW).skills[0]).toMatchObject({ status: "weak", attempted: 1, dueAt: LATER });
    expect(failed.attempts[0]!.help).toEqual([]);
  });

  it("does not expire explicit family exposure after 24 hours or carry same-run assistance into the later run", () => {
    const authorized = open(createExamSprintState(NOW));
    const q3Only = { ...pack, questions: pack.questions.filter(item => item.id === "q3") };
    const presented = applyExamSprintCommand(authorized, { action: "start", clientKey, mode: "practice" }, q3Only, "2026-10-20T09:00:00.000Z");
    expect(presented.attempts[0]!.seenExampleExposureIds).toEqual([authorized.lessonExposures![0]!.id]);
    expect(presented.attempts[0]!.lessonExposureIds).toEqual([]);
    expect(presented.attempts[0]!.firstFamilyExposure).toBe(false);
  });

});
