// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { MemoryPanel } from "./memory-panel";

vi.mock("../v3/motion/view-transition", () => ({ TransitionLink: ({ children, ...props }: { children: ReactNode; href: string }) => <a {...props}>{children}</a> }));

it("routes candidate decisions to the inbox while keeping confirmed memory management", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const at = "2026-10-26T00:00:00.000Z";
  const api = {
    listCandidates: vi.fn(async () => [{ id: "candidate", sourceTurnId: "turn", sourceIds: [], status: "pending", version: 0,
      candidate: { kind: "memory", text: "偏好分步推导", temporary: false }, createdAt: at }]),
    listMemory: vi.fn(async () => ({ items: [{ id: "memory", kind: "confirmed", status: "active", text: "已确认的学习偏好", sourceTurnIds: [], createdAt: at, version: 1 }] })),
    decideMemoryCandidate: vi.fn(),
  } as unknown as OpeningApi;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryPanel api={api} />));
    expect(host.textContent).toContain("已确认的学习偏好");
    expect([...host.querySelectorAll("button")].map(button => button.textContent)).toContain("删除记忆");
    expect([...host.querySelectorAll("button")].map(button => button.textContent)).not.toEqual(expect.arrayContaining(["确认", "不记住"]));
    expect(host.querySelector('a[href="/opening/suggestions"]')?.textContent).toContain("确认记忆");
    expect(api.listCandidates).not.toHaveBeenCalled();
    expect(api.decideMemoryCandidate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
