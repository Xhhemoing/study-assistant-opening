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
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("sourceVersion mismatch");
    expect(api.submitAttempt).not.toHaveBeenCalled(); expect(api.gradeObservation).not.toHaveBeenCalled();
    const resume = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "继续此练习");
    await act(async () => resume!.click());
    expect(api.createSession).toHaveBeenCalledOnce();
    expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
