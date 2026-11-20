import { describe, expect, it } from "vitest";
import { EXAM_SPRINT_PACK } from "./catalog";
import { validExamLessonExposure } from "./lesson-exposure-mapping";
import type { ExamAttempt, ExamPack, ExamQuestion, ExamSprintCommand, ExamSprintState } from "@aistudy/contracts";
import { evaluateExamQuestionParts, applyExamSprintCommand, createExamSprintState, examSprintOverview, type ExamSelectionContext } from "./engine";

const NOW = "2026-10-17T08:00:00.000Z";
const LATER = "2026-10-18T08:00:00.000Z";
const key = "request-key-0001";
const question = (id: string, skillId = "s1", overrides: Partial<ExamQuestion> = {}): ExamQuestion => ({
  id, skillId, topicId: skillId === "s1" || skillId === "s2" ? "t1" : "t2", familyId: `family-${id}`, lessonId: `lesson-${skillId}`,
  pool: "training", difficulty: "foundation", prompt: `Question ${id}`, options: [{ id: "A", label: "One" }, { id: "B", label: "Two" }],
  answer: "A", explanation: `SECRET-EXPLANATION-${id}`, hint: `SECRET-HINT-${id}`, estimatedMinutes: 3, ...overrides,
});
const pack: ExamPack = {
  id: "test-pack", version: "1", title: "Exam", description: "test",
  topics: [{ id: "t1", title: "Limits" }, { id: "t2", title: "Calculus" }],
  lessons: ["s1", "s2", "s3", "s4"].map(skill => ({ id: `lesson-${skill}`, topicId: skill === "s1" || skill === "s2" ? "t1" : "t2", title: skill, summary: "Learn", steps: [], workedExample: "Example", pitfalls: [] })),
  questions: [
    ...["s1", "s2", "s3", "s4"].flatMap(skill => Array.from({ length: 4 }, (_, index) => question(`${skill}-${index}`, skill))),
    question("transfer", "s2", { difficulty: "transfer" }),
    question("mock-a-1", "s1", { pool: "mock-a", estimatedMinutes: 2 }), question("mock-a-2", "s2", { pool: "mock-a", estimatedMinutes: 4 }),
    question("mock-b-1", "s3", { pool: "mock-b" }),
  ],
  sourceItems: [
    { id: "source-a", topicId: "t1", label: "A", sourceTitle: "Original", sourcePage: 1, kind: "choice", suggestedDay: 1, skills: ["s1"] },
    { id: "source-b", topicId: "t1", label: "B", sourceTitle: "Original", sourcePage: 2, kind: "choice", suggestedDay: 1, skills: ["s2"] },
    { id: "source-c", topicId: "t2", label: "C", sourceTitle: "Original", sourcePage: 3, kind: "problem", suggestedDay: 2, skills: ["s3"] },
    { id: "source-d", topicId: "t2", label: "D", sourceTitle: "Original", sourcePage: 4, kind: "problem", suggestedDay: 2, skills: ["s4"] },
  ],
  weekPlan: [], limitations: ["Self-reported original source evidence"],
};
const start = (state = createExamSprintState(NOW), mode: Extract<ExamSprintCommand, { action: "start" }>["mode"] = "diagnostic", now = NOW, selectedPack = pack) =>
  applyExamSprintCommand(state, { action: "start", clientKey: key, mode }, selectedPack, now);
const answer = (state: ExamSprintState, value = "A", now = NOW, selectedPack = pack) =>
  applyExamSprintCommand(state, { action: "answer", clientKey: key, attemptId: state.attempts.at(-1)!.id, answer: value, confidence: 3 }, selectedPack, now);
const finish = (state: ExamSprintState, now = NOW, selectedPack = pack) =>
  applyExamSprintCommand(state, { action: "finish", clientKey: key, runId: state.runs.at(-1)!.id }, selectedPack, now);
function addEvidence(state: ExamSprintState, questionId: string, answeredAt: string, overrides: Partial<ExamAttempt> = {}): ExamSprintState {
  const runId = `history-run-${state.runs.length}`;
  return {
    ...state,
    runs: [...state.runs, { id: runId, mode: "practice", questionIds: [questionId], startedAt: answeredAt, completedAt: answeredAt, deadlineAt: null }],
    attempts: [...state.attempts, { id: `history-attempt-${state.attempts.length}`, runId, questionId, presentedAt: answeredAt, answeredAt,
      answer: "A", correct: true, confidence: 3, durationSeconds: 10, help: [], errorCause: null, ...overrides }],
  };
}
const source = (state: ExamSprintState, overrides: Partial<Extract<ExamSprintCommand, { action: "source" }>> = {}, now = NOW) =>
  applyExamSprintCommand(state, { action: "source", clientKey: key, sourceId: "source-a", phase: "first", outcome: "correct", assistance: "none", durationMinutes: 5, errorCause: null, note: "", ...overrides }, pack, now);

describe("private immutable per-part grading", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const q = question("parts", "s1", { partSnapshot: { questionIdentityRefId: uuid(1), packId: pack.id, packVersion: pack.version,
    questionId: "parts", familyId: "family-parts", parts: [
      { partId: "left", identityRefId: uuid(2), requirementKey: "left", evaluator: { kind: "choice-options-v1", correctOptionIds: ["B"] } },
      { partId: "right", identityRefId: uuid(3), requirementKey: "right", evaluator: { kind: "choice-options-v1", correctOptionIds: ["A"] } },
    ] } });
  it("grades each trusted part, not the whole-question answer, independent of order", () => {
    const graded = evaluateExamQuestionParts(q, pack, "A", uuid(4), "revealed")!;
    expect(graded.parts.map(p => [p.partId, p.outcome, p.assistance])).toEqual([["left", "incorrect", "revealed"], ["right", "correct", "revealed"]]);
    const reversed = { ...q, partSnapshot: { ...q.partSnapshot!, parts: [...q.partSnapshot!.parts].reverse() } };
    expect(evaluateExamQuestionParts(reversed, pack, "A", uuid(4), "revealed")!.parts).toEqual([...graded.parts].reverse());
  });
  it("keeps missing or unverifiable part rules unknown and rejects a foreign revision", () => {
    const missing = structuredClone(q); delete missing.partSnapshot!.parts[1]!.evaluator;
    expect(evaluateExamQuestionParts(missing, pack, "A", uuid(4), "independent")!.parts[1]).toMatchObject({ outcome: "unknown", assistance: "unknown" });
    expect(() => evaluateExamQuestionParts(q, { ...pack, version: "other" }, "A", uuid(4), "independent")).toThrow("revision");
    expect(evaluateExamQuestionParts(question("legacy"), pack, "A", uuid(4), "independent")).toBeNull();
  });
  it("never leaks private refs/rules/results and keeps the whole-question timed score sealed", () => {
    const selectedPack = { ...pack, questions: [{ ...q, pool: "mock-a" as const }] };
    const answered = answer(start(createExamSprintState(NOW), "mock-a", NOW, selectedPack), "A", NOW, selectedPack);
    answered.attempts[0]!.resultMetadata = { questionEvaluation: evaluateExamQuestionParts(q, pack, "A", uuid(4), "independent")! };
    expect(answered.attempts[0]!.correct).toBe(true);
    const view = examSprintOverview(answered, selectedPack, NOW);
    expect(view.attempts[0]!.correct).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/partSnapshot|resultMetadata|questionIdentityRefId|correctOptionIds/);
  });
});

