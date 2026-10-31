import { expect, it } from "vitest";
import { getSpanProblem, solveSpanProblem, spanModeForIntent, verifySpanAnswer } from "@aistudy/domain";
import type { LearningObservation, StudySessionIntent } from "@aistudy/contracts";
import { updateSpanDraftAnswer } from "../../teaching/span/span-answer";
import { adaptSpanHelp, adaptSpanNext, adaptSpanResult, spanLessonMoves, spanProblemForMove } from "./span";
import { spanSessionProblemIds } from "../../teaching/span/session-service";

const id = "11111111-1111-4111-8111-111111111111";
const intent = (purpose: StudySessionIntent["purpose"]): StudySessionIntent =>
  ({ purpose, timeBudgetMinutes: 20, language: "zh", pace: "normal", continuous: true, selfReportedFatigue: "unknown" });

it("picks the same problem for every move as the server-issued sequence, ending with the reserved item", () => {
  for (const purpose of ["self_study", "overview", "challenge"] as const) {
    const mode = spanModeForIntent(intent(purpose));
    const moves = spanLessonMoves(mode);
    const issued = moves.map((_, index) => spanProblemForMove(mode, index, moves.length));
    expect(issued[0]).toBeNull();
    expect(issued.at(-1)).toBe("reserved:auto");
    // Every non-reserved practice problem must be one the server prepares for this intent.
    const server = spanSessionProblemIds(intent(purpose));
    for (const problemId of issued.slice(1, -1)) expect(server).toContain(problemId);
  }
});

it("serializes answers so the real verifier can grade them (the C1 encoding made every answer unparseable)", () => {
  const problem = getSpanProblem("span-faded-3d")!;
  const solution = solveSpanProblem(problem);
  if (solution.kind !== "unique") throw new Error("fixture must have a unique solution");
  const [alpha, beta] = solution.coefficients;
  // Only the judgement and coefficients, the way a learner usually answers.
  const right = updateSpanDraftAnswer(updateSpanDraftAnswer("", { membership: "in_span" }), { coefficients: [alpha, beta] });
  expect(verifySpanAnswer(problem, JSON.parse(right)).outcome).toBe("correct");
  const wrong = updateSpanDraftAnswer(right, { coefficients: ["9", "9"] });
  expect(verifySpanAnswer(problem, JSON.parse(wrong)).outcome).toBe("incorrect");
  // Opening the optional working section without filling it must not break grading.
  const touched = updateSpanDraftAnswer(right, { representations: {} });
  expect(verifySpanAnswer(problem, JSON.parse(touched)).outcome).toBe("correct");
});

it("labels results from evaluation and help separately", () => {
  const record = { assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as unknown as LearningObservation;
  expect(adaptSpanResult(record)).toMatchObject({ outcome: "correct", assistance: "hinted" });
  expect(adaptSpanResult(record).detail).toContain("一致");
  expect(adaptSpanResult({ ...record, serverEvaluation: null } as LearningObservation, "grading").outcome).toBe("pending");
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
