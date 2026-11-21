"use client";

import type { ConversationSummary } from "@aistudy/contracts";
import { Drawer } from "@aistudy/ui";
import { CalendarDays, ChevronRight, Download, Focus, Inbox, LogOut, Maximize2, MoreHorizontal, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { ui } from "../design/ui";
import { ShellNavLink } from "./shell-nav-link";
import { FocusTimer } from "./focus-timer";
import { RecentConversations } from "./recent-conversations";
import { AppearanceControl } from "./appearance-control";

const menuRowClass = "flex min-h-11 w-full items-center justify-between gap-3 px-3.5 py-2.5 text-sm text-text transition-colors duration-150 hover:bg-surface-2/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring motion-reduce:transition-none";

export function OpeningAccountMenu({ userLabel, pendingCount, focusMode, onToggleFocus, onLogout, logoutPending, recent = [], recentUnavailable = false }: {
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
      <nav aria-label="学习工具与账户" className="space-y-4">
        <RecentConversations recent={recent} unavailable={recentUnavailable} onNavigate={() => setOpen(false)} />
        <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <ShellNavLink className={menuRowClass} href="/opening/settings/learning" onClick={() => setOpen(false)}><span className="inline-flex items-center gap-2.5"><CalendarDays size={16} aria-hidden="true" className="text-text-2" />学习安排</span><ChevronRight size={15} aria-hidden="true" className="text-text-3" /></ShellNavLink>
          <ShellNavLink className={menuRowClass} href="/opening/suggestions" onClick={() => setOpen(false)}><span className="inline-flex items-center gap-2.5 tabular-nums"><Inbox size={16} aria-hidden="true" className="text-text-2" />待确认建议{pendingCount ? ` · ${pendingCount}` : ""}</span><ChevronRight size={15} aria-hidden="true" className="text-text-3" /></ShellNavLink>
          <button className={menuRowClass} type="button" aria-pressed={focusMode} onClick={() => { onToggleFocus(); setOpen(false); }}><span className="inline-flex items-center gap-2.5">{focusMode ? <Maximize2 size={16} aria-hidden="true" className="text-accent" /> : <Focus size={16} aria-hidden="true" className="text-text-2" />}{focusMode ? "退出专注模式" : "进入专注模式"}</span></button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface px-3.5 py-2.5 shadow-card"><span className="text-xs font-medium text-text-2">专注计时</span><FocusTimer /></div>
        <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <AppearanceControl />
          <ShellNavLink className={menuRowClass} href="/opening/settings" onClick={() => setOpen(false)}><span className="inline-flex items-center gap-2.5"><Settings size={16} aria-hidden="true" className="text-text-2" />设置</span><ChevronRight size={15} aria-hidden="true" className="text-text-3" /></ShellNavLink>
          <ShellNavLink className={menuRowClass} href="/opening/settings/export" onClick={() => setOpen(false)}><span className="inline-flex items-center gap-2.5"><Download size={16} aria-hidden="true" className="text-text-2" />导出</span><ChevronRight size={15} aria-hidden="true" className="text-text-3" /></ShellNavLink>
          <button type="button" className={`${menuRowClass} text-text-2 hover:text-danger disabled:opacity-50`} onClick={onLogout} disabled={logoutPending}><span className="inline-flex min-w-0 items-center gap-2.5 truncate"><LogOut size={16} aria-hidden="true" className="shrink-0" /><span className="truncate">{logoutPending ? "正在退出…" : `${userLabel ? `${userLabel} · ` : ""}退出登录`}</span></span></button>
        </div>
        <p className="px-1 text-xs text-text-3 tabular-nums">{version ? <>版本 <span className="font-mono">{version.commit}</span> · <time dateTime={version.builtAt}>{new Date(version.builtAt).toLocaleString()}</time></> : "版本暂不可用"}</p>
      </nav>
    </Drawer>
  </>;
}
