// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { selectedLessonExcerpt, SelectionAsk } from "./selection-ask";

const id = "11111111-1111-4111-8111-111111111111";
const binding: CurrentStudyContext = { isQuestion: false, context: { courseId: id, activityId: id, blockId: id, contentVersion: 2, purpose: "learning_help", label: "向量课" } };
let container: HTMLDivElement, root: Root;
const onAsk = vi.fn();
const fetchSpy = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onAsk.mockReset(); fetchSpy.mockReset(); vi.stubGlobal("fetch", fetchSpy);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals();
});
async function render(value: CurrentStudyContext | null = binding) {
  await act(async () => root.render(createElement(SelectionAsk, { binding: value, onAsk,
    children: createElement("p", { "data-catalog": "text" }, "向量空间包含零向量，课堂其余文字") })));
}
function button(label: string) { return Array.from(container.querySelectorAll("button")).find(node => node.textContent === label); }
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label)!.click()); }
async function select(start = 0, end = 4) {
  const text = container.querySelector('[data-catalog="text"]')!.firstChild!;
  const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end);
  await act(async () => { const native = window.getSelection()!; native.removeAllRanges(); native.addRange(range); document.dispatchEvent(new Event("selectionchange")); });
}
it("previews only the frozen visible selection and explicitly continues through the existing callback", async () => {
  await render(); await select(); expect(fetchSpy).not.toHaveBeenCalled(); expect(onAsk).not.toHaveBeenCalled();
  await click("查看课堂片段");
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("当前课堂片段"); expect(dialog.textContent).toContain("来源：向量课");
  expect(dialog.querySelector("blockquote")!.textContent).toBe("向量空间");
  await select(6, 9); // A later native selection must not replace the click-time text.
  expect(dialog.querySelector("blockquote")!.textContent).toBe("向量空间");
  expect(fetchSpy).not.toHaveBeenCalled(); expect(onAsk).not.toHaveBeenCalled();
  await click("继续问"); expect(onAsk).toHaveBeenCalledOnce(); expect(onAsk).toHaveBeenCalledWith("向量空间");
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
});
it("Escape restores the opener, or the stable lesson root if the native selection disappeared", async () => {
  await render(); await select();
  const opener = button("查看课堂片段")!;
  opener.focus(); await click("查看课堂片段");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  // Focusing the preview can clear the native selection and unmount its opener.
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener.isConnected ? opener : container.firstElementChild);
  await select(); await click("查看课堂片段");
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); });
  expect(button("查看课堂片段")).toBeUndefined();
  await click("返回课堂"); expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.firstElementChild); expect(onAsk).not.toHaveBeenCalled();
});
it("drops preview on binding/version changes and blocks unsaved answers and restricted assistance", async () => {
  await render(); await select(); await click("查看课堂片段");
  await render({ ...binding, context: { ...binding.context, contentVersion: 3 } });
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(button("查看课堂片段")).toBeUndefined();
  for (const value of [{ ...binding, isQuestion: true, learningAttempt: null }, { ...binding, blockedReason: "本次不能提问" }]) {
    await render(value); await select(); expect(button("查看课堂片段")).toBeUndefined();
    expect(container.querySelector("button")!.disabled).toBe(true);
  }
  await render(null); expect(button("查看课堂片段")).toBeUndefined(); expect(onAsk).not.toHaveBeenCalled();
});
it("preserves direct ask and invalidates an already open preview when permission changes", async () => {
  await render(); await select(); await click("问选中内容"); expect(onAsk).toHaveBeenCalledWith("向量空间");
  await click("查看课堂片段"); await render({ ...binding, blockedReason: "已限制" });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await render(); expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it("rejects ranges through hidden answers, controls, hidden ancestors and other instructional regions", () => {
  const scope = document.createElement("div"); container.append(scope);
  scope.innerHTML = '<p data-catalog="text">开头<span hidden>隐藏答案</span>末尾</p><p data-catalog="text">另一个块</p>';
  const first = scope.firstElementChild!;
  const range = document.createRange(); range.setStart(first.firstChild!, 0); range.setEnd(first.lastChild!, 2);
  const native = window.getSelection()!; native.removeAllRanges(); native.addRange(range);
  expect(selectedLessonExcerpt(scope, native)).toBe("");
  first.innerHTML = '开头<input value="答案">末尾'; range.setStart(first.firstChild!, 0); range.setEnd(first.lastChild!, 2); native.removeAllRanges(); native.addRange(range);
  expect(selectedLessonExcerpt(scope, native)).toBe("");
  first.textContent = "普通文字"; first.setAttribute("hidden", ""); range.selectNodeContents(first); native.removeAllRanges(); native.addRange(range);
  expect(selectedLessonExcerpt(scope, native)).toBe("");
  first.removeAttribute("hidden"); range.setStart(first.firstChild!, 0); range.setEnd(scope.lastElementChild!.firstChild!, 2); native.removeAllRanges(); native.addRange(range);
  expect(selectedLessonExcerpt(scope, native)).toBe("");
});
