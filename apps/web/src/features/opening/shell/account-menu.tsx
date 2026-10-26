"use client";

import type { ConversationSummary } from "@aistudy/contracts";
import { Drawer } from "@aistudy/ui";
import { ClipboardCheck, Focus, LogOut, Maximize2, MoreHorizontal, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { ui } from "../design/ui";
import { ShellNavLink } from "./shell-nav-link";
import { FocusTimer } from "./focus-timer";
import { navigationIsActive, openingNavigation } from "./navigation";
import { openingNavigationIcons } from "./navigation-icons";
import { RecentConversations } from "./recent-conversations";
import { AppearanceControl } from "./appearance-control";

export function OpeningAccountMenu({ userLabel, pendingCount, focusMode, onToggleFocus, onLogout, logoutPending, recent = [], recentUnavailable = false, pathname = "", search = "" }: {
  userLabel: string; pendingCount: number | null; focusMode: boolean;
  onToggleFocus: () => void; onLogout: () => void; logoutPending: boolean;
  recent?: ConversationSummary[]; recentUnavailable?: boolean; pathname?: string; search?: string;
}) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<{ commit: string; builtAt: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVersion(null);
    fetch("/api/opening/health", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "commit" in body && "builtAt" in body
          && typeof body.commit === "string" && /^[a-f0-9]{7,40}$/i.test(body.commit)
          && typeof body.builtAt === "string" && Number.isFinite(Date.parse(body.builtAt))
          && !controller.signal.aborted) {
          setVersion({ commit: body.commit, builtAt: body.builtAt });
        }
      }).catch(() => { /* Release details are optional; account actions remain available. */ });
    return () => controller.abort();
  }, [open]);
  return <>
    <button type="button" className={ui.icon} aria-label="更多" aria-haspopup="dialog" aria-expanded={open} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}><MoreHorizontal size={20} aria-hidden="true" /></button>
    <Drawer open={open} onClose={() => setOpen(false)} title="更多" keepMounted>
      <nav aria-label="学习工具与账户" className="space-y-2">
        {openingNavigation().filter(item => item.group === "tools").map(item => {
          const Icon = openingNavigationIcons[item.icon];
          return <ShellNavLink key={item.href} aria-current={navigationIsActive(item.href, pathname, search) ? "page" : undefined} className={`${ui.secondary} min-h-11 w-full justify-start aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium aria-[current=page]:text-text`} href={item.href} onClick={() => setOpen(false)}><Icon size={18} aria-hidden="true" />{item.label}</ShellNavLink>;
        })}
        <RecentConversations recent={recent} unavailable={recentUnavailable} onNavigate={() => setOpen(false)} />
        <ShellNavLink className={`${ui.secondary} min-h-11 w-full justify-start`} href="/opening/settings/planning#suggestions" onClick={() => { window.dispatchEvent(new Event("opening:show-suggestions")); setOpen(false); }}><ClipboardCheck size={16} aria-hidden="true" />待确认建议{pendingCount ? ` · ${pendingCount}` : ""}</ShellNavLink>
        <button className={`${ui.secondary} min-h-11 w-full justify-start`} type="button" aria-pressed={focusMode} onClick={() => { onToggleFocus(); setOpen(false); }}>{focusMode ? <Maximize2 size={16} aria-hidden="true" /> : <Focus size={16} aria-hidden="true" />}{focusMode ? "退出专注模式" : "进入专注模式"}</button>
        <div className="rounded-md border border-line p-3"><p className="mb-2 text-xs text-text-2">专注计时</p><FocusTimer /></div>
        <ShellNavLink className={`${ui.secondary} min-h-11 w-full justify-start`} href="/opening/settings" onClick={() => setOpen(false)}><Settings size={16} aria-hidden="true" />设置</ShellNavLink>
        <AppearanceControl />
        <button type="button" className={`${ui.quiet} min-h-11 w-full justify-start`} onClick={onLogout} disabled={logoutPending}><LogOut size={16} aria-hidden="true" />{logoutPending ? "正在退出…" : `${userLabel ? `${userLabel} · ` : ""}退出登录`}</button>
        <p className="px-3 pt-2 text-xs text-text-2">{version ? <>版本 {version.commit} · <time dateTime={version.builtAt}>{new Date(version.builtAt).toLocaleString()}</time></> : "版本暂不可用"}</p>
      </nav>
    </Drawer>
  </>;
}
