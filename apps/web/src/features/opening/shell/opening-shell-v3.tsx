"use client";

import { LogOut, Minimize2, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "../../search/command-palette";
import { AssistantDrawer } from "../assistant/assistant-drawer";
import { openAssistantDrawer } from "../assistant/assistant-entry";
import { OpeningCapabilityNotice } from "../capabilities/capabilities-provider";
import { CitationReaderHost } from "../inbox/citation-reader-host";
import { AppShell } from "../v3/shell/app-shell";
import { StatusToastProvider } from "../v3/ui/toast";
import { ui } from "../v3/ui/controls";
import { OpeningAccountMenu } from "./account-menu";
import { ConnectionNotice } from "./connection-notice";

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

  const askButton = (
    <button type="button" onClick={() => openAssistantDrawer()} title="学习助手 (Ctrl / ⌘ J)"
      className="flex min-h-(--control-h) w-full items-center gap-0 rounded-pill bg-linear-to-r from-ai-1/12 via-ai-2/10 to-ai-3/12 text-ui font-medium text-text transition-[background-color,transform] duration-(--duration-micro) hover:from-ai-1/20 hover:to-ai-3/20 active:scale-[0.98]">
      <span className="grid w-12 shrink-0 justify-items-center text-ai-2"><Sparkles size={17} aria-hidden="true" /></span>
      <span className="truncate in-data-[compact=true]:sr-only">问 AI</span>
    </button>
  );

  return (
    <StatusToastProvider>
      <AppShell
        counts={pendingCount ? { review: pendingCount } : {}}
        hideNav={focusMode}
        navExtra={askButton}
        account={<div className="flex items-center gap-2 px-1.5 py-1">
          <OpeningAccountMenu userLabel={userLabel} pendingCount={pendingCount} focusMode={focusMode} onToggleFocus={toggleFocus} onLogout={logout} logoutPending={logoutPending} />
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
      {focusMode ? <button type="button" onClick={toggleFocus} className="fixed right-3 top-3 z-40 inline-flex h-(--control-h-sm) items-center gap-1.5 rounded-pill glass px-3 text-meta font-medium text-text"><Minimize2 size={14} aria-hidden="true" />退出专注</button> : null}
      <CommandPalette onClose={closePalette} onOpen={openPalette} open={paletteOpen} />
      <Suspense fallback={null}><AssistantDrawer /></Suspense>
      <CitationReaderHost />
    </StatusToastProvider>
  );
}
