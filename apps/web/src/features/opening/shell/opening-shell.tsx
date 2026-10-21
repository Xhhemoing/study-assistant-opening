"use client";

import { AppShell, getWorkspaceEntry, SIDEBAR_COLLAPSED_STORAGE_KEY } from "@aistudy/ui";
import { Layers2, Library, Notebook, Sparkles, Sun } from "lucide-react";
import { ShellNavLink } from "./shell-nav-link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { ui } from "../design/ui";
import { ConnectionNotice } from "./connection-notice";
import { OpeningAccountMenu } from "./account-menu";
import { AssistantDrawer } from "../assistant/assistant-drawer";
import { openAssistantDrawer } from "../assistant/assistant-entry";
import { OpeningMobileNavigation } from "./mobile-navigation";
import { navigationIsActive, openingNavigation } from "./navigation";
import { OpeningCapabilityNotice } from "../capabilities/capabilities-provider";
import { CitationReaderHost } from "../inbox/citation-reader-host";

const icons = { today: Sun, library: Library, courses: Notebook, review: Layers2 };

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
  const router = useRouter();
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dismissedFocusPath, setDismissedFocusPath] = useState<string | null>(null);
  const studySurface = /^\/opening\/courses\/[^/]+\/study(?:\/(?:matrix|span))?\/?$/.test(pathname);
  // Entering a lesson is a layout choice, never a change to AI intervention settings.
  const effectiveFocusMode = focusMode || (studySurface && dismissedFocusPath !== pathname);
  const exitFocusMode = useCallback(() => {
    setFocusMode(false);
    if (studySurface) setDismissedFocusPath(pathname);
  }, [pathname, studySurface]);
  const toggleFocusMode = useCallback(() => {
    if (effectiveFocusMode) exitFocusMode();
    else setFocusMode(true);
  }, [effectiveFocusMode, exitFocusMode]);
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
  const activeItem = openingNavigation().find(item => navigationIsActive(item.href, pathname));
  useEffect(() => {
    setSidebarCollapsed(readSidebarCollapsed());
  }, []);
  useEffect(() => {
    if (!effectiveFocusMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('dialog[open],[role="dialog"][data-state="open"]')) return;
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
    const controller = new AbortController();
    // The shell survives soft navigation. Refresh the badge after reviewing
    // suggestions rather than relying on a full page load to update it.
    fetch("/api/opening/reviews?limit=1", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) { if (!controller.signal.aborted) setPendingCount(null); return; }
        const body = await response.json() as { total?: number };
        if (!controller.signal.aborted) setPendingCount(typeof body.total === "number" ? body.total : null);
      }).catch(() => { if (!controller.signal.aborted) setPendingCount(null); });
    return () => controller.abort();
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
  const navigation = <nav aria-label="学习工作台导航" className="flex flex-col gap-1 px-2 lg:px-0">{openingNavigation().map(item => {
    const Icon = icons[item.icon];
    const active = navigationIsActive(item.href, pathname);
    return <ShellNavLink key={item.href} href={item.href} aria-current={active ? "page" : undefined} title={item.label} className={`flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none ${sidebarCollapsed ? "" : "lg:flex-row lg:justify-start lg:gap-3 lg:px-3"} ${active ? "bg-accent-soft font-semibold text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text"}`}><Icon size={18} aria-hidden="true" /><span className={sidebarCollapsed ? "md:sr-only" : undefined}>{item.label}</span></ShellNavLink>;
  })}</nav>;
  return <>
    <AppShell activeEntry={getWorkspaceEntry(pathname.split("/")[1])} title={studySurface ? "课程学习" : activeItem?.label ?? (pathname.startsWith("/opening/settings") ? "设置" : "学习工作台")} navigation={navigation} mobileNavigation={<OpeningMobileNavigation pathname={pathname} pendingCount={pendingCount} />} settingsHref="/opening/settings" focusMode={effectiveFocusMode} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} userLabel={userLabel} logoutPending={logoutPending} onLogout={logout} onOpenCommandPalette={openPalette} accountMenu={<OpeningAccountMenu userLabel={userLabel} pendingCount={pendingCount} focusMode={effectiveFocusMode} onToggleFocus={toggleFocusMode} onLogout={logout} logoutPending={logoutPending} />} topbar={<button type="button" className={ui.icon} aria-label="打开学习助手" title="学习助手 (Ctrl / ⌘ J)" onClick={() => openAssistantDrawer()}><Sparkles size={18} aria-hidden="true" /></button>}>
      {logoutError ? <div className="border-b border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger" role="alert">{logoutError}</div> : null}<ConnectionNotice /><OpeningCapabilityNotice />{children}
    </AppShell>
    <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
    <Suspense fallback={null}><AssistantDrawer /></Suspense>
    <CitationReaderHost />
  </>;
}
