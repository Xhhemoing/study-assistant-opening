// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
const mocks = vi.hoisted(() => ({ getPrefs: vi.fn() }));
vi.mock("../../client/api", () => ({ createOpeningApi: () => ({ getAdaptivePrefs: mocks.getPrefs }) }));
vi.mock("../../v3/motion/view-transition", () => ({ TransitionLink: "a" }));
import { SpanDelayedRetestControl } from "./delayed-retest-control";
const id = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";
const record = { id, courseId, serverEvaluation: { evaluatorVersion: "span-exact-v1", decision: "incorrect" } } as LearningObservation;
const receipt = { taskId: id, activityId: id, courseId, candidateId: id, notBeforeAt: "2026-10-30T00:00:00Z", href: `/opening/courses/${courseId}/study/span?retest=${id}`, taskStatus: "pending", activityStatus: "accepted" };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 3 } } } });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt)));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function render() { await act(async () => root.render(<SpanDelayedRetestControl record={record} />)); }
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
it("does not automatically use the manual route when the course has no grant", async () => {
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: {} } });
  await render();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button("安排 3 天后再练习").click());
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/delayed", expect.objectContaining({ body: JSON.stringify({ observationId: id, clientKey: `span-delayed:${id}` }) }));
});
it("sends an automatic request only with the observed course grant revision", async () => {
  await render();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/delayed/automatic", expect.objectContaining({ body: JSON.stringify({ observationId: id, clientKey: `span-delayed:${id}`, expectedGrantRevision: 3 }) }));
  expect(host.textContent).toContain("已自动排进复习");
});
it("keeps an automatic budget refusal visible and leaves a separate explicit manual choice", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "今日预算已用完，请手动选择后续安排。" } }, { status: 409 })).mockResolvedValueOnce(Response.json(receipt));
  await render();
  expect(host.textContent).toContain("今日预算已用完");
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => button("安排 3 天后再练习").click());
  expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe("/api/opening/teaching/span/delayed");
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).not.toHaveProperty("expectedGrantRevision");
});
it("shows a cancelled replay as preserved history instead of newly scheduled work", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...receipt, taskStatus: "skipped", activityStatus: "cancelled" }));
  await render();
  expect(host.textContent).toContain("这项复测已取消");
  expect(host.textContent).not.toContain("已自动排进复习");
  expect(host.querySelector('a[href="' + receipt.href + '"]')).toBeNull();
});
it("keeps an unknown automatic attempt locked until an explicit retry reuses the same key and revision", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render();
  expect(host.textContent).toContain("保存结果未确认");
  expect([...host.querySelectorAll("button")].some(node => node.textContent === "安排 3 天后再练习")).toBe(false);
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
  expect(host.textContent).toContain("已自动排进复习");
});

it("finishes automatic scheduling when React remounts effects in strict mode", async () => {
  await act(async () => root.render(<StrictMode><SpanDelayedRetestControl record={record} /></StrictMode>));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("已自动排进复习");
});

it("automatically schedules a correct independently answered result through the same grant boundary", async () => {
  await act(async () => root.render(<SpanDelayedRetestControl record={{ ...record, assistance: "independent", serverEvaluation: { ...record.serverEvaluation!, decision: "correct" } }} />));
  expect(mocks.getPrefs).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/opening/teaching/span/delayed/automatic", expect.any(Object));
  expect(host.textContent).toContain("已自动排进复习");
  expect(host.textContent).not.toContain("掌握");
});

it("does not auto-schedule when the stored authorization cannot be read", async () => {
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: true, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 3 } } } });
  await render();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("导师授权暂时无法读取");
  expect(button("安排 3 天后再练习")).not.toBeNull();
});

it.each([
  ["skipped", "cancelled", "这项复测已取消"],
  ["done", "completed", "这项复测已完成"],
])("shows a manual %s replay as existing history instead of new work", async (taskStatus, activityStatus, message) => {
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: {} } });
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...receipt, taskStatus, activityStatus }));
  await render();
  await act(async () => button("安排 3 天后再练习").click());
  expect(host.textContent).toContain(message);
  expect(host.textContent).not.toContain("复习已加入今日任务");
  if (taskStatus === "skipped") expect(host.querySelector('a[href="' + receipt.href + '"]')).toBeNull();
  else expect(host.querySelector('a[href="' + receipt.href + '"]')?.textContent).toBe("回看这项复习");
});
