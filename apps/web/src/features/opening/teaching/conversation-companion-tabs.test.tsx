// @vitest-environment jsdom

import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationCompanionTabs } from "./conversation-companion-tabs";
const state = vi.hoisted(() => ({ originalMount: vi.fn(), tutorMount: vi.fn(), originalProps: vi.fn() }));
vi.mock("../assistant/conversation-companion", () => ({ OriginalConversationSlot: (props: { conversationId: string; className?: string }) => {
  state.originalProps(props);
  useEffect(() => { state.originalMount(); }, []);
  return createElement("textarea", { "aria-label": "原对话草稿", defaultValue: "原来的问题" });
} }));
const conversationId = "77777777-7777-4777-8777-777777777777";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function Tutor() {
  useEffect(() => { state.tutorMount(); }, []);
  return createElement("textarea", { "aria-label": "本题辅导草稿", defaultValue: "本题自己的问题" });
}
async function render(section: "chat" | "notes" = "chat", children: ReactNode = createElement(Tutor)) {
  await act(async () => root.render(createElement(ConversationCompanionTabs, { conversationId, section, children })));
}
async function click(label: string) {
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!.click());
}
it("keeps the original conversation identity isolated and mounts task tutoring only after explicit selection", async () => {
  await render();
  expect(state.originalProps).toHaveBeenCalledWith({ conversationId, className: "flex h-full min-h-0 min-w-0 flex-col" });
  expect(state.tutorMount).not.toHaveBeenCalled();
  const original = host.querySelector<HTMLTextAreaElement>('[aria-label="原对话草稿"]')!;
  original.value = "原对话还没发的问题";
  await click("本题辅导");
  const tutor = host.querySelector<HTMLTextAreaElement>('[aria-label="本题辅导草稿"]')!;
  tutor.value = "本题关联的辅导草稿";
  expect(original.closest("[hidden]")).not.toBeNull();
  await click("原对话");
  expect(host.querySelector('[aria-label="原对话草稿"]')).toBe(original);
  expect(original.value).toBe("原对话还没发的问题");
  expect(tutor.closest("[hidden]")).not.toBeNull();
  await click("本题辅导");
  expect(host.querySelector('[aria-label="本题辅导草稿"]')).toBe(tutor);
  expect(tutor.value).toBe("本题关联的辅导草稿");
  expect(state.originalMount).toHaveBeenCalledOnce(); expect(state.tutorMount).toHaveBeenCalledOnce();
});
it("retains a note view first visited from the original conversation after returning to chat", async () => {
  await render();
  const original = host.querySelector('[aria-label="原对话草稿"]');
  await render("notes");
  const tutor = host.querySelector<HTMLTextAreaElement>('[aria-label="本题辅导草稿"]')!;
  tutor.value = "仍在写的笔记";
  await render("chat");
  expect(host.querySelector('[aria-label="原对话草稿"]')).toBe(original);
  expect(host.querySelector('[aria-label="本题辅导草稿"]')).toBe(tutor);
  expect(tutor.closest("[hidden]")).not.toBeNull();
  await render("notes");
  expect(tutor.value).toBe("仍在写的笔记");
  expect(state.tutorMount).toHaveBeenCalledOnce();
});
it("does not load an implicit ordinary conversation when the page has no reference", async () => {
  await act(async () => root.render(createElement(ConversationCompanionTabs, { children: createElement(Tutor) })));
  expect(state.originalProps).not.toHaveBeenCalled();
  expect(state.tutorMount).toHaveBeenCalledOnce();
});
