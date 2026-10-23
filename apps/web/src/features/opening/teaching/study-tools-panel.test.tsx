// @vitest-environment jsdom

import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyToolsPanel } from "./study-tools-panel";

let host: HTMLDivElement;
let root: Root;
let resize: ResizeObserverCallback;
let containerWidth = 1300;
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "show");

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: containerWidth, height: 800 } as DOMRect));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  Object.defineProperty(HTMLDialogElement.prototype, "show", { configurable: true, value: function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>('button[tabindex="0"],button,input')?.focus();
  } });
  containerWidth = 1300;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "show", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
});

async function click(element: HTMLElement) { await act(async () => element.click()); }
async function key(element: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  await act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options })));
}
async function changeWidth(width: number) {
  containerWidth = width;
  const target = host.querySelector<HTMLElement>("[data-study-tools-layout]")!;
  await act(async () => resize([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver));
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("nav button")].find(item => item.textContent === label)!;
}
function Example({ onMount = () => {}, pending, suspended = false, initialPanel = null, preferContentOnNarrowEntry = false }: { onMount?: () => void; pending?: Promise<string>; suspended?: boolean; initialPanel?: string | null; preferContentOnNarrowEntry?: boolean }) {
  const [panel, setPanel] = useState<string | null>(initialPanel);
  return createElement(StudyToolsPanel, { activePanel: panel, onPanelChange: setPanel, fillHeight: true, suspended, preferContentOnNarrowEntry,
    panels: [
      { id: "chat", label: "对话", mountKey: "context", content: createElement(Editor, { onMount, pending, section: panel === "notes" ? "笔记" : "对话" }) },
      { id: "outline", label: "目录", content: createElement("div", null, "目录位置") },
      { id: "notes", label: "笔记", mountKey: "context", content: createElement(Editor, { onMount, pending, section: panel === "notes" ? "笔记" : "对话" }) },
    ], children: createElement("textarea", { "aria-label": "原答", defaultValue: "原答草稿" }) });
}
function Editor({ onMount, pending, section }: { onMount: () => void; pending?: Promise<string>; section: string }) {
  const [result, setResult] = useState("");
  useEffect(() => { onMount(); }, [onMount]);
  useEffect(() => { if (pending) void pending.then(setResult); }, [pending]);
  return createElement("div", null, createElement("span", { "data-current-view": true }, section),
    createElement("textarea", { "aria-label": "提问草稿", defaultValue: "未发送的问题" }), createElement("output", null, result));
}

describe("persistent companion surface", () => {
  it("uses the real container width and keeps the same answer and editor through split/full-width switches", async () => {
    const mount = vi.fn();
    await act(async () => root.render(createElement(Example, { onMount: mount })));
    const answer = host.querySelector<HTMLTextAreaElement>('[aria-label="原答"]')!;
    answer.value = "正在写的步骤";
    await click(button("对话"));
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    draft.value = "为什么这样变换";
    expect(host.querySelector("[data-study-tools-layout]")?.getAttribute("data-study-tools-layout")).toBe("split");
    await changeWidth(1023);
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector("[data-study-tools-layout]")?.getAttribute("data-study-tools-layout")).toBe("switch");
    await changeWidth(1024);
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector('[aria-label="原答"]')).toBe(answer);
    expect(answer.value).toBe("正在写的步骤");
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(draft.value).toBe("为什么这样变换");
    expect(mount).toHaveBeenCalledOnce();
  });

  it("shares one mounted conversation/note editor and finishes an in-flight request while hidden", async () => {
    let finish!: (result: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const mount = vi.fn();
    await act(async () => root.render(createElement(Example, { onMount: mount, pending })));
    await click(button("对话"));
    const draft = host.querySelector('[aria-label="提问草稿"]');
    await click(button("笔记"));
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(host.querySelector("[data-current-view]")?.textContent).toBe("笔记");
    await click(button("目录"));
    await act(async () => finish("已经返回的说明"));
    await click(button("对话"));
    expect(host.querySelector("output")?.textContent).toBe("已经返回的说明");
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(mount).toHaveBeenCalledOnce();
  });

  it("moves among tabs with arrows/Home/End and leaves IME composition alone", async () => {
    await act(async () => root.render(createElement(Example)));
    await click(button("对话"));
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]!.focus(); await key(tabs[0]!, "ArrowRight");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    await key(tabs[1]!, "End"); expect(document.activeElement).toBe(tabs[2]);
    await key(tabs[2]!, "Home"); expect(document.activeElement).toBe(tabs[0]);
    await key(tabs[0]!, "ArrowRight", { isComposing: true });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
  });

  it("returns focus to the opener and retains the draft after closing and reopening", async () => {
    await act(async () => root.render(createElement(Example)));
    const opener = button("对话"); opener.focus(); await click(opener);
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    draft.value = "稍后再发"; draft.focus();
    await key(draft, "Escape");
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
    expect(document.activeElement).toBe(opener);
    await click(opener);
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(draft.value).toBe("稍后再发");
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("leaves Escape to the input method: %j", async composition => {
    await act(async () => root.render(createElement(Example)));
    await click(button("对话"));
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    draft.value = "还在输入"; draft.focus();
    await key(draft, "Escape", composition);
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("还在输入");
  });

  it("suspends the auxiliary surface for focus mode without losing its selected tab or draft", async () => {
    const mount = vi.fn();
    await act(async () => root.render(createElement(Example, { onMount: mount })));
    await click(button("笔记"));
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    draft.value = "写到一半的笔记";
    await act(async () => root.render(createElement(Example, { onMount: mount, suspended: true })));
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(false);
    await act(async () => root.render(createElement(Example, { onMount: mount, suspended: false })));
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("笔记");
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(draft.value).toBe("写到一半的笔记");
    expect(mount).toHaveBeenCalledOnce();
  });

  it("shows task content on a narrow automatic entry while preserving the mounted conversation and later explicit choice", async () => {
    containerWidth = 800;
    const mount = vi.fn();
    await act(async () => root.render(createElement(Example, { onMount: mount, initialPanel: "chat", preferContentOnNarrowEntry: true })));
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(false);
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="提问草稿"]')!;
    expect(draft).not.toBeNull();
    draft.value = "原会话还在";
    await click(button("对话"));
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(true);
    await changeWidth(1300); await changeWidth(800);
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(host.querySelector('[aria-label="提问草稿"]')).toBe(draft);
    expect(draft.value).toBe("原会话还在");
    await click(button("对话"));
    await changeWidth(1300);
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
    expect(mount).toHaveBeenCalledOnce();
  });

  it("keeps the automatic companion visible on a wide entry and does not reset it after resizing", async () => {
    await act(async () => root.render(createElement(Example, { initialPanel: "chat", preferContentOnNarrowEntry: true })));
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    await changeWidth(800);
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    expect(host.querySelector("[data-study-content]")?.hasAttribute("hidden")).toBe(true);
  });

  it("lets a nested save dialog own Escape", async () => {
    await act(async () => root.render(createElement(Example)));
    await click(button("对话"));
    const nested = document.createElement("dialog"); nested.setAttribute("open", "");
    host.querySelector("dialog")!.appendChild(nested);
    await key(document.body, "Escape");
    expect(host.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    nested.remove();
  });
});