describe("atomic mock to teaching", () => {
  const selectedPack = EXAM_SPRINT_PACK;
  function pending() {
    let state = start(createExamSprintState(NOW), "mock-a", NOW, selectedPack);
    state = answer(state, selectedPack.questions.find(q => q.id === state.attempts[0]!.questionId)!.answer, NOW, selectedPack);
    return applyExamSprintCommand(state, { action: "next", runId: state.runs[0]!.id, clientKey: "next-request-key" }, selectedPack, NOW);
  }
  function command(state: ExamSprintState): Extract<ExamSprintCommand, { action: "switch_to_teaching" }> {
    const attempt = state.attempts.at(-1)!, lessonId = selectedPack.questions.find(q => q.id === attempt.questionId)!.lessonId;
    const mapping = validExamLessonExposure(selectedPack.lessons.find(l => l.id === lessonId)!)!;
    return { action: "switch_to_teaching", clientKey: "conversion-request-key", expectedRunId: state.runs[0]!.id,
      expectedAttemptId: attempt.id, lessonId, packVersion: selectedPack.version, contentFingerprint: mapping.contentFingerprint,
      mappingVersion: mapping.mappingVersion, confirmedEndScoredMock: true };
  }
  it("ends only the original run, records real-time assistance and preserves sealed independent answers and whole scores", () => {
    const state = pending(), input = command(state), now = "2026-10-17T08:01:00.000Z";
    const converted = applyExamSprintCommand(state, input, selectedPack, now);
    expect(converted.attempts[0]).toEqual(state.attempts[0]);
    expect(converted.runs[0]).toMatchObject({ ...state.runs[0], completedAt: now, conversion: {
      runId: input.expectedRunId, attemptId: input.expectedAttemptId, convertedAt: now, packId: selectedPack.id, packVersion: selectedPack.version } });
    expect(converted.attempts.at(-1)).toMatchObject({ answer: null, answeredAt: null, correct: null,
      help: [{ kind: "solution", at: now }], lessonExposureIds: [converted.runs[0]!.conversion!.exposureId] });
    const view = examSprintOverview(converted, selectedPack, now);
    expect(view.activeRun).toBeNull(); expect(view.lessonContents.some(c => c.exposureId === converted.runs[0]!.conversion!.exposureId)).toBe(true);
    expect(view.attempts[0]).toMatchObject({ correct: true, independent: true });
    expect(view.attempts.at(-1)!.independent).toBe(false);
    expect(() => start(converted, "mock-a", now, selectedPack)).toThrow("不能重复");
    expect(() => applyExamSprintCommand(converted, { action: "next", runId: input.expectedRunId, clientKey: key }, selectedPack, now)).toThrow("没有进行");
    expect(state.runs[0]!.completedAt).toBeNull(); expect(state.lessonExposures).toEqual([]);
  });
  it("returns the conversion receipt even when the same lesson was previously opened in practice", () => {
    const state = pending(), input = command(state), mapping = validExamLessonExposure(selectedPack.lessons.find(l => l.id === input.lessonId)!)!;
    state.lessonExposures!.push({ id: "old-lesson-receipt", clientKey: "previous-lesson-key", openedAt: NOW, runId: null,
      lessonId: input.lessonId, packId: selectedPack.id, packVersion: selectedPack.version, ...mapping });
    const converted = applyExamSprintCommand(state, input, selectedPack, "2026-10-17T08:01:00.000Z");
    const view = examSprintOverview(converted, selectedPack, NOW);
    expect(view.lessonContents.find(c => c.lesson.id === input.lessonId)?.exposureId).toBe(converted.runs[0]!.conversion!.exposureId);
  });
  it("rejects stale attempts, answered captures, practice, other lessons and untrusted mappings without partial mutation", () => {
    const state = pending(), input = command(state), before = structuredClone(state);
    for (const invalid of [{ ...input, expectedAttemptId: state.attempts[0]!.id }, { ...input, expectedRunId: "stale" },
      { ...input, packVersion: "other" }, { ...input, contentFingerprint: "forged" }, { ...input, mappingVersion: "other" },
      { ...input, lessonId: "other" }]) expect(() => applyExamSprintCommand(state, invalid, selectedPack, NOW)).toThrow();
    expect(() => applyExamSprintCommand(answer(state, "A", NOW, selectedPack), input, selectedPack, NOW)).toThrow("已改变");
    const legacy = structuredClone(selectedPack); legacy.lessons.forEach(l => { l.workedExample = "unreviewed"; });
    expect(() => applyExamSprintCommand(state, input, legacy, NOW)).toThrow("曝光映射");
    const practice = structuredClone(state); practice.runs[0]!.mode = "practice";
    expect(() => applyExamSprintCommand(practice, input, selectedPack, NOW)).toThrow("已改变");
    expect(state).toEqual(before);
  });
  it("rejects switch_to_teaching once the mock deadline has been reached or passed without mutating state", () => {
    const state = pending(), input = command(state), before = structuredClone(state);
    const deadline = state.runs[0]!.deadlineAt!;
    const afterDeadline = new Date(Date.parse(deadline) + 1000).toISOString();
    expect(() => applyExamSprintCommand(state, input, selectedPack, deadline)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => applyExamSprintCommand(state, input, selectedPack, afterDeadline)).toThrow("模拟时间已到");
    expect(state).toEqual(before);
  });
});

