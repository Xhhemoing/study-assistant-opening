"use client";

import { LogOut, Minimize2, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { AssistantDrawer } from "../assistant/assistant-drawer";
import { ConversationCompanionProvider } from "../assistant/conversation-companion";
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
import { useRecentConversations } from "./recent-conversations";
import { useDueReviewCount } from "./review-count";
import { WorkspaceLayoutContext } from "./workspace-layout-context";

const navigationFeature = (href: string, label: string, placement: "core" | "tool"): Feature => ({
  ...FEATURES.find(item => item.route === href)!, label, placement,
});
const navigation = openingNavigation();
const OPENING_NAV = {
  label: "学习工作台导航",
  mobileLabel: "学习工作台导航（移动端）",
  core: navigation.filter(item => item.group === "core").map(item => navigationFeature(item.href, item.label, "core")),
  tools: navigation.filter(item => item.group === "tools").map(item => navigationFeature(item.href, item.label, "tool")),
  system: [FEATURES.find(item => item.id === "settings")!],
};

/**
 * 生产壳层（UI v3）：v3 AppShell 负责导航、外观层与页面过渡；这里只接业务数据与全局能力：
 * 复习计数、账户（专注 / 退出）、命令面板（⌘K）、学习助手抽屉（⌘J，右侧打开）、引用阅读器、连接/能力提示。
 * 专注由用户主动进入（账户菜单），不再进入学习页时自动隐藏导航。
 */
export function OpeningShellV3({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [userLabel, setUserLabel] = useState("");
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const { recent, unavailable: recentUnavailable } = useRecentConversations(pathname);
  const dueCount = useDueReviewCount(pathname);
  const shellNav: ShellNav = { ...OPENING_NAV, isActive: (item, path) => navigationIsActive(item.route, path, search) };
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleFocus = useCallback(() => setFocusMode(value => !value), []);

  useEffect(() => {
    if (!focusMode) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open],[role="dialog"][data-state="open"]')) return;
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

  const accountMenu = <OpeningAccountMenu pathname={pathname} search={search} recent={recent} recentUnavailable={recentUnavailable} userLabel={userLabel} pendingCount={pendingCount} focusMode={focusMode} onToggleFocus={toggleFocus} onLogout={logout} logoutPending={logoutPending} />;

  return (
    <ConversationCompanionProvider><WorkspaceLayoutContext.Provider value={{ focusMode, setFocusMode, toggleFocusMode: toggleFocus }}><StatusToastProvider>
      <AppShell
        counts={dueCount ? { review: dueCount } : {}}
        recent={recent.map(thread => ({ id: thread.id, title: thread.title, href: `/opening/assistant?conversation=${encodeURIComponent(thread.id)}` }))}
        hideNav={focusMode}
        nav={shellNav}
        onOpenSearch={openPalette}
        mobileTrailing={accountMenu}
        account={<div className="flex items-center gap-2 px-1.5 py-1">
          {accountMenu}
          <span className="truncate text-meta text-text-2 in-data-[compact=true]:sr-only">{userLabel}</span>
        </div>}
        mobileMenuExtra={<div className="grid gap-1">
          <Link href="/opening/review" className={`${ui.quiet} justify-start`}><RotateCcw size={16} aria-hidden="true" />复习{dueCount ? ` · ${dueCount}` : ""}</Link>
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
    </StatusToastProvider></WorkspaceLayoutContext.Provider></ConversationCompanionProvider>
  );
}
