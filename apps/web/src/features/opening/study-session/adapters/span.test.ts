import { expect, it } from "vitest";
import { createSpanTeachingSequence, getSpanProblem, solveSpanProblem, spanModeForIntent, verifySpanAnswer } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation, StudySessionIntent } from "@aistudy/contracts";
import { updateSpanDraftAnswer } from "../../teaching/span/span-answer";
import { adaptSpanHelp, adaptSpanNext, adaptSpanResult, spanAnswerSummary } from "./span";
import { spanLessonMoves, spanLessonProblemId, spanPracticeMoveId } from "../../teaching/span/span-lesson-moves";
import { spanSessionProblemIds } from "../../teaching/span/session-service";
import { spanDiagnosticNextStep } from "../../teaching/span/span-diagnostic";
import { readSpanNextResult, readSpanPrerequisiteReturnResult } from "../../teaching/span/span-next-action-control";

const id = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const returned = { kind: "ready", activityId: target, courseId: id, href: `/opening/courses/${id}/study?activity=${target}`, label: "返回原要求", resumed: false };
it("accepts only a real no-session course return in B and keeps ordinary strict", () => {
  expect(readSpanPrerequisiteReturnResult(returned, id)).toEqual(returned);
  expect(() => readSpanNextResult(returned, id)).toThrow();
  const ordinary = { ...returned, sessionId: id, href: `/opening/courses/${id}/study/span?lesson=${target}` };
  expect(readSpanNextResult(ordinary, id)).toEqual(ordinary);
  expect(() => readSpanPrerequisiteReturnResult(ordinary, id)).toThrow();
});
it.each([
  { sessionId: id }, { courseId: target }, { activityId: id },
  ...[`https://evil.test/opening/courses/${id}/study?activity=${target}`, `//evil.test/opening/courses/${id}/study?activity=${target}`,
    `/opening/courses/${target}/study?activity=${target}`, `/opening/courses/${id}/study?activity=${target}&extra=1`,
    `/opening/courses/${id}/study?activity=${target}&activity=${target}`, `/opening/courses/${id}/study?activity=${target}#x`,
    `/opening/courses/${id}/study?activity=${target} `, `/opening/courses/${id}/study?activity=${target}\\\\evil`,
    `/opening/courses/${id}/study?mode=practice`, `/opening/courses/${id}/study/span?lesson=${target}`].map(href => ({ href })),
])("rejects B return identity/query/origin attacks %j", patch => {
  expect(() => readSpanPrerequisiteReturnResult({ ...returned, ...patch }, id)).toThrow();
});
it("keeps B choices bounded to current course records, route or actual lesson, never ordinary fallback", () => {
  const choice = { kind: "choice", reason: "unseen_unavailable", message: "原位置保留", primary: { label: "核对记录", href: `/opening/courses/${id}#course-learning-records` } };
  expect(readSpanPrerequisiteReturnResult(choice, id)).toEqual(choice);
  for (const href of [`/opening/courses/${id}/study?mode=practice`, `/opening/courses/${target}`, "https://evil.test", `/opening/courses/${id}/study/span?lesson=${target}&extra=1`]) {
    expect(() => readSpanPrerequisiteReturnResult({ ...choice, primary: { label: "x", href } }, id)).toThrow();
    expect(() => readSpanPrerequisiteReturnResult({ ...choice, secondary: { label: "x", href } }, id)).toThrow();
  }
});
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

