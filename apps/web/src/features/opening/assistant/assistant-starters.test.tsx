// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { assistantStarters } from "./assistant-starters";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import type { ChatMessageView } from "./message-model";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("offers hints in a study context and only offers system records when available", () => {
  expect(assistantStarters(true, true).map(value => value.mode)).toEqual(["hint", "hint", "hint"]);
  expect(assistantStarters(false, false).some(value => value.purpose === "query")).toBe(false);
  expect(assistantStarters(false, true).at(-1)?.purpose).toBe("query");
});
it("lets a starter prepare a draft without submitting it", async () => {
  const onStarter = vi.fn();
  await act(async () => root.render(<MessageList compact messages={[]} studyMode onStarter={onStarter} />));
  const buttons = host.querySelectorAll("button");
  expect(buttons).toHaveLength(3);
  expect(buttons[0]?.textContent).toContain("给我一个提示");
  await act(async () => buttons[0]!.click());
  expect(onStarter).toHaveBeenCalledExactlyOnceWith(assistantStarters(true, false)[0]);
});
it("prefills the real query purpose but waits for an explicit send", async () => {
  const submit = vi.fn(async () => ({ accepted: true }));
  await act(async () => root.render(<Composer draft="我最近的学习记录有哪些？" onDraftChange={() => undefined} onSubmit={submit} queryAvailable purposePrefill={{ purpose: "query", nonce: 1 }} />));
  expect(submit).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="本轮目的"]')?.value).toBe("query");
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ querySystem: true, purpose: "query" }));
});
it("replaces the send button with an accessible stop button during a pending reply", async () => {
  const cancel = vi.fn();
  await act(async () => root.render(<Composer draft="" onDraftChange={() => undefined} onSubmit={() => undefined} pending onCancel={cancel} />));
  expect(host.querySelector('[aria-label="发送"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="停止回答"]')!.click());
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("announces a completed reply once without announcing partial text or old history", async () => {
  const message: ChatMessageView = { id: "reply", role: "assistant", text: "尚未完成", citations: [], citationLabels: [], status: "pending" };
  const render = async (messages: ChatMessageView[]) => act(async () => root.render(<MessageList messages={messages} artifactsEnabled={false} proseEnabled={false} />));
  await render([message]);
  expect(host.querySelector('[data-reply-announcement]')?.textContent).toBe("");
  expect(host.querySelector('[role="log"]')?.getAttribute("aria-busy")).toBe("true");
  await render([{ ...message, status: "complete", text: "这一步成立。" }]);
  expect(host.querySelector('[data-reply-announcement]')?.textContent).toBe("这一步成立。");
  const observer = vi.fn();
  const mutation = new MutationObserver(observer);
  mutation.observe(host.querySelector('[data-reply-announcement]')!, { subtree: true, childList: true, characterData: true });
  await render([{ ...message, status: "complete", text: "这一步成立。" }]);
  expect(observer).not.toHaveBeenCalled();
  mutation.disconnect();
});
