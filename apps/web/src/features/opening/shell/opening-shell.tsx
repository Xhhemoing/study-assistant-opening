"use client";

import { AppShell, getWorkspaceEntry, SIDEBAR_COLLAPSED_STORAGE_KEY } from "@aistudy/ui";
import { ShellNavLink } from "./shell-nav-link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { ConnectionNotice } from "./connection-notice";
import { OpeningAccountMenu } from "./account-menu";
import { AssistantDrawer } from "../assistant/assistant-drawer";
import { ConversationCompanionProvider } from "../assistant/conversation-companion";
import { OpeningMobileNavigation } from "./mobile-navigation";
import { navigationIsActive, openingNavigation } from "./navigation";
import { OpeningCapabilityNotice } from "../capabilities/capabilities-provider";
import { CitationReaderHost } from "../inbox/citation-reader-host";

import { openingNavigationIcons } from "./navigation-icons";
import { RecentConversations, useRecentConversations } from "./recent-conversations";
import { OpeningSidebarFooter } from "./appearance-control";
import { useDueReviewCount } from "./review-count";
import { WorkspaceLayoutContext } from "./workspace-layout-context";

function readSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function OpeningShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { recent, unavailable: recentUnavailable } = useRecentConversations(pathname);
  const dueCount = useDueReviewCount(pathname);
  const studySurface = /^\/opening\/courses\/[^/]+\/study(?:\/(?:matrix|span))?\/?$/.test(pathname);
  // Focus is always an explicit choice; route entry never hides navigation.
  const effectiveFocusMode = focusMode;
  const exitFocusMode = useCallback(() => setFocusMode(false), []);
  const toggleFocusMode = useCallback(() => setFocusMode(current => !current), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(current => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        /* ignore quota / private mode */
      }
      return next;
    });
  }, []);
  const activeItem = openingNavigation().find(item => navigationIsActive(item.href, pathname, search));
  useEffect(() => {
    setSidebarCollapsed(readSidebarCollapsed());
  }, []);
  useEffect(() => {
    if (!effectiveFocusMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open],[role="dialog"][data-state="open"]')) return;
      exitFocusMode();
    };
    // Run after document-level dismiss handlers so an open panel gets Escape first.
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [effectiveFocusMode, exitFocusMode]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json() as { user?: { displayName?: string } };
        if (!controller.signal.aborted && typeof body.user?.displayName === "string") setUserLabel(body.user.displayName);
      }).catch(() => undefined);
    return () => controller.abort();
  }, []);
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch("/api/opening/reviews?limit=1", { cache: "no-store", signal: current.signal })
        .then(async response => {
          if (!response.ok) { if (!current.signal.aborted) setPendingCount(null); return; }
          const body = await response.json() as { total?: number };
          if (!current.signal.aborted) setPendingCount(typeof body.total === "number" ? body.total : null);
        }).catch(() => { if (!current.signal.aborted) setPendingCount(null); });
    };
    refresh();
    if (typeof window !== "undefined") window.addEventListener("opening:reviews-changed", refresh);
    return () => { controller?.abort(); if (typeof window !== "undefined") window.removeEventListener("opening:reviews-changed", refresh); };
  }, [pathname]);
  async function logout() {
    if (logoutPending) return;
    setLogoutPending(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) { setLogoutError("退出失败，请重试。"); return; }
      router.replace("/login");
      router.refresh();
    } catch { setLogoutError("网络连接异常，请重试退出。"); }
    finally { setLogoutPending(false); }
  }
  const navigation = <div>
    {(["core", "tools"] as const).map(group => <nav key={group} aria-label={group === "core" ? "主导航" : "学习工具"} className={`flex flex-col gap-1 ${group === "tools" ? "mt-3 border-t border-line pt-3" : ""}`}>
      {openingNavigation().filter(item => item.group === group).map(item => {
        const Icon = openingNavigationIcons[item.icon];
        const active = navigationIsActive(item.href, pathname, search);
        return <ShellNavLink key={item.href} href={item.href} aria-current={active ? "page" : undefined} title={item.label} className={`flex min-h-11 min-w-0 rounded-md px-2 py-2 text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none ${sidebarCollapsed ? "flex-col items-center justify-center gap-1 text-xs" : "items-center gap-3 px-3"} ${active ? "bg-surface-2 font-medium text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}><Icon size={18} aria-hidden="true" /><span>{item.label}</span>{item.icon === "review" && dueCount ? <span className={`tabular-nums text-xs text-accent ${sidebarCollapsed ? "" : "ml-auto"}`}>{dueCount}<span className="sr-only">项待复习</span></span> : null}</ShellNavLink>;
      })}
    </nav>)}
    <RecentConversations recent={recent} compact={sidebarCollapsed} unavailable={recentUnavailable} />
  </div>;
  return <ConversationCompanionProvider><WorkspaceLayoutContext.Provider value={{ focusMode, setFocusMode, toggleFocusMode }}>
    <AppShell activeEntry={getWorkspaceEntry(pathname.split("/")[1])} title={studySurface ? "课程学习" : activeItem?.label ?? (pathname.startsWith("/opening/settings") ? "设置" : "学习工作台")} navigation={navigation} sidebarFooter={<OpeningSidebarFooter compact={sidebarCollapsed} pathname={pathname} />} mobileNavigation={<OpeningMobileNavigation pathname={pathname} search={search} dueCount={dueCount} />} settingsHref="/opening/settings" focusMode={effectiveFocusMode} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} userLabel={userLabel} logoutPending={logoutPending} onLogout={logout} onOpenCommandPalette={openPalette} accountMenu={<OpeningAccountMenu pathname={pathname} search={search} userLabel={userLabel} pendingCount={pendingCount} focusMode={effectiveFocusMode} onToggleFocus={toggleFocusMode} onLogout={logout} logoutPending={logoutPending} recent={recent} recentUnavailable={recentUnavailable} />}>
      {logoutError ? <div className="border-b border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger" role="alert">{logoutError}</div> : null}<ConnectionNotice /><OpeningCapabilityNotice />{children}
    </AppShell>
    <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
    <Suspense fallback={null}><AssistantDrawer /></Suspense>
    <CitationReaderHost />
  </WorkspaceLayoutContext.Provider></ConversationCompanionProvider>;
}
