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
  vi.clearAllMocks(); localStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<StrictMode><TeachingExampleControl target={target} onPublished={() => {}} /></StrictMode>));
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
  await render(); await render(); await click("只读刷新原请求");
  expect(fetcher.mock.calls.every(call => !call[1]?.method)).toBe(true);
  expect(host.textContent).not.toContain("确认付费生成新例题");
});
it("keeps a lost POST read-only, including when the subsequent lookup finds nothing", async () => {
  await render(); fetcher.mockResolvedValueOnce(Response.json({ operation: null })); fetcher.mockResolvedValueOnce(Response.json({ target, estimatedCents: 2, isCap: false, consentVersion: TEACHING_EXAMPLE_CONSENT_VERSION, consentText: TEACHING_EXAMPLE_CONSENT_TEXT }));
  await click("先查看模型费用预估"); await act(async () => host.querySelector<HTMLInputElement>("input")!.click());
  fetcher.mockRejectedValueOnce(new Error("offline")); await click("确认付费生成新例题");
  fetcher.mockResolvedValueOnce(Response.json({ operation: null })); await click("只读刷新原请求");
  expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(host.textContent).toContain("不会自动重新发送");
});
it("denies creation when local recovery storage is corrupt", async () => {
  localStorage.setItem(`aistudy:teaching-example:${id}:${id}`, "bad"); await render();
  await click("先查看模型费用预估"); expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain("无法安全恢复");
});
