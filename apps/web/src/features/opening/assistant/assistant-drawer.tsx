"use client";

import { Drawer } from "@aistudy/ui";
import type { LearningAttempt } from "@aistudy/contracts";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { AssistantSession } from "./assistant-session";
import { ASSISTANT_OPEN_EVENT, assistantEntry, isStudySurface, sameStudyItem, type AssistantEntry } from "./assistant-entry";
import { useCurrentStudyContext } from "./current-study-context";
import { studyConversationHref, studyConversationIdentity } from "./study-conversation-context";

/** Each explicit context keeps its own mounted conversation, including temporary drafts and pending requests. */
export function AssistantDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openContextKey, setOpenContextKey] = useState("");
  const binding = useCurrentStudyContext();
  const [entries, setEntries] = useState<(AssistantEntry & { learningAttempt?: LearningAttempt })[]>([]);
  const [active, setActive] = useState("");
  // 宽版 = 对话页：从「助理」入口打开时默认展开，偏好记在本机。
  const [wide, setWide] = useState(false);
  const toggleWide = useCallback(() => setWide(current => { const next = !current; try { window.localStorage.setItem("aistudy:assistant-wide", next ? "1" : "0"); } catch { /* 存储不可用时只影响本次 */ } return next; }), []);
  const bound = binding?.pathname === pathname ? binding : null;
  const studySurface = Boolean(bound) || isStudySurface(pathname);
  const boundKey = bound ? `${studyConversationIdentity(bound.context)}:${bound.isQuestion}:${bound.blockedReason ?? ""}:${bound.learningAttempt?.id ?? ""}` : null;
  const contextKey = JSON.stringify([pathname, boundKey]);
  const visible = open && openContextKey === contextKey;
  const launch = useCallback((href?: string) => {
    setOpenContextKey(contextKey);
    // A toolbar reopen returns to the active question; navigation never silently rebinds it.
    if (!href && active && !studySurface) { setOpen(true); return; }
    const next: AssistantEntry & { learningAttempt?: LearningAttempt } = assistantEntry(href ?? (bound ? studyConversationHref(bound.context) : "/opening/assistant"), pathname);
    const matching = bound && sameStudyItem(next.context, bound.context);
    if (studySurface && (!matching || bound?.blockedReason || (bound?.isQuestion && !bound.learningAttempt))) {
      next.error = bound?.blockedReason || "先保存自己的原答案，再围绕这道题提问。帮助会关联本次作答。";
      next.key += `:${next.error}`;
    } else if (matching && bound.learningAttempt) next.learningAttempt = bound.learningAttempt;
    setEntries(current => current.some(entry => entry.key === next.key) ? current : [...current, next]);
    setActive(next.key);
    setOpen(true);
  }, [active, pathname, bound, studySurface, contextKey]);
  // Changing the current item can happen on Today without a route change.
  // Close the previous session while keeping its draft and pending request intact.
  useEffect(() => { setOpen(false); }, [pathname, boundKey]);
  useEffect(() => {
    const openEvent = (event: Event) => {
      const href = (event as CustomEvent<unknown>).detail;
      if (typeof href !== "string" || href === "/opening/assistant") {
        let stored: string | null = null;
        try { stored = window.localStorage.getItem("aistudy:assistant-wide"); } catch { stored = null; }
        setWide(stored !== "0");
      }
      launch(typeof href === "string" && href !== "/opening/assistant" ? href : undefined);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, openEvent);
    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, openEvent);
    };
  }, [launch]);
  return <Drawer open={visible} onClose={() => setOpen(false)} title="学习助手" keepMounted className={wide ? "sm:w-[min(760px,calc(100vw-1rem))]!" : ""} contentClassName="flex min-h-0 flex-1 flex-col p-0">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-text-2"><span className="flex min-w-0 items-center gap-1"><button type="button" className="hidden size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 sm:inline-flex" aria-pressed={wide} aria-label={wide ? "收窄对话" : "展开为对话页"} title={wide ? "收窄对话" : "展开为对话页"} onClick={toggleWide}>{wide ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button><span className="truncate">提问背景：{entries.find(entry => entry.key === active)?.label ?? "当前内容"}</span></span>{!studySurface ? <div className="flex flex-wrap gap-1">{entries.find(entry => entry.key === active)?.context ? <button type="button" className="min-h-8 rounded px-2 underline" aria-label="移除提问背景" onClick={() => launch("/opening/assistant?context=none")}>自由提问</button> : null}<button type="button" className="min-h-8 rounded px-2 text-accent underline" onClick={() => launch(`/opening/assistant${/^\/opening\/courses\/([0-9a-f-]{36})/.exec(pathname)?.[1] ? `?courseId=${pathname.split("/")[3]}` : ""}`)}>围绕当前页面提问</button></div> : null}</div>
    {entries.length > 1 && !studySurface ? <label className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-xs text-text-2">本次提问<select aria-label="切换本次提问" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-text" value={active} onChange={event => setActive(event.target.value)}>{entries.map((entry, index) => <option key={entry.key} value={entry.key}>{index + 1}. {entry.label}</option>)}</select></label> : null}
    {entries.map(entry => <div key={entry.key} hidden={entry.key !== active} inert={entry.key !== active} className={entry.key === active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <AssistantSession entry={entry} />
    </div>)}
  </Drawer>;
}