describe("exam sprint sessions and selection", () => {
  it("creates deterministic immutable diagnostics with one or two questions per topic and no reserved questions", () => {
    const initial = createExamSprintState(NOW);
    const state = start(initial);
    expect(state).toEqual(start(initial));
    expect(initial.runs).toEqual([]);
    expect(state.attempts).toHaveLength(1);
    expect(state.runs[0]!.questionIds).toHaveLength(4);
    for (const topic of pack.topics) expect(state.runs[0]!.questionIds.filter(id => pack.questions.find(item => item.id === id)?.topicId === topic.id)).toHaveLength(2);
    expect(state.runs[0]!.questionIds.every(id => pack.questions.find(item => item.id === id)?.pool === "training")).toBe(true);
    const longKey = applyExamSprintCommand(initial, { action: "start", mode: "diagnostic", clientKey: "x".repeat(200) }, pack, NOW);
    expect(longKey.runs[0]!.id.length).toBeLessThanOrEqual(100);
    expect(longKey.attempts[0]!.id.length).toBeLessThanOrEqual(100);
  });

  it("enforces one run, current-answer-only, valid options, answer permanence and no skipping", () => {
    const state = start();
    expect(() => start(state, "practice")).toThrow("当前");
    expect(() => applyExamSprintCommand(state, { action: "next", clientKey: key, runId: state.runs[0]!.id }, pack, NOW)).toThrow("先作答");
    expect(() => answer(state, "C")).toThrow("有效选项");
    const answered = answer(state);
    expect(() => answer(answered)).toThrow("不能覆盖");
    expect(state.attempts[0]!.answeredAt).toBeNull();
    const next = applyExamSprintCommand(answered, { action: "next", clientKey: key, runId: state.runs[0]!.id }, pack, NOW);
    expect(next.attempts).toHaveLength(2);
    expect(() => applyExamSprintCommand(next, { action: "answer", clientKey: key, attemptId: next.attempts[0]!.id, answer: "A", confidence: 2 }, pack, NOW)).toThrow("当前题目");
  });

  it("allocates 6 foundation, 3 targeted and 1 transfer slots, preferring unseen questions", () => {
    const previous = addEvidence(createExamSprintState(NOW), "s1-0", NOW, { correct: false, answer: "B", errorCause: "method" });
    const state = start(previous, "practice");
    const selected = state.runs.at(-1)!.questionIds;
    expect(selected).toHaveLength(10);
    expect(selected.filter(id => id.startsWith("s1-"))).toHaveLength(3);
    expect(selected).not.toContain("s1-0");
    expect(selected).toContain("transfer");
    expect(examSprintOverview(previous, pack, NOW).recommendations.at(-1)!.reason).toContain("6/3/1");
  });

  it("discloses insufficient practice quota instead of pretending complete coverage", () => {
    const smallPack = { ...pack, questions: [question("only")] };
    const state = start(undefined, "practice", NOW, smallPack);
    expect(state.runs[0]!.questionIds).toEqual(["only"]);
    expect(examSprintOverview(createExamSprintState(NOW), smallPack, NOW).recommendations.at(-1)!.reason).toContain("不足");
  });

  it.each(EXAM_SPRINT_PACK.topics)("starts up to three training questions only from $title", ({ id, title }) => {
    const initial = createExamSprintState(NOW);
    const command = { action: "start", mode: "practice", topicId: id, clientKey: key } as const;
    const started = applyExamSprintCommand(initial, command, EXAM_SPRINT_PACK, NOW);
    const run = started.runs[0]!;
    expect(run.questionIds).toHaveLength(3);
    expect(run.questionIds.map(id => EXAM_SPRINT_PACK.questions.find(question => question.id === id)))
      .toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ topicId: id, pool: "training" })));
    expect(run.deadlineAt).toBeNull();
    const note = examSprintOverview(started, EXAM_SPRINT_PACK, NOW).recommendations.at(-1)!.reason;
    expect(note).toContain("本轮共 3 题");
    expect(note).toContain(title);
    expect(initial.runs).toEqual([]);
    expect(() => applyExamSprintCommand(started, command, EXAM_SPRINT_PACK, NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("prioritizes weak skills before fresh families while keeping questions unseen", () => {
    const selectedPack = { ...pack, questions: [
      question("unseen-strong", "s2"), question("weak-seen", "s1", { familyId: "seen-family" }),
      question("weak-new-same-family", "s1", { familyId: "seen-family" }), question("weak-fresh", "s1"),
      question("outside", "s3"), question("reserved", "s1", { pool: "mock-a" }),
    ] };
    const previous = addEvidence(createExamSprintState(NOW), "weak-seen", NOW, { correct: false, answer: "B" });
    const started = applyExamSprintCommand(previous, { action: "start", mode: "practice", topicId: "t1", clientKey: key }, selectedPack, NOW);
    expect(started.runs.at(-1)!.questionIds).toEqual(["weak-fresh", "weak-new-same-family", "unseen-strong"]);
  });

  it.each(["weak", "low-confidence"] as const)("puts a %s skill variant before a secure skill with a fresh family in chapter practice", status => {
    const selectedPack = { ...pack, questions: [
      question("secure-old-1", "s2"), question("secure-old-2", "s2"), question("secure-new", "s2"),
      question("priority-old", "s1", { familyId: "priority-family" }),
      question("priority-variant", "s1", { familyId: "priority-family" }),
    ] };
    let previous = addEvidence(createExamSprintState(NOW), "secure-old-1", NOW, { confidence: 5 });
    previous = addEvidence(previous, "secure-old-2", LATER, { confidence: 5 });
    previous = addEvidence(previous, "priority-old", LATER, { correct: status === "weak" ? false : true, confidence: status === "weak" ? 5 : 1 });
    const started = applyExamSprintCommand(previous, { action: "start", mode: "practice", topicId: "t1", clientKey: key }, selectedPack, LATER);
    expect(started.runs.at(-1)!.questionIds).toEqual(["priority-variant", "secure-new"]);
    expect(started.attempts.at(-1)!.firstFamilyExposure).toBe(false);
  });

  it("describes the fixed current practice question mix and chapters after a new answer", () => {
    const started = start(undefined, "practice");
    const fixedIds = [...started.runs[0]!.questionIds];
    const answered = answer(started, "B");
    const view = examSprintOverview(answered, pack, NOW);
    const note = view.recommendations.at(-1)!.reason;
    expect(view.activeRun!.questionIds).toEqual(fixedIds);
    expect(note).toContain("本轮共 10 题");
    expect(note).toContain("基础 9 题");
    expect(note).toContain("迁移 1 题");
    expect(note).toContain("Limits");
    expect(note).toContain("Calculus");
    expect(note).not.toContain("6/3/1");
    expect(note).toBe(examSprintOverview(started, pack, NOW).recommendations.at(-1)!.reason);
  });

  it("warns about same-family variants in the fixed chapter arrangement without presenting them early", () => {
    const selectedPack = { ...pack, questions: [
      question("same-1", "s1", { familyId: "shared" }), question("same-2", "s1", { familyId: "shared" }), question("other", "s1"),
    ] };
    const started = applyExamSprintCommand(createExamSprintState(NOW), { action: "start", mode: "practice", topicId: "t1", clientKey: key }, selectedPack, NOW);
    const view = examSprintOverview(started, selectedPack, NOW);
    expect(view.activeRun!.questionIds).toEqual(["same-1", "other", "same-2"]);
    expect(view.recommendations.at(-1)!.reason).toContain("同类变式");
    expect(started.attempts).toHaveLength(1);
    expect(started.attempts[0]!.firstFamilyExposure).toBe(true);
    expect(view.currentAttempt!.question.id).toBe("same-1");
  });
  it("stays in a short or empty chapter and rejects forged scope on other modes", () => {
    const initial = createExamSprintState(NOW);
    const smallPack = { ...pack, questions: [question("only"), question("outside", "s3", { pool: "mock-b" })] };
    const practice = { action: "start", mode: "practice", topicId: "t1", clientKey: key } as const;
    expect(applyExamSprintCommand(initial, practice, smallPack, NOW).runs[0]!.questionIds).toEqual(["only"]);
    expect(() => applyExamSprintCommand(initial, { ...practice, topicId: "t2" }, smallPack, NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => applyExamSprintCommand(initial, { ...practice, topicId: "unknown" }, smallPack, NOW)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    for (const mode of ["diagnostic", "retest", "mock-a", "mock-b"] as const) {
      expect(() => applyExamSprintCommand(initial, { ...practice, mode }, pack, NOW)).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    }
    const sealed = start(initial, "mock-b");
    expect(() => applyExamSprintCommand(sealed, practice, pack, NOW)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(examSprintOverview(sealed, pack, NOW).currentAttempt?.feedback).toBeNull();
  });

  it("starts default practice with weak skills even without a recorded error cause", () => {
    const previous = addEvidence(createExamSprintState(NOW), "s4-0", NOW, { correct: false, answer: "B" });
    const selected = start(previous, "practice").runs.at(-1)!.questionIds;
    expect(selected.slice(0, 3)).toEqual(["s4-1", "s4-2", "s4-3"]);
    expect(selected).not.toContain("s4-0");
  });

  it("prioritizes current low confidence and untested skills over secure skills without changing mastery", () => {
    const selectedPack = { ...pack, questions: [
      ...Array.from({ length: 12 }, (_, index) => question(`secure-${index}`, "s1")),
      question("uncertain-old", "s2"), question("uncertain-new", "s2"), question("untested", "s3"),
    ] };
    let previous = addEvidence(createExamSprintState(NOW), "secure-0", NOW, { confidence: 5 });
    previous = addEvidence(previous, "secure-1", LATER, { confidence: 5 });
    previous = addEvidence(previous, "uncertain-old", LATER, { confidence: 1 });
    const started = start(previous, "practice", LATER, selectedPack);
    expect(started.runs.at(-1)!.questionIds.slice(0, 2)).toEqual(["uncertain-new", "untested"]);
    expect(examSprintOverview(started, selectedPack, LATER).skills.find(skill => skill.skillId === "s2")!.status).toBe("usable");
  });

  it("keeps recovered secure skills behind untested skills despite a withdrawn historical success", () => {
    const selectedPack = { ...pack, questions: [
      ...Array.from({ length: 4 }, (_, index) => question(`recovered-${index}`, "s1")), question("untested", "s2"),
    ] };
    let previous = addEvidence(createExamSprintState(NOW), "recovered-0", NOW, { confidence: 5 });
    previous = addEvidence(previous, "recovered-1", NOW, { confidence: 5 });
    previous = addEvidence(previous, "recovered-2", LATER, { confidence: 5 });
    const context: ExamSelectionContext = { ruleEvidence: {
      [previous.attempts[0]!.id]: { usable: false, correct: null, independent: false, assisted: false },
    } };
    expect(examSprintOverview(previous, selectedPack, LATER, context).skills.find(skill => skill.skillId === "s1")!.status).toBe("secure");
    const started = applyExamSprintCommand(previous, { action: "start", clientKey: key, mode: "practice" }, selectedPack, LATER, context);
    expect(started.runs.at(-1)!.questionIds).toEqual(["untested", "recovered-3"]);
  });
  it("rotates unpresented questions from an ended practice instead of scheduling the same batch", () => {
    const initial = start(undefined, "practice");
    const closed = finish(initial);
    const next = start(closed, "practice");
    const unallocated = pack.questions.filter(question => question.pool === "training" && !initial.runs[0]!.questionIds.includes(question.id));
    expect(unallocated.every(question => next.runs.at(-1)!.questionIds.includes(question.id))).toBe(true);
    expect(next.runs.at(-1)!.questionIds).not.toContain(initial.attempts[0]!.questionId);
    expect(next.attempts[1]!.firstFamilyExposure).toBe(true);
  });

  it("shortens practice to unseen questions and reports exhausted training instead of repeating old questions", () => {
    const selectedPack = { ...pack, questions: [question("old"), question("new")] };
    const previous = addEvidence(createExamSprintState(NOW), "old", NOW);
    const started = start(previous, "practice", LATER, selectedPack);
    expect(started.runs.at(-1)!.questionIds).toEqual(["new"]);
    expect(examSprintOverview(started, selectedPack, LATER).recommendations.at(-1)!.reason).toContain("不足");
    const exhausted = finish(started, LATER, selectedPack);
    expect(() => start(exhausted, "practice", LATER, selectedPack)).toThrow("没有新的");
    expect(() => applyExamSprintCommand(exhausted, { action: "start", mode: "practice", topicId: "t1", clientKey: key }, selectedPack, LATER)).toThrow("没有新的");
  });

  it("puts a weak transfer question before general foundation coverage", () => {
    const selectedPack = { ...pack, questions: [...pack.questions,
      question("transfer-old", "s4", { difficulty: "transfer" }),
      question("transfer-new", "s4", { difficulty: "transfer" }),
    ].filter(question => question.skillId !== "s4" || question.difficulty === "transfer") };
    const previous = addEvidence(createExamSprintState(NOW), "transfer-old", NOW, { correct: false });
    expect(start(previous, "practice", LATER, selectedPack).runs.at(-1)!.questionIds[0]).toBe("transfer-new");
  });

  it("discloses missing new weak-skill questions while keeping other practice available", () => {
    const selectedPack = { ...pack, questions: [question("weak-old", "s4"), ...pack.questions.filter(question => question.skillId !== "s4")] };
    const previous = addEvidence(createExamSprintState(NOW), "weak-old", NOW, { correct: false });
    const started = start(previous, "practice", LATER, selectedPack);
    expect(started.runs.at(-1)!.questionIds).not.toContain("weak-old");
    expect(examSprintOverview(previous, selectedPack, LATER).recommendations.at(-1)!.reason).toContain("技能已无新题");
    expect(examSprintOverview(started, selectedPack, LATER).recommendations.at(-1)!.reason).toContain("本轮未安排");
  });
  it("ends a run with pending work while preserving answers and keeping a used mock consumed", () => {
    const answered = answer(start(undefined, "mock-a"));
    const pending = applyExamSprintCommand(answered, { action: "next", clientKey: key, runId: answered.runs[0]!.id }, pack, NOW);
    const closed = finish(pending);
    expect(closed.attempts).toEqual(pending.attempts);
    expect(closed.attempts[0]).toMatchObject({ answer: "A", correct: true });
    expect(closed.attempts[1]).toMatchObject({ answeredAt: null, answer: null, correct: null, errorCause: null });
    expect(examSprintOverview(closed, pack, NOW).summary.onlineAnswered).toBe(1);
    expect(examSprintOverview(closed, pack, NOW).skills.some(skill => skill.status === "weak")).toBe(false);
    expect(start(closed, "practice").runs.at(-1)!.mode).toBe("practice");
    expect(() => start(closed, "mock-a")).toThrow("已经开启过");
  });
  it("requires 24 hours after a failure and selects a different unseen family for retests", () => {
    const previous = addEvidence(createExamSprintState(NOW), "s1-0", NOW, { correct: false, answer: "B" });
    expect(() => start(previous, "retest", "2026-10-18T07:59:59.000Z")).toThrow("24 小时");
    const state = start(previous, "retest", LATER);
    expect(state.runs.at(-1)!.questionIds).toEqual(["s1-1"]);
    const exhaustedPack = { ...pack, questions: [pack.questions[0]!] };
    expect(() => start(previous, "retest", LATER, exhaustedPack)).toThrow("没有未见题");
  });

  it("also retests usable skills after 24 hours to verify retention", () => {
    const previous = addEvidence(createExamSprintState(NOW), "s1-0", NOW);
    expect(() => start(previous, "retest", "2026-10-18T07:59:59.000Z")).toThrow("24 小时");
    const state = answer(start(previous, "retest", LATER), "A", LATER);
    expect(examSprintOverview(state, pack, LATER).skills.find(skill => skill.skillId === "s1")!.status).toBe("secure");
  });

  it("allows early finish without inventing answers, and completes on next after the last answer", () => {
    const state = finish(start());
    expect(state.runs[0]!.completedAt).toBe(NOW);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]!.correct).toBeNull();
    expect(state.attempts[0]!.answeredAt).toBeNull();
    expect(examSprintOverview(state, pack, NOW).summary.onlineAnswered).toBe(0);
    expect(start(state, "practice").runs).toHaveLength(2);
    const tiny = { ...pack, questions: [question("only")] };
    const answered = answer(start(undefined, "diagnostic", NOW, tiny), "A", NOW, tiny);
    const completed = applyExamSprintCommand(answered, { action: "next", clientKey: key, runId: answered.runs[0]!.id }, tiny, NOW);
    expect(completed.runs[0]!.completedAt).toBe(NOW);
  });
});

describe("exam sprint answer isolation and evidence", () => {
  it("seals mock feedback and all correctness-derived summaries until submission", () => {
    const state = start(undefined, "mock-a");
    expect(state.runs[0]!.questionIds).toEqual(["mock-a-1", "mock-a-2"]);
    expect(state.runs[0]!.deadlineAt).toBe("2026-10-17T08:06:00.000Z");
    const correct = examSprintOverview(answer(state, "A"), pack, NOW);
    const incorrect = examSprintOverview(answer(state, "B"), pack, NOW);
    expect(correct.currentAttempt).toMatchObject({ correct: null, feedback: null, hint: null, independent: false });
    expect(correct.summary).toEqual(incorrect.summary);
    expect(correct.skills).toEqual(incorrect.skills);
    expect(correct.recommendations).toEqual(incorrect.recommendations);
    expect(correct.summary.onlineAnswered).toBe(0);
    expect(JSON.stringify(correct)).not.toContain("SECRET");
    expect(correct.pack).not.toHaveProperty("questions");
    expect(correct.currentAttempt!.question).not.toHaveProperty("answer");
    expect(correct.state).not.toHaveProperty("attempts");
    const submitted = examSprintOverview(finish(answer(state, "A")), pack, NOW);
    expect(submitted.currentAttempt).toBeNull();
    expect(submitted.attempts[0]).toMatchObject({ correct: true, independent: true, feedback: { answer: "A" } });
    expect(submitted.summary.onlineIndependentCorrect).toBe(1);
  });

  it("forbids help and late mock answers while permitting submission with unanswered items", () => {
    const state = start(undefined, "mock-a");
    expect(() => applyExamSprintCommand(state, { action: "help", clientKey: key, attemptId: state.attempts[0]!.id, kind: "solution" }, pack, NOW)).toThrow("不提供帮助");
    expect(() => answer(state, "A", "2026-10-17T08:06:00.000Z")).toThrow("时间已到");
    const closed = finish(state, "2026-10-17T08:07:00.000Z");
    expect(closed.attempts[0]!.correct).toBeNull();
    expect(examSprintOverview(closed, pack, NOW).attempts[0]!.feedback).toBeNull();
    expect(() => start(closed, "mock-a", LATER)).toThrow("已经开启过");
    expect(start(closed, "mock-b", LATER).runs.at(-1)!.mode).toBe("mock-b");
  });

  it.each(["hint", "solution", "external"] as const)("records %s help and excludes the answer from independent evidence", kind => {
    const state = start();
    const helped = applyExamSprintCommand(state, { action: "help", clientKey: key, attemptId: state.attempts[0]!.id, kind }, pack, NOW);
    const before = examSprintOverview(helped, pack, NOW).currentAttempt!;
    expect(before.correct).toBeNull();
    expect(before.feedback !== null).toBe(kind === "solution");
    expect(before.hint !== null).toBe(kind === "hint");
    const overview = examSprintOverview(answer(helped), pack, NOW);
    expect(overview.currentAttempt!.independent).toBe(false);
    expect(overview.summary.onlineIndependentCorrect).toBe(0);
    expect(overview.skills.find(skill => skill.skillId === "s1")!.status).toBe("weak");
  });

  it("requires new families and delayed independent successes, and repeated correct answers cannot erase failures", () => {
    const related = { ...pack, questions: [...pack.questions, question("same-family", "s1", { familyId: "family-s1-0" })] };
    let state = addEvidence(createExamSprintState(NOW), "s1-0", NOW);
    state = addEvidence(state, "same-family", LATER);
    let skill = examSprintOverview(state, related, LATER).skills.find(item => item.skillId === "s1")!;
    expect(skill).toMatchObject({ status: "usable", independentCorrect: 1 });
    state = addEvidence(state, "s1-1", LATER);
    skill = examSprintOverview(state, related, LATER).skills.find(item => item.skillId === "s1")!;
    expect(skill.status).toBe("secure");
    state = addEvidence(state, "s1-2", "2026-10-19T08:00:00.000Z", { correct: false });
    state = addEvidence(state, "s1-0", "2026-10-20T08:00:00.000Z");
    expect(examSprintOverview(state, related, LATER).skills.find(item => item.skillId === "s1")!.status).toBe("weak");
    const sameDay = addEvidence(addEvidence(createExamSprintState(NOW), "s1-0", NOW), "s1-1", "2026-10-17T09:00:00.000Z");
    expect(examSprintOverview(sameDay, related, LATER).skills.find(item => item.skillId === "s1")!.status).toBe("usable");
  });

  it("does not expose or mutate server-side answers through overview references", () => {
    const state = start();
    const view = examSprintOverview(state, pack, NOW);
    view.currentAttempt!.question.options[0]!.label = "changed";
    view.state.runs[0]!.questionIds.push("fake");
    view.pack.lessons[0]!.title = "changed";
    expect(view.pack.lessons[0]).not.toHaveProperty("steps");
    expect(state.runs[0]!.questionIds).not.toContain("fake");
    expect(pack.lessons[0]!.steps).toEqual([]);
    expect(pack.lessons[0]!.title).toBe("s1");
    expect(pack.questions[0]!.options[0]!.label).toBe("One");
  });
});

describe("source self-report and workload", () => {
  it("uses only explicitly mapped latest self-reported failures to rank practice, without adding mastery", () => {
    const initial = createExamSprintState(NOW);
    const failed = source(initial, { sourceId: "source-c", outcome: "incorrect", errorCause: "method" });
    const prioritized = start(failed, "practice", LATER);
    expect(prioritized.runs[0]!.questionIds[0]).toBe("s3-0");
    const overview = examSprintOverview(prioritized, pack, LATER);
    expect(overview.skills.every(skill => skill.status === "untested")).toBe(true);
    expect(prioritized.attempts[0]!.prediction!.historyAttemptIds).toEqual([]);
    expect(examSprintOverview(failed, pack, LATER).recommendations.at(-1)!.reason).toContain("仅提高相关题");
    expect(examSprintOverview(failed, pack, LATER).recommendations.at(-1)!.reason).not.toContain("BKT证据");
    const unmapped = { ...pack, sourceItems: pack.sourceItems.map(item => ({ ...item, skills: [] })) };
    expect(start(failed, "practice", LATER, unmapped).runs[0]!.questionIds).toEqual(start(initial, "practice", LATER, unmapped).runs[0]!.questionIds);
    const recovered = source(failed, { sourceId: "source-c", phase: "blind", outcome: "correct", assistance: "none" }, LATER);
    expect(start(recovered, "practice", LATER).runs[0]!.questionIds[0]).toBe("s1-0");
    const helped = source(initial, { sourceId: "source-c", outcome: "correct", assistance: "hint" });
    expect(start(helped, "practice", LATER).runs[0]!.questionIds[0]).toBe("s3-0");
  });

  it("retains original work references and review markers as self-report data", () => {
    const state = source(createExamSprintState(NOW), {
      answerText: "u=x, dv=e^x dx", workSourceId: "work-source", workSourceVersion: 2, reviewId: "review-id", referenceChecked: true,
    });
    expect(state.sourceRecords[0]).toMatchObject({
      answerText: "u=x, dv=e^x dx", workSourceId: "work-source", workSourceVersion: 2, reviewId: "review-id", referenceChecked: true,
    });
    expect(examSprintOverview(state, pack, NOW).skills.every(skill => skill.status === "untested")).toBe(true);
  });

  it("validates source identity, first/blank/delayed/variant progression and elapsed time", () => {
    const initial = createExamSprintState(NOW);
    expect(() => source(initial, { sourceId: "missing" })).toThrow("不存在");
    expect(() => source(initial, { phase: "blind" })).toThrow("首次");
    expect(() => source(initial, { durationMinutes: 0 })).toThrow("大于零");
    const first = source(initial);
    expect(() => source(first, {}, LATER)).toThrow("首次学习已记录");
    expect(source(first, { phase: "delayed" }, LATER).sourceRecords.at(-1)!.phase).toBe("delayed");
    const assisted = source(initial, { assistance: "solution" });
    expect(() => source(assisted, { phase: "delayed" }, LATER)).toThrow("盲做");
    expect(() => source(first, { phase: "variant" }, LATER)).toThrow("隔日独立正确");
    const blind = source(first, { phase: "blind" }, "2026-10-17T09:00:00.000Z");
    expect(() => source(blind, { phase: "delayed" }, LATER)).toThrow("24 小时");
    const delayed = source(blind, { phase: "delayed" }, "2026-10-18T09:00:00.000Z");
    expect(() => source(delayed, { phase: "variant" }, "2026-10-18T10:00:00.000Z")).toThrow("陌生变式");
    const variant = source(delayed, { phase: "variant", note: "另一份卷子第六题，改变函数形式" }, "2026-10-18T10:00:00.000Z");
    expect(variant.sourceRecords.map(record => record.phase)).toEqual(["first", "blind", "delayed", "variant"]);
    const view = examSprintOverview(variant, pack, LATER);
    expect(view.summary).toMatchObject({ sourceCovered: 1, sourceIndependent: 1, sourceDelayed: 1, onlineIndependentCorrect: 0 });
    expect(view.skills.every(skill => skill.status === "untested")).toBe(true);
  });

  it("does not count reading as coverage or assisted work as independent success", () => {
    let state = source(createExamSprintState(NOW), { outcome: "read", assistance: "solution", durationMinutes: 0 });
    expect(examSprintOverview(state, pack, NOW).summary).toMatchObject({ sourceCovered: 0, sourceIndependent: 0 });
    state = source(state, { sourceId: "source-b", assistance: "hint" });
    expect(examSprintOverview(state, pack, NOW).summary).toMatchObject({ sourceCovered: 1, sourceIndependent: 0 });
    state = source(state, { sourceId: "source-b", phase: "blind", assistance: "solution" }, LATER);
    expect(state.sourceRecords.at(-1)!.assistance).toBe("solution");
    state = source(state, { sourceId: "source-b", phase: "delayed", assistance: "hint" }, "2026-10-19T08:00:00.000Z");
    expect(examSprintOverview(state, pack, NOW).summary.sourceDelayed).toBe(0);
  });

  it("keeps unknown workloads unknown, then estimates by observed source type and reserves the last two days", () => {
    let state = applyExamSprintCommand(createExamSprintState(NOW), { action: "configure", clientKey: key, examDate: "2026-10-20", dailyMinutes: 30 }, pack, NOW);
    expect(examSprintOverview(state, pack, NOW).workload).toMatchObject({ estimatedMinutes: null, availableMinutes: 30, remainingItems: 4 });
    state = source(state, { durationMinutes: 10 });
    expect(examSprintOverview(state, pack, NOW).workload.estimatedMinutes).toBeNull();
    state = source(state, { sourceId: "source-c", durationMinutes: 40 });
    expect(examSprintOverview(state, pack, NOW).workload).toMatchObject({ remainingItems: 2, estimatedMinutes: 50, availableMinutes: 30, overloaded: true });
    expect(examSprintOverview(state, pack, LATER).workload.availableMinutes).toBe(0);
    expect(examSprintOverview(createExamSprintState(NOW), pack, NOW).workload.availableMinutes).toBeNull();
  });
});

describe("current formal qualification and retained sprint history", () => {
  const valid = { usable: true, correct: true, independent: true, assisted: false };
  const withdrawn = { usable: false, correct: null, independent: false, assisted: false };

  it("removes withdrawn/private success from mastery and targets a fresh confirmation without deleting history", () => {
    const state = addEvidence(addEvidence(createExamSprintState(NOW), "s3-0", NOW), "s3-1", LATER);
    expect(examSprintOverview(state, pack, LATER).skills.find(skill => skill.skillId === "s3")!.status).toBe("secure");
    const context: ExamSelectionContext = { bktEligibleAttemptIds: [], ruleEvidence: {
      [state.attempts[0]!.id]: withdrawn, [state.attempts[1]!.id]: withdrawn,
    } };
    const before = structuredClone(state);
    const view = examSprintOverview(state, pack, LATER, context);
    expect(view.skills.find(skill => skill.skillId === "s3")).toMatchObject({ status: "untested", independentCorrect: 0 });
    expect(view.summary.onlineIndependentCorrect).toBe(0);
    expect(view.attempts).toHaveLength(2);
    expect(view.attempts.every(attempt => attempt.correct === true && attempt.independent === false)).toBe(true);
    expect(view.recommendations.some(item => item.title === "重新确认：s3" && item.mode === "practice")).toBe(true);
    expect(view.skills.find(skill => skill.skillId === "s3")!.reason).not.toContain("资格");
    expect(view.recommendations.at(-1)!.reason).not.toContain("资格");
    const practice = applyExamSprintCommand(state, { action: "start", clientKey: key, mode: "practice" }, pack, LATER, context);
    expect(practice.runs.at(-1)!.questionIds).toEqual(expect.arrayContaining(["s3-2", "s3-3"]));
    expect(practice.runs.at(-1)!.questionIds.filter(id => id.startsWith("s3-"))).toEqual(["s3-2", "s3-3"]);
    expect(state).toEqual(before);
  });

  it("uses a live incorrect revision to require remediation, while a correction cannot create a new first success", () => {
    const state = addEvidence(addEvidence(createExamSprintState(NOW), "s1-0", NOW), "s1-1", LATER);
    const context: ExamSelectionContext = { ruleEvidence: {
      [state.attempts[0]!.id]: valid,
      [state.attempts[1]!.id]: { ...valid, correct: false, independent: false },
    } };
    const view = examSprintOverview(state, pack, LATER, context);
    expect(view.skills.find(skill => skill.skillId === "s1")).toMatchObject({ status: "weak", independentCorrect: 1 });
    expect(view.summary.onlineIndependentCorrect).toBe(1);
    expect(view.attempts[1]!.correct).toBe(true); // Captured first-answer history is unchanged.
    const originallyWrong = addEvidence(createExamSprintState(NOW), "s1-0", NOW, { correct: false, answer: "B" });
    const corrected = examSprintOverview(originallyWrong, pack, LATER, { ruleEvidence: { [originallyWrong.attempts[0]!.id]: { ...valid, independent: false } } });
    expect(corrected.skills.find(skill => skill.skillId === "s1")).toMatchObject({ status: "weak", independentCorrect: 0 });
  });

  it("keeps assisted/failed evidence for remediation even when BKT excludes every record", () => {
    const state = addEvidence(addEvidence(createExamSprintState(NOW), "s2-0", NOW), "s2-1", LATER, { correct: false, answer: "B" });
    const context: ExamSelectionContext = { bktEligibleAttemptIds: [], ruleEvidence: {
      [state.attempts[0]!.id]: { ...valid, independent: false, assisted: true },
      [state.attempts[1]!.id]: { ...valid, independent: false, correct: false },
    } };
    const view = examSprintOverview(state, pack, LATER, context);
    expect(view.skills.find(skill => skill.skillId === "s2")).toMatchObject({ status: "weak", attempted: 2, independentCorrect: 0 });
    expect(view.summary.onlineAnswered).toBe(2);
    const onlyAssisted = { ...state, runs: state.runs.slice(0, 1), attempts: state.attempts.slice(0, 1) };
    expect(examSprintOverview(onlyAssisted, pack, LATER, context).skills.find(skill => skill.skillId === "s2")!.status).toBe("weak");
  });

  it("allows fresh independent evidence to restore confidence after historical evidence was withdrawn", () => {
    let state = addEvidence(addEvidence(createExamSprintState(NOW), "s3-0", NOW), "s3-1", LATER);
    const context: ExamSelectionContext = { ruleEvidence: { [state.attempts[0]!.id]: withdrawn, [state.attempts[1]!.id]: withdrawn } };
    state = addEvidence(state, "s3-2", "2026-10-19T08:00:00.000Z");
    state = addEvidence(state, "s3-3", "2026-10-20T08:00:00.000Z");
    const view = examSprintOverview(state, pack, "2026-10-20T08:00:00.000Z", context);
    expect(view.skills.find(skill => skill.skillId === "s3")).toMatchObject({ status: "secure", independentCorrect: 2 });
    expect(view.recommendations.some(item => item.lessonId === "lesson-s3")).toBe(false);
  });

  it("permits honest external-help registration during a sealed mock without revealing answers", () => {
    let state = start(undefined, "mock-a");
    state = applyExamSprintCommand(state, { action: "help", clientKey: key, attemptId: state.attempts[0]!.id, kind: "external" }, pack, NOW);
    state = answer(state);
    expect(examSprintOverview(state, pack, NOW).currentAttempt).toMatchObject({ correct: null, feedback: null, hint: null, independent: false });
    const view = examSprintOverview(finish(state), pack, LATER);
    expect(view.attempts[0]).toMatchObject({ correct: true, independent: false });
    expect(view.summary.onlineIndependentCorrect).toBe(0);
    expect(view.skills.find(skill => skill.skillId === "s1")!.status).toBe("weak");
  });

  it("removes private/stale paper records from current priorities and workload while retaining their originals", () => {
    const initial = createExamSprintState(NOW);
    let state = source(initial, { sourceId: "source-c", outcome: "incorrect", errorCause: "method", durationMinutes: 40 });
    state = source(state, { sourceId: "source-a", outcome: "correct", durationMinutes: 10 });
    const excluded = Object.fromEntries(state.sourceRecords.map(record => [record.id, false]));
    const context: ExamSelectionContext = { sourceRecordEligibility: excluded, sourceCoverageEligibility: excluded };
    const view = examSprintOverview(state, pack, LATER, context);
    expect(view.state.sourceRecords).toEqual(state.sourceRecords);
    expect(view.summary).toMatchObject({ sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0 });
    expect(view.workload).toMatchObject({ remainingItems: 4, estimatedMinutes: null });
    const selected = applyExamSprintCommand(state, { action: "start", mode: "practice", clientKey: key }, pack, LATER, context);
    expect(selected.runs[0]!.questionIds).toEqual(start(initial, "practice", LATER).runs[0]!.questionIds);
    expect(view.recommendations.at(-1)!.reason).not.toContain("纸笔自评错误");
  });

  it("preserves actual paper coverage and timing when old or unmapped work has no canonical link", () => {
    const initial = createExamSprintState(NOW);
    let state = source(initial, { sourceId: "source-c", outcome: "incorrect", errorCause: "method", durationMinutes: 40 });
    state = source(state, { sourceId: "source-a", outcome: "correct", durationMinutes: 10 });
    const context: ExamSelectionContext = {
      sourceRecordEligibility: Object.fromEntries(state.sourceRecords.map(record => [record.id, false])),
      sourceCoverageEligibility: {}, // No known withdrawal/privacy/version invalidation.
    };
    for (const selectedPack of [pack, { ...pack, sourceItems: pack.sourceItems.map(item => ({ ...item, skills: [] })) }]) {
      const view = examSprintOverview(state, selectedPack, LATER, context);
      expect(view.summary).toMatchObject({ sourceCovered: 2, sourceIndependent: 1, onlineIndependentCorrect: 0 });
      expect(view.workload).toMatchObject({ remainingItems: 2, estimatedMinutes: 50 });
      expect(view.state.sourceRecords).toEqual(state.sourceRecords);
      expect(view.skills.every(skill => skill.status === "untested")).toBe(true);
      expect(view.recommendations.at(-1)!.reason).not.toContain("纸笔自评错误");
      const practice = applyExamSprintCommand(state, { action: "start", mode: "practice", clientKey: key }, selectedPack, LATER, context);
      expect(practice.runs[0]!.questionIds).toEqual(start(initial, "practice", LATER, selectedPack).runs[0]!.questionIds);
    }
  });
});
