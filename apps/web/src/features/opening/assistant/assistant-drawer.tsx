"use client";

import { Drawer } from "@aistudy/ui";
import type { LearningAttempt } from "@aistudy/contracts";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minimize2, SquareArrowOutUpRight } from "lucide-react";
import { TransitionLink } from "../v3/motion/view-transition";
import { AssistantSession } from "./assistant-session";
import { ASSISTANT_OPEN_EVENT, assistantEntry, isStudySurface, sameStudyItem, type AssistantEntry, type AssistantPromptRequest } from "./assistant-entry";
import { useCurrentStudyContext } from "./current-study-context";
import { studyConversationHref, studyConversationIdentity } from "./study-conversation-context";
import { validConversationId } from "./conversation-links";

/** Each explicit context keeps its own mounted conversation, including temporary drafts and pending requests. */
export function AssistantDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openContextKey, setOpenContextKey] = useState("");
  const binding = useCurrentStudyContext();
  const [entries, setEntries] = useState<(AssistantEntry & { learningAttempt?: LearningAttempt })[]>([]);
  const [active, setActive] = useState("");
  const [resumeChecks, setResumeChecks] = useState<Record<string, number>>({});
  const [conversations, setConversations] = useState<Record<string, string | null>>({});
  // 宽版 = 对话页：从「助理」入口打开时默认展开，偏好记在本机。
  const [wide, setWide] = useState(false);
  const toggleWide = useCallback(() => setWide(current => { const next = !current; try { window.localStorage.setItem("aistudy:assistant-wide", next ? "1" : "0"); } catch { /* 存储不可用时只影响本次 */ } return next; }), []);
  const bound = binding?.pathname === pathname ? binding : null;
  const studySurface = Boolean(bound) || isStudySurface(pathname);
  const boundKey = bound ? `${studyConversationIdentity(bound.context)}:${bound.isQuestion}:${bound.blockedReason ?? ""}:${bound.learningAttempt?.id ?? ""}` : null;
  const contextKey = JSON.stringify([pathname, boundKey]);
  const visible = open && openContextKey === contextKey;
  const launch = useCallback((href?: string, promptRequest?: AssistantPromptRequest) => {
    setOpenContextKey(contextKey);
    // A toolbar reopen returns to the active question; navigation never silently rebinds it.
    if (!href && active && !studySurface && !promptRequest) {
      setResumeChecks(current => ({ ...current, [active]: (current[active] ?? 0) + 1 }));
      setOpen(true); return;
    }
    const next: AssistantEntry & { learningAttempt?: LearningAttempt } = assistantEntry(href ?? (bound ? studyConversationHref(bound.context) : "/opening/assistant"), pathname);
    if (promptRequest) { next.fresh = true; next.conversation = null; next.key += ":composed"; }
    const matching = bound && sameStudyItem(next.context, bound.context);
    // 只有当前确实是一道尚未开始的题（或题目明确不可提问）才拦下；讲解、示范、页面加载中都按课程背景直接提问。
    const questionPending = Boolean(bound && (bound.blockedReason || (bound.isQuestion && !bound.learningAttempt)));
    if (studySurface && (questionPending || (bound?.isQuestion && !matching))) {
      next.error = bound?.blockedReason || "先开始这道题，再围绕它提问。帮助会关联本次作答。";
      next.key += `:${next.error}`;
    } else if (matching && bound.learningAttempt) next.learningAttempt = bound.learningAttempt;
    if (promptRequest) next.promptRequest = promptRequest;
    setEntries(current => current.some(entry => entry.key === next.key) ? current.map(entry => entry.key === next.key && promptRequest ? { ...entry, promptRequest } : entry) : [...current, next]);
    setActive(next.key);
    if (!next.conversation && !next.fresh) setResumeChecks(current => ({ ...current, [next.key]: (current[next.key] ?? 0) + 1 }));
    setOpen(true);
  }, [active, pathname, bound, studySurface, contextKey]);
  // Changing the current item can happen on Today without a route change.
  // Close the previous session while keeping its draft and pending request intact.
  useEffect(() => { setOpen(false); }, [pathname, boundKey]);
  useEffect(() => {
    const openEvent = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      let href: string | undefined;
      let promptRequest: AssistantPromptRequest | undefined;
      if (typeof detail === "string") href = detail;
      else if (detail && typeof detail === "object" && "href" in detail && typeof detail.href === "string"
        && "promptRequest" in detail && detail.promptRequest && typeof detail.promptRequest === "object"
        && "id" in detail.promptRequest && typeof detail.promptRequest.id === "string"
        && "text" in detail.promptRequest && typeof detail.promptRequest.text === "string" && detail.promptRequest.text.trim()) {
        href = detail.href; promptRequest = { id: detail.promptRequest.id, text: detail.promptRequest.text };
      } else return;
      if (typeof href !== "string" || href === "/opening/assistant") {
        let stored: string | null = null;
        try { stored = window.localStorage.getItem("aistudy:assistant-wide"); } catch { stored = null; }
        setWide(stored !== "0");
      }
      launch(href !== "/opening/assistant" ? href : undefined, promptRequest);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, openEvent);
    return () => {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, openEvent);
    };
  }, [launch]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey
        || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j"
        || document.querySelector('dialog[open]:not([data-study-companion]),[role="dialog"]')) return;
      event.preventDefault(); launch();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [launch]);
  const activeEntry = entries.find(entry => entry.key === active);
  const conversationId = activeEntry && Object.hasOwn(conversations, activeEntry.key) ? conversations[activeEntry.key] : activeEntry?.conversation;
  const fullPage = new URL(activeEntry?.context ? studyConversationHref(activeEntry.context) : "/opening/assistant", "https://study.invalid");
  fullPage.pathname = "/opening/agent";
  if (conversationId && validConversationId(conversationId)) fullPage.searchParams.set("conversation", conversationId);
  if (activeEntry?.error) fullPage.searchParams.set("contextError", "1");
  const fullPageHref = `${fullPage.pathname}${fullPage.search}`;
  return <Drawer open={visible} onClose={() => setOpen(false)} title="学习助手" keepMounted className={wide ? "sm:w-[min(760px,calc(100vw-1rem))]!" : ""} contentClassName="flex min-h-0 flex-1 flex-col p-0">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-text-2"><span className="flex min-w-0 items-center gap-1"><button type="button" className="hidden size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 sm:inline-flex" aria-pressed={wide} aria-label={wide ? "收窄对话" : "展开为对话页"} title={wide ? "收窄对话" : "展开为对话页"} onClick={toggleWide}>{wide ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}</button><TransitionLink href={fullPageHref} onClick={() => setOpen(false)} className="hidden size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 sm:inline-flex" aria-label="在助理全页中打开" title="在助理全页中打开（会话列表、待确认产出）"><SquareArrowOutUpRight size={14} aria-hidden="true" /></TransitionLink><span className="truncate">提问背景：{entries.find(entry => entry.key === active)?.label ?? "当前内容"}</span></span>{!studySurface ? <div className="flex flex-wrap gap-1">{entries.find(entry => entry.key === active)?.context ? <button type="button" className="min-h-8 rounded px-2 underline" aria-label="移除提问背景" onClick={() => launch("/opening/assistant?context=none")}>自由提问</button> : null}<button type="button" className="min-h-8 rounded px-2 text-accent underline" onClick={() => launch(`/opening/assistant${/^\/opening\/courses\/([0-9a-f-]{36})/.exec(pathname)?.[1] ? `?courseId=${pathname.split("/")[3]}` : ""}`)}>围绕当前页面提问</button></div> : null}</div>
    {entries.length > 1 && !studySurface ? <label className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-xs text-text-2">本次提问<select aria-label="切换本次提问" className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-text" value={active} onChange={event => setActive(event.target.value)}>{entries.map((entry, index) => <option key={entry.key} value={entry.key}>{index + 1}. {entry.label}</option>)}</select></label> : null}
    {entries.map(entry => <div key={entry.key} hidden={entry.key !== active} inert={entry.key !== active} className={entry.key === active ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <AssistantSession entry={entry} implicitResumeVersion={!entry.conversation && !entry.fresh ? resumeChecks[entry.key] : undefined}
        onConversationChange={id => setConversations(current => current[entry.key] === id ? current : { ...current, [entry.key]: id })} />
    </div>)}
  </Drawer>;
}
