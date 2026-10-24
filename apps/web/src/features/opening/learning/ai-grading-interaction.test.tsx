// @vitest-environment jsdom
import { createElement, StrictMode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiEvaluation, AiGradingStatus, LearningObservation, ObservationHistory } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

// React interactions against mocked HTTP boundaries, not a browser/live service.
const api = vi.hoisted(() => ({ observationDraft: vi.fn(), gradeObservation: vi.fn(), getGradingStatus: vi.fn(),
  getObservationHistory: vi.fn(), reviseObservation: vi.fn(), listRevisionCourses: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("../cards/cards-client", () => ({ createOpeningCardsClient: () => api }));
vi.mock("../cards/create-card-dialog", () => ({ CreateCardDialog: () => createElement("div", { "data-card-draft": true }, "卡片草稿") }));
import { saveGradingPhotoDraft } from "./ai-grading-photo-draft";
import { AiGradingCard } from "./ai-grading-card";
import { ObservationRevisionCard } from "./observation-revision-card";
const record: LearningObservation = { ...learningObservation, attemptId: "22222222-2222-4222-8222-222222222222",
  itemVersionId: "88888888-8888-4888-8888-888888888888", answer: "原答案：x = 2\n  原有空格", outcome: "unverified", verdictSource: "self_report" };
const evaluation: AiEvaluation = { observationId: record.id, attemptId: record.attemptId!, problemId: record.problemId!, itemVersionId: record.itemVersionId!,
  requirementKey: null, evaluatorVersion: "ai-rubric-v1", modelLabel: "fixture", evaluatedAt: "2026-10-21T12:00:00.000Z", outcome: "correct",
  confidence: .95, questionMatch: true, feedback: "计算正确。", transcription: "OCR识别：x = 999", criteria: [{ label: "计算", verdict: "correct", feedback: "步骤完整。" }] };
const graded: LearningObservation = { ...record, id: "77777777-7777-4777-8777-777777777777", rootObservationId: record.id,
  verdictSource: "ai_graded", outcome: "correct", aiEvaluation: evaluation };
const status = (patch: Partial<AiGradingStatus> = {}): AiGradingStatus => ({ rootObservationId: record.id, headObservationId: record.id,
  answerRevision: 1, jobId: "11111111-1111-4111-8111-111111111111", status: "needs_manual", retryable: true, workSource: null, ...patch });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); api.getGradingStatus.mockResolvedValue(status());
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(element => element.textContent === label);
  expect(button, `button ${label}`).toBeTruthy(); await act(async () => button!.click());
}
async function renderCard(props: Partial<Parameters<typeof AiGradingCard>[0]> = {}) {
  await act(async () => root.render(createElement(AiGradingCard, { record, onGraded() {}, ...props })));
}

it("autoGrade and StrictMode only poll; no render/rerender can enqueue a paid operation", async () => {
  api.getGradingStatus.mockResolvedValue(status({ status: "queued", retryable: false }));
  const render = () => act(async () => root.render(createElement(StrictMode, null, createElement(AiGradingCard, { record, autoGrade: true, onGraded() {} }))));
  await render(); await render(); await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(api.getGradingStatus).toHaveBeenCalled(); expect(api.gradeObservation).not.toHaveBeenCalled();
  expect(container.textContent).toContain("离开页面不会取消");
});

it("unmount only stops polling; returning reads the durable result without enqueueing again", async () => {
  const onGraded = vi.fn(); api.getGradingStatus.mockResolvedValue(status({ status: "grading", retryable: false }));
  await renderCard({ onGraded }); await act(async () => root.render(null));
  const reads = api.getGradingStatus.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(api.getGradingStatus).toHaveBeenCalledTimes(reads);
  api.getGradingStatus.mockResolvedValue(status({ status: "graded", retryable: false, headObservationId: graded.id }));
  api.getObservationHistory.mockResolvedValue({ rootObservationId: record.id, headObservationId: graded.id, revisions: [record, graded] });
  await renderCard({ onGraded }); expect(onGraded).toHaveBeenCalledExactlyOnceWith(graded); expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("double clicks enqueue once, use only sealed identity, and recover status after an unknown HTTP response", async () => {
  const request = deferred<AiGradingStatus>(); api.gradeObservation.mockReturnValueOnce(request.promise);
  await renderCard();
  const button = Array.from(container.querySelectorAll("button")).find(element => element.textContent === "重试批改")!;
  await act(async () => { button.click(); button.click(); }); expect(api.gradeObservation).toHaveBeenCalledExactlyOnceWith({ observationId: record.id });
  await act(async () => request.reject(new Error("连接中断"))); expect(container.textContent).toContain("原答案已保存");
  api.getGradingStatus.mockResolvedValue(status({ status: "queued", retryable: false }));
  await act(async () => root.render(null)); await renderCard();
  expect(api.gradeObservation).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("后台批改");
});

it("unknown cost exposes manual correction, never a retry that could resend", async () => {
  api.getGradingStatus.mockResolvedValue(status({ status: "unknown_cost", retryable: false }));
  await renderCard({ onDispute: vi.fn() }); expect(container.textContent).toContain("不会重复发送");
  expect(container.textContent).not.toContain("重试批改"); await click("修改这一步"); expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("ignores a stale poll/history response after switching to another answer", async () => {
  const request = deferred<AiGradingStatus>(); api.getGradingStatus.mockReturnValueOnce(request.promise);
  const onGraded = vi.fn(), next = { ...record, id: "99999999-9999-4999-8999-999999999999" };
  await renderCard({ onGraded }); api.getGradingStatus.mockResolvedValue(status({ headObservationId: next.id }));
  await renderCard({ record: next, onGraded });
  await act(async () => request.resolve(status({ status: "graded", headObservationId: graded.id })));
  expect(onGraded).not.toHaveBeenCalled(); expect(api.getObservationHistory).not.toHaveBeenCalled();
});

it("uses persisted photo identity and ignores a conflicting local-only photo draft", async () => {
  const selected = { workSourceId: "44444444-4444-4444-8444-444444444444", workSourceVersion: 3, physicalPage: 2 };
  saveGradingPhotoDraft(record.id, selected);
  api.getGradingStatus.mockResolvedValue(status({ workSource: { id: selected.workSourceId, version: 1, physicalPage: 1 } }));
  api.gradeObservation.mockResolvedValue(status({ status: "queued", retryable: false }));
  await renderCard({ photo: selected });
  expect(container.querySelector("a")?.href).toContain("version=1&page=1"); await click("重试批改");
  expect(api.gradeObservation).toHaveBeenCalledWith({ observationId: record.id });
  saveGradingPhotoDraft(record.id, { workSourceId: "", workSourceVersion: 0, physicalPage: 1 });
});

it("keeps a completed grade when an older history request returns the ungraded head", async () => {
  const history = deferred<ObservationHistory>(); api.getObservationHistory.mockReturnValueOnce(history.promise);
  api.getGradingStatus.mockResolvedValue(status({ status: "queued", retryable: false }));
  const onUpdated = vi.fn();
  await act(async () => root.render(createElement(ObservationRevisionCard, { record, onChanged() {}, onUpdated })));
  await click("查看历史");
  api.getGradingStatus.mockResolvedValue(status({ status: "graded", retryable: false, headObservationId: graded.id }));
  api.getObservationHistory.mockResolvedValue({ rootObservationId: record.id, headObservationId: graded.id, revisions: [record, graded] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => history.resolve({ rootObservationId: record.id, headObservationId: record.id, revisions: [record] }));
  expect(container.textContent).toContain("AI 批改 · 正确"); expect(container.querySelector('[aria-label="观察修订历史"]')).toBeNull();
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(graded);
});

it("disputes the original answer rather than OCR transcription, keeping manual correction available", async () => {
  api.getGradingStatus.mockResolvedValue(status({ status: "graded", retryable: false, headObservationId: graded.id }));
  api.getObservationHistory.mockResolvedValue({ rootObservationId: record.id, headObservationId: graded.id, revisions: [record, graded] });
  const corrected = { ...record, id: "99999999-9999-4999-8999-999999999999", rootObservationId: record.id, revisionKind: "replace" as const, outcome: "incorrect" as const };
  api.reviseObservation.mockResolvedValue({ disposition: "applied", observation: corrected });
  await act(async () => root.render(createElement(ObservationRevisionCard, { record: graded, onChanged() {} })));
  await click("判错了"); const select = container.querySelector("form select") as HTMLSelectElement;
  await act(async () => { select.value = "incorrect"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  api.getGradingStatus.mockResolvedValue(status({ headObservationId: corrected.id }));
  await click("保存纠正");
  expect(api.reviseObservation.mock.calls[0]![0]).toMatchObject({ expectedHead: graded.id, replacement: { answer: record.answer, outcome: "incorrect", verdictSource: "self_report" } });
  expect(api.listRevisionCourses).not.toHaveBeenCalled(); expect(container.textContent).toContain(record.answer);
});

it("discards a card draft generated from an answer superseded by a correction", async () => {
  const draft = deferred<never>(); api.observationDraft.mockReturnValue(draft.promise);
  api.getGradingStatus.mockResolvedValue(status({ headObservationId: graded.id, status: "graded", retryable: false }));
  await act(async () => root.render(createElement(ObservationRevisionCard, { record: { ...graded, outcome: "incorrect" }, onChanged() {} })));
  await click("做成记忆卡片");
  const corrected = { ...record, id: "66666666-6666-4666-8666-666666666666", revisionKind: "replace" as const, outcome: "correct" as const };
  api.getGradingStatus.mockResolvedValue(status({ headObservationId: corrected.id }));
  await act(async () => root.render(createElement(ObservationRevisionCard, { record: corrected, onChanged() {} })));
  await act(async () => draft.resolve({ question: "旧错因" } as never)); expect(container.querySelector("[data-card-draft]")).toBeNull();
});
