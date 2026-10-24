// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantViewProps } from "./assistant-view";
const state = vi.hoisted(() => ({ mounts: vi.fn(), props: [] as AssistantViewProps[] }));
vi.mock("./assistant-view", () => ({ AssistantView: (props: AssistantViewProps) => {
  state.props.push(props);
  useEffect(() => { state.mounts(); }, []);
  return <textarea aria-label="会话草稿" defaultValue="未发送" disabled={props.interactionDisabled} />;
} }));
import { ConversationCompanionProvider, ConversationSurface, OriginalConversationSlot } from "./conversation-companion";
const id = "11111111-1111-4111-8111-111111111111";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.mounts.mockClear(); state.props = [];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(children: ReactNode) {
  await act(async () => root.render(<ConversationCompanionProvider>{children}</ConversationCompanionProvider>));
}
const editor = () => host.querySelector<HTMLTextAreaElement>('[aria-label="会话草稿"]')!;
const latest = () => state.props.at(-1)!;

describe("ordinary conversation host continuity", () => {
  it("moves the same editor through page, parking and original-conversation slots without remounting", async () => {
    await render(<ConversationSurface initialConversationId={id} />);
    const original = editor(); original.value = "同一草稿"; original.scrollTop = 42;
    await render(null);
    expect(original.closest("[data-conversation-parking]")).not.toBeNull();
    expect(latest().isActiveConversation?.()).toBe(false);
    await render(<OriginalConversationSlot conversationId={id} />);
    expect(editor()).toBe(original); expect(original.value).toBe("同一草稿"); expect(original.scrollTop).toBe(42);
    expect(original.closest("[data-original-conversation]")?.getAttribute("data-original-conversation")).toBe(id);
    expect(latest().companion).toBe(true);
    await render(<ConversationSurface initialConversationId={id} />);
    expect(editor()).toBe(original); expect(latest().companion).toBe(false);
    expect(state.mounts).toHaveBeenCalledOnce();
  });

  it("promotes a parked in-flight creation into its saved-id slot rather than replacing its draft", async () => {
    await render(<ConversationSurface startFresh />);
    const original = editor(); original.value = "请求仍进行中";
    const creating = latest();
    await act(async () => creating.onConversationCreateStateChange?.(true));
    await render(<OriginalConversationSlot conversationId={id} />);
    const awaiting = [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(item => item !== original)!;
    expect(awaiting.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在确认新对话的保存结果");
    await act(async () => creating.onConversationReady?.(id));
    expect(editor()).toBe(original); expect(original.value).toBe("请求仍进行中");
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
    expect(original.closest("[data-original-conversation]")).not.toBeNull();
    await act(async () => creating.onConversationCreateStateChange?.(false));
    expect(original.disabled).toBe(false);
    await render(<ConversationSurface initialConversationId={id} />);
    expect(editor()).toBe(original);
    expect(state.mounts).toHaveBeenCalledTimes(2); // The blocked placeholder mounted once, then was discarded.
  });

  it("keeps unsaved temporary state parked without inventing a persisted identity", async () => {
    await render(<ConversationSurface startFresh />);
    const original = editor(); original.value = "临时内容";
    const props = latest();
    await act(async () => props.onRetainStateChange?.({ pending: true, volatile: true }));
    await render(null);
    expect(original.isConnected).toBe(true);
    expect(original.closest("[hidden][inert]")).not.toBeNull();
    expect(props.objectHref?.("/opening/library?page=2")).toBe("/opening/library?page=2");
    expect(props.initialConversationId).toBeUndefined();
    expect(state.mounts).toHaveBeenCalledOnce();
  });

  it("does not host or merge a task-bound session with an ordinary conversation of the same id", async () => {
    await render(<><ConversationSurface initialConversationId={id} /><ConversationSurface initialConversationId={id} studyContext={{ attemptId: id, purpose: "language_support" }} /></>);
    expect(host.querySelectorAll("textarea")).toHaveLength(2);
    expect(host.querySelectorAll("[data-conversation-surface]")).toHaveLength(1);
    expect(state.props.some(props => props.studyContext?.attemptId === id && props.studyContext.purpose === "language_support")).toBe(true);
    expect(state.mounts).toHaveBeenCalledTimes(2);
  });
});
