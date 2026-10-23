"use client";

import type { ConversationSummary } from "@aistudy/contracts";
import { MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { createOpeningApi } from "../client/api";
import { ShellNavLink } from "./shell-nav-link";

export function useRecentConversations(pathname: string) {
  const [recent, setRecent] = useState<ConversationSummary[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const rows = await createOpeningApi().listConversations();
        if (active && generation === request) {
          setRecent([...rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8));
          setUnavailable(false);
        }
      } catch {
        if (active && generation === request) { setRecent([]); setUnavailable(true); }
      }
    };
    void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("opening:conversations-changed", refresh);
      window.addEventListener("focus", refresh);
    }
    return () => {
      active = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("opening:conversations-changed", refresh);
        window.removeEventListener("focus", refresh);
      }
    };
  }, [pathname]);
  return { recent, unavailable };
}

export function RecentConversations({ recent, compact = false, unavailable = false, onNavigate }: {
  recent: ConversationSummary[]; compact?: boolean; unavailable?: boolean; onNavigate?: () => void;
}) {
  return <section aria-label="最近对话" className="mt-3 border-t border-line pt-3">
    {!compact && recent.length > 0 ? <ul>{recent.slice(0, 8).map(thread => <li key={thread.id}>
      <ShellNavLink href={`/opening/assistant?conversation=${encodeURIComponent(thread.id)}`} onClick={onNavigate} className="block min-h-11 truncate rounded-md px-3 py-3 text-[13px] text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{thread.title}</ShellNavLink>
    </li>)}</ul> : null}
    {!compact && unavailable ? <p className="px-3 py-2 text-xs text-text-3">最近对话暂时无法读取</p> : null}
    <ShellNavLink href="/opening/assistant" onClick={onNavigate} aria-label="全部对话" className={`flex min-h-11 rounded-md px-2 py-2 text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${compact ? "flex-col items-center gap-1 text-xs" : "items-center gap-3 px-3 text-[13px]"}`}>
      <MessageSquare size={18} aria-hidden="true" /><span>{compact ? "对话" : "全部对话"}</span>
    </ShellNavLink>
  </section>;
}
