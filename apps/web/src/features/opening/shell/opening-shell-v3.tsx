"use client";

import { LogOut, Minimize2, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { AssistantDrawer } from "../assistant/assistant-drawer";
import { openAssistantDrawer } from "../assistant/assistant-entry";
import { OpeningCapabilityNotice } from "../capabilities/capabilities-provider";
import { CitationReaderHost } from "../inbox/citation-reader-host";
import { AppShell, type ShellNav } from "../v3/shell/app-shell";
import { FEATURES, type Feature } from "../v3/shell/features";
import { navigationIsActive, openingNavigation } from "./navigation";
import { StatusToastProvider } from "../v3/ui/toast";
import { ui } from "../v3/ui/controls";
import { OpeningAccountMenu } from "./account-menu";
import { ConnectionNotice } from "./connection-notice";

const ICONS: Record<string, Feature["icon"]> = { today: "start", courses: "courses", assistant: "assistant", library: "library" };
const feature = (id: string) => FEATURES.find(item => item.id === id)!;
const TOOLS: Feature[] = [feature("review"), feature("sprint"), feature("cards")];
const exact = (item: Feature, pathname: string) => pathname === item.route || pathname.startsWith(`${item.route}/`);

/** 生产导航沿用既有四个入口（今日/课程/助理/资料）与无障碍名称；学习工具只在桌面侧栏。每个路径只高亮一项。 */
const OPENING_NAV: ShellNav = {
  label: "学习工作台导航",
  mobileLabel: "学习工作台导航（移动端）",
  core: openingNavigation().map(item => ({ id: item.icon, route: item.href, label: item.label, icon: ICONS[item.icon] ?? "start", placement: "core", depth: 0, layout: "list", source: "features/opening/shell/navigation" })),
  tools: TOOLS,
  system: [feature("settings")],
  isActive: (item, pathname) => {
    const tool = TOOLS.find(candidate => exact(candidate, pathname));
    if (item.placement === "tool" || item.id === "settings") return exact(item, pathname);
    if (tool || pathname.startsWith("/opening/settings")) return false;
    return navigationIsActive(item.route, pathname);
  },
};

/**
 * 生产壳层（UI v3）：v3 AppShell 负责导航、外观层与页面过渡；这里只接业务数据与全局能力：
 * 复习计数、账户（专注 / 退出）、命令面板（⌘K）、学习助手抽屉（⌘J，右侧打开）、引用阅读器、连接/能力提示。
 * 专注由用户主动进入（账户菜单），不再进入学习页时自动隐藏导航。
 */
export function OpeningShellV3({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleFocus = useCallback(() => setFocusMode(value => !value), []);

  useEffect(() => {
    if (!focusMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('dialog[open],[role="dialog"][data-state="open"]')) return;
      setFocusMode(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [focusMode]);

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
    window.addEventListener("opening:reviews-changed", refresh);
    return () => { controller?.abort(); window.removeEventListener("opening:reviews-changed", refresh); };
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

  const accountMenu = <OpeningAccountMenu userLabel={userLabel} pendingCount={pendingCount} focusMode={focusMode} onToggleFocus={toggleFocus} onLogout={logout} logoutPending={logoutPending} />;

  return (
    <StatusToastProvider>
      <AppShell
        counts={pendingCount ? { review: pendingCount } : {}}
        hideNav={focusMode}
        nav={OPENING_NAV}
        onOpenSearch={openPalette}
        mobileTrailing={accountMenu}
        account={<div className="flex items-center gap-2 px-1.5 py-1">
          {accountMenu}
          <span className="truncate text-meta text-text-2 in-data-[compact=true]:sr-only">{userLabel}</span>
        </div>}
        mobileMenuExtra={<div className="grid gap-1">
          <button type="button" className={`${ui.quiet} justify-start`} onClick={() => openAssistantDrawer()}><Sparkles size={16} aria-hidden="true" />问 AI</button>
          <button type="button" className={`${ui.quiet} justify-start`} onClick={toggleFocus}>{focusMode ? "退出专注" : "进入专注"}</button>
          <button type="button" className={`${ui.quiet} justify-start`} onClick={logout} disabled={logoutPending}><LogOut size={16} aria-hidden="true" />{logoutPending ? "正在退出…" : "退出登录"}</button>
        </div>}
        banner={<>
          {logoutError ? <div className="mx-3 mt-2 rounded-pill bg-danger-soft px-4 py-2 text-meta text-danger" role="alert">{logoutError}</div> : null}
          <ConnectionNotice />
          <OpeningCapabilityNotice />
        </>}>
        {children}
      </AppShell>
      {focusMode ? <div className="fixed right-3 top-2 z-40 flex items-center gap-1 rounded-pill glass p-1">
        <button type="button" onClick={toggleFocus} className="inline-flex h-(--control-h-sm) items-center gap-1.5 rounded-pill px-3 text-meta font-medium text-text hover:bg-text/5"><Minimize2 size={14} aria-hidden="true" />退出专注</button>
        {accountMenu}
      </div> : null}
      <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
      <Suspense fallback={null}><AssistantDrawer /></Suspense>
      <CitationReaderHost />
    </StatusToastProvider>
  );
}
