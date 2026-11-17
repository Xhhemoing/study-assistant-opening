// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TEACHING_EXAMPLE_CONSENT_TEXT, TEACHING_EXAMPLE_CONSENT_VERSION } from "@aistudy/contracts";
import { TeachingExampleControl } from "./teaching-example-control";
const id = "11111111-1111-4111-8111-111111111111";
const target = { activityId: id, documentId: id, revisionNumber: 1, blockId: id, contentVersion: 1 };
const request = { clientKey: "example-saved", target, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, acceptPaidGeneration: true };
const status = { operationId: id, clientKey: request.clientKey, target, state: "outcome_unknown", estimatedCents: 2, estimateIsCap: false, costState: "unknown", publication: null, createdAt: "2026-11-10T15:00:00.000Z" };
let host: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (selected = target) => act(async () => root.render(<StrictMode><TeachingExampleControl target={selected} onPublished={() => {}} /></StrictMode>));
const click = (text: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click());
it("mount does not request an estimate or submit; explicit quote and consent gate payment", async () => {
  await render(); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(Response.json({ operation: null }));
  fetcher.mockResolvedValueOnce(Response.json({ target, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估");
  const paid = [...host.querySelectorAll("button")].find(b => b.textContent === "确认付费生成新例题")!;
  expect(paid.disabled).toBe(true); expect(host.textContent).toContain("不是费用上限");
  await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
  fetcher.mockImplementationOnce(async (_url, options) => Response.json({ ...status, clientKey: JSON.parse(options.body).clientKey, state: "queued", costState: "unsent" }));
  await act(async () => { paid.click(); paid.click(); });
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(localStorage.getItem(`aistudy:teaching-example:${id}:${id}`)).toContain("clientKey");
  expect(host.textContent).toContain("已排队");
});
it.each(["queued", "running", "outcome_unknown"])("restores %s via GET only, never resends on remount", async state => {
  localStorage.setItem(`aistudy:teaching-example:${id}:${id}`, JSON.stringify(request));
  fetcher.mockResolvedValue(Response.json({ operation: { ...status, state } }));
  await render(); await render(); await click("刷新进度");
  expect(fetcher.mock.calls.every(call => !call[1]?.method)).toBe(true);
  expect(host.textContent).not.toContain("确认付费生成新例题");
});
it("keeps a lost POST read-only, including when the subsequent lookup finds nothing", async () => {
  await render(); fetcher.mockResolvedValueOnce(Response.json({ operation: null })); fetcher.mockResolvedValueOnce(Response.json({ target, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估"); await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
  fetcher.mockRejectedValueOnce(new Error("offline")); await click("确认付费生成新例题");
  fetcher.mockResolvedValueOnce(Response.json({ operation: null })); await click("刷新进度");
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(host.textContent).toContain("不会自动重新生成");
});
it.each(["resolve", "reject"] as const)("clears target A quote busy on switching to B, ignores A %s, and does not submit", async ending => {
  let resolve!: (value: Response) => void, reject!: (reason: Error) => void;
  const deferred = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  await render(); fetcher.mockReturnValueOnce(deferred);
  await click("先查看模型费用预估");
  const other = { ...target, blockId: "22222222-2222-4222-8222-222222222222" };
  await render(other);
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "先查看模型费用预估")!.disabled).toBe(false);
  await act(async () => { if (ending === "resolve") resolve(Response.json({ operation: status })); else reject(new Error("old lookup failed")); });
  expect(host.textContent).not.toContain("结果或费用待确认");
  fetcher.mockResolvedValueOnce(Response.json({ operation: null }));
  fetcher.mockResolvedValueOnce(Response.json({ target: other, estimatedCents: 3, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估"); expect(host.textContent).toContain("预估 3 分");
  expect(fetcher.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
});
it.each(["resolve", "reject"] as const)("ignores a deferred original-operation refresh %s after switching targets", async ending => {
  localStorage.setItem(`aistudy:teaching-example:${id}:${id}`, JSON.stringify(request));
  fetcher.mockImplementation(async () => Response.json({ operation: status }));
  await render();
  expect(host.textContent).toContain("结果或费用待确认");
  let resolve!: (value: Response) => void, reject!: (reason: Error) => void;
  fetcher.mockReturnValueOnce(new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
  await click("刷新进度");
  await render({ ...target, blockId: "22222222-2222-4222-8222-222222222222" });
  await act(async () => { if (ending === "resolve") resolve(Response.json({ operation: status })); else reject(new Error("old refresh failed")); });
  expect(host.textContent).not.toContain("暂时无法查看处理进度");
  expect(host.textContent).not.toContain("结果或费用待确认");
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "先查看模型费用预估")!.disabled).toBe(false);
  expect(fetcher.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
});
it("returns to target A during a lost paid response using the persisted identity and GET only", async () => {
  await render(); fetcher.mockResolvedValueOnce(Response.json({ operation: null }));
  fetcher.mockResolvedValueOnce(Response.json({ target, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估"); await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
  let fail!: (reason: Error) => void;
  fetcher.mockReturnValueOnce(new Promise<Response>((_yes, no) => { fail = no; }));
  await click("确认付费生成新例题");
  const original = JSON.parse(localStorage.getItem(`aistudy:teaching-example:${id}:${id}`)!);
  await render({ ...target, blockId: "22222222-2222-4222-8222-222222222222" });
  fetcher.mockResolvedValue(Response.json({ operation: { ...status, clientKey: original.clientKey } }));
  await render();
  await act(async () => fail(new Error("lost original POST")));
  await click("刷新进度");
  expect(host.textContent).toContain("结果或费用待确认");
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(host.textContent).not.toContain("确认付费生成新例题");
});
it.each(["pending", "resolve", "reject"] as const)("allows B read-only quote while A paid POST is %s and returns A GET-only", async ending => {
  await render();
  fetcher.mockResolvedValueOnce(Response.json({ operation: null }));
  fetcher.mockResolvedValueOnce(Response.json({ target, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估");
  await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
  let resolveA!: (value: Response) => void, rejectA!: (reason: Error) => void;
  fetcher.mockReturnValueOnce(new Promise<Response>((resolve, reject) => { resolveA = resolve; rejectA = reject; }));
  await click("确认付费生成新例题");
  const original = JSON.parse(localStorage.getItem(`aistudy:teaching-example:${id}:${id}`)!);
  const other = { ...target, blockId: "22222222-2222-4222-8222-222222222222" };
  await render(other);
  let resolveB!: (value: Response) => void;
  fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { resolveB = resolve; }));
  const beforeQuote = fetcher.mock.calls.length;
  await click("先查看模型费用预估");
  expect(fetcher.mock.calls).toHaveLength(beforeQuote + 1);
  await act(async () => {
    if (ending === "resolve") resolveA(Response.json({ ...status, clientKey: original.clientKey }));
    else if (ending === "reject") rejectA(new Error("lost A response"));
  });
  fetcher.mockResolvedValueOnce(Response.json({ target: other, estimatedCents: 3, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await act(async () => resolveB(Response.json({ operation: null })));
  expect(host.textContent).toContain("预估 3 分");
  expect(host.textContent).not.toContain("本次生成的结果还未确认");
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  fetcher.mockImplementation(async () => Response.json({ operation: { ...status, clientKey: original.clientKey } }));
  await render();
  await click("刷新进度");
  expect(host.textContent).toContain("结果或费用待确认");
  expect(host.textContent).not.toContain("确认付费生成新例题");
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(`aistudy:teaching-example:${id}:${id}`)!)).toEqual(original);
});
it("keeps B submission isolated when stale A settles, without another POST on either target", async () => {
  const other = { ...target, blockId: "22222222-2222-4222-8222-222222222222" };
  const failed: Array<(reason: Error) => void> = [];
  for (const selected of [target, other]) {
    await render(selected);
    fetcher.mockResolvedValueOnce(Response.json({ operation: null }));
    fetcher.mockResolvedValueOnce(Response.json({ target: selected, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
    await click("先查看模型费用预估");
    expect(host.querySelector("input")).not.toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
    fetcher.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => failed.push(reject)));
    await act(async () => {
      const button = [...host.querySelectorAll("button")].find(button => button.textContent === "确认付费生成新例题")!;
      button.click(); button.click();
    });
  }
  await act(async () => failed[0]!(new Error("stale A failed")));
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(2);
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "刷新进度")!.disabled).toBe(true);
  expect(host.textContent).not.toContain("本次生成的结果还未确认");
  await act(async () => failed[1]!(new Error("B response unknown")));
  expect(host.textContent).toContain("本次生成的结果还未确认");
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "刷新进度")!.disabled).toBe(false);
  for (const selected of [target, other]) {
    const saved = JSON.parse(localStorage.getItem(`aistudy:teaching-example:${id}:${selected.blockId}`)!);
    fetcher.mockImplementation(async () => Response.json({ operation: { ...status, target: selected, clientKey: saved.clientKey } }));
    await render(selected); await click("刷新进度");
    expect(host.textContent).not.toContain("确认付费生成新例题");
  }
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(2);
});
it("denies creation when local recovery storage is corrupt", async () => {
  localStorage.setItem(`aistudy:teaching-example:${id}:${id}`, "bad"); await render();
  await click("先查看模型费用预估"); expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain("无法安全恢复");
});
