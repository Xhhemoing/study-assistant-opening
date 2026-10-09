import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, LogOut, Search, Settings } from "lucide-react";
import { WorkspaceNavigation, type WorkspaceEntry } from "./workspace-navigation";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50";
const iconClass = `inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-[color,background-color,transform] duration-150 hover:bg-zinc-100 hover:text-zinc-900 active:scale-95 disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100 md:size-8 ${focusRing}`;

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "aistudy.shell.sidebarCollapsed";

export function AppShell({ activeEntry, children, userLabel, onLogout, onOpenCommandPalette, logoutPending = false, navigation, topbar, title = "学习工作台", focusMode = false, sidebarCollapsed = false, onToggleSidebar }: {
  activeEntry: WorkspaceEntry;
  children: ReactNode;
  userLabel?: string;
  onLogout?: () => void;
  onOpenCommandPalette?: () => void;
  logoutPending?: boolean;
  navigation?: ReactNode;
  topbar?: ReactNode;
  title?: string;
  focusMode?: boolean;
  /** Desktop aside collapses to an icon rail; mobile bottom nav is unchanged. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}): ReactNode {
  const collapsed = Boolean(sidebarCollapsed);
  return <div className="group/workspace flex h-dvh min-h-0 bg-zinc-100/70 font-sans text-sm text-zinc-800 antialiased" data-app-shell="true" data-focus={focusMode} data-sidebar-collapsed={collapsed ? "true" : "false"}>
    <a className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3 focus:shadow-lg" href="#main-content">跳至主要内容</a>
    <aside
      className={`hidden shrink-0 flex-col py-3 group-data-[focus=true]/workspace:hidden md:flex ${collapsed ? "w-16 items-center" : "w-16 items-center lg:w-52 lg:items-stretch lg:px-3"}`}
      data-shell-navigation="desktop"
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      <a className={`group/logo mb-5 inline-flex h-10 items-center justify-center gap-2.5 rounded-lg text-sm font-semibold tracking-tight text-zinc-900 ${collapsed ? "" : "lg:justify-start lg:px-1.5"} ${focusRing}`} href="/" aria-label="AIstudy 首页">
        <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 text-[11px] font-bold text-white shadow-md shadow-zinc-900/20 ring-1 ring-white/10 transition-transform duration-300 ease-out-expo group-hover/logo:-rotate-6 group-hover/logo:scale-105 motion-reduce:transition-none ${collapsed ? "" : "lg:size-8"}`}>AI</span>
        <span className={collapsed ? "hidden" : "hidden lg:inline"} aria-hidden="true">AIstudy</span>
      </a>
      <div className="min-h-0 w-full flex-1 overflow-y-auto">{navigation ?? <WorkspaceNavigation activeEntry={activeEntry} />}</div>
      {onToggleSidebar ? <button type="button" className={`${iconClass} mt-1 ${collapsed ? "" : "lg:h-10 lg:w-full lg:justify-start lg:gap-2.5 lg:px-2 lg:text-xs"}`} onClick={onToggleSidebar} aria-pressed={collapsed} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} data-sidebar-toggle="true">{collapsed ? <ChevronRight aria-hidden="true" size={16} /> : <><ChevronLeft className="lg:hidden" aria-hidden="true" size={16} /><ChevronLeft className="hidden shrink-0 lg:inline" aria-hidden="true" size={14} /><span className="hidden min-w-0 flex-1 truncate text-left lg:inline" aria-hidden="true">收起侧栏</span></>}</button> : null}
      {onLogout ? <button type="button" className={`${iconClass} ${collapsed ? "" : "lg:h-10 lg:w-full lg:justify-start lg:gap-2.5 lg:px-2 lg:text-xs"}`} onClick={onLogout} disabled={logoutPending} aria-label={logoutPending ? "正在退出" : "退出登录"} title={userLabel ? `${userLabel} · 退出登录` : "退出登录"}><span className={`hidden size-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-800 ${collapsed ? "" : "lg:inline-flex"}`} aria-hidden="true">{(userLabel || "我").slice(0, 1).toUpperCase()}</span><LogOut className={collapsed ? "" : "lg:hidden"} aria-hidden="true" size={17} /><span className={`hidden min-w-0 flex-1 truncate text-left ${collapsed ? "" : "lg:inline"}`} aria-hidden="true">{userLabel || "退出登录"}</span><LogOut className={`hidden shrink-0 ${collapsed ? "" : "lg:inline"}`} aria-hidden="true" size={14} /></button> : null}
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white md:my-2 md:mr-2 md:rounded-2xl md:border md:border-zinc-200/80 md:shadow-sm md:shadow-zinc-900/5 group-data-[focus=true]/workspace:md:m-0 group-data-[focus=true]/workspace:md:rounded-none group-data-[focus=true]/workspace:md:border-0">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200/70 bg-white/80 px-3 backdrop-blur-md sm:px-5">
        <div className="flex min-w-0 items-center gap-2"><span className="truncate text-[13px] font-semibold text-zinc-900">{title}</span></div>
        <div className="flex shrink-0 items-center gap-1" data-shell-utilities="true">
          {onOpenCommandPalette ? <button aria-label="打开全局搜索" title="全局搜索与快捷导航 (Ctrl / ⌘ K)" className={`${iconClass} lg:mr-1 lg:w-48 lg:justify-between lg:gap-2 lg:border lg:border-zinc-200 lg:bg-zinc-50 lg:px-2.5 lg:text-xs lg:text-zinc-500 lg:hover:border-zinc-300 lg:hover:bg-white`} onClick={onOpenCommandPalette} type="button"><span className="inline-flex items-center gap-2"><Search aria-hidden="true" size={15} /><span className="hidden lg:inline" aria-hidden="true">搜索或跳转…</span></span><kbd className="hidden rounded border border-zinc-200 bg-white px-1.5 font-sans text-[10px] font-medium text-zinc-500 lg:inline" aria-hidden="true">⌘K</kbd></button> : <a aria-label="打开全局搜索" className={iconClass} href="/search"><Search aria-hidden="true" size={16} /></a>}
          {topbar}
          <a aria-label="设置" className={iconClass} href="/settings" title="设置"><Settings aria-hidden="true" size={16} /></a>
          {onLogout ? <button className={`${iconClass} md:hidden`} type="button" onClick={onLogout} disabled={logoutPending} aria-label="退出登录"><LogOut aria-hidden="true" size={16} /></button> : null}
        </div>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto" id="main-content" tabIndex={-1}>{children}</main>
      <div className="shrink-0 overflow-x-auto border-t border-zinc-200/80 bg-white/90 pb-[env(safe-area-inset-bottom)] pt-1 backdrop-blur-md group-data-[focus=true]/workspace:hidden md:hidden" data-shell-navigation="mobile">{navigation ?? <WorkspaceNavigation activeEntry={activeEntry} placement="bottom" />}</div>
    </div>
  </div>;
}
