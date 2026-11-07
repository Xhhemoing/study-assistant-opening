// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { LearningAttempt } from "@aistudy/contracts";
const api = vi.hoisted(() => ({ listSources: vi.fn(), getSummary: vi.fn(), createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(), submitAttempt: vi.fn(), gradeObservation: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
import { LearningAttemptForm } from "./attempt-form";

it("automatically prepares a confirmed photo question once and resumes the same attempt with an empty answer", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.sessionStorage.clear();
  const courseId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222", sessionId = "33333333-3333-4333-8333-333333333333";
  const attempt: LearningAttempt = { id: "44444444-4444-4444-8444-444444444444", workspaceId: courseId, courseId, sessionId,
    skillLabel: "随手练习", requirementKey: null, sourceIds: [sourceId], sourceVersions: { [sourceId]: 2 },
    problemId: sourceId, itemVersionId: sessionId, observationId: null, submittedAt: null, startedAt: "2026-10-22T00:00:00Z", historyRevision: 0 };
  api.listSources.mockResolvedValue([]); api.getSummary.mockResolvedValue([]);
  api.createSession.mockResolvedValue({ id: sessionId }); api.createAttempt.mockResolvedValue(attempt);
  api.getAttempt.mockResolvedValue({ attemptId: attempt.id, sessionId, deliveredAssistance: "none" }); api.listObservations.mockResolvedValue([]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const props = { courseId, initialProblem: { sourceId, sourceVersion: 2, stem: "计算 1+1" }, onRecorded() {} };
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(LearningAttemptForm, props))));
    expect(api.createSession).toHaveBeenCalledOnce(); expect(api.createAttempt).toHaveBeenCalledOnce();
    expect(api.createAttempt).toHaveBeenCalledWith(expect.objectContaining({ problem: { sourceId, stemSnapshot: "计算 1+1", artifactKind: "reference_item" }, contextAnchor: { courseId, sourceId, sourceVersion: 2, purpose: "learning_help" } }));
    expect(api.createSession.mock.calls[0]![0]).not.toHaveProperty("requirementKey");
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(api.submitAttempt).not.toHaveBeenCalled(); expect(api.gradeObservation).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(LearningAttemptForm, props)));
    const resume = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "继续此练习");
    expect(resume).toBeTruthy(); await act(async () => resume!.click());
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
    expect(container.querySelector("textarea")?.value).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("retains the confirmed image-version anchor when the server rejects an upgraded source before creating an attempt", async () => {
  vi.clearAllMocks(); window.sessionStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const courseId = "55555555-5555-4555-8555-555555555555", sourceId = "66666666-6666-4666-8666-666666666666", sessionId = "77777777-7777-4777-8777-777777777777";
  api.listSources.mockResolvedValue([]); api.getSummary.mockResolvedValue([]); api.createSession.mockResolvedValue({ id: sessionId });
  api.createAttempt.mockRejectedValue(new Error("study context sourceVersion mismatch; reopen the selected version"));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(LearningAttemptForm, { courseId, initialProblem: { sourceId, sourceVersion: 2, stem: "v2题干" }, onRecorded() {} })));
    expect(api.createAttempt).toHaveBeenCalledOnce();
    expect(api.createAttempt.mock.lastCall![0].contextAnchor).toEqual({ courseId, sourceId, sourceVersion: 2, purpose: "learning_help" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法恢复练习，原答案已保留");
    expect(api.submitAttempt).not.toHaveBeenCalled(); expect(api.gradeObservation).not.toHaveBeenCalled();
    const resume = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "继续此练习");
    await act(async () => resume!.click());
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it.each([
  { shell: false, known: true }, { shell: false, known: false }, { shell: true, known: true },
])("only releases a known rejection in ordinary practice: $shell $known", async ({ shell, known }) => {
  const { OpeningApiError } = await import("../client/api");
  const { OpeningCapabilitiesContext } = await import("../capabilities/capabilities-provider");
  const { CLOSED_CAPABILITIES } = await import("@aistudy/config/public");
  vi.resetAllMocks(); window.sessionStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const courseId = crypto.randomUUID(), sourceId = crypto.randomUUID(), workId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const attempt: LearningAttempt = { id: crypto.randomUUID(), workspaceId: courseId, courseId, sessionId, skillLabel: "随手练习", requirementKey: null,
    sourceIds: [sourceId], sourceVersions: { [sourceId]: 2 }, problemId: sourceId, itemVersionId: sessionId, stemSnapshot: "计算 1+1",
    observationId: null, submittedAt: null, startedAt: "2026-10-22T00:00:00Z", historyRevision: 0 };
  const source = (id: string, name: string) => ({ id, workspaceId: courseId, name, mime: "image/png", bytes: 100, sha256: "a".repeat(64), version: 2,
    uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-22T00:00:00Z" });
  api.listSources.mockResolvedValue([source(sourceId, "原题.png"), source(workId, "作答.png")]); api.getSummary.mockResolvedValue([]);
  api.createSession.mockResolvedValue({ id: sessionId }); api.createAttempt.mockResolvedValue(attempt);
  api.getAttempt.mockResolvedValue({ attemptId: attempt.id, sessionId, deliveredAssistance: "none" }); api.listObservations.mockResolvedValue([]);
  api.submitAttempt.mockRejectedValue(new OpeningApiError(409, "照片不可用", "CONFLICT", known ? "work_source_rejected" : null));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(OpeningCapabilitiesContext.Provider, { value: { ...CLOSED_CAPABILITIES, studySessionV2: shell } },
      createElement(LearningAttemptForm, { photoSession: shell, courseId, initialProblem: { sourceId, sourceVersion: 2, stem: "计算 1+1" }, onRecorded() {} }))));
    const select = [...container.querySelectorAll("select")].find(item => item.closest("label")?.textContent?.includes("作答图片或文档"))!;
    expect([...select.options].some(option => option.textContent === "原题.png")).toBe(shell);
    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "我的答案");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      select.value = `${workId}:2`; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    const input = api.submitAttempt.mock.calls[0]![1];
    expect(input.workSource.id).toBe(workId);
    expect(input.answer).toBe("我的答案");
    expect(textarea.value).toBe("我的答案");
    expect(select.value).toBe(`${workId}:2`);
    expect(select.disabled).toBe(shell || !known);
    if (!shell && known) {
      expect(container.textContent).toContain("可以改页码、换照片或移除照片");
      await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(api.submitAttempt.mock.calls[1]![0]).toBe(attempt.id);
      expect(api.submitAttempt.mock.calls[1]![1].clientKey).not.toBe(input.clientKey);
      expect(api.submitAttempt.mock.calls[1]![1].workSource).toEqual(input.workSource);
    }
  } finally { await act(async () => root.unmount()); container.remove(); }
});
