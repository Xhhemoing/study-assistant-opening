// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiEvaluation, LearningObservation, ObservationHistory } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

// These exercise React interactions against mocked HTTP-client boundaries, not a live service.
const api = vi.hoisted(() => ({
  gradeObservation: vi.fn(), getObservationHistory: vi.fn(), reviseObservation: vi.fn(), listRevisionCourses: vi.fn(),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
import { AiGradingCard } from "./ai-grading-card";
import { ObservationRevisionCard } from "./observation-revision-card";

const record: LearningObservation = {
  ...learningObservation, attemptId: "22222222-2222-4222-8222-222222222222",
  itemVersionId: "88888888-8888-4888-8888-888888888888", answer: "原答案：x = 2\n  原有空格", outcome: "unverified", verdictSource: "self_report",
};
const evaluation: AiEvaluation = {
  observationId: record.id, attemptId: record.attemptId!, problemId: record.problemId!, itemVersionId: record.itemVersionId!,
  requirementKey: null, evaluatorVersion: "ai-rubric-v1", modelLabel: "fixture", evaluatedAt: "2026-10-21T12:00:00.000Z",
  outcome: "correct", confidence: 0.95, questionMatch: true, feedback: "计算正确。", transcription: "OCR识别：x = 999",
  criteria: [{ label: "计算", verdict: "correct", feedback: "步骤完整。" }],
};
const graded: LearningObservation = { ...record, verdictSource: "ai_graded", outcome: "correct", aiEvaluation: evaluation };

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(element => element.textContent === label);
  expect(button, `button ${label}`).toBeTruthy();
  await act(async () => button!.click());
}

it("starts automatic grading once under StrictMode and does not repeat it on rerenders", async () => {
  const request = deferred<LearningObservation>();
  api.gradeObservation.mockReturnValue(request.promise);
  const onGraded = vi.fn();
  const render = async (input: LearningObservation) => act(async () => root.render(createElement(StrictMode, null,
    createElement(AiGradingCard, { record: input, autoGrade: true, onGraded }))));
  await render(record);
  await render({ ...record });
  expect(api.gradeObservation).toHaveBeenCalledTimes(1);
  expect(api.gradeObservation).toHaveBeenCalledWith({ observationId: record.id });
  await act(async () => request.resolve(graded));
  await render({ ...record });
  expect(api.gradeObservation).toHaveBeenCalledTimes(1);
  expect(onGraded).toHaveBeenCalledExactlyOnceWith(graded);
});

it("preserves the original answer after failure and allows an explicit successful retry", async () => {
  const request = deferred<LearningObservation>();
  api.gradeObservation.mockReturnValueOnce(request.promise).mockResolvedValueOnce(graded);
  const onUpdated = vi.fn();
  await act(async () => root.render(createElement(ObservationRevisionCard, { record, autoGrade: true, onChanged() {}, onUpdated })));
  await act(async () => request.reject(new Error("模型暂时不可用")));
  expect(container.textContent).toContain(record.answer);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("原答案已保存");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("模型暂时不可用");
  await click("重试批改");
  expect(api.gradeObservation).toHaveBeenCalledTimes(2);
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(graded);
  expect(container.textContent).toContain(record.answer);
  expect(container.textContent).toContain("AI 批改 · 正确");
});

it("keeps the completed grade when an earlier history request returns the ungraded head later", async () => {
  const grading = deferred<LearningObservation>(), history = deferred<ObservationHistory>();
  const nextGrade = { ...graded, id: "77777777-7777-4777-8777-777777777777", rootObservationId: record.id };
  api.gradeObservation.mockReturnValue(grading.promise);
  api.getObservationHistory.mockReturnValue(history.promise);
  const onUpdated = vi.fn();
  await act(async () => root.render(createElement(ObservationRevisionCard, { record, autoGrade: true, onChanged() {}, onUpdated })));
  await click("查看历史");
  await act(async () => grading.resolve(nextGrade));
  expect(container.textContent).toContain("AI 批改 · 正确");
  await act(async () => history.resolve({ rootObservationId: record.id, headObservationId: record.id, revisions: [record] }));
  expect(container.textContent).toContain("AI 批改 · 正确");
  expect(container.querySelector('[aria-label="观察修订历史"]')).toBeNull();
  expect(container.textContent).toContain("判错了");
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(nextGrade);
  expect(api.gradeObservation).toHaveBeenCalledTimes(1);
  expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "查看历史")?.disabled).toBe(false);
});

