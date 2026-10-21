// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

const api = vi.hoisted(() => ({
  getSubmittedAttempt: vi.fn(), getSummary: vi.fn(), getCourseKnowledge: vi.fn(),
  createSession: vi.fn(), createAttempt: vi.fn(), submitAttempt: vi.fn(), gradeObservation: vi.fn(),
  getObservationHistory: vi.fn(), reviseObservation: vi.fn(), listRevisionCourses: vi.fn(),
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
const initialDraft = { prompt: "1/2 + 1/2 = ?", skillLabel: record.skillLabel, answer: record.answer };

let container: HTMLDivElement, root: Root, head: LearningObservation;
beforeEach(() => {
  vi.resetAllMocks(); head = record;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.getSubmittedAttempt.mockResolvedValue(null);
  api.getSummary.mockResolvedValue([]); api.getCourseKnowledge.mockResolvedValue({ snapshot: null });
  api.createSession.mockResolvedValue({ id: record.sessionId }); api.createAttempt.mockResolvedValue(attempt);
  api.submitAttempt.mockResolvedValue(record);
  api.gradeObservation.mockImplementation(async () => { head = graded; return graded; });
  api.getObservationHistory.mockImplementation(async () => ({ rootObservationId: record.id,
    headObservationId: head.id, revisions: [record, ...(head.id !== record.id ? [head] : [])] }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

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

it("grades a newly saved lesson answer once and reports the effective result to the learning flow", async () => {
  await render(); expect(api.gradeObservation).not.toHaveBeenCalled();
  await submit(); await render();
  expect(api.submitAttempt).toHaveBeenCalledOnce();
  expect(api.submitAttempt).toHaveBeenCalledWith(attemptId, expect.objectContaining({ answer: record.answer, outcome: "unverified" }));
  expect(api.gradeObservation).toHaveBeenCalledExactlyOnceWith({ observationId: record.id });
  expect(container.textContent).toContain(record.answer);
  expect(container.textContent).toContain("AI 批改 · 正确");
  expect(container.querySelector('[data-feedback-verdict="correct"]')).not.toBeNull();
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, graded);
  expect(api.getObservationHistory).not.toHaveBeenCalled();
});

it("restores an ungraded answer without starting another model call and allows explicit grading", async () => {
  api.getSubmittedAttempt.mockResolvedValue({ attempt, observation: record });
  await render();
  expect(api.gradeObservation).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(container.textContent).toContain(record.answer);
  await click("AI 批改");
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
  expect(api.gradeObservation).toHaveBeenCalledTimes(1);
  expect(context.onObservationReady).toHaveBeenLastCalledWith(blockId, corrected);
  expect(container.querySelector('[data-feedback-verdict="unverified"]')).not.toBeNull();
  expect(api.getObservationHistory).toHaveBeenCalledTimes(1); // Only the explicit dispute opens history.
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
  expect(Array.from(container.querySelectorAll("button")).some(button => ["AI 批改", "判错了", "纠正记录", "撤回记录"].includes(button.textContent ?? ""))).toBe(false);
  expect(api.gradeObservation).not.toHaveBeenCalled(); expect(api.submitAttempt).not.toHaveBeenCalled();
});
