// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingRows } from "./skeleton";
import { Drawer } from "./drawer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
import { ToastProvider, useToast } from "./toast";

let host: HTMLDivElement;
let root: Root;
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.removeAttribute("data-motion");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
  vi.useRealTimers();
});
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
}
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function Draft() {
  const [count, setCount] = useState(0);
  return <button type="button" data-draft onClick={() => setCount(value => value + 1)}>草稿 {count}</button>;
}
function DrawerExample({ keepMounted = false }: { keepMounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button data-open type="button" onClick={() => setOpen(true)}>打开</button><Drawer open={open} onClose={() => setOpen(false)} title="问 AI" description="当前课程" keepMounted={keepMounted}><Draft /></Drawer></>;
}

function matchMedia({ mobile = true, reduced = false }: { mobile?: boolean; reduced?: boolean } = {}) {
  const reducedQuery = new EventTarget() as MediaQueryList;
  Object.defineProperty(reducedQuery, "matches", { value: reduced, writable: true });
  vi.stubGlobal("matchMedia", (query: string) => query.includes("prefers-reduced-motion") ? reducedQuery : { matches: mobile, addEventListener() {}, removeEventListener() {} });
  return reducedQuery;
}

async function pointer(element: Element, type: string, point: { x: number; y: number; pointerType?: string; pointerId?: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: point.x, clientY: point.y, pointerType: point.pointerType ?? "touch", pointerId: point.pointerId ?? 1, button: 0, isPrimary: true });
  await act(async () => { element.dispatchEvent(event); });
}

