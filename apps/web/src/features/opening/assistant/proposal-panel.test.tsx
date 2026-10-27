// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AssistantProposalRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { ProposalPanel } from "./proposal-panel";
import { usePendingProposals } from "./use-pending-proposals";

vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: { children: ReactNode; href: string }) => <a {...props}>{children}</a> }));
const row = (text: string): AssistantProposalRecord => ({ id: text, sourceTurnId: "turn", version: 0, status: "draft",
  createdAt: "2026-10-26T00:00:00Z", basisVersion: "v1", result: null, prepared: null,
  tool: { name: "propose_note", arguments: { title: "课堂笔记", text } } });
function ConversationProposals({ api, conversationId }: { api: OpeningApi; conversationId: string }) {
  return <ProposalPanel state={usePendingProposals(api, { conversationId })} />;
}

it("shows only the requested conversation's cards and links every decision to the inbox", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const list = vi.fn().mockResolvedValueOnce({ proposals: [row("分步示例")], nextCursor: "later", total: 2 })
    .mockResolvedValueOnce({ proposals: [row("更早的对话建议")], nextCursor: null, total: 2 });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ConversationProposals api={{ listPendingAssistantProposals: list } as unknown as OpeningApi} conversationId="conversation-a" />));
    expect(list).toHaveBeenCalledWith({ conversationId: "conversation-a" });
    expect(host.textContent).toContain("分步示例");
    expect(host.querySelector('a[href="/opening/suggestions"]')).not.toBeNull();
    expect(host.querySelector("form")).toBeNull();
    expect([...host.querySelectorAll("button")].some(button => /接受|不采用|准备建议/.test(button.textContent ?? ""))).toBe(false);
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "读取更多建议")!.click());
    expect(list).toHaveBeenLastCalledWith({ conversationId: "conversation-a", cursor: "later" });
    expect(host.textContent).toContain("更早的对话建议");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("does not display a late previous-conversation read after switching conversations", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let oldResult!: (value: { proposals: AssistantProposalRecord[]; nextCursor: null; total: number }) => void;
  const list = vi.fn().mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve; }))
    .mockResolvedValue({ proposals: [row("当前会话建议")], nextCursor: null, total: 1 });
  const api = { listPendingAssistantProposals: list } as unknown as OpeningApi;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ConversationProposals api={api} conversationId="conversation-a" />));
    await act(async () => root.render(<ConversationProposals api={api} conversationId="conversation-b" />));
    await act(async () => oldResult({ proposals: [row("旧会话建议")], nextCursor: null, total: 1 }));
    expect(host.textContent).toContain("当前会话建议");
    expect(host.textContent).not.toContain("旧会话建议");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
