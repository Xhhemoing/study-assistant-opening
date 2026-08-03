import type { ReactNode } from "react";
import { LogOut, Search, Settings } from "lucide-react";
import {
  WorkspaceNavigation,
  type WorkspaceEntry,
} from "./workspace-navigation";

function ShellUtilities({ onOpenCommandPalette }: { onOpenCommandPalette?: () => void }) {
  const searchAction = onOpenCommandPalette ? (
    <button
      aria-label="打开全局搜索"
      className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onOpenCommandPalette}
      title="打开全局搜索"
      type="button"
    >
      <Search aria-hidden="true" size={16} />
      <span>搜索</span>
      <span className="hidden text-xs text-text-dim sm:inline">⌘K</span>
    </button>
  ) : (
    <a
      aria-label="打开全局搜索"
      className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      href="/search"
      title="打开全局搜索"
    >
      <Search aria-hidden="true" size={16} />
      <span>搜索</span>
    </a>
  );

  return (
    <div className="flex items-center gap-2" data-shell-utilities="true">
      {searchAction}
      <a
        aria-label="设置"
        className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-line text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        href="/settings"
        title="设置"
      >
        <Settings aria-hidden="true" size={17} />
      </a>
    </div>
  );
}

export function AppShell({
  activeEntry,
  children,
  userLabel,
  onLogout,
  onOpenCommandPalette,
  logoutPending = false,
}: {
  activeEntry: WorkspaceEntry;
  children: ReactNode;
  userLabel?: string;
  onLogout?: () => void;
  onOpenCommandPalette?: () => void;
  logoutPending?: boolean;
}): ReactNode {
  return (
    <div className="app-shell" data-app-shell="true">
      <aside className="app-shell__sidebar" data-shell-navigation="desktop">
        <a className="app-shell__brand" href="/" aria-label="AIstudy 首页">
          <span className="app-shell__brand-mark" aria-hidden="true">
            AI
          </span>
          <span>AIstudy</span>
        </a>
        <WorkspaceNavigation activeEntry={activeEntry} />
        <ShellUtilities onOpenCommandPalette={onOpenCommandPalette} />
        {userLabel ? (
          <div className="app-shell__account">
            <span className="app-shell__user">{userLabel}</span>
            {onLogout ? (
              <button type="button" onClick={onLogout} disabled={logoutPending} aria-label="退出登录">
                <LogOut aria-hidden="true" size={17} />
                <span>退出</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </aside>

      <main className="app-shell__main" id="main-content">
        {children}
      </main>

      <div className="app-shell__bottom" data-shell-navigation="mobile">
        <WorkspaceNavigation activeEntry={activeEntry} placement="bottom" />
        <div className="px-4 pb-3">
          <ShellUtilities onOpenCommandPalette={onOpenCommandPalette} />
        </div>
        {onLogout ? (
          <button className="app-shell__mobile-logout" type="button" onClick={onLogout} disabled={logoutPending} aria-label="退出登录">
            <LogOut aria-hidden="true" size={19} />
            <span>退出</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
