"use client";

import { Moon, Settings } from "lucide-react";
import { useId } from "react";
import { useAppearancePreferences, type AppearancePreferences } from "../settings/appearance-preferences";
import { ShellNavLink } from "./shell-nav-link";

export function AppearanceControl() {
  const id = useId();
  const { preferences, hydrated, updatePreferences, persistenceError } = useAppearancePreferences();
  return <div className="px-3 py-2">
    <label htmlFor={id} className="mb-1 flex items-center gap-2 text-[13px] text-text-2"><Moon size={16} aria-hidden="true" />主题</label>
    <select id={id} value={preferences.theme} disabled={!hydrated} onChange={event => updatePreferences({ theme: event.target.value as AppearancePreferences["theme"] })} className="min-h-11 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select>
    {persistenceError ? <p role="status" className="mt-1 text-xs text-warn">主题仅在本次使用中生效</p> : null}
  </div>;
}

export function OpeningSidebarFooter({ compact, pathname = "" }: { compact: boolean; pathname?: string }) {
  return <div className="shrink-0 border-t border-line pt-2">
    <ShellNavLink href="/opening/settings" aria-current={pathname === "/opening/settings" || pathname.startsWith("/opening/settings/") ? "page" : undefined} className={`flex min-h-11 rounded-md px-3 py-2 text-text-2 hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${compact ? "flex-col items-center gap-1 text-xs" : "items-center gap-3 text-[15px]"}`}><Settings size={18} aria-hidden="true" /><span>设置</span></ShellNavLink>
    {compact ? <ShellNavLink href="/opening/settings#appearance" className="flex min-h-11 flex-col items-center gap-1 rounded-md px-2 py-2 text-xs text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"><Moon size={18} aria-hidden="true" /><span>主题</span></ShellNavLink> : <AppearanceControl />}
  </div>;
}
