import type { ReactNode } from "react";
import { LogOut, Search, Settings } from "lucide-react";
import { WorkspaceNavigation, type WorkspaceEntry } from "./workspace-navigation";

const iconClass = "inline-flex size-10 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors duration-150 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none md:size-8";

export function AppShell({ activeEntry, children, userLabel, onLogout, onOpenCommandPalette, logoutPending = false, navigation, topbar, title = "学习工作台", focusMode = false }: {
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
}): ReactNode {
  return <div className="group/workspace flex h-dvh min-h-0 bg-white text-sm text-zinc-800" data-app-shell="true" data-focus={focusMode}>
    <a className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-white focus:p-3" href="#main-content">跳至主要内容</a>
    <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 py-2 group-data-[focus=true]/workspace:hidden md:flex" data-shell-navigation="desktop">
      <a className="mb-4 inline-flex size-10 items-center justify-center rounded-md bg-zinc-900 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2" href="/" aria-label="AIstudy 首页">AI</a>
      <div className="min-h-0 w-full flex-1 overflow-y-auto">{navigation ?? <WorkspaceNavigation activeEntry={activeEntry} />}</div>
      {onLogout ? <button type="button" className={iconClass} onClick={onLogout} disabled={logoutPending} aria-label={logoutPending ? "正在退出" : "退出登录"} title={userLabel ? `${userLabel} · 退出登录` : "退出登录"}><LogOut aria-hidden="true" size={17} /></button> : null}
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-medium text-zinc-600">{title}</span></div>
        <div className="flex shrink-0 items-center gap-1" data-shell-utilities="true">
          {topbar}
          {onOpenCommandPalette ? <button aria-label="打开全局搜索" title="全局搜索与快捷导航 (Ctrl / ⌘ K)" className={iconClass} onClick={onOpenCommandPalette} type="button"><Search aria-hidden="true" size={16} /></button> : <a aria-label="打开全局搜索" className={iconClass} href="/search"><Search aria-hidden="true" size={16} /></a>}
          <a aria-label="设置" className={iconClass} href="/settings" title="设置"><Settings aria-hidden="true" size={16} /></a>
          {onLogout ? <button className={`${iconClass} md:hidden`} type="button" onClick={onLogout} disabled={logoutPending} aria-label="退出登录"><LogOut aria-hidden="true" size={16} /></button> : null}
        </div>
      </header>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto" id="main-content" tabIndex={-1}>{children}</main>
      <div className="shrink-0 overflow-x-auto border-t border-zinc-200 bg-zinc-50 py-1 group-data-[focus=true]/workspace:hidden md:hidden" data-shell-navigation="mobile">{navigation ?? <WorkspaceNavigation activeEntry={activeEntry} placement="bottom" />}</div>
    </div>
  </div>;
}
