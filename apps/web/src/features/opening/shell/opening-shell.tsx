"use client";

import { AppShell, getWorkspaceEntry } from "@aistudy/ui";
import { BookOpen, Compass, Focus, Library, Maximize2, MessageCircle, Notebook, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { ui } from "../design/ui";
import { FocusTimer } from "./focus-timer";
import { navigationIsActive, openingNavigation } from "./navigation";

const icons = { today: Sun, assistant: MessageCircle, learn: BookOpen, explore: Compass, library: Library, courses: Notebook };

export function OpeningShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const activeItem = openingNavigation().find(item => navigationIsActive(item.href, pathname));
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
  const navigation = <nav aria-label="学习工作台导航" className="flex min-w-max justify-around gap-1 px-2 md:min-w-0 md:flex-col md:justify-start">{openingNavigation().map(item => {
    const Icon = icons[item.icon];
    const active = navigationIsActive(item.href, pathname);
    return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} title={item.label} className={`flex min-h-11 min-w-11 flex-col items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none ${active ? "bg-emerald-50 text-emerald-800" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"}`}><Icon size={18} strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span></Link>;
  })}</nav>;
  return <>
    <AppShell activeEntry={getWorkspaceEntry(pathname.split("/")[1])} title={activeItem?.label ?? "学习工作台"} navigation={navigation} focusMode={focusMode} userLabel={userLabel} logoutPending={logoutPending} onLogout={logout} onOpenCommandPalette={openPalette} topbar={<><FocusTimer /><button type="button" className={ui.icon} aria-pressed={focusMode} aria-label={focusMode ? "退出专注模式" : "进入专注模式"} title={focusMode ? "退出专注模式" : "进入专注模式"} onClick={() => setFocusMode(value => !value)}>{focusMode ? <Maximize2 size={16} aria-hidden="true" /> : <Focus size={16} aria-hidden="true" />}</button></>}>
      {logoutError ? <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700" role="alert">{logoutError}</div> : null}{children}
    </AppShell>
    <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
  </>;
}