it("uses the real verifier's no-solution skills instead of failed coordinates", () => {
  const attempt = { id, spanExercise: getSpanProblem("span-independent-3d") } as LearningAttempt;
  const cases = [
    { answer: { membership: "not_in_span", coefficients: ["2", "1"], coordinateChecks: ["2", "3", "1"], coefficientDerivationCoordinates: [0, 2] }, skill: "coefficients" },
    { answer: { membership: "not_in_span", coefficients: ["2", "1"], coordinateChecks: ["2", "3", "1"], coefficientDerivationCoordinates: [0, 1], representations: { geometry: "line" } }, skill: "geometry" },
  ] as const;
  for (const { answer, skill } of cases) {
    const verified = verifySpanAnswer(attempt.spanExercise!, answer);
    expect(verified.outcome).toBe("incorrect");
    expect(verified.skills[skill]).toBe("incorrect");
    const record = { id, answer: JSON.stringify(answer), serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } } as unknown as LearningObservation;
    const next = spanDiagnosticNextStep(record, attempt);
    expect(next?.action).not.toMatch(/重算第\d+个坐标/);
    expect(next?.action).toMatch(skill === "coefficients" ? /系数/ : /几何/);
  }
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

it("propagates the validated remediation choice reason and message without inventing an action or href", () => {
  const choice = { kind: "choice", reason: "remediation_limit", message: "请换讲法、到课程路线重新选择或暂缓。原记录保留。",
    primary: { label: "回原活动选择串讲", href: `/opening/courses/${id}/study/span?lesson=${id}` },
    secondary: { label: "到课程路线重新选择", href: `/opening/courses/${id}?tab=units#course-learning-route` } };
  expect(adaptSpanNext(choice, id)).toEqual({ href: choice.primary.href, label: choice.primary.label, choiceReason: "remediation_limit", notice: choice.message, alternatives: [choice.secondary] });
  for (const href of ["https://evil.test", "/opening/courses/22222222-2222-4222-8222-222222222222/study"]) {
    for (const key of ["primary", "secondary"] as const) expect(() => adaptSpanNext({ ...choice, [key]: { href, label: "x" } }, id)).toThrow();
  }
  expect(() => adaptSpanNext({ ...choice, secondary: { ...choice.secondary, href: `/opening/courses/${id}/study` } }, id)).toThrow();
});

it("summarizes the sealed answer by membership and key fields within 200 characters", () => {
  expect(spanAnswerSummary({})).toBeUndefined();
  expect(spanAnswerSummary({ membership: "in_span", coefficients: ["2", "-1"] })).toBe("属于 span；α = 2，β = -1");
  expect(spanAnswerSummary({ membership: "not_in_span", coefficients: ["2", ""], coordinateChecks: ["2", "4", "2"] }))
    .toBe("不属于 span；α = 2，β = 未填；代回后各坐标 2, 4, 2");
  const long = spanAnswerSummary({ membership: "in_span", coefficients: ["1".repeat(160), "2".repeat(160)] })!;
  expect(long).toHaveLength(200);
  expect(long.endsWith("…")).toBe(true);
});

it("keeps missing coordinates explicit and includes a no-solution witness", () => {
  expect(spanAnswerSummary({ membership: "not_in_span", coordinateChecks: ["2", "", "2"], noSolutionWitness: ["1", "", "-1"] }))
    .toBe("不属于 span；代回后各坐标 2, 未填, 2；矛盾坐标 1, 未填, -1");
  expect(spanAnswerSummary({ membership: "in_span", noSolutionWitness: ["1", "0", "-1"] })).toBe("属于 span");
});

it("truncates by Unicode code point without splitting a surrogate pair", () => {
  const summary = spanAnswerSummary({ membership: "in_span", coefficients: ["𝛼".repeat(200), ""] })!;
  expect(Array.from(summary)).toHaveLength(200);
  expect(summary.endsWith("𝛼…")).toBe(true);
  expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

it("keeps a successor choice as a visible notice instead of a folded reason", () => {
  const next = adaptSpanNext({ kind: "choice", reason: "authorization_required", message: "请先授权导师安排。", primary: { href: `/opening/courses/${id}`, label: "回到课程" } }, id);
  expect(next).toMatchObject({ href: `/opening/courses/${id}`, label: "回到课程", notice: "请先授权导师安排。" });
  expect(next).not.toHaveProperty("reason");
});
