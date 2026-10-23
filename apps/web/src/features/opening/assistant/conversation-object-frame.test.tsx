// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const slot = vi.hoisted(() => ({ mounts: vi.fn(), ids: [] as string[] }));
vi.mock("./conversation-companion", () => ({ OriginalConversationSlot: ({ conversationId }: { conversationId: string }) => {
  slot.ids.push(conversationId); useEffect(() => { slot.mounts(); }, []);
  return createElement("textarea", { "aria-label": "原对话草稿", defaultValue: "未发送的问题" });
} }));
import { ConversationObjectFrame } from "./conversation-object-frame";
import { useConversationObjectHref } from "./conversation-object-context";
import { WorkspaceLayoutContext } from "../shell/workspace-layout-context";

const conversation = "11111111-1111-4111-8111-111111111111", course = "22222222-2222-4222-8222-222222222222";
let host: HTMLDivElement, root: Root, resize: ResizeObserverCallback, width = 1300;
const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "show"), close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  slot.mounts.mockClear(); slot.ids = []; width = 1300;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 800 } as DOMRect));
  vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, "show", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (show) Object.defineProperty(HTMLDialogElement.prototype, "show", show); else Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});
function Content() {
  const href = useConversationObjectHref();
  return createElement("section", null, createElement("h1", null, "课程"), createElement("textarea", { "aria-label": "对象草稿", defaultValue: "未提交原答" }),
    createElement("a", { href: href(`/opening/courses/${course}/study?activity=original&block=step&contentVersion=2`) }, "继续"));
}
function Example({ id }: { id?: string | string[] | null }) {
  const [focusMode, setFocusMode] = useState(false);
  return createElement(WorkspaceLayoutContext.Provider, { value: { focusMode, setFocusMode, toggleFocusMode: () => setFocusMode(value => !value) } },
    createElement(ConversationObjectFrame, { conversation: id, children: createElement(Content) }));
}
async function click(label: string) { const target = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label)!; expect(target).toBeTruthy(); await act(async () => target.click()); }

it("returns the original child and does not load any conversation or browser preference without an explicit id", async () => {
  const child = createElement("h1", null, "原页面");
  expect(ConversationObjectFrame({ children: child })).toBe(child);
  const storage = vi.spyOn(Storage.prototype, "getItem");
  await act(async () => root.render(createElement(Example)));
  expect(slot.mounts).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  expect(host.querySelector("dialog")).toBeNull(); expect(host.querySelector("[data-conversation-object]")).toBeNull();
  expect(host.querySelector("a")?.getAttribute("href")).not.toContain("conversation");
});
it.each(["not-a-conversation", [conversation, conversation]])("does not restore a malformed or repeated conversation parameter", async id => {
  await act(async () => root.render(createElement(Example, { id })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("原对话链接无效");
  expect(host.querySelector("h1")?.textContent).toBe("课程"); expect(slot.mounts).not.toHaveBeenCalled();
  expect(host.querySelector("dialog")).toBeNull();
});
it("passes an explicit id unchanged to the authorized host and preserves canonical task parameters", async () => {
  await act(async () => root.render(createElement(Example, { id: conversation })));
  expect(new Set(slot.ids)).toEqual(new Set([conversation])); expect(slot.mounts).toHaveBeenCalledOnce();
  expect(host.querySelectorAll("[data-study-companion]")).toHaveLength(1);
  expect(host.querySelectorAll("h1")).toHaveLength(1);
  const url = new URL(host.querySelector("a")!.getAttribute("href")!, "https://study.test");
  expect(url.searchParams.get("conversation")).toBe(conversation);
  expect(url.searchParams.get("activity")).toBe("original"); expect(url.searchParams.get("block")).toBe("step"); expect(url.searchParams.get("contentVersion")).toBe("2");
});
it("opens task content first on narrow entry while retaining the original conversation for an explicit switch", async () => {
  width = 600;
  await act(async () => root.render(createElement(Example, { id: conversation })));
  const original = host.querySelector('[aria-label="原对话草稿"]');
  expect(original).not.toBeNull(); expect(slot.mounts).toHaveBeenCalledOnce();
  expect(host.querySelector<HTMLElement>('[data-study-content]')?.hidden).toBe(false);
  expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(false);
  await click("原对话");
  expect(host.querySelector<HTMLElement>('[data-study-content]')?.hidden).toBe(true);
  expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  expect(host.querySelector('[aria-label="原对话草稿"]')).toBe(original);
  expect(slot.mounts).toHaveBeenCalledOnce();
});
it("keeps the same object and original editor mounted through closing, focus and narrow switching", async () => {
  await act(async () => root.render(createElement(Example, { id: conversation })));
  const answer = host.querySelector<HTMLTextAreaElement>('[aria-label="对象草稿"]')!, original = host.querySelector<HTMLTextAreaElement>('[aria-label="原对话草稿"]')!;
  answer.value = "原答不丢"; original.value = "对话未发送";
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="关闭学习工具"]')!.click());
  expect(host.querySelector('[aria-label="原对话草稿"]')).toBe(original);
  await click("原对话"); await click("专注");
  expect(host.querySelector("dialog")?.hasAttribute("open")).toBe(false);
  await click("退出专注");
  width = 600;
  await act(async () => resize([{ target: host.querySelector('[data-study-tools-layout]')!, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
  expect(host.querySelector('[data-study-tools-layout]')?.getAttribute("data-study-tools-layout")).toBe("switch");
  expect(host.querySelectorAll("[data-study-companion]")).toHaveLength(1);
  expect(host.querySelector('[aria-label="对象草稿"]')).toBe(answer); expect(answer.value).toBe("原答不丢");
  expect(host.querySelector('[aria-label="原对话草稿"]')).toBe(original); expect(original.value).toBe("对话未发送");
  expect(slot.mounts).toHaveBeenCalledOnce();
});
