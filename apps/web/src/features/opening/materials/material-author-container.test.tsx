// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MaterialAuthorContainer } from "./material-author-container";
import type { MaterialAuthorSelector } from "./material-author-review-client";

const selection = (): MaterialAuthorSelector => ({ actorKey: "actor-a", accessEpoch: 1,
  courseId: "00000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000002", version: 1 });
const empty = () => new Response(JSON.stringify({ status: "unavailable", reason: "manifest_reader_disabled",
  authorReview: null, contents: [], publishable: false }));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement, root: Root;
let globalFetch: ReturnType<typeof vi.fn>, storage: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  globalFetch = vi.fn(() => { throw new Error("Unexpected global HTTP"); }); vi.stubGlobal("fetch", globalFetch);
  storage = vi.spyOn(Storage.prototype, "setItem");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  expect(globalFetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const mount = (selector: MaterialAuthorSelector | null, transport: typeof fetch) =>
  act(() => root.render(createElement(MaterialAuthorContainer, { selector, fetch: transport })));
const settle = async (fn: () => void) => { await act(async () => { fn(); }); };
function closed() {
  expect(host.textContent).toContain("人工草稿不可编辑：缺少获准资料信息；尚未保存或发布");
  expect(host.textContent).toContain("PDF 字节与来源真实性尚未验证");
  expect(host.textContent).toContain("未绑定，无法打开来源");
  expect(host.textContent).toContain("MODULE_PENDING · not_ready · 已执行题目：0");
  expect(host.querySelectorAll("a, input, textarea, select, form, iframe, object, embed, [contenteditable]")).toHaveLength(0);
  expect(host.innerHTML).not.toMatch(/PRIVATE_|published|MODULE_READY|answer_key|chunk/i);
}

it("does nothing while unselected and SSR never reads; only an explicit selection issues one injected GET", async () => {
  const pending = deferred<Response>(), transport = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
  mount(null, transport); closed(); expect(transport).not.toHaveBeenCalled();
  expect(host.textContent).toContain("请选择一项资料");
  const html = renderToStaticMarkup(createElement(MaterialAuthorContainer, { selector: selection(), fetch: transport }));
  expect(html).toContain("正在读取"); expect(transport).not.toHaveBeenCalled();
  mount(selection(), transport); closed(); expect(host.textContent).toContain("正在读取");
  expect(transport).toHaveBeenCalledTimes(1);
  mount({ ...selection() }, transport); expect(transport).toHaveBeenCalledTimes(1);
  await settle(() => pending.resolve(empty())); closed();
  expect(host.textContent).toContain("资料作者审阅暂不可用，尚未接入资料读取");
  expect(host.querySelector("button")).toBeNull();
});

it.each(["actorKey", "courseId", "sourceId", "version", "accessEpoch"] as const)(
  "destroys old state and aborts on %s change, including A→B→A and late body completion", async field => {
    const body = deferred<unknown>();
    const old = empty(); vi.spyOn(old, "json").mockReturnValue(body.promise);
    const b = deferred<Response>(), again = deferred<Response>();
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(old).mockReturnValueOnce(b.promise).mockReturnValueOnce(again.promise);
    const a = selection(), next = { ...a, [field]: field === "version" || field === "accessEpoch" ? 2
      : field === "actorKey" ? "actor-b" : "00000000-0000-4000-8000-000000000003" };
    await act(async () => { mount(a, transport); });
    const firstSignal = transport.mock.calls[0]![1]!.signal!;
    mount(next, transport); expect(firstSignal.aborted).toBe(true);
    expect(host.textContent).toContain("正在读取"); closed();
    await settle(() => body.resolve({ status: "ready", answer_key: "PRIVATE_OLD_BODY" }));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    mount(a, transport); expect(transport.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    await settle(() => b.resolve(empty())); expect(host.textContent).toContain("正在读取");
    await settle(() => again.resolve(empty())); expect(host.textContent).toContain("尚未接入资料读取"); closed();
    expect(transport).toHaveBeenCalledTimes(3);
  },
);

it("immediately discards a completed empty result on switch, and ignores an obsolete network failure", async () => {
  const old = deferred<Response>(), current = deferred<Response>();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(empty())
    .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await act(async () => { mount(selection(), transport); });
  expect(host.textContent).toContain("尚未接入资料读取");
  mount({ ...selection(), sourceId: "00000000-0000-4000-8000-000000000003" }, transport);
  expect(host.textContent).not.toContain("尚未接入资料读取"); expect(host.textContent).toContain("正在读取");
  mount(selection(), transport);
  await settle(() => old.reject(new Error("PRIVATE_OBSOLETE_NETWORK")));
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.textContent).toContain("正在读取");
  await settle(() => current.resolve(empty())); closed(); expect(transport).toHaveBeenCalledTimes(3);
});

it("clears completed errors on scope change/null and ignores stale network rejection after deselect/unmount", async () => {
  const late = deferred<Response>(), final = deferred<Response>();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("PRIVATE_404", { status: 404 }))
    .mockReturnValueOnce(late.promise).mockReturnValueOnce(final.promise);
  await act(async () => { mount(selection(), transport); });
  expect(host.textContent).toContain("找不到资料或无权访问"); closed();
  mount({ ...selection(), accessEpoch: 2 }, transport);
  expect(host.textContent).not.toContain("找不到资料"); expect(host.textContent).toContain("正在读取");
  mount(null, transport); expect(transport.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  await settle(() => late.reject(new Error("PRIVATE_LATE_NETWORK")));
  expect(host.textContent).toContain("请选择一项资料"); closed();
  mount(selection(), transport); act(() => root.unmount()); root = createRoot(host);
  expect(transport.mock.calls[2]![1]!.signal!.aborted).toBe(true);
  await settle(() => final.resolve(empty())); expect(host.textContent).toBe("");
});

it.each([
  [401, "会话已失效", false], [404, "找不到资料或无权访问", false],
  [409, "资料选择已失效", true], [503, "暂不可用", true],
])("shows only safe HTTP %i copy, never raw, with explicit retry policy", async (status, message, retry) => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE_SQL_TOKEN", { status }));
  await act(async () => { mount(selection(), transport); }); closed();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain(message);
  expect(Boolean(host.querySelector("button"))).toBe(retry);
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["json", "network", "ready", "raw"])("fails closed on %s, retry never posts or restores content", async kind => {
  const pending = deferred<Response>();
  const transport = vi.fn<typeof fetch>();
  if (kind === "network") transport.mockRejectedValueOnce(new Error("PRIVATE_NETWORK"));
  else transport.mockResolvedValueOnce(kind === "json" ? new Response("PRIVATE_JSON")
    : new Response(JSON.stringify({ status: kind === "ready" ? "ready" : "unavailable",
      reason: "manifest_reader_disabled", authorReview: null, contents: [], publishable: false,
      answer_key: "PRIVATE_RAW" })));
  transport.mockReturnValueOnce(pending.promise);
  await act(async () => { mount(selection(), transport); }); closed();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("正在读取"); expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  await settle(() => pending.resolve(empty())); closed(); expect(host.textContent).toContain("尚未接入资料读取");
  expect(transport).toHaveBeenCalledTimes(2);
  for (const [url, init] of transport.mock.calls) {
    expect(String(url)).toMatch(/^\/api\/opening\/courses\/[\da-f-]+\/material-author-review\?sourceId=[\da-f-]+&version=1$/);
    expect(init!.method).toBe("GET"); expect(init!.body).toBeUndefined();
  }
});
