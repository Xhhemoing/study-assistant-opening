// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiGradingStatus, LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

const api = vi.hoisted(() => ({
  getSubmittedAttempt: vi.fn(), getSummary: vi.fn(), getCourseKnowledge: vi.fn(),
  createSession: vi.fn(), createAttempt: vi.fn(), submitAttempt: vi.fn(), gradeObservation: vi.fn(), getGradingStatus: vi.fn(),
  getObservationHistory: vi.fn(), reviseObservation: vi.fn(), listRevisionCourses: vi.fn(), associateTeachingActivityCourse: vi.fn(),
}));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../design/haptics", () => ({ successfulInteractionHaptic() {} }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";

const blockId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const itemVersionId = "88888888-8888-4888-8888-888888888888";
const record: LearningObservation = { ...learningObservation, attemptId, itemVersionId,
  requirementKey: `teaching:${blockId}:v3`, answer: "原答案：1/2 + 1/2 = 1\n  保留空格",
  outcome: "unverified", verdictSource: "self_report" };
const attempt: LearningAttempt = { id: attemptId, workspaceId: record.workspaceId, courseId: record.courseId,
  sessionId: record.sessionId, skillLabel: record.skillLabel, requirementKey: record.requirementKey!,
  sourceIds: record.sourceIds, sourceVersions: {}, problemId: record.problemId ?? null, itemVersionId,
  startedAt: record.occurredAt, submittedAt: null, observationId: null, historyRevision: 1 };
const gradedId = "99999999-9999-4999-8999-999999999999";
const graded: LearningObservation = { ...record, id: gradedId, rootObservationId: record.id,
  revisesObservationId: record.id, revisionKind: "replace", verdictSource: "ai_graded", outcome: "correct",
  aiEvaluation: { observationId: gradedId, attemptId, problemId: record.problemId!, itemVersionId,
    requirementKey: record.requirementKey!, evaluatorVersion: "ai-rubric-v1", modelLabel: "fixture",
    evaluatedAt: "2026-10-21T12:00:00.000Z", outcome: "correct", confidence: 0.95, questionMatch: true,
    feedback: "分子相加正确。", criteria: [{ label: "同分母分数相加", verdict: "correct", feedback: "结果为1。" }] } };
const context: InlineAttemptContext = { id: blockId, courseId: record.courseId, sourceIds: record.sourceIds,
  contentVersion: 3, status: "active", intentSummary: "分数练习", onCourseAssociated: vi.fn(),
  onObservationReady: vi.fn(), onAttemptReady: vi.fn() };
context.completionAction = { label: "下一题", onClick: vi.fn() };
const initialDraft = { prompt: "1/2 + 1/2 = ?", skillLabel: record.skillLabel, answer: record.answer };
const gradingStatus = (patch: Partial<AiGradingStatus> = {}): AiGradingStatus => ({
  rootObservationId: record.id, headObservationId: record.id, answerRevision: 1,
  jobId: blockId, status: "needs_manual", retryable: true, autoGradeSkipped: null, workSource: null, ...patch,
});

