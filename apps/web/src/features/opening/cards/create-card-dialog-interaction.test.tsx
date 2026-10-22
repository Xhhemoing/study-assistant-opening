// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
import { CreateCardDialog } from "./create-card-dialog";
import type { OpeningCardsClient } from "./cards-client";
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => ({ listRevisionCourses: async () => [] }) }));
let root: Root, host: HTMLDivElement, clearIdentity: () => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  clearIdentity = publishVerifiedSessionIdentity({ id: "card-owner", workspaceId: "card-workspace" });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function () { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function () { this.removeAttribute("open"); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearIdentity(); vi.restoreAllMocks(); });
const draft = () => ({ identity: crypto.randomUUID(), front: "原问题", back: "原答案", sourceLabel: "讲义 · v2 · 第7页", createSource: vi.fn().mockResolvedValue("11111111-1111-4111-8111-111111111111") });
async function change(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("creates neither source nor card before confirmation and cancel leaves the draft out of storage", async () => {
  const studyDraft = draft(), createCard = vi.fn(), close = vi.fn();
  await act(async () => root.render(createElement(CreateCardDialog, { studyDraft, cards: { createCard } as unknown as OpeningCardsClient, onClose: close })));
  expect(host.textContent).toContain("讲义 · v2 · 第7页");
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "取消")!.click());
  expect(close).toHaveBeenCalledOnce(); expect(studyDraft.createSource).not.toHaveBeenCalled(); expect(createCard).not.toHaveBeenCalled();
});
it("saves the edited visible sides once, then retries an uncertain response with the same identity", async () => {
  const studyDraft = draft(), createCard = vi.fn().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue({});
  await act(async () => root.render(createElement(CreateCardDialog, { studyDraft, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} })));
  const fields = host.querySelectorAll("textarea");
  await change(fields[0]!, "修改的问题"); await change(fields[1]!, "修改的答案");
  await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(createCard).toHaveBeenCalledOnce();
  expect(createCard.mock.calls[0]![0]).toMatchObject({ front: "修改的问题", back: "修改的答案" });
  expect(fields[0]!.disabled).toBe(true);
  await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); });
  expect(createCard).toHaveBeenCalledTimes(2); expect(studyDraft.createSource).toHaveBeenCalledOnce();
  expect(createCard.mock.calls[1]![0]).toEqual(createCard.mock.calls[0]![0]);
  expect(host.textContent).toContain("已制成记忆卡片");
});

it("retains an uncertain card's edited intent and identity after closing and reopening the draft", async () => {
  const studyDraft = draft(), createCard = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue({});
  const props = { studyDraft, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  await change(host.querySelectorAll("textarea")[0]!, "关闭前编辑的问题");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  expect(host.querySelectorAll("textarea")[0]!.value).toBe("关闭前编辑的问题");
  expect(host.querySelectorAll("textarea")[0]!.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(createCard).toHaveBeenCalledTimes(2); expect(studyDraft.createSource).toHaveBeenCalledOnce();
  expect(createCard.mock.calls[1]![0]).toEqual(createCard.mock.calls[0]![0]);
});

it("restores explicitly cleared course and skill as empty when retrying an observation card", async () => {
  const createCard = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValue({});
  const props = { initial: { observationId: crypto.randomUUID(), front: "题目", back: "答案", courseId: crypto.randomUUID(), skillLabel: "原知识点" }, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  const selects = host.querySelectorAll("select"), skill = host.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
  await act(async () => { selects[1]!.value = ""; selects[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(skill, ""); skill.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(createCard.mock.calls[0]![0]).toMatchObject({ courseId: null, skillLabel: null });
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  expect(host.querySelectorAll("select")[1]!.value).toBe("");
  expect(host.querySelector<HTMLInputElement>('input[maxlength="200"]')!.value).toBe("");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(createCard.mock.calls[1]![0]).toEqual(createCard.mock.calls[0]![0]);
});

it("retains the edited card when source-note creation is uncertain, without recreating its non-idempotent source on reopen", async () => {
  const snippet = { title: "回答", text: "原回答", provenanceId: crypto.randomUUID() };
  const createSnippet = vi.fn().mockRejectedValue(new Error("reply lost")), createCard = vi.fn();
  const props = { draft: snippet, api: { createSnippet }, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  await change(host.querySelectorAll("textarea")[0]!, "自定义卡片题目");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  expect(host.querySelectorAll("textarea")[0]!.value).toBe("自定义卡片题目");
  expect(host.textContent).toContain("来源笔记的保存结果尚未确认");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(createSnippet).toHaveBeenCalledOnce(); expect(createCard).not.toHaveBeenCalled();
});

it("resumes display of the original source/card operation after reopening while its source is pending", async () => {
  const snippet = { title: "回答", text: "原回答", savedTurnId: crypto.randomUUID() };
  let finish!: (value: { documentId: string }) => void;
  const createSnippet = vi.fn(() => new Promise<{ documentId: string }>(resolve => { finish = resolve; }));
  const createCard = vi.fn().mockResolvedValue({});
  const props = { draft: snippet, api: { createSnippet }, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  await change(host.querySelectorAll("textarea")[0]!, "发出前修改的题面");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  expect(host.querySelectorAll("textarea")[0]!.value).toBe("发出前修改的题面");
  expect(host.querySelectorAll("textarea")[0]!.disabled).toBe(true);
  await act(async () => finish({ documentId: crypto.randomUUID() }));
  expect(host.textContent).toContain("已制成记忆卡片");
  expect(createSnippet).toHaveBeenCalledOnce(); expect(createCard).toHaveBeenCalledOnce();
  expect(createSnippet).toHaveBeenCalledWith(snippet);
  expect(createCard.mock.calls[0]![0]).toMatchObject({ front: "发出前修改的题面" });
});

it("retains the saved source note and edited card after a definite card rejection, then continues without another source POST", async () => {
  const snippet = { title: "回答", text: "原回答", savedTurnId: crypto.randomUUID() };
  const createSnippet = vi.fn().mockResolvedValue({ documentId: crypto.randomUUID() });
  const { OpeningApiError } = await import("../client/api");
  const createCard = vi.fn().mockRejectedValueOnce(new OpeningApiError(422, "请修改卡片")).mockResolvedValue({});
  const props = { draft: snippet, api: { createSnippet }, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  await change(host.querySelectorAll("textarea")[0]!, "保留的自定义正面");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  expect(host.querySelectorAll("textarea")[0]!.value).toBe("保留的自定义正面");
  expect(host.querySelectorAll("textarea")[0]!.disabled).toBe(false);
  await change(host.querySelectorAll("textarea")[1]!, "修改后背面");
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(createSnippet).toHaveBeenCalledOnce(); expect(createCard).toHaveBeenCalledTimes(2);
  expect(createCard.mock.calls[1]![0]).toMatchObject({ front: "保留的自定义正面", back: "修改后背面", sourceDocumentId: createCard.mock.calls[0]![0].sourceDocumentId });
});

it("publishes a known saved card to a reopened dialog even when persisting its final receipt fails", async () => {
  const studyDraft = draft(); let finish!: () => void;
  const createCard = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { studyDraft, cards: { createCard } as unknown as OpeningCardsClient, onClose() {} };
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(CreateCardDialog, props)));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await act(async () => finish());
  expect(host.textContent).toContain("已制成记忆卡片");
  expect(createCard).toHaveBeenCalledOnce();
});