describe("Drawer lifecycle", () => {
  it("keeps closed content out of the document and labels the modal on open", async () => {
    await act(async () => root.render(<DrawerExample />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(host.querySelector("[data-open]"));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("问 AI");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("当前课程");
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await click(document.querySelector('[aria-label="关闭抽屉"]'));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.hasAttribute("aria-hidden")).toBe(false);
  });

  it("retains a child draft while closed, releases modal effects, and restores the trigger", async () => {
    await act(async () => root.render(<DrawerExample keepMounted />));
    const trigger = host.querySelector<HTMLButtonElement>("[data-open]")!;
    trigger.focus();
    await click(trigger);
    await click(document.querySelector("[data-draft]"));
    const draft = document.querySelector("[data-draft]")!;
    const retained = draft.parentElement!;
    expect(draft.textContent).toBe("草稿 1");
    await click(document.querySelector('[aria-label="关闭抽屉"]'));
    await settle();
    expect(document.querySelector("[data-draft]")).toBeNull();
    expect(retained.isConnected).toBe(false);
    expect(retained.hidden).toBe(true);
    expect(retained.inert).toBe(true);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.activeElement).toBe(trigger);
    await click(trigger);
    expect(document.querySelector("[data-draft]")).toBe(draft);
    expect(draft.textContent).toBe("草稿 1");
    expect(retained.hidden).toBe(false);
    expect(retained.inert).toBe(false);
  });

  it("closes with Escape through the Radix dismissable layer", async () => {
    await act(async () => root.render(<DrawerExample />));
    await click(host.querySelector("[data-open]"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes a downward handle gesture and preserves the draft and focus", async () => {
    matchMedia();
    await act(async () => root.render(<DrawerExample keepMounted />));
    const trigger = host.querySelector<HTMLButtonElement>("[data-open]")!;
    trigger.focus(); await click(trigger);
    await click(document.querySelector("[data-draft]"));
    const draft = document.querySelector("[data-draft]")!;
    const handle = document.querySelector("[data-drawer-handle]")!;
    await pointer(handle, "pointerdown", { x: 120, y: 100 });
    await pointer(handle, "pointerup", { x: 130, y: 180 });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("[data-draft]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
    await click(trigger);
    expect(document.querySelector("[data-draft]")).toBe(draft);
    expect(draft.textContent).toBe("草稿 1");
  });

  it("ignores content scrolling, taps, upward, horizontal and cancelled handle gestures", async () => {
    matchMedia();
    await act(async () => root.render(<DrawerExample />));
    await click(host.querySelector("[data-open]"));
    const handle = document.querySelector("[data-drawer-handle]")!, draft = document.querySelector("[data-draft]")!;
    await pointer(draft, "pointerdown", { x: 120, y: 100 });
    await pointer(draft, "pointerup", { x: 120, y: 200 });
    for (const end of [{ x: 120, y: 110 }, { x: 120, y: 10 }, { x: 220, y: 180 }]) {
      await pointer(handle, "pointerdown", { x: 120, y: 100 });
      await pointer(handle, "pointerup", end);
    }
    await pointer(handle, "pointerdown", { x: 120, y: 100 });
    await pointer(handle, "pointercancel", { x: 120, y: 150 });
    await pointer(handle, "pointerup", { x: 120, y: 200 });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not dismiss the desktop drawer through a touch gesture", async () => {
    matchMedia({ mobile: false });
    await act(async () => root.render(<DrawerExample />));
    await click(host.querySelector("[data-open]"));
    const handle = document.querySelector("[data-drawer-handle]")!;
    await pointer(handle, "pointerdown", { x: 120, y: 100 });
    await pointer(handle, "pointerup", { x: 120, y: 200 });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("Tabs", () => {
  it("provides linked panels, disabled tabs and keyboard selection", async () => {
    await act(async () => root.render(<Tabs defaultValue="overview"><TabsList aria-label="课程内容"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="disabled" disabled>暂不可用</TabsTrigger><TabsTrigger value="units">单元</TabsTrigger></TabsList><TabsContent value="overview">概览内容</TabsContent><TabsContent value="units">单元内容</TabsContent></Tabs>));
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].disabled).toBe(true);
    await act(async () => { tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    await settle();
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2].getAttribute("aria-selected")).toBe("true");
    const panel = document.getElementById(tabs[2].getAttribute("aria-controls")!);
    expect(panel?.textContent).toBe("单元内容");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[2].id);
    expect(host.textContent).not.toContain("概览内容");
  });

  function measureTabs() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const first = this.textContent === "概览";
      return { left: this.getAttribute("role") === "tab" && !first ? 90 : 10, width: this.getAttribute("role") === "tab" ? first ? 64 : 100 : 300, top: 0, bottom: 44, height: 44, right: 310, x: 10, y: 0, toJSON() {} };
    });
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true, writable: true });
    return { animate, cancel };
  }

  function AnimatedTabs() {
    return <Tabs defaultValue="overview"><TabsList aria-label="课程内容"><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="units">单元</TabsTrigger></TabsList><TabsContent value="overview">概览内容</TabsContent><TabsContent value="units">单元内容</TabsContent></Tabs>;
  }

  async function selectUnits() {
    const first = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => { first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    await settle();
  }

  it("moves a single decorative indicator between unequal tab widths without changing keyboard behavior", async () => {
    matchMedia(); const { animate } = measureTabs();
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; } observe() {} unobserve() {} disconnect() {} });
    await act(async () => root.render(<AnimatedTabs />));
    expect(host.querySelectorAll("[data-tabs-indicator]").length).toBe(1);
    expect(host.querySelector("[data-tabs-indicator]")?.getAttribute("aria-hidden")).toBe("true");
    expect(animate).toHaveBeenLastCalledWith([{ transform: "translateX(0px) scaleX(64)", opacity: 1 }, { transform: "translateX(0px) scaleX(64)", opacity: 1 }], expect.objectContaining({ duration: 0 }));
    await selectUnits();
    expect(animate).toHaveBeenLastCalledWith([{ transform: "translateX(0px) scaleX(64)", opacity: 1 }, { transform: "translateX(80px) scaleX(100)", opacity: 1 }], expect.objectContaining({ duration: 220 }));
    expect(document.activeElement?.textContent).toBe("单元");
    const movements = animate.mock.calls.length;
    await act(async () => { resized?.(); });
    expect(animate.mock.calls.length).toBe(movements);
  });

  it("snaps when the OS requests reduced motion and cancels motion on an app preference change", async () => {
    const media = matchMedia({ reduced: true }); const { animate, cancel } = measureTabs();
    await act(async () => root.render(<AnimatedTabs />));
    await selectUnits();
    expect(animate).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ duration: 0 }));
    await act(async () => { Object.assign(media, { matches: false }); media.dispatchEvent(new Event("change")); });
    const before = cancel.mock.calls.length;
    await act(async () => { document.documentElement.setAttribute("data-motion", "reduce"); });
    expect(cancel.mock.calls.length).toBeGreaterThan(before);
    expect(animate).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ duration: 0 }));
  });
});

function NotifyButtons() {
  const { notify } = useToast();
  return <><button data-first onClick={() => notify({ title: "已保存笔记" })}>保存</button><button data-second onClick={() => notify({ title: "已更新课程" })}>更新</button></>;
}

describe("ToastProvider", () => {
  it("replaces the previous notification and supports explicit dismiss", async () => {
    await act(async () => root.render(<ToastProvider><NotifyButtons /></ToastProvider>));
    await click(host.querySelector("[data-first]"));
    expect(host.querySelectorAll('[data-state="open"]').length).toBe(1);
    await click(host.querySelector("[data-second]"));
    expect(host.querySelectorAll('[data-state="open"]').length).toBe(1);
    expect(host.textContent).toContain("已更新课程");
    expect(host.textContent).not.toContain("已保存笔记");
    await click(host.querySelector('[aria-label="关闭提示"]'));
    expect(host.querySelector('[data-state="open"]')).toBeNull();
  });
});


describe("LoadingRows", () => {
  it("shows the loading announcement only after 300ms", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<LoadingRows label="正在读取课程" />));
    expect(host.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(299));
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.querySelector('[role="status"]')?.textContent).toBe("正在读取课程");
  });

  it("does not show a delayed skeleton after the request has finished", async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<LoadingRows />));
    await act(async () => { vi.advanceTimersByTime(100); root.render(<p>课程已就绪</p>); });
    await act(async () => vi.advanceTimersByTime(500));
    expect(host.textContent).toBe("课程已就绪");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
