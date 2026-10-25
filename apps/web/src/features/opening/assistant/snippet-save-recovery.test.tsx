// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { SaveSnippetDialog } from "./save-snippet-dialog";
import { MessageList } from "./message-list";
import { readSnippetSaveReceipt, saveSnippetWithReceipt, snippetSaveIdentity, startAnotherSnippetSave, subscribeSnippetSave } from "./snippet-save-receipt";
import type { ChatMessageView } from "./message-model";
let host: HTMLDivElement, root: Root, clearIdentity: () => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sessionStorage.clear();
  clearIdentity = publishVerifiedSessionIdentity({ id: "snippet-owner", workspaceId: "snippet-workspace" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.restoreAllMocks(); });
const draft = () => ({ title: "原题解释", text: "保留原文", provenanceId: crypto.randomUUID() });
const documentId = "11111111-1111-4111-8111-111111111111";
async function change(field: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("retains an uncertain edited note on reopen and never sends a second non-idempotent request", async () => {
  const input = draft(), createSnippet = vi.fn().mockRejectedValue(new Error("reply lost"));
  const props = { draft: { input }, api: { createSnippet }, onClose() {} };
  await act(async () => root.render(createElement(SaveSnippetDialog, props)));
  await change(host.querySelector("textarea")!, "用户修改后的笔记");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(SaveSnippetDialog, props)));
  expect(host.querySelector("textarea")!.value).toBe("用户修改后的笔记");
  expect(host.querySelector("textarea")!.disabled).toBe(true);
  expect(host.textContent).toContain("保存结果尚未确认");
  expect(host.querySelector('button[type="submit"]')).toBeNull();
  expect(createSnippet).toHaveBeenCalledOnce();
});
it("lets a reopened dialog subscribe to its pending save and explicitly start a different note after success", async () => {
  const input = draft(); let finish!: (value: { documentId: string }) => void;
  const createSnippet = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ documentId: crypto.randomUUID() });
  const props = { draft: { input }, api: { createSnippet }, onClose() {} };
  await act(async () => root.render(createElement(SaveSnippetDialog, props)));
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(SaveSnippetDialog, props)));
  expect(host.textContent).toContain("正在保存");
  await act(async () => finish({ documentId }));
  expect(host.textContent).toContain("已保存为关联笔记");
  expect(createSnippet).toHaveBeenCalledOnce();
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "另存为新笔记")!.click());
  await change(host.querySelector("textarea")!, "另一篇新理解");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(createSnippet).toHaveBeenCalledTimes(2);
  expect(createSnippet.mock.calls[1]![0]).toMatchObject({ text: "另一篇新理解" });
});
it("blocks a durable pending receipt after reload and requires an explicit new intent after known success", async () => {
  const input = draft(), identity = snippetSaveIdentity(input), create = vi.fn().mockResolvedValue({ documentId });
  sessionStorage.setItem(`opening:snippet-save:v1:${encodeURIComponent(JSON.stringify(["snippet-owner", "snippet-workspace"]))}:${identity}`, JSON.stringify({ status: "pending", input }));
  expect(readSnippetSaveReceipt(identity)?.status).toBe("unknown");
  await expect(saveSnippetWithReceipt(identity, input, create)).resolves.toEqual({ kind: "unknown" });
  expect(create).not.toHaveBeenCalled();
  const other = crypto.randomUUID(), notify = vi.fn(), unsubscribe = subscribeSnippetSave(other, notify);
  await saveSnippetWithReceipt(other, input, create);
  await saveSnippetWithReceipt(other, input, create);
  expect(create).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledTimes(2);
  startAnotherSnippetSave(other);
  await saveSnippetWithReceipt(other, { ...input, text: "新意图" }, create);
  expect(create).toHaveBeenCalledTimes(2); unsubscribe();
});
it("does not write if the request identity cannot be persisted", () => {
  const input = draft(), create = vi.fn();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(() => saveSnippetWithReceipt(crypto.randomUUID(), input, create)).toThrow("quota");
  expect(create).not.toHaveBeenCalled();
});
it("directly saves an owned saved answer by its real turn id, reports completion after remount, and opens no confirmation dialog", async () => {
  const savedTurnId = crypto.randomUUID(); let finish!: (value: { documentId: string }) => void;
  const message: ChatMessageView = { id: savedTurnId, savedTurnId, role: "assistant", origin: "saved", status: "complete", text: "当前材料的解释", citations: [], citationLabels: [] };
  const createSnippet = vi.fn(() => new Promise<{ documentId: string }>(resolve => { finish = resolve; }));
  const props = { messages: [message], directSaveApi: { createSnippet }, proseEnabled: false, objectHref: (href: string) => `${href}${href.includes("?") ? "&" : "?"}conversation=original-conversation` };
  await act(async () => root.render(createElement(MessageList, props)));
  const save = () => Array.from(host.querySelectorAll("button")).find(button => /存为笔记|正在保存笔记/.test(button.textContent ?? ""))!;
  await act(async () => { save().click(); save().click(); });
  expect(createSnippet).toHaveBeenCalledOnce();
  expect(createSnippet).toHaveBeenCalledWith({ savedTurnId, title: message.text, text: message.text });
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(MessageList, props)));
  expect(save().disabled).toBe(true);
  await act(async () => finish({ documentId }));
  expect(save().textContent).toBe("已存为笔记");
  expect(host.querySelector(`a[href*="${documentId}"]`)?.getAttribute("href")).toContain("conversation=original-conversation");
  expect(host.textContent).toContain(message.text);
});

it("keeps a direct answer save uncertain across reopening instead of displaying a retry action", async () => {
  const savedTurnId = crypto.randomUUID();
  const message: ChatMessageView = { id: savedTurnId, savedTurnId, role: "assistant", origin: "saved", status: "complete", text: "尚待确认的解释", citations: [], citationLabels: [] };
  const createSnippet = vi.fn().mockRejectedValue(new Error("reply lost"));
  const props = { messages: [message], directSaveApi: { createSnippet }, proseEnabled: false };
  await act(async () => root.render(createElement(MessageList, props)));
  await act(async () => Array.from(host.querySelectorAll("button")).find(button => button.textContent === "存为笔记")!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(MessageList, props)));
  expect(host.textContent).toContain("还不确定是否已经存好");
  expect(Array.from(host.querySelectorAll("button")).find(button => button.textContent === "存为笔记")!.disabled).toBe(true);
  expect(createSnippet).toHaveBeenCalledOnce();
});

it("captures the original account scope for a late response and never exposes it to the next account", async () => {
  const input = draft(), identity = crypto.randomUUID(); let finish!: (value: { documentId: string }) => void;
  const pending = saveSnippetWithReceipt(identity, input, () => new Promise(resolve => { finish = resolve; }));
  const clearNext = publishVerifiedSessionIdentity({ id: "next-owner", workspaceId: "next-workspace" });
  expect(readSnippetSaveReceipt(identity)).toBeNull();
  finish({ documentId }); await pending;
  expect(readSnippetSaveReceipt(identity)).toBeNull();
  clearNext();
  const clearPrevious = publishVerifiedSessionIdentity({ id: "snippet-owner", workspaceId: "snippet-workspace" });
  expect(readSnippetSaveReceipt(identity)).toMatchObject({ status: "saved", documentId });
  clearPrevious();
});
