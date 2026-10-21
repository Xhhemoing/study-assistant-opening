// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LessonFocusDialog } from "./lesson-focus-dialog";

let container: HTMLElement, root: Root;
const start = vi.fn(), end = vi.fn();
function Lesson() {
  const [answer, setAnswer] = useState("");
  useEffect(() => { start(); return () => { end(); }; }, []);
  return <section className="h-full overflow-y-auto"><label>原答<input aria-label="原答" value={answer} onChange={event => setAnswer(event.target.value)} /></label><button type="button">保留原答</button></section>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); start.mockReset(); end.mockReset();
  container = document.createElement("main"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(children = createElement(Lesson)) { await act(async () => root.render(createElement(LessonFocusDialog, { title: "当前课程", children }))); }
const trigger = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.includes("专注学习"))!;

it("keeps one lesson instance and input across opening, closing and reopening", async () => {
  await render(); const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(input, "保留我的原答"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  trigger().focus(); await act(async () => trigger().click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("input")).toBe(input); expect(input.value).toBe("保留我的原答");
  expect(start).toHaveBeenCalledTimes(1); expect(end).not.toHaveBeenCalled();
  await act(async () => dialog.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("保留我的原答"); expect(document.activeElement).toBe(trigger());
  expect(container.closest('[aria-hidden="true"],[inert]')).toBeNull();
  await act(async () => trigger().click());
  expect(document.querySelector('[role="dialog"] input')).toBe(input); expect(start).toHaveBeenCalledTimes(1);
});

it("Escape releases the modal and restores the inline learning tree", async () => {
  await render(); const input = container.querySelector("input");
  await act(async () => trigger().click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.querySelector("input")).toBe(input);
  expect(document.querySelector('[data-lesson-focus="inline"]')).not.toBeNull();
});

it("does not reload embedded content on browsers without state-preserving moves", async () => {
  await render(createElement("iframe", { title: "嵌入讲义", srcDoc: "<p>讲义</p>" }));
  const frame = container.querySelector("iframe"); await act(async () => trigger().click());
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(container.querySelector("iframe")).toBe(frame);
  expect(container.textContent).toContain("继续在本页学习");
});
