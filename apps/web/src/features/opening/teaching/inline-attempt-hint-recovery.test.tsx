// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
const api = vi.hoisted(() => ({ getSubmittedAttempt: vi.fn(), getSummary: vi.fn(), getCourseKnowledge: vi.fn() }));
const ack = vi.hoisted(() => vi.fn());
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: ack }));
import { InlineAttemptForm, type InlineAttemptContext } from "./inline-attempt";
const id = "11111111-1111-4111-8111-111111111111", blockId = "22222222-2222-4222-8222-222222222222";
const record: LearningObservation = { ...learningObservation, attemptId: id, answer: "原先保存的完整答案", outcome: "unverified", verdictSource: "self_report" };
const attempt: LearningAttempt = { id, workspaceId: record.workspaceId, courseId: record.courseId, sessionId: record.sessionId,
  skillLabel: record.skillLabel, requirementKey: record.requirementKey ?? null, sourceIds: record.sourceIds, sourceVersions: {},
  problemId: record.problemId ?? null, itemVersionId: record.itemVersionId ?? null, startedAt: record.occurredAt, submittedAt: record.occurredAt, observationId: record.id, historyRevision: 0 };
const context: InlineAttemptContext = { id, courseId: record.courseId, sourceIds: record.sourceIds, contentVersion: 3, status: "active", intentSummary: "本题", onCourseAssociated() {} };
function hint(level: 1 | 4) {
  return { attemptId: id, level, text: level === 1 ? "已经释放的方向提示" : "已经释放的完整参考解答", referenceSourceId: null,
    exposureReceipt: { id: level === 1 ? id : blockId, releaseKey: `teaching-hint-v1:${id}:${level}`, contextAnchor: { attemptId: id, courseId: record.courseId, itemVersionId: attempt.itemVersionId, activityId: id, blockId, contentVersion: 3, purpose: level === 4 ? "history_solution" : "learning_help" },
      origin: level === 4 ? "history_solution" : "assistant", supportDomain: "unknown", generatedAt: record.occurredAt, releasedAt: record.occurredAt, acknowledgedAt: null, historyRevision: 1 } };
}
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal("fetch", fetcher);
  api.getSubmittedAttempt.mockResolvedValue({ attempt, observation: record }); api.getSummary.mockResolvedValue([]); api.getCourseKnowledge.mockResolvedValue({ snapshot: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() { await act(async () => root.render(createElement(InlineAttemptForm, { blockId, prompt: "原题", context, ready: true, onDraftChange() {} }))); }

it("restores released hint text and the reference on fresh entry using only GET without releasing or acknowledging help", async () => {
  fetcher.mockResolvedValue(Response.json({ hints: [hint(1), hint(4)] }));
  await render();
  expect(host.textContent).toContain(record.answer);
  expect(host.textContent).toContain("已经释放的方向提示"); expect(host.textContent).toContain("已经释放的完整参考解答");
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/opening/teaching/hint?attemptId=${id}`, { cache: "no-store" });
  expect(ack).not.toHaveBeenCalled(); expect(host.querySelector("textarea")).toBeNull();
});
it("preserves the original answer after a failed read and retries only the read explicitly", async () => {
  fetcher.mockResolvedValueOnce(Response.json({ error: { message: "读取已读提示失败" } }, { status: 503 }));
  await render();
  expect(host.textContent).toContain(record.answer); expect(host.textContent).not.toContain("已经释放的方向提示");
  fetcher.mockResolvedValueOnce(Response.json({ hints: [hint(1)] }));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "重新读取已查看的提示")!.click());
  expect(host.textContent).toContain("已经释放的方向提示"); expect(host.textContent).toContain(record.answer);
  expect(fetcher.mock.calls).toHaveLength(2); expect(fetcher.mock.calls.every(call => !call[1]?.method)).toBe(true); expect(ack).not.toHaveBeenCalled();
});
