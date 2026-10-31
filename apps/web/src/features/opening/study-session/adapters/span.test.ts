import { expect, it } from "vitest";
import { createSpanTeachingSequence, getSpanProblem, solveSpanProblem, spanModeForIntent, verifySpanAnswer } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation, StudySessionIntent } from "@aistudy/contracts";
import { updateSpanDraftAnswer } from "../../teaching/span/span-answer";
import { adaptSpanHelp, adaptSpanNext, adaptSpanResult } from "./span";
import { spanLessonMoves, spanLessonProblemId, spanPracticeMoveId } from "../../teaching/span/span-lesson-moves";
import { spanSessionProblemIds } from "../../teaching/span/session-service";
import { spanDiagnosticNextStep } from "../../teaching/span/span-diagnostic";

const id = "11111111-1111-4111-8111-111111111111";
const intent = (purpose: StudySessionIntent["purpose"]): StudySessionIntent =>
  ({ purpose, timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" });

it("uses the legacy lesson steps, and records only teaching moves the session service accepts", () => {
  const expected = { self_study: ["span-faded-3d", "span-independent-3d"], overview: ["span-contrast-dependent", "span-geometry-transfer"], challenge: ["span-geometry-transfer"] };
  for (const purpose of ["self_study", "overview", "challenge"] as const) {
    const mode = spanModeForIntent(intent(purpose));
    const moves = spanLessonMoves(mode);
    const problems = moves.slice(1).map((_, index) => spanLessonProblemId(mode, index + 1, moves.length));
    expect(problems).toEqual([...expected[mode], "reserved:auto"]);
    // session-service.ts only accepts a move from the teaching sequence ("教学动作不属于本次学习目的" otherwise).
    const accepted = createSpanTeachingSequence(mode).map(move => move.id);
    for (const problemId of problems) expect(accepted).toContain(spanPracticeMoveId(purpose, problemId));
    for (const problemId of problems.slice(0, -1)) expect(spanSessionProblemIds(intent(purpose))).toContain(problemId);
  }
});

// Minimal answers a learner gives on each lesson problem, encoded by the shared form helper.
const encode = (change: Parameters<typeof updateSpanDraftAnswer>[1]) => JSON.parse(updateSpanDraftAnswer("", change)) as unknown;
const gradable: Record<string, { right: Parameters<typeof updateSpanDraftAnswer>[1]; wrong: Parameters<typeof updateSpanDraftAnswer>[1] }> = {
  "span-faded-3d": { right: { membership: "in_span", coefficients: ["2", "-1"] }, wrong: { membership: "in_span", coefficients: ["9", "9"] } },
  "span-contrast-dependent": { right: { membership: "in_span", coefficients: ["3", "0"] }, wrong: { membership: "in_span", coefficients: ["1", "1"] } },
  // No solution: candidate coefficients from two coordinates, all coordinate checks, and which coordinates were used.
  "span-independent-3d": { right: { membership: "not_in_span", coefficients: ["2", "2"], coordinateChecks: ["2", "4", "2"], coefficientDerivationCoordinates: [0, 2] }, wrong: { membership: "in_span", coefficients: ["2", "2"] } },
  "span-geometry-transfer": { right: { membership: "not_in_span", coefficients: ["1", "2"], coordinateChecks: ["1", "2", "3"], coefficientDerivationCoordinates: [0, 1] }, wrong: { membership: "in_span", coefficients: ["1", "2"] } },
};

it("every lesson problem is graded right or wrong by the real verifier from the form's encoding", () => {
  for (const [problemId, answers] of Object.entries(gradable)) {
    const problem = getSpanProblem(problemId)!;
    expect(verifySpanAnswer(problem, encode(answers.right)), problemId).toMatchObject({ outcome: "correct" });
    expect(verifySpanAnswer(problem, encode(answers.wrong)).outcome, problemId).toBe("incorrect");
  }
  // Opening the optional working section without filling it must not break grading.
  expect(verifySpanAnswer(getSpanProblem("span-faded-3d")!, encode({ ...gradable["span-faded-3d"]!.right, representations: {} })).outcome).toBe("correct");
  expect(solveSpanProblem(getSpanProblem("span-independent-3d")!).kind).toBe("none");
});

it("labels results from evaluation and help separately", () => {
  const record = { assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as unknown as LearningObservation;
  expect(adaptSpanResult(record)).toMatchObject({ outcome: "correct", assistance: "hinted" });
  expect(adaptSpanResult(record).detail).toContain("一致");
  expect(adaptSpanResult({ ...record, serverEvaluation: null } as LearningObservation, "grading").outcome).toBe("pending");
});

it("selects the first failed coordinate from the real verifier without exposing an answer", () => {
  const problem = getSpanProblem("span-faded-3d")!;
  const answer = encode({ membership: "in_span", coefficients: ["9", "9"] });
  const attempt = { id, spanExercise: problem } as LearningAttempt;
  const record = { id, answer: JSON.stringify(answer), serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } } as unknown as LearningObservation;
  const next = spanDiagnosticNextStep(record, attempt);
  expect(next).toMatchObject({ label: "先回到原题重算" });
  expect(next?.action).toContain("第");
  expect(next?.action).not.toContain("=");
});

it("does not diagnose unknown, revised, or non-span results", () => {
  const record = { id, answer: "{}", serverEvaluation: { evaluatorVersion: "matrix-exact-v1", decision: "incorrect" } } as unknown as LearningObservation;
  expect(spanDiagnosticNextStep(record, undefined)).toBeNull();
  const attempt = { id, spanExercise: getSpanProblem("span-faded-3d"), spanValidation: { reasonCode: "restored_identity_unverified" } } as unknown as LearningAttempt;
  expect(spanDiagnosticNextStep({ ...record, serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } } as LearningObservation, attempt)).toBeNull();
});

it("offers the next hint level and holds the full demonstration until the first answer is saved", () => {
  const help = adaptSpanHelp("hinted", [{ level: 1, text: "a" }, { level: 2, text: "b" }, { level: 3, text: "c" }], false, false);
  expect(help.next).toBeNull();
  expect(help.blockedReason).toContain("先提交");
  expect(adaptSpanHelp("hinted", [{ level: 1, text: "a" }, { level: 2, text: "b" }, { level: 3, text: "c" }], true, true).next).toMatchObject({ level: 4 });
  expect(adaptSpanHelp("none", [], false, false).next).toMatchObject({ level: 1 });
});

it("validates successor links with the legacy rule and keeps choices", () => {
  const href = `/opening/courses/${id}/study/span?lesson=${id}`;
  expect(adaptSpanNext({ kind: "ready", href, activityId: id, sessionId: id, courseId: id, label: "继续新题", resumed: false }, id)).toMatchObject({ href, label: "继续新题" });
  expect(() => adaptSpanNext({ kind: "choice", reason: "source_unavailable", message: "资料不可用", primary: { href: "https://evil.test", label: "继续" } }, id)).toThrow();
  expect(() => adaptSpanNext({ kind: "ready", href: `/opening/courses/${id}/study/span?lesson=${id}`, activityId: id, sessionId: id, courseId: "22222222-2222-4222-8222-222222222222", label: "x", resumed: false }, id)).toThrow();
});
