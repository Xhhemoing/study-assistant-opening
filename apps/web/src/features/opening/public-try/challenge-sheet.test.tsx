// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChallengeSheet } from "./challenge-sheet";

let host: HTMLDivElement;
let root: Root;
const key = "opening:public-try:v1";
const timer = () => host.querySelector('[role="timer"]')!.textContent;
const button = (name: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === name)!;
const click = (el: HTMLElement) => act(() => el.click());
const radio = (group: string, index: number) => host.querySelectorAll<HTMLInputElement>(`input[name="${group}"]`)[index]!;
function render(entry: "/register" | "/login" = "/login") {
  act(() => root.render(<ChallengeSheet entry={entry} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.sessionStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("pauses the clock, expires after the remaining time, and gives a fresh attempt", () => {
  render();
  click(button("开始计时"));
  click(radio("step", 1));
  act(() => vi.advanceTimersByTime(31_000));
  expect(timer()).toBe("00:59");
  click(button("暂停"));
  act(() => vi.advanceTimersByTime(120_000));
  expect(timer()).toBe("00:59");
  click(button("继续计时"));
  act(() => vi.advanceTimersByTime(59_000));
  expect(timer()).toBe("00:00");
  expect(host.textContent).toContain("时间到了");
  expect(window.sessionStorage.getItem(key)).toBeNull();
  click(button("重新作答"));
  expect(timer()).toBe("01:30");
  expect(radio("step", 1).checked).toBe(false);
  expect(document.activeElement).toBe(button("开始计时"));
});

it("uses labeled native radio groups, focuses the diagnosis and restores the tab's receipt", () => {
  render();
  click(button("开始计时"));
  expect(host.querySelectorAll("fieldset legend")).toHaveLength(2);
  expect(radio("step", 2).labels?.[0]?.textContent).toContain("第 3 步");
  radio("step", 2).focus();
  expect(document.activeElement).toBe(radio("step", 2));
  click(radio("step", 2));
  expect(button("核对答案").disabled).toBe(true);
  click(radio("reason", 0));
  click(button("核对答案"));
  expect(document.activeElement?.textContent).toBe("错因诊断预览");
  expect(host.textContent).toContain("步骤和原因都找对了");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/login?from=try&challenge=limit&step=2");
  expect(JSON.parse(window.sessionStorage.getItem(key)!)).toEqual({ challenge: "limit", step: 2, reason: 0 });
  act(() => root.unmount());
  root = createRoot(host);
  render("/register");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/register?from=try&challenge=limit&step=2");
  expect(host.textContent).toContain("24 小时");
});

it("still grades and shows the handoff when tab storage is blocked", () => {
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("denied"); });
  render("/register");
  click(button("开始计时"));
  click(radio("step", 0));
  click(radio("reason", 2));
  click(button("核对答案"));
  expect(host.textContent).toContain("再看看第 3 步");
  expect(host.textContent).toContain("本次诊断仅在当前页面显示");
  expect(host.querySelector("a")?.textContent).toContain("注册");
});

it("rejects an answer after the deadline even before a throttled tab updates the timer", () => {
  render();
  click(button("开始计时"));
  click(radio("step", 2));
  click(radio("reason", 0));
  vi.setSystemTime(Date.now() + 91_000);
  click(button("核对答案"));
  expect(timer()).toBe("00:00");
  expect(host.textContent).toContain("时间到了");
  expect(window.sessionStorage.getItem(key)).toBeNull();
});

it("switches questions without carrying over choices or the old deadline", () => {
  render();
  click(button("开始计时"));
  click(radio("step", 2));
  act(() => vi.advanceTimersByTime(88_000));
  const select = host.querySelector("select")!;
  act(() => {
    select.value = "matrix";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => vi.advanceTimersByTime(3_000));
  expect(timer()).toBe("01:30");
  expect(radio("step", 2).checked).toBe(false);
  expect(host.textContent).toContain("AB = AC");
});