let container: HTMLDivElement, root: Root, head: LearningObservation;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); head = record;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.getSubmittedAttempt.mockResolvedValue(null);
  api.getSummary.mockResolvedValue([]); api.getCourseKnowledge.mockResolvedValue({ snapshot: null });
  api.createSession.mockResolvedValue({ id: record.sessionId }); api.createAttempt.mockResolvedValue(attempt);
  // Saving enqueues on the server; GET + history recover the worker's durable result.
  api.submitAttempt.mockImplementation(async () => { head = graded; return record; });
  api.getGradingStatus.mockImplementation(async () => gradingStatus({ headObservationId: head.id,
    status: head.aiEvaluation ? "graded" : "needs_manual", retryable: !head.aiEvaluation }));
  api.gradeObservation.mockImplementation(async () => {
    head = graded; return gradingStatus({ status: "queued", retryable: false });
  });
  api.getObservationHistory.mockImplementation(async () => ({ rootObservationId: record.id,
    headObservationId: head.id, revisions: [record, ...(head.id !== record.id ? [head] : [])] }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

const render = (status: InlineAttemptContext["status"] = "active") => act(async () => root.render(createElement(StrictMode, null,
  createElement(InlineAttemptForm, { blockId, prompt: initialDraft.prompt, context: { ...context, status }, ready: true,
    initialDraft, onDraftChange() {} }))));
async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(item => item.textContent === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function submit() {
  const form = container.querySelector("form"); expect(form).toBeTruthy();
  await act(async () => form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

it("reads a newly saved lesson's background grade without enqueueing on render and reports the effective result", async () => {
  await render(); expect(api.gradeObservation).not.toHaveBeenCalled();
  await submit(); await render();
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  expect(api.submitAttempt).toHaveBeenCalledWith(attemptId, expect.objectContaining({ answer: record.answer, outcome: "unverified" }));
  expect(api.gradeObservation).not.toHaveBeenCalled();
  expect(api.getGradingStatus).toHaveBeenCalledWith(record.id);
  expect(container.textContent).toContain(record.answer);
  expect(container.textContent).toContain("AI 批改 · 正确");
  expect(container.querySelector('[data-feedback-verdict="correct"]')).not.toBeNull();
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, graded);
  expect(api.getObservationHistory).toHaveBeenCalledExactlyOnceWith(record.id);
});

it("automatically assigns a course once without asking the learner to choose one", async () => {
  api.associateTeachingActivityCourse.mockResolvedValue({ courseId: record.courseId });
  await act(async () => root.render(createElement(StrictMode, null, createElement(InlineAttemptForm, {
    blockId, prompt: initialDraft.prompt, context: { ...context, courseId: null }, ready: true, onDraftChange() {},
  }))));
  expect(api.associateTeachingActivityCourse).toHaveBeenCalledExactlyOnceWith(blockId, { auto: true });
  expect(context.onCourseAssociated).toHaveBeenCalled();
  expect(container.textContent).not.toContain("学习记录所属课程");
});

it("restores an ungraded answer without starting another model call and allows explicit grading", async () => {
  api.getSubmittedAttempt.mockResolvedValue({ attempt, observation: record });
  await render();
  expect(api.gradeObservation).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(container.textContent).toContain(record.answer);
  expect(api.getGradingStatus).toHaveBeenCalledWith(record.id);
  expect(api.getObservationHistory).not.toHaveBeenCalled();
  await click("重试批改");
  expect(api.gradeObservation).toHaveBeenCalledExactlyOnceWith({ observationId: record.id });
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, graded);
});

it("keeps a learner correction after an AI grade without automatically grading it again", async () => {
  await render(); await submit();
  const corrected: LearningObservation = { ...record, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    rootObservationId: record.id, revisesObservationId: graded.id, revisionKind: "replace", outcome: "incorrect" };
  api.reviseObservation.mockImplementation(async () => { head = corrected; return { disposition: "applied", observation: corrected }; });
  await click("判错了");
  const select = container.querySelector("form select") as HTMLSelectElement;
  await act(async () => { select.value = "incorrect"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("保存纠正"); await render();
  expect(api.reviseObservation).toHaveBeenCalledWith(expect.objectContaining({ expectedHead: graded.id,
    replacement: expect.objectContaining({ answer: record.answer, outcome: "incorrect", verdictSource: "self_report" }) }));
  expect(api.gradeObservation).not.toHaveBeenCalled();
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, corrected);
  expect(container.querySelector('[data-feedback-verdict="unverified"]')).not.toBeNull();
  expect(api.getObservationHistory).toHaveBeenCalledTimes(2); // Head recovery + dispute; no reread after correction.
});

it.each([graded, { ...record, outcome: "correct", verdictSource: "deterministic",
  serverEvaluation: { decision: "correct" } } as LearningObservation])("does not regrade an already assessed lesson answer: $verdictSource", async observation => {
  head = observation; api.getSubmittedAttempt.mockResolvedValue({ attempt, observation });
  await render(); await render();
  expect(api.gradeObservation).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(container.querySelector('[data-feedback-verdict="correct"]')).not.toBeNull();
});

it.each([record, graded])("keeps completed lesson history read-only: $verdictSource", async observation => {
  api.getSubmittedAttempt.mockResolvedValue({ attempt, observation });
  await render("completed");
  expect(container.textContent).toContain(record.answer);
  if (observation.aiEvaluation) expect(container.textContent).toContain("AI 批改 · 正确");
  expect(container.querySelector("form")).toBeNull();
  expect(Array.from(container.querySelectorAll("button")).some(button => ["AI 批改", "重试批改", "修改这一步", "判错了", "纠正记录", "撤回记录"].includes(button.textContent ?? ""))).toBe(false);
  expect(api.getGradingStatus).not.toHaveBeenCalled();
  expect(api.getObservationHistory).not.toHaveBeenCalled();
  expect(api.gradeObservation).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
});

it("prepares a question without an extra click and does not submit or grade it", async () => {
  await render(); await render();
  expect(api.createSession).toHaveBeenCalledOnce();
  expect(api.createAttempt).toHaveBeenCalledOnce();
  expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(api.gradeObservation).not.toHaveBeenCalled();
  expect(container.textContent).not.toMatch(/封存|曝光|回执|资格|记录的技能|开始本题并启用提示/);
  expect(container.querySelector("form")).not.toBeNull();
});

it("offers the one completion action only after grading, and removes it for an uncertain correction", async () => {
  api.submitAttempt.mockResolvedValue(record);
  let jobStatus: AiGradingStatus["status"] = "queued";
  api.getGradingStatus.mockImplementation(async () => gradingStatus({ status: jobStatus, retryable: false }));
  await render(); await submit();
  expect(container.querySelector('[data-attempt-stage="processing"]')).not.toBeNull();
  expect(container.textContent).not.toContain("下一题");
  expect(api.getObservationHistory).not.toHaveBeenCalled();
  expect(api.gradeObservation).not.toHaveBeenCalled();
  const initialStatusReads = api.getGradingStatus.mock.calls.length;
  jobStatus = "grading";
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  // StrictMode may read on both effect mounts; the live poll adds one GET, never a POST.
  expect(api.getGradingStatus).toHaveBeenCalledTimes(initialStatusReads + 1);
  expect(container.querySelector('[data-attempt-stage="processing"]')).not.toBeNull();
  expect(container.textContent).not.toContain("下一题");
  expect(api.getObservationHistory).not.toHaveBeenCalled();
  expect(api.gradeObservation).not.toHaveBeenCalled();
  head = graded;
  api.getGradingStatus.mockResolvedValue(gradingStatus({ headObservationId: graded.id, status: "graded", retryable: false }));
  // Pending reads back off from 2s to 4s; the old fixed 2s fixture would inspect
  // the DOM before the next status read. Completion must stay absent until then.
  await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
  expect(api.getGradingStatus).toHaveBeenCalledTimes(initialStatusReads + 1);
  expect(container.textContent).not.toContain("下一题");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const complete = Array.from(container.querySelectorAll('[data-attempt-stage="reliable"] button')).filter(button => button.textContent === "下一题");
  expect(complete).toHaveLength(1);
  await act(async () => (complete[0] as HTMLButtonElement).click());
  expect(context.completionAction?.onClick).toHaveBeenCalledOnce();

  api.reviseObservation.mockImplementation(async () => {
    head = { ...record, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", rootObservationId: record.id,
      revisesObservationId: graded.id, revisionKind: "replace", outcome: "unverified" };
    api.getGradingStatus.mockResolvedValue(gradingStatus({ headObservationId: head.id }));
    return { disposition: "applied", observation: head };
  });
  await click("判错了"); await click("保存纠正");
  expect(container.textContent).not.toContain("下一题");
  expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("keeps completion absent after a failed or low-confidence grade", async () => {
  api.submitAttempt.mockResolvedValue(record);
  api.gradeObservation.mockRejectedValue(new Error("批改服务未完成"));
  await render(); await submit();
  expect(container.textContent).toContain("重试批改");
  expect(container.textContent).not.toContain("下一题");
  expect(api.gradeObservation).not.toHaveBeenCalled();
  await click("重试批改");
  expect(container.textContent).toContain("批改服务未完成");
  expect(container.textContent).not.toContain("下一题");
  api.gradeObservation.mockImplementation(async () => {
    head = { ...graded, outcome: "unverified", aiEvaluation: { ...graded.aiEvaluation!, confidence: 0.2 } };
    api.getGradingStatus.mockResolvedValue(gradingStatus({ headObservationId: head.id, status: "needs_manual", retryable: false }));
    return gradingStatus({ status: "queued", retryable: false });
  });
  await click("重试批改");
  expect(container.textContent).toContain("修改这一步");
  expect(container.textContent).not.toContain("下一题");
  expect(api.gradeObservation).toHaveBeenCalledTimes(2);
  expect(api.gradeObservation).toHaveBeenNthCalledWith(1, { observationId: record.id });
  expect(api.gradeObservation).toHaveBeenNthCalledWith(2, { observationId: record.id });
  expect(api.getObservationHistory).toHaveBeenCalledWith(record.id);
  expect(container.textContent).toContain(record.answer);
  expect(container.textContent).toContain("AI 批改 · 暂不能判断");
  expect(container.querySelector('[data-feedback-verdict="unverified"]')).not.toBeNull();
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, head);
});

it("offers completion for a known learner correction without regrading or claiming an assessed answer", async () => {
  const corrected = { ...record, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", rootObservationId: record.id,
    revisionKind: "replace" as const, outcome: "incorrect" as const };
  head = corrected;
  api.getSubmittedAttempt.mockResolvedValue({ attempt, observation: corrected });
  await render();
  expect(container.querySelector('[data-attempt-stage="corrected"]')?.textContent).toContain("下一题");
  // The single primary action is completion for a known correction, not another paid grade.
  expect(api.getGradingStatus).toHaveBeenCalledWith(corrected.id);
  expect(Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "下一题")).toHaveLength(1);
  expect(container.textContent).not.toContain("重试批改");
  expect(container.querySelector('[data-feedback-verdict="unverified"]')).not.toBeNull();
  expect(api.gradeObservation).not.toHaveBeenCalled();
});
