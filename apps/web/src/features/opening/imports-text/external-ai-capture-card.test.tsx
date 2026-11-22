// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalAiCaptureCard } from "./external-ai-capture-card";

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<ExternalAiCaptureCard />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function fill(value: string) {
  const area = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () => act(async () => host.querySelector("button")!.click());

it("labels the controls, previews steps, preserves the paste on failure and retries one intent", async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(
    Response.json({ sourceId: "saved", taskId: "task", deferredBehindActiveRetest: true }));
  vi.stubGlobal("fetch", fetcher);
  expect(host.querySelector("textarea")?.labels?.[0]?.textContent).toBe("讲解内容");
  expect(host.querySelector("button")!.disabled).toBe(true);
  expect(host.querySelector("select")!.labels?.[0]?.textContent).toContain("讲解来自");
  await fill("# 导数\n1. 展开定义");
  expect(host.querySelector("ol li")?.textContent).toBe("展开定义");
  await submit();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("重试");
  expect(host.querySelector("textarea")!.value).toContain("展开定义");
  await submit();
  expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
  expect(host.querySelector("[role=status]")?.textContent).toContain("现有复测之后");
  expect(host.querySelector("textarea")!.value).toBe("");
});

it("preserves the paste on conflict and uses a fresh key on the next click", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ sourceId: "saved", taskId: "task" }));
  vi.stubGlobal("fetch", fetcher);
  await fill("先列出方程");
  await submit();
  expect(host.querySelector("[role=alert]")?.textContent).toContain("冲突或已过期");
  expect(host.querySelector("textarea")!.value).toBe("先列出方程");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await submit();
  const [first, second] = fetcher.mock.calls.map(([, request]) => JSON.parse(request.body));
  expect(second.clientKey).not.toBe(first.clientKey);
  expect(second).toEqual({ ...first, clientKey: second.clientKey });
  expect(host.querySelector("textarea")!.value).toBe("");
});

it("disables submission while saving and honors the scheduling toggle", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  await fill("先列出方程");
  await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  await submit();
  expect(host.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector("fieldset")!.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledWith("/api/opening/imports/text", expect.objectContaining({
    body: expect.stringContaining('"scheduleNextDayRetell":false'),
  }));
  await act(async () => finish(Response.json({ sourceId: "saved", taskId: null })));
  expect(host.querySelector("[role=status]")?.textContent).toBe("讲解已存入资料库。");
});

it("falls back to server time zone and only notifies after a confirmed save", async () => {
  const onSaved = vi.fn();
  const resolveTimeZone = vi.fn().mockRejectedValue(new Error("settings unavailable"));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ sourceId: "saved", taskId: "task" }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<ExternalAiCaptureCard resolveTimeZone={resolveTimeZone} onSaved={onSaved} />));
  await fill("先列出方程");
  await submit();
  expect(onSaved).not.toHaveBeenCalled();
  await submit();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).not.toHaveProperty("timeZone");
  expect(onSaved).toHaveBeenCalledExactlyOnceWith({ sourceId: "saved", taskId: "task" });
});
