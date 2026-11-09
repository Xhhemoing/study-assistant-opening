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
  sessionStorage.clear();
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 3 } } } });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt)));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
async function render() { await act(async () => root.render(<SpanDelayedRetestControl record={record} />)); }
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
function hasButton(text: string) { return [...host.querySelectorAll("button")].some(node => node.textContent === text); }
const undoResult = (cancelled: boolean, closedTaskIds: string[] = []) => Response.json({ activityId: id, cancelled, closedTaskIds });
async function confirmUndo() {
  await act(async () => button("撤销这次安排").click());
  await act(async () => button("确认撤销").click());
}
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
it("preserves a deterministic conflict across passive remounts without another POST", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: "CONFLICT", message: "已有另一条 span 复测任务，未将它改成这次的 3 天保持检查。" } }, { status: 409 }));
  await render();
  expect(host.textContent).toContain("已有另一条 span 复测任务");
  for (let mount = 0; mount < 5; mount += 1) {
    await act(async () => root.render(null));
    await render();
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(mocks.getPrefs).toHaveBeenCalledTimes(6);
  expect(host.textContent).toContain("页面重读不会自动重试");
  expect(host.querySelector('a[href="/opening/today"]')).not.toBeNull();
  await act(async () => button("安排 3 天后再练习").click());
  expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe("/api/opening/teaching/span/delayed");
});

it("does not reuse a blocked trigger for another observation or grant revision", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: "CONFLICT", message: "原任务保留" } }, { status: 409 }));
  await render();
  await act(async () => root.render(<SpanDelayedRetestControl record={{ ...record, id: courseId }} />));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 4 } } } });
  await render();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("requires explicit same-request confirmation after a remount of an unknown automatic write", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render();
  await act(async () => root.render(null));
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 4 } } } });
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("保存结果未确认");
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
});

it("rechecks permission before reading a prior blocked identity", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: "CONFLICT", message: "原任务保留" } }, { status: 409 }));
  await render();
  await act(async () => root.render(null));
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: {} } });
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain("已被服务器拒绝");
});

it("treats malformed persisted trigger data as a read error, not permission to POST", async () => {
  sessionStorage.setItem(`aistudy:span-delayed-attempt:v1:${courseId}:${id}:${id}`, "invalid JSON");
  await render();
  expect(fetch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it("does not repeat a still-pending POST after unmounting its original control", async () => {
  let settle: (response: Response) => void = () => undefined;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; })).mockResolvedValueOnce(Response.json(receipt));
  await render();
  await act(async () => root.render(null));
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(button("重新确认自动安排")).not.toBeNull();
  await act(async () => settle(Response.json(receipt)));
  expect(host.textContent).not.toContain("已自动排进复习");
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
});

it("does not dispatch an automatic write when durable trigger storage is unavailable", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  try {
    await render();
    expect(fetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain("本次未发送安排请求");
    expect(button("安排 3 天后再练习")).not.toBeNull();
  } finally { storage.mockRestore(); }
});

it("does not convert a driver failure into a deterministic conflict on remount", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求" } }, { status: 500 }));
  await render();
  await act(async () => root.render(null));
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(button("重新确认自动安排")).not.toBeNull();
  expect(host.textContent).not.toContain("已被服务器拒绝");
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

it.each([
  ["the first undo", [id]],
  ["a repeated undo", [] as string[]],
])("asks before %s and then shows the automatic arrangement as undone", async (_, closedTaskIds) => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(receipt)).mockResolvedValueOnce(undoResult(true, closedTaskIds));
  await render();
  await act(async () => button("撤销这次安排").click());
  expect(button("撤销这次安排").getAttribute("aria-expanded")).toBe("true");
  await act(async () => button("保留安排").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  await confirmUndo();
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(["/api/opening/teaching/span/delayed/automatic/cancel",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ activityId: id }) })]);
  expect(host.textContent).toContain("已撤销这次自动安排");
  expect(host.querySelector('a[href="' + receipt.href + '"]')).toBeNull();
  expect(hasButton("撤销这次安排")).toBe(false);
});

it.each([
  ["refuses a started, adjusted or planned arrangement", () => undoResult(false), "这项安排已开始、已调整或已列入计划"],
  ["does not find an automatic arrangement", () => Response.json({ error: { code: "NOT_FOUND", message: "自动复测不存在。" } }, { status: 404 }), "这项复习不是可撤销的自动安排"],
])("keeps the arrangement when the server %s", async (_, reply, reason) => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(receipt)).mockResolvedValueOnce(reply());
  await render();
  await confirmUndo();
  expect(host.textContent).toContain(`${reason}，未撤销，原记录保留`);
  expect(host.textContent).toContain("已自动排进复习");
  expect(host.querySelector('a[href="' + receipt.href + '"]')?.textContent).toBe("打开这项复习");
  expect(hasButton("撤销这次安排")).toBe(false);
});

