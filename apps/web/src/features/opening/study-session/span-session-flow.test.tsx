// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { getSpanProblem } from "@aistudy/domain";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { createSpanStudySession, adaptSpanLearn } from "./adapters/span";
import { StudySession } from "./study-session-shell";
const mocks = vi.hoisted(() => ({ createAttempt: vi.fn(), submitAttempt: vi.fn(), getAttemptContext: vi.fn(), preparePhotoWorkSource: vi.fn(), read: vi.fn(), request: vi.fn(), hint: vi.fn(), ack: vi.fn(), uploadFile: vi.fn(), addToCourse: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => mocks }));
vi.mock("../inbox/upload-client", () => ({ createUploadClient: () => ({ uploadFile: mocks.uploadFile }) }));
vi.mock("../library/material-organization-client", () => ({ createMaterialOrganizationClient: () => ({ addToCourse: mocks.addToCourse }) }));
vi.mock("../learning/practice-draft", () => ({ readPracticeRecord: mocks.read }));
vi.mock("../teaching/span/span-session-client", async original => ({ ...await original<typeof import("../teaching/span/span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("../teaching/span/span-hint-client", () => ({ requestSpanHint: mocks.hint }));
vi.mock("../assistant/study-exposure-ack", () => ({ acknowledgeStudyExposure: mocks.ack }));
const id = "11111111-1111-4111-8111-111111111111";
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, sourceIds: [id], sourceVersions: { [id]: 1 }, skillLabel: "span", requirementKey: null, problemId: id, itemVersionId: id, startedAt: "2026-10-31T00:00:00Z", submittedAt: null, observationId: null, historyRevision: 0, spanExercise: getSpanProblem("span-independent-3d")! };
const session = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study" as const, timeBudgetMinutes: 20, language: "zh" as const, pace: "normal" as const, continuous: true, selfReportedFatigue: "unknown" as const }, moveId: "self-independent" as const, status: "active" as const, revision: 1, retestId: null, createdAt: attempt.startedAt, updatedAt: attempt.startedAt };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); sessionStorage.clear(); });
it.each([undefined, null, 17])("passes backend estimates through details → port → rendered learn step (%s)", async estimateMinutes => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.request.mockResolvedValue({ problem: getSpanProblem("span-independent-3d"), solution: { kind: "unique", coefficients: ["2", "3"] }, exposureReceipt: { id } });
  const port = createSpanStudySession({ session: { ...session, moveId: "self-example" }, estimateMinutes, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null }, vi.fn());
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<StudySession port={port} />));
    if (estimateMinutes == null) expect(host.textContent).not.toContain("分钟");
    else expect(host.textContent).toContain("预计 17 分钟");
  } finally { await act(async () => root.unmount()); }
});
it("runs question → durable answer → saved result → explicit real successor through the shell", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const record = { id, assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  mocks.read.mockResolvedValueOnce({ observation: null, deliveredAssistance: "none" }).mockResolvedValueOnce({ observation: null, deliveredAssistance: "hinted" }).mockResolvedValue({ observation: record, deliveredAssistance: "hinted" });
  mocks.getAttemptContext.mockResolvedValue({ attempt }); mocks.createAttempt.mockResolvedValue(attempt); mocks.submitAttempt.mockResolvedValue(record);
  mocks.hint.mockResolvedValue({ level: 1, text: "先写向量等式", exposureReceipt: { id } });
  mocks.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ kind: "ready", href: `/opening/courses/${id}/study/span?lesson=${id}`, activityId: id, sessionId: id, courseId: id, label: "继续新题", resumed: false });
  const save = vi.fn(), port = createSpanStudySession({ session, estimateMinutes: 17, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null }, save);
  const navigate = vi.fn(); port.navigate = navigate;
  const host = document.createElement("div"), root = createRoot(host);
  const click = async (text: string) => { const button = [...host.querySelectorAll("button")].find(node => node.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()); };
  try {
    await act(async () => root.render(<StudySession port={port} />));
    expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(host.textContent).toContain("预计 17 分钟");
    await click("需要帮助"); await click("看下一条提示"); expect(host.textContent).toContain("先写向量等式");
    // Port edit is shared by the renderer and durable storage, then reflected by reload.
    port.edit("membership", "in_span"); port.edit("alpha", "2");
    await click("重新读取");
    await click("提交答案");
    expect(mocks.submitAttempt).toHaveBeenCalledOnce();
    const input = mocks.submitAttempt.mock.calls[0]![1]; expect(JSON.parse(input.answer)).toMatchObject({ membership: "in_span", coefficients: ["2", ""] }); expect(input.assistance).toBe("hinted");
    expect(host.textContent).toContain("用提示后答对"); expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    await click("安排下一步学习"); expect(navigate).not.toHaveBeenCalled();
    await click("继续新题"); expect(navigate).toHaveBeenCalledWith(`/opening/courses/${id}/study/span?lesson=${id}`);
  } finally { await act(async () => root.unmount()); }
});
it("adapts a released presentation and advances learning only after progress is saved", async () => {
  const raw = { problem: getSpanProblem("span-independent-3d"), solution: { kind: "unique", coefficients: ["2", "3"] }, exposureReceipt: { id } };
  expect(adaptSpanLearn(raw, "self-example")).toMatchObject({ kind: "learn", estimateMinutes: null });
  mocks.request.mockResolvedValue(raw); const save = vi.fn().mockResolvedValue(true);
  const port = createSpanStudySession({ session: { ...session, moveId: "self-example" }, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null }, save);
  expect((await port.load()).step.kind).toBe("learn"); await port.primary(); expect(save).toHaveBeenCalledWith(session.intent, "self-faded", "active");
});

