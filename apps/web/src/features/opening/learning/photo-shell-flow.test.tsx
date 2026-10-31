// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ listSources: vi.fn(), getSummary: vi.fn(), prepare: vi.fn(), createSession: vi.fn(), createAttempt: vi.fn(), getAttempt: vi.fn(), listObservations: vi.fn(), getObservationHistory: vi.fn(), submitAttempt: vi.fn(), getGradingStatus: vi.fn(), gradeObservation: vi.fn() }));
const flags = vi.hoisted(() => ({ studySessionV2: true }));
vi.mock("../capabilities/capabilities-provider", () => ({ useOpeningCapabilities: () => flags }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => api }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("./photo-practice-client", () => ({ preparePhotoPractice: api.prepare }));
vi.mock("./photo-recognition-editor", () => ({ PhotoRecognitionEditor: () => null }));
vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => false }));
import { PhotoPractice } from "./photo-practice";
import { LearningAttemptForm } from "./attempt-form";
const courseId = "11111111-1111-4111-8111-111111111111", sourceId = "22222222-2222-4222-8222-222222222222", sessionId = "33333333-3333-4333-8333-333333333333", workId = "55555555-5555-4555-8555-555555555555";
const attempt = { id: "44444444-4444-4444-8444-444444444444", workspaceId: courseId, courseId, sessionId, skillLabel: "随手练习", requirementKey: null, sourceIds: [sourceId], sourceVersions: { [sourceId]: 2 }, problemId: sourceId, itemVersionId: sessionId, stemSnapshot: "确认的题干", observationId: null, submittedAt: null, startedAt: "2026-10-22T00:00:00Z", historyRevision: 0 };
const observation = { ...attempt, id: "66666666-6666-4666-8666-666666666666", attemptId: attempt.id, answer: "第一行\n第二行", outcome: "correct", assistance: "hinted", verdictSource: "self_report", revisionKind: "original", occurredAt: "2026-10-22T00:00:00Z" };
let testSourceId: string;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks(); window.sessionStorage.clear(); flags.studySessionV2 = true;
  testSourceId = crypto.randomUUID();
  attempt.sourceIds = [testSourceId]; attempt.sourceVersions = { [testSourceId]: 2 };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.show = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.listSources.mockResolvedValue([{ id: testSourceId, version: 2, name: "题图", mime: "image/png", uploadState: "uploaded", parseState: "ready" }, { id: workId, version: 0, name: "我的作答照片", mime: "image/png", uploadState: "uploaded", parseState: "ready" }]);
  api.prepare.mockResolvedValue({ courseId, sourceId: testSourceId, sourceVersion: 2 }); api.getSummary.mockResolvedValue([]);
  api.createSession.mockResolvedValue({ id: sessionId }); api.createAttempt.mockResolvedValue(attempt);
  api.getAttempt.mockResolvedValue({ attemptId: attempt.id, sessionId, deliveredAssistance: "hinted" }); api.listObservations.mockResolvedValue([]);
  api.getObservationHistory.mockResolvedValue({ rootObservationId: observation.id, headObservationId: observation.id, revisions: [observation] });
  api.getGradingStatus.mockResolvedValue({ status: "needs_manual", headObservationId: observation.id, retryable: true, autoGradeSkipped: "disabled" });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(createElement(PhotoPractice, { sourceId: testSourceId }))); }
async function input(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLTextAreaElement ? "input" : "change", { bubbles: true })); });
}
async function click(text: string) { const button = [...container.querySelectorAll("button")].find(button => button.textContent === text); expect(button).toBeTruthy(); await act(async () => button!.click()); }
async function confirm() { await render(); expect(container.querySelector('[aria-label="学习会话"]')).toBeNull(); await input(container.querySelector("textarea")!, "确认的题干"); await click("确认题干，开始作答"); }
const primaries = () => [...container.querySelectorAll("button, a")].filter(element => element.className.includes("bg-ink"));

it.each([false, true])("confirmed photo flag=%s keeps a separate blank answer and one real save action", async enabled => {
  flags.studySessionV2 = enabled; await confirm();
  expect(Boolean(container.querySelector('[aria-label="学习会话"]'))).toBe(enabled);
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(container.textContent).toContain("上传作答照片");
  expect(primaries()).toHaveLength(1); expect((primaries()[0] as HTMLButtonElement).disabled).toBe(true);
  expect(api.submitAttempt).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("预计");
});

it("saves multiline text and the selected original attachment, then renders the real result chain only", async () => {
  await confirm(); await input(container.querySelector("textarea")!, "第一行\n第二行");
  const select = [...container.querySelectorAll("select")].find(select => select.textContent?.includes("仅批改文字答案"))!;
  await input(select, `${workId}:0`);
  api.submitAttempt.mockResolvedValue(observation); await click("保存并批改");
  expect(api.submitAttempt).toHaveBeenCalledWith(attempt.id, expect.objectContaining({ answer: "第一行\n第二行", assistance: "hinted", workSource: { id: workId, version: 0, physicalPage: 1 } }));
  expect(container.textContent).toContain("原答案已保存"); expect(container.textContent).toContain("我的解答 · 原答案");
  expect(container.textContent).toContain("纠正记录"); expect(container.textContent).not.toContain("独立答对");
  expect(container.textContent).not.toContain("安排下一步学习"); expect(primaries()).toHaveLength(1);
  expect(container.textContent).toContain("工作区已关闭首次提交自动批改"); expect(api.gradeObservation).not.toHaveBeenCalled();
});

it("retains failed sealed text/photo and replays the same payload/key after refresh with the same source version", async () => {
  await confirm(); await input(container.querySelector("textarea")!, "第一行\n第二行");
  await input([...container.querySelectorAll("select")].find(select => select.textContent?.includes("仅批改文字答案"))!, `${workId}:0`);
  api.submitAttempt.mockRejectedValueOnce(new Error("保存失败")); await click("保存并批改");
  const first = api.submitAttempt.mock.calls[0];
  expect(container.querySelector("textarea")?.value).toBe("第一行\n第二行"); expect(container.textContent).toContain("已附作答照片");
  expect(container.textContent).not.toContain("原答案已保存");
  await act(async () => root.render(null)); await render(); await click("继续此练习");
  expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
  expect(api.createAttempt.mock.lastCall![0].contextAnchor.sourceVersion).toBe(2);
  expect(container.querySelector("textarea")?.value).toBe("第一行\n第二行"); expect(container.textContent).toContain("确认的题干");
  api.submitAttempt.mockResolvedValue(observation); await click("重试保存同一答案");
  expect(api.submitAttempt.mock.calls[1]).toEqual(first); expect(container.textContent).toContain("我的解答 · 原答案"); expect(primaries()).toHaveLength(1);
});

it("leaves ordinary practice outside the new shell when enabled", async () => {
  await act(async () => root.render(createElement(LearningAttemptForm, { courseId, onRecorded() {} })));
  expect(container.querySelector('[aria-label="学习会话"]')).toBeNull(); expect(container.textContent).toContain("开始本次练习"); expect(api.createAttempt).not.toHaveBeenCalled();
});
