// @vitest-environment jsdom

import { act, createElement, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({ pathname: "/opening/today", search: "", chatMounts: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => data.pathname,
  useSearchParams: () => new URLSearchParams(data.search),
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children) }));
vi.mock("../v3/motion/view-transition", () => ({
  TransitionLink: ({ children, ...props }: ComponentProps<"a">) => createElement("a", props, children),
  ViewTransitionBoundary: () => null,
  runViewTransition: (update: () => void) => update(),
}));
vi.mock("../search/command-palette", () => ({ CommandPalette: ({ open }: { open: boolean }) => open ? <div role="dialog">全局搜索已打开</div> : null }));
vi.mock("../assistant/assistant-drawer", () => ({ AssistantDrawer: () => null }));
vi.mock("../assistant/assistant-view", () => ({ AssistantView: () => {
  useEffect(() => { data.chatMounts(); }, []);
  return <textarea aria-label="对话草稿" defaultValue="" />;
} }));
vi.mock("../capabilities/capabilities-provider", () => ({ OpeningCapabilityNotice: () => null }));
vi.mock("../inbox/citation-reader-host", () => ({ CitationReaderHost: () => null }));
vi.mock("./connection-notice", () => ({ ConnectionNotice: () => null }));
vi.mock("./account-menu", () => ({ OpeningAccountMenu: ({ pendingCount, focusMode, onToggleFocus, recent = [] }: {
  pendingCount: number | null; focusMode: boolean; onToggleFocus: () => void; recent?: { title: string }[];
}) => <><span data-account-recent>{recent.map(item => item.title).join("、")}</span><button type="button" aria-label="账户切换专注" aria-pressed={focusMode} onClick={onToggleFocus}>建议 {pendingCount}</button></> }));
vi.mock("./recent-conversations", () => ({ useRecentConversations: () => ({
  recent: [{ id: "11111111-1111-4111-8111-111111111111", title: "我的矩阵问题" }], unavailable: false,
}) }));
vi.mock("./review-count", () => ({ useDueReviewCount: () => 7 }));

import { ConversationSurface } from "../assistant/conversation-companion";
import { PageHeader } from "../v3/shell/page-header";
import { OpeningShellV3 } from "./opening-shell-v3";
import { useWorkspaceLayout } from "./workspace-layout-context";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); data.pathname = "/opening/today"; data.search = "";
  vi.stubGlobal("fetch", vi.fn(async input => String(input).startsWith("/api/opening/reviews")
    ? Response.json({ total: 3 }) : Response.json({ user: { displayName: "学生" } })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(children: ReactNode = <PageHeader title="学习" />) {
  await act(async () => root.render(<OpeningShellV3>{children}</OpeningShellV3>));
}
function desktopNavigation() { return host.querySelector('nav[aria-label="学习工作台导航"]')!; }

describe("production V3 shell business wiring", () => {
  it("retains navigation collapse without exposing width adjustment", async () => {
    await render();
    expect(host.querySelector('[aria-label="调整导航宽度"]')).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--layout-nav")).toBe("");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="收起导航"]')!.click());
    expect(host.querySelector('nav[data-compact="true"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展开导航"]')!.click());
    expect(host.querySelector('nav[data-compact="false"]')).not.toBeNull();
  });
  it.each([
    ["/opening/today", "", "/opening/today"],
    ["/opening/agent", "", "/opening/today"],
    ["/opening/review", "", "/opening/review"],
    ["/opening/review", "tab=cards", "/opening/review"],
    ["/opening/courses/course-a", "mode=sprint", "/opening/today"],
    ["/opening/assistant", "", "/opening/today"],
    ["/opening/settings/export", "", null],
  ])("selects exactly one destination for %s?%s", async (pathname, search, expected) => {
    data.pathname = pathname; data.search = search; await render();
    const nav = desktopNavigation();
    const destinations = [...nav.querySelectorAll("a[href]")].map(link => link.getAttribute("href"));
    expect(new Set(destinations).size).toBe(destinations.length);
    const selected = nav.querySelectorAll('a[aria-current="page"]');
    expect(selected).toHaveLength(expected ? 1 : 0);
    if (expected) expect(selected[0]?.getAttribute("href")).toBe(expected);
    expect(destinations).toEqual(["/opening/today", "/opening/review", "/opening/library"]);
  });

  it("shows due reviews separately from pending suggestions and connects recent conversations", async () => {
    await render();
    expect(desktopNavigation().querySelector('a[href="/opening/review"]')?.textContent).toContain("7");
    expect(desktopNavigation().querySelector('a[href="/opening/today"]')?.textContent).toContain("3项待确认建议");
    expect(host.querySelector('nav[aria-label="学习工作台导航（移动端）"] a[href="/opening/today"]')?.textContent).toContain("3项待确认建议");
    expect(host.querySelector('[aria-label="账户切换专注"]')?.textContent).toBe("建议 3");
    expect(desktopNavigation().querySelector('a[href*="conversation="]')).toBeNull();
    expect(host.querySelector("[data-account-recent]")?.textContent).toContain("我的矩阵问题");
  });

  it("opens the same command palette from mobile search without repeating navigation in More", async () => {
    await render();
    const searches = host.querySelectorAll<HTMLButtonElement>('[aria-label="打开全局搜索"]');
    expect(searches.length).toBe(2);
    await act(async () => searches[searches.length - 1]!.click());
    expect(host.textContent).toContain("全局搜索已打开");
    expect(host.querySelectorAll('a[href="/opening/review"]')).toHaveLength(2);
  });
  it("shares focus state with the mounted workspace and ignores composition Escape", async () => {
    function Workspace() {
      const layout = useWorkspaceLayout();
      return <button type="button" onClick={layout.toggleFocusMode}>课堂专注 {String(layout.focusMode)}</button>;
    }
    await render(<Workspace />);
    const trigger = [...host.querySelectorAll("button")].find(button => button.textContent === "课堂专注 false")!;
    await act(async () => trigger.click());
    expect(host.querySelector("[data-app-shell]")?.getAttribute("data-focus")).toBe("true");
    expect(host.textContent).toContain("课堂专注 true");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
    expect(host.querySelector("[data-app-shell]")?.getAttribute("data-focus")).toBe("true");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector("[data-app-shell]")?.getAttribute("data-focus")).toBe("false");
  });

  it("retains the original conversation editor across route changes", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    data.pathname = "/opening/assistant";
    await render(<ConversationSurface initialConversationId={id} />);
    const original = host.querySelector<HTMLTextAreaElement>('[aria-label="对话草稿"]')!;
    original.value = "我的未发送推导";
    data.pathname = "/opening/courses/course-a"; await render(<p>课程空间</p>);
    expect(original.closest("[hidden]")).not.toBeNull();
    data.pathname = "/opening/assistant"; await render(<ConversationSurface initialConversationId={id} />);
    expect(host.querySelector('[aria-label="对话草稿"]')).toBe(original);
    expect(original.value).toBe("我的未发送推导");
    expect(data.chatMounts).toHaveBeenCalledOnce();
  });

  it("renders rich page titles with a readable fallback toolbar label", async () => {
    await render(<PageHeader title={<span>线性代数 <strong>第一课</strong></span>} />);
    expect(host.querySelector("h1")?.textContent).toBe("线性代数 第一课");
    expect(host.querySelector('header[aria-label="页面顶栏"]')).not.toBeNull();
    expect(host.innerHTML).not.toContain("[object Object]");
  });
});