it("ignores a history response after the card switches to another observation", async () => {
  const history = deferred<ObservationHistory>();
  const next = { ...record, id: "99999999-9999-4999-8999-999999999999", answer: "另一道题的原答" };
  api.getObservationHistory.mockReturnValue(history.promise);
  await act(async () => root.render(createElement(ObservationRevisionCard, { record, onChanged() {} })));
  await click("查看历史");
  await act(async () => root.render(createElement(ObservationRevisionCard, { record: next, onChanged() {} })));
  await act(async () => history.resolve({ rootObservationId: record.id, headObservationId: record.id, revisions: [record] }));
  expect(container.textContent).toContain(next.answer);
  expect(container.textContent).not.toContain(record.answer);
  expect(container.querySelector('[aria-label="观察修订历史"]')).toBeNull();
});

it("ignores an old response after switching the record and can grade the new record", async () => {
  const request = deferred<LearningObservation>();
  const nextRecord = { ...record, id: "99999999-9999-4999-8999-999999999999", answer: "另一道题的原答" };
  const nextGraded = { ...graded, ...nextRecord, verdictSource: "ai_graded" as const, outcome: "correct" as const,
    aiEvaluation: { ...evaluation, observationId: nextRecord.id } };
  api.gradeObservation.mockReturnValueOnce(request.promise).mockResolvedValueOnce(nextGraded);
  const onGraded = vi.fn();
  await act(async () => root.render(createElement(AiGradingCard, { record, autoGrade: true, onGraded })));
  await act(async () => root.render(createElement(AiGradingCard, { record: nextRecord, autoGrade: false, onGraded })));
  await act(async () => request.resolve(graded));
  expect(onGraded).not.toHaveBeenCalled();
  await click("AI 批改");
  expect(api.gradeObservation).toHaveBeenLastCalledWith({ observationId: nextRecord.id });
  expect(onGraded).toHaveBeenCalledExactlyOnceWith(nextGraded);
});

it("disputes the grade using the original answer and chosen outcome, never the OCR transcription", async () => {
  api.getObservationHistory.mockResolvedValue({ rootObservationId: record.id, headObservationId: record.id, revisions: [graded] });
  const corrected: LearningObservation = { ...record, id: "99999999-9999-4999-8999-999999999999", rootObservationId: record.id, revisionKind: "replace", outcome: "incorrect" };
  api.reviseObservation.mockResolvedValue({ disposition: "applied", observation: corrected });
  const onUpdated = vi.fn();
  await act(async () => root.render(createElement(ObservationRevisionCard, { record: graded, onChanged() {}, onUpdated })));
  await click("判错了");
  const select = container.querySelector("form select") as HTMLSelectElement;
  await act(async () => { select.value = "incorrect"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("保存纠正");
  expect(api.reviseObservation).toHaveBeenCalledTimes(1);
  expect(api.reviseObservation.mock.calls[0]![0]).toMatchObject({
    rootObservationId: record.id, expectedHead: record.id, revisionKind: "replace",
    replacement: { answer: record.answer, outcome: "incorrect", verdictSource: "self_report" },
  });
  expect(api.reviseObservation.mock.calls[0]![0].replacement.answer).not.toBe(evaluation.transcription);
  expect(api.listRevisionCourses).not.toHaveBeenCalled();
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(corrected);
  expect(container.textContent).toContain(record.answer);
});