it.each([
  ["a lost connection", () => Promise.reject(new Error("connection lost"))],
  ["a server failure", async () => Response.json({ error: { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求，请稍后重试。" } }, { status: 500 })],
])("keeps an undo after %s locked until an explicit retry repeats the same request", async (_, fail) => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(receipt)).mockImplementationOnce(fail).mockResolvedValueOnce(undoResult(true));
  await render();
  await confirmUndo();
  expect(host.textContent).toContain("撤销结果未确认");
  expect(host.querySelector('a[href="' + receipt.href + '"]')).toBeNull();
  expect(["撤销这次安排", "确认撤销", "保留安排"].some(text => hasButton(text))).toBe(false);
  await act(async () => button("重新确认撤销").click());
  expect(vi.mocked(fetch).mock.calls[2]).toEqual(vi.mocked(fetch).mock.calls[1]);
  expect(host.textContent).toContain("已撤销这次自动安排");
});

it("sends one undo request however often the confirmation is pressed", async () => {
  let settle: (response: Response) => void = () => undefined;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(receipt)).mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }));
  await render();
  await act(async () => button("撤销这次安排").click());
  const confirm = button("确认撤销");
  await act(async () => { confirm.click(); confirm.click(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(button("正在撤销…").disabled).toBe(true);
  await act(async () => settle(undoResult(true, [id])));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("已撤销这次自动安排");
});

it.each([
  ["a manual receipt", {}, false],
  ["a cancelled automatic replay", { taskStatus: "skipped", activityStatus: "cancelled" }, true],
  ["a completed automatic replay", { taskStatus: "done", activityStatus: "completed" }, true],
])("does not offer undo for %s", async (_, replay, automatic) => {
  if (!automatic) mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: {} } });
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...receipt, ...replay }));
  await render();
  if (!automatic) await act(async () => button("安排 3 天后再练习").click());
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(hasButton("撤销这次安排")).toBe(false);
});


it("keeps an unknown automatic identity when explicit confirmation cannot persist it", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render();
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  await act(async () => button("重新确认自动安排").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(button("重新确认自动安排")).not.toBeNull();
  expect(host.textContent).not.toContain("安排 3 天后再练习");
  storage.mockRestore();
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
});
it.each(["network", "invalid"])("retains unknown automatic identity across a %s preference failure", async failure => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render();
  await act(async () => root.render(null));
  if (failure === "network") mocks.getPrefs.mockRejectedValueOnce(new Error("preferences unavailable"));
  else mocks.getPrefs.mockResolvedValueOnce({ invalidStoredPrefs: true, prefs: {} });
  await render();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(button("重新确认自动安排")).not.toBeNull();
  expect(host.textContent).not.toContain("安排 3 天后再练习");
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
});

it("uses one recovered pending snapshot even if a second storage read would fail", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render(); await act(async () => root.render(null));
  const original = Storage.prototype.getItem;
  const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(function(this: Storage, key) { return original.call(this, key); }).mockImplementation(() => { throw new Error("second read unavailable"); });
  mocks.getPrefs.mockResolvedValue({ invalidStoredPrefs: false, prefs: { spanTutorGrants: { [courseId]: { enabled: true, revision: 4 } } } });
  await render();
  expect(storage).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
  storage.mockRestore();
});
it("blocks all scheduling when pending storage cannot be read, then explicitly restores the same request", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error("connection lost")).mockResolvedValueOnce(Response.json(receipt));
  await render(); await act(async () => root.render(null));
  const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("read unavailable"); });
  await render();
  expect(button("安排 3 天后再练习").disabled).toBe(true);
  await act(async () => button("安排 3 天后再练习").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector('a[href="/opening/today"]')).not.toBeNull();
  storage.mockRestore();
  await act(async () => button("重新读取安排记录").click());
  await act(async () => button("重新确认自动安排").click());
  expect(vi.mocked(fetch).mock.calls[1]).toEqual(vi.mocked(fetch).mock.calls[0]);
});

it("dispatches once after explicit reread recovers empty storage with a valid grant", async () => {
  const storage = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("read unavailable"); });
  await render();
  expect(fetch).not.toHaveBeenCalled(); expect(button("安排 3 天后再练习").disabled).toBe(true);
  storage.mockRestore();
  await act(async () => button("重新读取安排记录").click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/opening/teaching/span/delayed/automatic");
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).expectedGrantRevision).toBe(3);
});
