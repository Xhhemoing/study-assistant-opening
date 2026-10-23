// @vitest-environment jsdom
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpanLessonSnapshot } from "@aistudy/contracts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./span-session-client", async original => ({ ...await original<typeof import("./span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("./span-lesson", () => ({ SpanLesson: ({ session, onProgress }: { session: SpanLessonSnapshot; onProgress: (intent: SpanLessonSnapshot["intent"], move: string, status: string) => Promise<boolean> }) =>
  createElement("section", { "aria-label": session.activityId },
    createElement("input", { "aria-label": "未提交的思考", defaultValue: "" }),
    createElement("button", { onClick: () => void onProgress(session.intent, "self-independent", "active") }, "保存步骤")) }));
vi.mock("./span-session-summary", () => ({ SpanSessionSummary: () => createElement("p", null, "会话小结") }));
import { SpanLessonSession } from "./span-lesson-session";

const courseId = "11111111-1111-4111-8111-111111111111", firstId = "22222222-2222-4222-8222-222222222222";
const secondId = "33333333-3333-4333-8333-333333333333", sourceId = "44444444-4444-4444-8444-444444444444";
const snapshot: SpanLessonSnapshot = { activityId: firstId, sessionId: firstId, courseId, sourceIds: [sourceId],
  intent: { purpose: "self_study", timeBudgetMinutes: 20, pace: "normal", language: "zh", continuous: true, selfReportedFatigue: "unknown" },
  moveId: "self-example", status: "active", revision: 1, retestId: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
const details = (session: SpanLessonSnapshot | null) => ({ session, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null });
const baseProps = { courseId, sourceIds: [sourceId], sourceLoadError: false };
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.request.mockReset(); mocks.request.mockImplementation(async (_path: string, _schema: unknown, init?: RequestInit) => init?.method === "POST" ? { ...snapshot, ...JSON.parse(String(init.body)), activityId: secondId } : details(snapshot));
  window.history.replaceState(null, "", `/opening/courses/${courseId}/study/span`);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function render(props: Partial<ComponentProps<typeof SpanLessonSession>> = {}) {
  await act(async () => root.render(createElement(SpanLessonSession, { ...baseProps, ...props })));
}

it.each(["retest", "course"] as const)("clears the old activity when same-page navigation changes %s", async kind => {
  mocks.request.mockResolvedValueOnce(details({ ...snapshot, status: "completed" }));
  await render({ initialActivityId: firstId });
  expect(container.textContent).toContain("本次学习已结束");
  mocks.request.mockResolvedValueOnce(details(null));
  await render(kind === "retest" ? { delayedRetestId: secondId } : { courseId: secondId });
  const reads = mocks.request.mock.calls.filter(call => !call[2]);
  const url = new URL(reads.at(-1)![0] as string, window.location.origin);
  expect(url.searchParams.has("activityId")).toBe(false);
  expect(url.searchParams.get(kind === "retest" ? "retestId" : "courseId")).toBe(secondId);
  expect(container.textContent).not.toContain("本次学习已结束");
  expect(container.textContent).not.toContain("会话小结");
  expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST")).toBe(true);
});

it("restores a different explicit activity and ignores a late save from the old one", async () => {
  await render({ initialActivityId: firstId });
  let finishOldSave!: (value: SpanLessonSnapshot) => void;
  mocks.request.mockImplementationOnce(() => new Promise<SpanLessonSnapshot>(resolve => { finishOldSave = resolve; }));
  await act(async () => container.querySelector("button")!.click());
  mocks.request.mockResolvedValueOnce(details({ ...snapshot, activityId: secondId, sessionId: secondId }));
  await render({ initialActivityId: secondId });
  expect(new URL(mocks.request.mock.calls.at(-1)![0] as string, window.location.origin).searchParams.get("activityId")).toBe(secondId);
  expect(container.querySelector(`section[aria-label="${secondId}"]`)).not.toBeNull();
  const url = window.location.href;
  await act(async () => finishOldSave({ ...snapshot, revision: 2, moveId: "self-independent" }));
  expect(window.location.href).toBe(url);
  expect(container.querySelector(`section[aria-label="${firstId}"]`)).toBeNull();
});

it("adopts its own acknowledged lesson URL without reloading or replacing unsaved input", async () => {
  mocks.request.mockResolvedValueOnce(details(null)).mockResolvedValueOnce(snapshot);
  await render();
  const editor = container.querySelector<HTMLInputElement>("input")!;
  editor.value = "尚未提交的原始思考";
  const requests = mocks.request.mock.calls.length;
  await render({ initialActivityId: firstId });
  expect(mocks.request).toHaveBeenCalledTimes(requests);
  expect(container.querySelector("input")).toBe(editor);
  expect(editor.value).toBe("尚未提交的原始思考");
});

it("automatically creates only one session under StrictMode and restores it without a new POST", async () => {
  mocks.request.mockImplementation(async (_path: string, _schema: unknown, init?: RequestInit) => init?.method === "POST" ? snapshot : details(null));
  await act(async () => root.render(createElement(StrictMode, null, createElement(SpanLessonSession, baseProps))));
  expect(mocks.request.mock.calls.filter(call => call[2]?.method === "POST")).toHaveLength(1);
  expect(container.querySelector(`section[aria-label="${firstId}"]`)).not.toBeNull();
});
