"use client";

import { Drawer } from "@aistudy/ui";
import { ClipboardCheck, Focus, Link2, LogOut, Maximize2, Settings, Timer } from "lucide-react";
import { useState } from "react";
import { ui } from "../design/ui";
import { ShellNavLink } from "./shell-nav-link";
import { FocusTimer } from "./focus-timer";

export function OpeningAccountMenu({ userLabel, pendingCount, focusMode, onToggleFocus, onLogout, logoutPending }: {
  userLabel: string; pendingCount: number | null; focusMode: boolean;
  onToggleFocus: () => void; onLogout: () => void; logoutPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={`${ui.icon} relative rounded-full bg-accent-soft text-accent`} aria-label="账户与学习工具" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span aria-hidden="true" className="text-sm font-semibold">{(userLabel || "我").slice(0, 1).toUpperCase()}</span>
      {pendingCount !== null && pendingCount > 0 ? <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1.5 text-xs text-on-ink" aria-label={`${pendingCount} 项待审核`}>{pendingCount > 99 ? "99+" : pendingCount}</span> : null}
    </button>
    <Drawer open={open} onClose={() => setOpen(false)} title={userLabel || "学习工具"} keepMounted description="AI 建议、专注计时与账户设置">
      <nav aria-label="账户与学习工具" className="space-y-2">
        <ShellNavLink className={`${ui.secondary} w-full justify-start`} href="/opening/suggestions" onClick={() => setOpen(false)}><ClipboardCheck size={16} aria-hidden="true" />AI 建议{pendingCount ? ` · ${pendingCount}` : ""}</ShellNavLink>
        <ShellNavLink className={`${ui.secondary} w-full justify-start`} href="/opening/sprint" onClick={() => setOpen(false)}><Timer size={16} aria-hidden="true" />考前冲刺</ShellNavLink>
        <button className={`${ui.secondary} w-full justify-start`} type="button" aria-pressed={focusMode} onClick={() => { onToggleFocus(); setOpen(false); }}>{focusMode ? <Maximize2 size={16} aria-hidden="true" /> : <Focus size={16} aria-hidden="true" />}{focusMode ? "退出专注模式" : "进入专注模式"}</button>
        <div className="rounded-xl border border-line p-3"><p className="mb-2 text-xs text-text-2">专注计时 · 仅当前页面有效</p><FocusTimer /></div>
        <ShellNavLink className={`${ui.secondary} w-full justify-start`} href="/opening/settings/connections" onClick={() => setOpen(false)}><Link2 size={16} aria-hidden="true" />连接</ShellNavLink>
        <ShellNavLink className={`${ui.secondary} w-full justify-start`} href="/opening/settings" onClick={() => setOpen(false)}><Settings size={16} aria-hidden="true" />设置</ShellNavLink>
        <button type="button" className={`${ui.quiet} w-full justify-start`} onClick={onLogout} disabled={logoutPending}><LogOut size={16} aria-hidden="true" />{logoutPending ? "正在退出…" : "退出登录"}</button>
      </nav>
    </Drawer>
  </>;
}
