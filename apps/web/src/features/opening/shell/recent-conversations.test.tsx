// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@aistudy/contracts";

const listConversations = vi.hoisted(() => vi.fn());
vi.mock("../client/api", () => ({ createOpeningApi: () => ({ listConversations }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/opening/today", useRouter: () => null }));
import { RecentConversations, useRecentConversations } from "./recent-conversations";

const rows: ConversationSummary[] = Array.from({ length: 10 }, (_, index) => ({
  id: `conversation-${index}`, title: `对话${index}`, courseId: null,
  updatedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, lastTurnPreview: null,
}));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  listConversations.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function Harness({ pathname }: { pathname: string }) {
  const result = useRecentConversations(pathname);
  return <RecentConversations recent={result.recent} unavailable={result.unavailable} />;
}

describe("recent conversation navigation", () => {
  it("always exposes all history in the empty and compact navigation", () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<RecentConversations recent={[]} compact={compact} />);
      expect(html).toContain('href="/opening/assistant"');
      expect(html).toContain('aria-label="全部对话"');
    }
  });
  it("sorts real summaries by recency, limits them to eight, and refreshes after conversation changes", async () => {
    listConversations.mockResolvedValue(rows);
    await act(async () => root.render(<Harness pathname="/opening/today" />));
    const links = host.querySelectorAll("li a");
    expect(links).toHaveLength(8);
    expect(links[0]?.textContent).toBe("对话9");
    expect(links[0]?.getAttribute("href")).toBe("/opening/assistant?conversation=conversation-9");
    listConversations.mockResolvedValue([]);
    await act(async () => { window.dispatchEvent(new Event("opening:conversations-changed")); });
    expect(host.querySelectorAll("li a")).toHaveLength(0);
    expect(host.querySelector('[aria-label="全部对话"]')).not.toBeNull();
  });
  it("does not let a previous route response replace the latest summaries", async () => {
    let resolveOld!: (rows: ConversationSummary[]) => void;
    listConversations.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce([rows[9]]);
    await act(async () => root.render(<Harness pathname="/opening/today" />));
    await act(async () => root.render(<Harness pathname="/opening/courses" />));
    await act(async () => resolveOld([rows[0]!]));
    expect(host.querySelector("li a")?.textContent).toBe("对话9");
  });
  it("keeps the all-history entry and reports a metadata read failure", async () => {
    listConversations.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<Harness pathname="/opening/today" />));
    expect(host.textContent).toContain("最近对话暂时无法读取");
    expect(host.querySelector('[aria-label="全部对话"]')).not.toBeNull();
  });
});
