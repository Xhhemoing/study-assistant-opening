import type { ReactNode } from "react";
import { LogOut } from "lucide-react";
import {
  WorkspaceNavigation,
  type WorkspaceEntry,
} from "./workspace-navigation";

export function AppShell({
  activeEntry,
  children,
  userLabel,
  onLogout,
  logoutPending = false,
}: {
  activeEntry: WorkspaceEntry;
  children: ReactNode;
  userLabel?: string;
  onLogout?: () => void;
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