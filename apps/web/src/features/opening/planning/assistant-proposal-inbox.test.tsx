// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AssistantProposalRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { AssistantProposalInbox } from "./assistant-proposal-inbox";
vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: { children: ReactNode; href: string }) => <a {...props}>{children}</a> }));
const row = (id: string): AssistantProposalRecord => ({ id, sourceTurnId: "turn", version: 0, status: "draft",
  createdAt: "2026-10-26T00:00:00Z", basisVersion: "v1", result: null, prepared: null,
  tool: { name: "propose_note", arguments: { title: id, text: `正文 ${id}` } } });

it("loads later pending pages and keeps an uncertain decision's original action and key", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const list = vi.fn().mockResolvedValueOnce({ proposals: [row("first")], nextCursor: "later", total: 2 })
    .mockResolvedValueOnce({ proposals: [row("second")], nextCursor: null, total: 2 })
    .mockResolvedValue({ proposals: [row("first")], nextCursor: "later", total: 2 });
  const decide = vi.fn().mockRejectedValueOnce(new Error("网络中断")).mockResolvedValue({ ...row("first"), status: "accepted" });
  const api = { listPendingAssistantProposals: list, decideAssistantProposal: decide } as unknown as OpeningApi;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text)!;
  try {
    await act(async () => root.render(<AssistantProposalInbox api={api} />));
    await act(async () => button("读取更多建议").click());
    expect(list).toHaveBeenLastCalledWith({ cursor: "later" });
    expect(host.textContent).toContain("正文 second");
    const pending = host.querySelectorAll("li")[1]!;
    await act(async () => pending.querySelector<HTMLButtonElement>('button[data-action="accept"]')!.click());
    expect(host.textContent).toContain("网络中断");
    await act(async () => window.dispatchEvent(new Event("opening:reviews-changed")));
    expect(host.textContent).toContain("正文 second");
    const retained = [...host.querySelectorAll("li")].find(item => item.textContent?.includes("正文 second"))!;
    expect(retained.querySelector<HTMLButtonElement>('button[data-action="reject"]')!.disabled).toBe(true);
    await act(async () => retained.querySelector<HTMLButtonElement>('button[data-action="accept"]')!.click());
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1]).toEqual(decide.mock.calls[0]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
