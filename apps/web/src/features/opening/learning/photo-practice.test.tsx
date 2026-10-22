// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SourceRecord } from "@aistudy/contracts";
const api = vi.hoisted(() => ({ listSources: vi.fn(), prepare: vi.fn(), attempt: vi.fn(), original: vi.fn(), tutoring: vi.fn() }));
vi.mock("../client/api", async original => ({ ...await original<typeof import("../client/api")>(), createOpeningApi: () => api }));
vi.mock("./photo-practice-client", () => ({ preparePhotoPractice: api.prepare }));
vi.mock("./attempt-form", () => ({ LearningAttemptForm: (props: unknown) => { api.attempt(props); return createElement("div", null, "我的解答"); } }));
vi.mock("../assistant/conversation-companion", () => ({ OriginalConversationSlot: (props: unknown) => { api.original(props); return createElement("div", null, "原对话"); } }));
vi.mock("../assistant/assistant-session", () => ({ AssistantSession: (props: unknown) => { api.tutoring(props); return createElement("div", null, "本题辅导"); } }));
import { PhotoPractice } from "./photo-practice";
const sourceId = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";
const source: SourceRecord = { id: sourceId, workspaceId: courseId, name: "试题.png", mime: "image/png", bytes: 100, sha256: "a".repeat(64), version: 2, uploadState: "uploaded", parseState: "ready", error: null, createdAt: "2026-10-21T00:00:00Z" };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks(); window.sessionStorage.clear();
  HTMLDialogElement.prototype.show = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.listSources.mockResolvedValue([source]); api.prepare.mockResolvedValue({ sourceId, sourceVersion: 2, courseId });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(createElement(PhotoPractice, { sourceId }))); }

it("waits for explicit question confirmation, then opens a source-bound attempt with an empty answer", async () => {
  await render(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.attempt).not.toHaveBeenCalled();
  expect(container.querySelector("img")?.src).toContain("version=2");
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "计算 1+1");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ sourceId, sourceVersion: 2 });
  expect(api.attempt).toHaveBeenLastCalledWith(expect.objectContaining({ courseId,
    initialFocus: { skillLabel: "随手练习", requirementKey: null }, initialProblem: { sourceId, sourceVersion: 2, stem: "计算 1+1" } }));
  expect(api.attempt.mock.lastCall![0]).not.toHaveProperty("answer");
  expect(api.attempt.mock.lastCall![0]).not.toHaveProperty("workSourceId");
});

it("restores confirmed question text through the idempotent service while preserving its version", async () => {
  window.sessionStorage.setItem(`study:photo-practice:v1:${sourceId}`, JSON.stringify({ sourceVersion: 2, stem: "原题干", confirmed: true }));
  await render();
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ sourceId, sourceVersion: 2 });
  expect(api.attempt).toHaveBeenLastCalledWith(expect.objectContaining({ initialProblem: { sourceId, sourceVersion: 2, stem: "原题干" } }));
});

it("keeps the old text and requires new confirmation when the uploaded image changes", async () => {
  window.sessionStorage.setItem(`study:photo-practice:v1:${sourceId}`, JSON.stringify({ sourceVersion: 1, stem: "旧题干", confirmed: true }));
  await render();
  expect(api.prepare).not.toHaveBeenCalled(); expect(api.attempt).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("旧题干");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("题图已更新");
});


it("keeps the original conversation and attempt tutoring in separate mounted sessions in one companion", async () => {
  const conversationId = "33333333-3333-4333-8333-333333333333";
  window.sessionStorage.setItem(`study:photo-practice:v1:${sourceId}`, JSON.stringify({ sourceVersion: 2, stem: "原题干", confirmed: true }));
  await act(async () => root.render(createElement(PhotoPractice, { sourceId, conversationId })));
  const originalButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "对话")!;
  await act(async () => originalButton.click());
  expect(api.original).toHaveBeenCalledWith(expect.objectContaining({ conversationId }));
  const practiceProps = api.attempt.mock.lastCall![0];
  expect(practiceProps).not.toHaveProperty("conversationId");
  const attempt = { id: "44444444-4444-4444-8444-444444444444", courseId, sessionId: "55555555-5555-4555-8555-555555555555", itemVersionId: "66666666-6666-4666-8666-666666666666" };
  await act(async () => practiceProps.onAskAttempt(attempt));
  const { entry } = api.tutoring.mock.lastCall![0];
  expect(entry.conversation).toBeNull(); expect(entry.fresh).toBe(true);
  expect(entry.learningAttempt).toEqual(attempt);
  expect(entry.context.attemptId).toBe(attempt.id);
  expect(container.querySelectorAll("[data-study-companion]")).toHaveLength(1);
  expect(api.original.mock.lastCall![0].conversationId).toBe(conversationId);
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("对话");
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "本题辅导")?.getAttribute("aria-pressed")).toBe("true");
  const nextAttempt = { ...attempt, id: "77777777-7777-4777-8777-777777777777" };
  await act(async () => practiceProps.onAskAttempt(nextAttempt));
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
  expect(container.querySelector<HTMLElement>(`[data-photo-tutoring="${attempt.id}"]`)?.hidden).toBe(true);
  expect(container.querySelector<HTMLElement>(`[data-photo-tutoring="${nextAttempt.id}"]`)?.hidden).toBe(false);
  await act(async () => practiceProps.onAskAttempt(attempt));
  expect(container.querySelectorAll("[data-photo-tutoring]")).toHaveLength(2);
  expect(container.querySelector<HTMLElement>(`[data-photo-tutoring="${attempt.id}"]`)?.hidden).toBe(false);
  expect(container.querySelector<HTMLElement>(`[data-photo-tutoring="${nextAttempt.id}"]`)?.hidden).toBe(true);
});


it.each([{ width: 400, companionOpen: false }, { width: 1100, companionOpen: true }])("opens the original chat beside photo content only when the initial workspace fits: $width", async ({ width, companionOpen }) => {
  const size = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
  try {
    await act(async () => root.render(createElement(PhotoPractice, { sourceId, conversationId: "33333333-3333-4333-8333-333333333333" })));
    expect(api.original).toHaveBeenCalled();
    expect(container.querySelector("[data-study-companion]")?.hasAttribute("open")).toBe(companionOpen);
    expect(container.querySelector<HTMLElement>("[data-study-content]")?.hidden).toBe(false);
  } finally { size.mockRestore(); }
});
