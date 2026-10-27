// @vitest-environment jsdom
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpanLessonSnapshot } from "@aistudy/contracts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./span-session-client", async original => ({ ...await original<typeof import("./span-session-client")>(), spanLessonRequest: mocks.request }));
vi.mock("./span-lesson", () => ({ SpanLesson: ({ session, onProgress, onReload }: { session: SpanLessonSnapshot; onReload?: () => void; onProgress: (intent: SpanLessonSnapshot["intent"], move: string, status: string) => Promise<boolean> }) =>
  createElement("section", { "aria-label": session.activityId },
    createElement("input", { "aria-label": "未提交的思考", defaultValue: "" }),
    createElement("button", { onClick: () => void onProgress(session.intent, "self-independent", "active") }, "保存步骤"), onReload ? createElement("button", { onClick: onReload }, "重新读取本节") : null) }));
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
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

it("blocks an old derived lesson after its origin evidence changes and submits the current origin snapshot", async () => {
  const changed = { ...details({ ...snapshot, activityId: secondId, sessionId: secondId }), originChange: { reason: "evidence_changed", originSession: { ...snapshot, revision: 8 }, observationId: sourceId } };
  mocks.request.mockResolvedValue(changed);
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ kind: "choice", reason: "evidence_changed", message: "原评价已变化，请重新选择。", primary: { label: "查看记录", href: `/opening/courses/${courseId}#course-learning-records` } }));
  vi.stubGlobal("fetch", fetcher);
  await render({ initialActivityId: secondId });
  expect(container.querySelector(`section[aria-label="${secondId}"]`)).toBeNull();
  expect(container.textContent).toContain("原评价已变化");
  const next = [...container.querySelectorAll("button")].find(node => node.textContent === "安排下一步学习")!;
  await act(async () => next.click());
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ activityId: firstId, expectedRevision: 8, observationId: sourceId, clientKey: `span-next:${firstId}:8:${sourceId}` });
  expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST" || call[2]?.method === "PATCH")).toBe(false);
});

it("opens the superseded activity history read-only and returns to the current choice without issuing work", async () => {
  mocks.request.mockResolvedValue({ ...details({ ...snapshot, activityId: secondId, sessionId: secondId }),
    attempts: [{ id: secondId, startedAt: snapshot.createdAt }],
    observations: [{ id: secondId, attemptId: secondId, answer: "旧纠偏答案保留", occurredAt: snapshot.createdAt }],
    originChange: { reason: "evidence_changed", originSession: { ...snapshot, revision: 8 }, observationId: sourceId } });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await render({ initialActivityId: secondId });
  await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === "查看原活动历史")!.click());
  expect(container.textContent).toContain("旧纠偏答案保留");
  expect(container.querySelector(`section[aria-label="${secondId}"]`)).toBeNull();
  expect(container.querySelector("textarea,input,form")).toBeNull();
  await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === "返回重新选择")!.click());
  expect(container.textContent).toContain("安排下一步学习");
  expect(fetcher).not.toHaveBeenCalled();
  expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST" || call[2]?.method === "PATCH")).toBe(false);
});

it.each([null, snapshot])("does not continue automatically when changed materials block the origin (%s)", async originSession => {
  mocks.request.mockResolvedValue({ ...details(null), originChange: { reason: "source_unavailable", originSession, observationId: sourceId } });
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await render({ initialActivityId: secondId });
  expect(container.querySelector('[aria-label="下一步学习安排"]')).toBeNull();
  expect(container.querySelector(`a[href="/opening/courses/${courseId}"]`)).not.toBeNull();
  expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST" || call[2]?.method === "PATCH")).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it("rereads a stale open tab into the origin-change choice without mounting the old remediation again", async () => {
  mocks.request.mockResolvedValueOnce(details({ ...snapshot, activityId: secondId, sessionId: secondId }));
  await render({ initialActivityId: secondId });
  expect(container.querySelector(`section[aria-label="${secondId}"]`)).not.toBeNull();
  mocks.request.mockResolvedValueOnce({ ...details({ ...snapshot, activityId: secondId, sessionId: secondId }), originChange: { reason: "evidence_changed", originSession: snapshot, observationId: sourceId } });
  await act(async () => [...container.querySelectorAll("button")].find(node => node.textContent === "重新读取本节")!.click());
  expect(container.querySelector(`section[aria-label="${secondId}"]`)).toBeNull();
  expect(container.textContent).toContain("原评价已变化");
  expect(mocks.request.mock.calls.some(call => call[2]?.method === "POST" || call[2]?.method === "PATCH")).toBe(false);
});
