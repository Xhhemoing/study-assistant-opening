// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EditorApiError } from "../../editor/editor-api";
import { InlineExplain } from "./inline-explain";
const createDocument = vi.hoisted(() => vi.fn());
vi.mock("../../editor/editor-api", async importOriginal => ({ ...await importOriginal<typeof import("../../editor/editor-api")>(), createEditorApi: () => ({ createDocument }) }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ listRevisionCourses: async () => [] }) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("directly saves the displayed explanation, retains it after rejection, and reports the actual successful retry", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  createDocument.mockRejectedValueOnce(new EditorApiError("INVALID", "rejected", 422)).mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const context = { activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), contentVersion: 2, label: "向量" };
    await act(async () => root.render(createElement(InlineExplain, { context, content: "这就是当前显示的解释", onContinueInChat() {} })));
    const save = () => Array.from(host.querySelectorAll("button")).find(button => /^保存$|保存失败|已存为笔记/.test(button.textContent ?? ""))!;
    await act(async () => save().click());
    expect(host.textContent).toContain("保存失败，重试"); expect(host.textContent).toContain("这就是当前显示的解释");
    await act(async () => { save().click(); save().click(); });
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(createDocument.mock.calls[1]![0])).toContain("这就是当前显示的解释");
    expect(host.textContent).toContain("已存为笔记"); expect(save().disabled).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it("keeps an edited card draft when the caller supplies a new object with the same content identity", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    const context = { activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), contentVersion: 2, label: "向量" };
    const props = { context, content: "解释内容", onContinueInChat() {} };
    await act(async () => root.render(createElement(InlineExplain, props)));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "制成卡片")!.click());
    const field = host.querySelector<HTMLTextAreaElement>("dialog textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "正在编辑的卡片"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => root.render(createElement(InlineExplain, { ...props, context: { ...context } })));
    expect(host.querySelector<HTMLTextAreaElement>("dialog textarea")).toBe(field);
    expect(field.value).toBe("正在编辑的卡片");
    expect(createDocument).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("observes the same in-flight explanation save after unmounting and reopening", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  let finish!: (value: { id: string }) => void;
  createDocument.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const context = { activityId: crypto.randomUUID(), blockId: crypto.randomUUID(), contentVersion: 2, label: "向量" };
  const props = { context, content: "保存中的解释", onContinueInChat() {} };
  try {
    await act(async () => root.render(createElement(InlineExplain, props)));
    await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "保存")!.click());
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(InlineExplain, props)));
    expect(host.textContent).toContain("保存中…");
    await act(async () => finish({ id: crypto.randomUUID() }));
    expect(host.textContent).toContain("已存为笔记");
    expect(createDocument).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
