// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CurrentStudyContext } from "../assistant/current-study-context";
import { SelectionAsk } from "./selection-ask";

let host: HTMLDivElement, root: Root, binding: CurrentStudyContext;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  binding = { isQuestion: false, context: { courseId: crypto.randomUUID(), activityId: crypto.randomUUID(),
    blockId: crypto.randomUUID(), contentVersion: 2, label: "原课程" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/documents"
    ? Response.json({ document: { id: crypto.randomUUID() } }) : Response.json({})));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(value = binding) {
  await act(async () => root.render(<SelectionAsk binding={value} onAsk={vi.fn()}><p data-catalog="text">甲段内容。乙段内容。</p></SelectionAsk>));
}
async function select(start = 0, end = 5) {
  await act(async () => {
    const range = document.createRange(), text = host.querySelector("p[data-catalog]")!.firstChild!;
    range.setStart(text, start); range.setEnd(text, end);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
const save = () => host.querySelector<HTMLButtonElement>('[aria-label="保存选中文字"]')!;
const documentWrites = () => vi.mocked(fetch).mock.calls.filter(call => call[0] === "/api/documents");
const associations = () => vi.mocked(fetch).mock.calls.filter(call => String(call[0]).endsWith("/memberships"));

it("saves exactly the selected text once with the original course and activity links", async () => {
  await render(); await select();
  expect(save()).not.toBeNull();
  expect([...host.querySelectorAll("[data-explanation-actions] button")].map(button => button.textContent)).toEqual(["我没懂", "举个例子", "讲快点", "讲细点"]);
  await act(async () => { save().click(); save().click(); });
  expect(documentWrites()).toHaveLength(1);
  const body = JSON.parse(documentWrites()[0]![1]!.body as string);
  expect(body.blocks[0].content.blockNoteContent).toBe("甲段内容。");
  expect(JSON.stringify(body)).not.toContain("乙段内容。");
  expect(JSON.stringify(body)).toContain(`activity=${binding.context.activityId}`);
  expect(JSON.stringify(body)).toContain(`block=${binding.context.blockId}`);
  expect(associations()[0]![0]).toBe(`/api/courses/${binding.context.courseId}/memberships`);
  expect(host.textContent).toContain("已存为笔记");
  expect(save().disabled).toBe(true);
});

it("keeps separate save receipts for different selections in the same unit", async () => {
  await render(); await select();
  expect(save()).not.toBeNull();
  await act(async () => save().click());
  await select(5, 10);
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  expect(documentWrites()).toHaveLength(2);
  expect(documentWrites().map(call => JSON.parse(call[1]!.body as string).blocks[0].content.blockNoteContent)).toEqual(["甲段内容。", "乙段内容。"]);
  await select();
  expect(save().disabled).toBe(true);
});

it("does not display a late save on a new question or associate it with the new course", async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(async url => url === "/api/documents"
    ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json({}));
  await render(); await select();
  expect(save()).not.toBeNull();
  await act(async () => save().click());
  const attemptId = crypto.randomUUID();
  const next = { ...binding, isQuestion: true, learningAttempt: { id: attemptId } as NonNullable<CurrentStudyContext["learningAttempt"]>,
    context: { ...binding.context, courseId: crypto.randomUUID(), activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), attemptId } };
  await render(next); await select(5, 10);
  expect(save().disabled).toBe(false);
  await act(async () => finish(Response.json({ document: { id: crypto.randomUUID() } })));
  expect(host.textContent).not.toContain("已存为笔记");
  expect(save().disabled).toBe(false);
  expect(associations()).toHaveLength(1);
  expect(associations()[0]![0]).toBe(`/api/courses/${binding.context.courseId}/memberships`);
});

it("retains an unknown result across remounts without creating another note", async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError("response lost"));
  await render(); await select();
  expect(save()).not.toBeNull();
  await act(async () => save().click());
  expect(host.textContent).toContain("保存结果尚未确认");
  await act(async () => root.render(null));
  await render(); await select();
  expect(save().disabled).toBe(true);
  await act(async () => save().click());
  expect(documentWrites()).toHaveLength(1);
  expect(associations()).toHaveLength(0);
});

it("does not expose more help or card actions when the original-answer guard blocks the selection", async () => {
  await render({ ...binding, isQuestion: true, learningAttempt: null, blockedReason: "先保存自己的原答案" });
  await select();
  expect(save()).toBeNull();
  expect(host.querySelector("[data-explanation-actions]")).toBeNull();
  expect(host.textContent).toContain("先保存自己的原答案");
  expect(documentWrites()).toHaveLength(0);
});
