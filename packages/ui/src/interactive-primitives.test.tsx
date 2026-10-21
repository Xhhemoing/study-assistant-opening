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
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
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
