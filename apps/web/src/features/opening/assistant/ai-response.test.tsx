// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StreamText } from "./ai-response";
import { LearningProse } from "./learning-prose";
import { MessageList } from "./message-list";
import { selectedSourceFor } from "./selection-source";
import type { ChatMessageView } from "./message-model";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  document.documentElement.dataset.motion = "full";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); delete document.documentElement.dataset.motion;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function render(text: string, reveal = true, busy = false) {
  await act(async () => root.render(createElement(StreamText, { reveal, busy, children: createElement(LearningProse, { text, citationLinks: [{ href: "/source/one", label: "原材料" }] }) })));
}
const groups = () => Array.from(container.querySelectorAll<HTMLElement>("[data-reply-text-group]"));
async function tick(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

it("reveals two graphemes at a time without changing full text or DOM selection", async () => {
  const text = "你好👩‍🔬é，学习顺利。";
  await render(text);
  const before = groups();
  expect(before[0]?.textContent).toBe("你好"); expect(before[1]?.textContent).toBe("👩‍🔬é");
  expect(before.every(group => group.className === "opacity-0")).toBe(true);
  expect(container.textContent).toBe(text);
  await tick(20); expect(before[0]?.className).toBe("opacity-100"); expect(before[1]?.className).toBe("opacity-0");
  const range = document.createRange(); range.selectNodeContents(container.querySelector("p")!);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(selection.toString()).toBe(text);
  expect(selectedSourceFor(text, container, selection)).toEqual({ kind: "source", text });
  await act(async () => container.querySelector("p")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await tick(40); expect(groups().every(group => group.className === "opacity-100")).toBe(true);
  expect(groups()[0]).toBe(before[0]); expect(selection.toString()).toBe(text);
});

it("keeps math, links, code, citations and list structure intact", async () => {
  await render("计算 $x^2$，参考[1]及[说明](https://example.com)。\n\n- 使用 `x + 1`\n\n```ts\nconst x = 1;\n```");
  expect(container.querySelector(".katex")).not.toBeNull();
  expect(container.querySelectorAll(".katex [data-reply-text-group],a [data-reply-text-group],code [data-reply-text-group],sup [data-reply-text-group]")).toHaveLength(0);
  expect(container.querySelector('sup a[href="/source/one"]')).not.toBeNull();
  expect(container.querySelector("ul > span")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe("x + 1");
  await tick(2500); expect(groups().every(group => group.className === "opacity-100")).toBe(true);
});

it.each(["user", "system"])("shows the whole reply immediately for %s reduced motion", async preference => {
  if (preference === "user") document.documentElement.dataset.motion = "reduce";
  else vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  await render("立即完整显示这段文字。"); expect(groups().every(group => group.className === "opacity-100")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops revealing when reduced motion is enabled while displaying a reply", async () => {
  await render("这是一段足够长的回答，切换减少动效后立即显示全部。");
  await act(async () => { document.documentElement.dataset.motion = "reduce"; });
  await tick(40); expect(groups().every(group => group.className === "opacity-100")).toBe(true);
});

it("finishes correctly when StrictMode replays mount effects", async () => {
  await act(async () => root.render(createElement(StrictMode, null, createElement(StreamText, { reveal: true, children: createElement(LearningProse, { text: "严格模式下也会完整显示。" }) }))));
  expect(groups().some(group => group.className === "opacity-0")).toBe(true);
  await tick(2500); expect(groups().every(group => group.className === "opacity-100")).toBe(true);
});

it("does not animate restored history, but reveals a pending reply once when completed", async () => {
  const old: ChatMessageView = { id: "history", role: "assistant", text: "历史记录", status: "complete", citations: [], citationLabels: [] };
  const pending: ChatMessageView = { ...old, id: "new", status: "pending", text: "" };
  async function messages(rows: ChatMessageView[]) { await act(async () => root.render(createElement(MessageList, { messages: rows, proseEnabled: true, artifactsEnabled: false }))); }
  await messages([]); await messages([old]); expect(groups()).toHaveLength(0);
  await messages([old, pending]);
  const complete = { ...pending, status: "complete" as const, text: "这是新的完整回答。" };
  await messages([old, complete]); expect(groups().length).toBeGreaterThan(0);
  expect(groups().some(group => group.className === "opacity-0")).toBe(true);
  expect(container.querySelector('[data-reply-announcement="true"]')?.textContent).toBe(complete.text);
  const announcement = container.querySelector('[data-reply-announcement="true"]')!.firstChild;
  await tick(2500); await messages([old, { ...complete }]);
  expect(groups().every(group => group.className === "opacity-100")).toBe(true);
  expect(container.querySelector('[data-reply-announcement="true"]')!.firstChild).toBe(announcement);
});
