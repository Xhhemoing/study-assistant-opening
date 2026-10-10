"use client";

import { AppShell, getWorkspaceEntry, SIDEBAR_COLLAPSED_STORAGE_KEY } from "@aistudy/ui";
import { BookOpen, ClipboardCheck, Compass, Focus, Layers2, Library, Link2, Maximize2, MessageCircle, Notebook, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { ui } from "../design/ui";
import { FocusTimer } from "./focus-timer";
import { navigationIsActive, openingNavigation } from "./navigation";

const icons = {
  today: Sun,
  assistant: MessageCircle,
  learn: BookOpen,
  explore: Compass,
  library: Library,
  courses: Notebook,
  cards: Layers2,
  review: ClipboardCheck,
  connections: Link2,
};

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
  const [pendingCount, setPendingCount] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
    const controller = new AbortController();
    fetch("/api/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json() as { user?: { displayName?: string } };
        if (!controller.signal.aborted && typeof body.user?.displayName === "string") setUserLabel(body.user.displayName);
      }).catch(() => undefined);
    fetch("/api/opening/reviews?limit=1", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json() as { total?: number };
        if (!controller.signal.aborted && typeof body.total === "number") setPendingCount(body.total);
      }).catch(() => undefined);
    return () => controller.abort();
  }, []);
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
  const navigation = <nav aria-label="学习工作台导航" className="flex min-w-max justify-around gap-1 px-2 md:min-w-0 md:flex-col md:justify-start lg:gap-0.5 lg:px-0">{openingNavigation().map((item, index, items) => {
    const Icon = icons[item.icon];
    const active = navigationIsActive(item.href, pathname);
    const groupStart = index > 0 && items[index - 1]?.group !== item.group;
    return <Fragment key={item.href}>
      {groupStart ? <span className={`hidden md:mx-3 md:my-2 md:block md:border-t md:border-zinc-200 ${sidebarCollapsed ? "" : "lg:mx-0 lg:mb-1 lg:mt-4 lg:border-0 lg:px-2.5 lg:text-[10px] lg:font-semibold lg:uppercase lg:tracking-wider lg:text-zinc-400"}`} aria-hidden="true"><span className={sidebarCollapsed ? "hidden" : "hidden lg:inline"}>更多</span></span> : null}
      <Link href={item.href} aria-current={active ? "page" : undefined} title={item.label} className={`group/nav flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 ${sidebarCollapsed ? "" : "lg:min-h-9 lg:flex-row lg:justify-start lg:gap-2.5 lg:px-2.5 lg:py-2 lg:text-xs"} ${active ? "bg-gradient-to-br from-emerald-50 to-emerald-100/70 font-semibold text-emerald-900 shadow-xs ring-1 ring-emerald-600/10" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"}`}><Icon size={18} strokeWidth={active ? 2 : 1.7} aria-hidden="true" className={sidebarCollapsed ? "" : "lg:size-[15px]"} /><span className={sidebarCollapsed ? "md:sr-only" : undefined}>{item.label}</span></Link>
    </Fragment>;
  })}</nav>;
  const quickActions = <>
    <Link href="/opening/cards" className={ui.icon} aria-label="记忆卡片" title="复习到期的记忆卡片" aria-current={pathname.startsWith("/opening/cards") ? "page" : undefined}><Layers2 size={16} aria-hidden="true" /></Link>
    <Link href="/opening/review" className={ui.icon} aria-label="待确认建议" title="审核 AI 生成的任务、记忆与补测建议" aria-current={pathname.startsWith("/opening/review") ? "page" : undefined}><ClipboardCheck size={16} aria-hidden="true" />{pendingCount > 0 ? <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-white ring-2 ring-white motion-safe:animate-pop" aria-label={`${pendingCount} 项待审核`}>{pendingCount}</span> : null}</Link>
  </>;
  return <>
    <AppShell activeEntry={getWorkspaceEntry(pathname.split("/")[1])} title={activeItem?.label ?? "学习工作台"} navigation={navigation} focusMode={focusMode} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} userLabel={userLabel} logoutPending={logoutPending} onLogout={logout} onOpenCommandPalette={openPalette} topbar={<>{focusMode ? null : quickActions}<FocusTimer /><button type="button" className={`${ui.icon} relative`} aria-pressed={focusMode} aria-label={focusMode ? "退出专注模式" : "进入专注模式"} title={focusMode ? "退出专注模式" : "进入专注模式"} onClick={() => setFocusMode(value => !value)}>{focusMode ? <Maximize2 size={16} aria-hidden="true" /> : <Focus size={16} aria-hidden="true" />}</button></>}>
      {logoutError ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700" role="alert">{logoutError}</div> : null}{children}
    </AppShell>
    <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
  </>;
}
