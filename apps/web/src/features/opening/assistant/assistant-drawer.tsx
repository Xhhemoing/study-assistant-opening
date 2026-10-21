"use client";

import { Drawer } from "@aistudy/ui";
import type { LearningAttempt } from "@aistudy/contracts";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AssistantSession } from "./assistant-session";
import { ASSISTANT_OPEN_EVENT, assistantEntry, isAssistantShortcut, isStudySurface, sameStudyItem, type AssistantEntry } from "./assistant-entry";
import { useCurrentStudyContext } from "./current-study-context";
import { studyConversationHref, studyConversationIdentity } from "./study-conversation-context";

/** Each explicit context keeps its own mounted conversation, including temporary drafts and pending requests. */
export function AssistantDrawer() {
  const pathname = usePathname();
  const query = useSearchParams();
  const [open, setOpen] = useState(false);
  const binding = useCurrentStudyContext();
  const [entries, setEntries] = useState<(AssistantEntry & { learningAttempt?: LearningAttempt })[]>([]);
  const [active, setActive] = useState("");
  const bound = binding?.pathname === pathname ? binding : null;
  const studySurface = Boolean(bound) || isStudySurface(pathname);
  const launch = useCallback((href?: string) => {
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
  }, [active, pathname, bound, studySurface]);
  const boundKey = bound ? `${studyConversationIdentity(bound.context)}:${bound.isQuestion}:${bound.blockedReason ?? ""}:${bound.learningAttempt?.id ?? ""}` : null;
  // Changing the current item can happen on Today without a route change.
  // Close the previous session while keeping its draft and pending request intact.
  useEffect(() => { setOpen(false); }, [pathname, boundKey]);
  useEffect(() => {
    const openEvent = (event: Event) => {
      const href = (event as CustomEvent<unknown>).detail;
      launch(typeof href === "string" && href !== "/opening/assistant" ? href : undefined);
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const editing = target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable=true]"));
      if (!isAssistantShortcut(event, editing)) return;
      if (document.querySelector('dialog[open],[role="dialog"][data-state="open"]') && !open) return;
      event.preventDefault();
      if (open) setOpen(false); else launch();
    };
    const openLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      const url = new URL(link.href);
      if (url.origin !== window.location.origin || url.pathname !== "/opening/assistant") return;
      event.preventDefault();
      launch(`${url.pathname}${url.search}`);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, openEvent);
    document.addEventListener("keydown", keyDown);
    document.addEventListener("click", openLink, true);
    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, openEvent);
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("click", openLink, true);
    };
  }, [launch, open]);
  const redirectQuery = query.get("ai") === "1" ? query.toString() : null;
  useEffect(() => {
    if (redirectQuery) launch(`/opening/assistant?${redirectQuery}`);
    // Consume an entry URL only when it changes; closing must not immediately reopen it.
  }, [redirectQuery]);
  return <Drawer open={open} onClose={() => setOpen(false)} title="学习助手" description="提示、讲解与学习提问。关闭后保留本次页面中的对话和草稿。" keepMounted contentClassName="flex min-h-0 flex-1 flex-col p-0">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-text-2"><span>提问背景：{entries.find(entry => entry.key === active)?.label ?? "当前内容"}</span>{!studySurface ? <button type="button" className="min-h-8 rounded px-2 text-accent underline" onClick={() => launch(`/opening/assistant${/^\/opening\/courses\/([0-9a-f-]{36})/.exec(pathname)?.[1] ? `?courseId=${pathname.split("/")[3]}` : ""}`)}>围绕当前页面提问</button> : null}</div>
    {entries.length > 1 && !studySurface ? <label className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-xs text-text-2">本次提问<select aria-label="切换本次提问" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-text" value={active} onChange={event => setActive(event.target.value)}>{entries.map((entry, index) => <option key={entry.key} value={entry.key}>{index + 1}. {entry.label}</option>)}</select></label> : null}
    {entries.map(entry => <div key={entry.key} hidden={entry.key !== active} inert={entry.key !== active} className={entry.key === active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <AssistantSession entry={entry} />
    </div>)}
  </Drawer>;
}
