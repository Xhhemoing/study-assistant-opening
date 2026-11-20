// @vitest-environment jsdom

vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => true }));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { LearningAttempt, MatrixExerciseInput } from "@aistudy/contracts";
import { createMatrixExerciseSpec } from "@aistudy/domain";
import { parseCourseStudyPracticeEntry } from "../courses/course-study-query";
import { MatrixExerciseForm } from "./matrix-exercise-form";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
import { emptyPracticeDraft, initializePracticeDraft, practiceScope, switchPracticeDraft } from "./practice-draft";

const client = vi.hoisted(() => ({
  createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(),
  submitAttempt: vi.fn(), getObservationHistory: vi.fn(),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => client }));

function boundScope(courseId: string, exercise: MatrixExerciseInput) {
  return practiceScope(courseId, "matrix", undefined, undefined, undefined, exercise);
}

it("offers real start controls, labels the built-in source honestly and blocks an empty material selection", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, {
    courseId: "course", sources: [], onRecorded() {}, onBack() {},
  }));
  expect(html).toContain("内置矩阵练习");
  expect(html).toContain("正在恢复矩阵练习");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).toContain("这是内置矩阵练习");
  expect(html).toContain("选择可用课程材料");
  expect(html).toContain("请先添加并完成解析一份材料");
  expect(html).toMatch(/<button disabled=""[^>]*>开始矩阵练习<\/button>/);
  expect(html).toContain("矩阵标量乘法");
});
it("distinguishes an automatic verdict from a learner's documented reference check", () => {
  const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility: {
    independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
    reasonCodes: ["deterministic_correct"], policyVersion: "opening-evidence-v1",
  } }));
  expect(html).toContain("内置题精确核算");
  expect(html).toContain("只覆盖这道结构化题目");
  expect(html).not.toContain("不代表系统客观判分");
});
it("seeds the exact exercise and variation of a new matrix entry while draft reads are pending", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, { courseId: "new-course", sources: [], initialKey: "addition", initialVariant: 2, onRecorded() {}, onBack() {} }));
  expect(html).toContain('<option value="addition" selected="">');
  expect(html).toContain("本次题组：3");
  expect(html).toContain('<fieldset disabled=""');
});

it("keeps a linked variant and the next question recoverable in their own scopes", async () => {
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const sessionId = crypto.randomUUID(), observationId = crypto.randomUUID();
  const { initialMatrixExercise: linked } = parseCourseStudyPracticeEntry({ mode: "matrix", exercise: "addition", variant: "2", sourceId });
  if (!linked) throw new Error("Expected a bound exercise from the summary link");
  const next = { ...linked, variant: 3 };
  client.createSession.mockResolvedValue({ id: sessionId });
  client.createAttempt.mockImplementation(async ({ matrixExercise }: { matrixExercise: MatrixExerciseInput }): Promise<LearningAttempt> => ({
    id: crypto.randomUUID(), workspaceId: courseId, courseId, sessionId,
    skillLabel: "矩阵加法", requirementKey: null, sourceIds: [sourceId], sourceVersions: { [sourceId]: 1 },
    problemId: null, itemVersionId: null, observationId: null, submittedAt: null,
    startedAt: "2026-11-20T00:00:00Z", historyRevision: 0,
    matrixExercise: createMatrixExerciseSpec(matrixExercise.exerciseKey, matrixExercise.variant),
  }));
  client.getAttempt.mockImplementation(async (attemptId: string) => ({ attemptId, sessionId, deliveredAssistance: "none" }));
  client.listObservations.mockResolvedValue([]);
  const observation = { id: observationId, courseId, sessionId, attemptId: "", answer: "[[1]]" };
  client.submitAttempt.mockImplementation(async (attemptId: string) => ({ ...observation, attemptId }));
  client.getObservationHistory.mockImplementation(async () => ({
    rootObservationId: observationId, headObservationId: observationId,
    revisions: [await client.submitAttempt.mock.results[0]!.value],
  }));

  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const open = (boundExercise: MatrixExerciseInput) => act(async () => root.render(createElement(MatrixExerciseForm, {
    courseId, boundExercise, boundSourceAvailable: true, onRecorded() {},
  })));
  const submit = () => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const typeAnswer = (answer: string) => act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, answer);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const stored = (exercise: MatrixExerciseInput) => sessionStorage.getItem(`opening-practice:v2:${boundScope(courseId, exercise)}`);
  try {
    await open(linked);
    await submit();
    await typeAnswer("[[1]]");
    await submit();
    expect(host.textContent).toContain("原答案：[[1]]");
    const original = stored(linked);
    expect(original).toBeTruthy();

    const switchQuestion = [...host.querySelectorAll("button")].find(button => button.textContent === "换一道题");
    expect(switchQuestion).toBeDefined();
    await act(async () => switchQuestion!.click());
    expect(host.textContent).toContain("本次题组：4");
    await submit();
    await typeAnswer("[[2]]");
    expect(client.createAttempt).toHaveBeenLastCalledWith(expect.objectContaining({ matrixExercise: next }));

    await act(async () => root.render(null));
    await open(linked);
    expect(host.textContent).toContain("本次题组：3");
    expect(host.querySelector("textarea")?.value).toBe("[[1]]");
    expect(stored(linked)).toBe(original);

    await act(async () => root.render(null));
    await open(next);
    expect(host.textContent).toContain("本次题组：4");
    expect(host.querySelector("textarea")?.value).toBe("[[2]]");
    expect(stored(next)).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});

it("recovers the linked variant when an older draft collection had another variant active", async () => {
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID();
  const linked = { sourceId, exerciseKey: "addition", variant: 2 } as const;
  const scope = boundScope(courseId, linked);
  const fields = { sourceId, matrixKey: linked.exerciseKey, matrixVariant: linked.variant };
  const original = emptyPracticeDraft(scope, { ...fields, answer: "[[1]]" });
  initializePracticeDraft(original);
  switchPracticeDraft(scope, original.id, emptyPracticeDraft(scope, { ...fields, matrixVariant: 3, answer: "[[2]]" }), sessionStorage);
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(createElement(MatrixExerciseForm, { courseId, boundExercise: linked, boundSourceAvailable: true, onRecorded() {} })));
    expect(host.textContent).toContain("本次题组：3");
    expect(host.querySelector("textarea")?.value).toBe("[[2]]");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    sessionStorage.clear();
  }
});