it("removes a failed photo candidate so text submission has no attachment", async () => {
  sessionStorage.clear();
  mocks.request.mockResolvedValue({}); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" }); mocks.uploadFile.mockResolvedValue({ phase: "failed", message: "上传失败" });
  const isolated = { ...session, courseId: crypto.randomUUID(), activityId: crypto.randomUUID(), sessionId: crypto.randomUUID() }; const localAttempt = { ...attempt, courseId: isolated.courseId, sessionId: isolated.sessionId };
  mocks.createAttempt.mockResolvedValue(localAttempt); mocks.request.mockResolvedValue({});
  const port = createSpanStudySession({ session: isolated, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null }, vi.fn(), { photoEnabled: true });
  await port.load(); await port.choosePhoto(new File(["bad"], "bad.png", { type: "image/png" })); await port.removePhoto(); port.edit("membership", "in_span");
  const saved = { id, assistance: "none", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  mocks.submitAttempt.mockResolvedValue(saved); mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" }); await port.primary();
  expect(mocks.submitAttempt.mock.calls[0]![1]).not.toHaveProperty("workSource");
});

it("replays the same sealed payload after a transient network failure", async () => {
  sessionStorage.clear();
  mocks.request.mockResolvedValue({}); mocks.read.mockResolvedValue({ observation: null, deliveredAssistance: "none" });
  const isolated = { ...session, courseId: crypto.randomUUID(), activityId: crypto.randomUUID(), sessionId: crypto.randomUUID() }; const localAttempt = { ...attempt, courseId: isolated.courseId, sessionId: isolated.sessionId };
  mocks.createAttempt.mockResolvedValue(localAttempt); mocks.request.mockResolvedValue({});
  const port = createSpanStudySession({ session: isolated, attempts: [], observations: [], hintLevels: {}, assistance: {}, intentEvent: null }, vi.fn()); await port.load(); port.edit("membership", "in_span");
  const saved = { id, assistance: "none", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  mocks.submitAttempt.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(saved); mocks.read.mockResolvedValue({ observation: saved, deliveredAssistance: "none" });
  await expect(port.primary()).rejects.toThrow("network"); await port.primary(); expect(mocks.submitAttempt.mock.calls[1]![1]).toEqual(mocks.submitAttempt.mock.calls[0]![1]);
});
