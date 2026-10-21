"use client";

import { ArrowUpRight, BookOpen, Download } from "lucide-react";
import type { Citation } from "@aistudy/contracts";
import { ArtifactView } from "@aistudy/jingwei/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useOpeningCapabilities } from "../capabilities/capabilities-provider";
import { artifactsForMessages, openingCapabilities, openingRenderers } from "../jingwei-host";
import { snippetSaveAvailability, type SelectedExcerpt } from "./save-snippet";
import { showsGeneralMaterialBadge, type ChatMessageView } from "./message-model";
import {
  citationChipLabel,
  sourceDownloadHref,
  sourceViewerCopy,
  sourceViewerHref,
} from "../inbox/source-viewer";
import { AiSpark, ReplyCard, StreamText, ThinkingText } from "./ai-response";
import { MessageActions } from "./message-actions";
import { LearningProse, type CitationLink } from "./learning-prose";
import { isQueryEvidenceHref } from "./query-evidence-links";
import { selectedSourceFor } from "./selection-source";
import { assistantStarters, type AssistantStarter } from "./assistant-starters";

/** LAB-U01: a page refusal (turn status `clarify`) is a follow-up question, not a failure. */
export const CLARIFY_FOLLOW_UP = "追问：要讲哪份材料的哪一页？请在「参考资料」里重新选择材料和页码后再问。";

type Props = {
  messages: ChatMessageView[];
  compact?: boolean;
  historyTruncated?: boolean;
  currentVersions?: Readonly<Record<string, number>>;
  sourceNames?: Readonly<Record<string, string>>;
  onPrompt?: (text: string) => void;
  onReplyMode?: (mode: "hint" | "explain") => void;
  onSaveSnippet?: (message: ChatMessageView, selection?: SelectedExcerpt) => void;
  onCreateCard?: (message: ChatMessageView, selection?: SelectedExcerpt) => void;
  /** 图解 under answers that already state a flow or numeric table (jingwei rules planner). Defaults to the server capability. */
  artifactsEnabled?: boolean;
  /** Markdown + math rendering for assistant answers. Defaults to the server capability. */
  proseEnabled?: boolean;
  disabled?: boolean;
  studyMode?: boolean;
  queryAvailable?: boolean;
  onStarter?: (starter: AssistantStarter) => void;
};
/** Shared by the 出处 chips and inline `[k]` links so both open the same place. */
function citationLink(citation: Citation, sourceNames: Readonly<Record<string, string>>): CitationLink {
  const locators = { page: citation.page, startMs: citation.startMs, slideLabel: citation.slideLabel };
  return {
    href: sourceViewerHref(citation.sourceId, citation.sourceVersion, locators),
    label: citationChipLabel({ ...locators, label: citation.label, sourceName: sourceNames[citation.sourceId] }),
  };
}

export const MessageList = memo(function MessageList({ messages, compact = false, historyTruncated, currentVersions = {}, sourceNames = {}, onPrompt, onReplyMode, onSaveSnippet, onCreateCard, disabled = false, studyMode = false, queryAvailable = false, onStarter, artifactsEnabled: artifactsEnabledProp, proseEnabled: proseEnabledProp }: Props) {
  const { chatArtifacts, chatProse } = useOpeningCapabilities();
  const artifactsEnabled = artifactsEnabledProp ?? chatArtifacts;
  const proseEnabled = proseEnabledProp ?? chatProse;
  const messageElements = useRef<Record<string, HTMLElement | null>>({});
  const scrollArea = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  const completed = useRef(new Set(messages.filter(message => message.role === "assistant" && (!message.status || message.status === "complete")).map(message => message.id)));
  const pendingReplies = useRef(new Set(messages.filter(message => message.role === "assistant" && message.status === "pending").map(message => message.id)));
  const streamedReplies = useRef(new Set(messages.filter(message => message.streamed).map(message => message.id)));
  const [announcement, setAnnouncement] = useState("");
  const lastMessage = messages.at(-1);
  useEffect(() => {
    let latest: ChatMessageView | undefined;
    for (const message of messages) {
      if (message.streamed) streamedReplies.current.add(message.id);
      if (message.role === "assistant" && message.status === "pending") pendingReplies.current.add(message.id);
      if (message.role !== "assistant" || message.status && message.status !== "complete" || completed.current.has(message.id)) continue;
      completed.current.add(message.id);
      latest = message;
    }
    if (latest) setAnnouncement(latest.text);
  }, [messages]);
  function showLatest() {
    const element = scrollArea.current;
    if (element) element.scrollTop = element.scrollHeight;
    following.current = true;
    setUnread(false);
  }
  useEffect(() => {
    if (following.current) showLatest();
    else setUnread(true);
  }, [lastMessage?.id, lastMessage?.text, messages.length]);
  const artifacts = useMemo(() => (artifactsEnabled ? artifactsForMessages(messages) : {}), [artifactsEnabled, messages]);
  function selectedTextFor(message: ChatMessageView): SelectedExcerpt | undefined {
    const selection = window.getSelection();
    const element = messageElements.current[message.id];
    if (!selection || selection.isCollapsed || !element?.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return undefined;
    // Rendered prose loses its Markdown; map the selection back to source blocks instead.
    if (message.role !== "assistant" || !proseEnabled) return { text: selection.toString() };
    const mapped = selectedSourceFor(message.text, element, selection);
    return mapped.kind === "source" ? { text: mapped.text } : { unmapped: true };
  }
  function saveSnippet(message: ChatMessageView) {
    onSaveSnippet?.(message, selectedTextFor(message));
  }
  function createCard(message: ChatMessageView) {
    onCreateCard?.(message, selectedTextFor(message));
  }
  return <div className="relative flex min-h-0 flex-1"><p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-reply-announcement="true">{announcement}</p><div ref={scrollArea} onScroll={event => { const area = event.currentTarget; following.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80; if (following.current) setUnread(false); }} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-bg px-5 py-6 sm:px-7" role="log" aria-live="off" aria-busy={messages.some(message => message.status === "pending")} aria-label="学习对话">
    {historyTruncated ? <p className="mb-5 rounded-lg bg-warn-soft px-3.5 py-2.5 text-xs leading-6 text-warn ring-1 ring-amber-600/20">更早的对话已截断；当前为服务端组装的有界历史。</p> : null}
    {!messages.length ? <div className={`mx-auto flex w-full max-w-lg flex-1 flex-col justify-center motion-safe:animate-enter ${compact ? "py-4" : "py-12"}`}>
      <span className="mb-4 inline-flex self-start" aria-hidden="true"><AiSpark size={compact ? 28 : 36} /></span>
      <h2 className="font-serif text-xl font-medium leading-7 text-text">想弄懂什么？</h2>
      <p className="mt-2 text-sm leading-6 text-text-2">{studyMode ? "围绕当前这一步提问，帮助会关联本次学习。" : "自由交流，或选一份材料一起读。"}</p>
      {onStarter || onPrompt ? <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line">{assistantStarters(studyMode, queryAvailable).map(starter => <button key={starter.label} type="button" disabled={disabled} onClick={() => onStarter ? onStarter(starter) : onPrompt?.(starter.text)} className="group flex min-h-11 w-full items-center justify-between gap-3 bg-surface px-4 text-left text-sm text-text transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"><span>{starter.label}</span><ArrowUpRight size={14} aria-hidden="true" className="text-text-3" /></button>)}</div> : null}
    </div> : <ul className="mx-auto flex w-full max-w-[72ch] flex-col gap-6">{messages.map((message, index) => {
      const saveAvailability = (onSaveSnippet || onCreateCard) ? snippetSaveAvailability(message) : "hidden";
      const lastAssistant = message.role === "assistant" && index === messages.length - 1 && (!message.status || message.status === "complete");
      return <li key={message.id} className={message.role === "user" ? "ml-4 self-end rounded-xl bg-surface-2 px-4 py-3 text-text sm:ml-12" : "w-full min-w-0 motion-safe:animate-enter"}>
      <p className={`mb-2 flex items-center gap-2 text-xs font-medium text-text-2`}>{message.role === "user" ? "你" : <><AiSpark size={20} />学习助理</>}</p>
      {message.status === "outcome_unknown" ? <p className="text-sm leading-7 text-text">这次回答未能确认是否生成成功。</p> : message.role === "assistant" && proseEnabled
        ? <ReplyCard><StreamText busy={message.status === "pending"} reveal={message.status === "complete" && pendingReplies.current.has(message.id) && !message.streamed && !streamedReplies.current.has(message.id)}><div ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className="text-text">{message.text ? <LearningProse text={message.text} citationLinks={(message.citations ?? []).map((citation) => citationLink(citation, sourceNames))} queryEvidenceLinks={message.queryEvidenceLinks} /> : null}</div></StreamText></ReplyCard>
        : <p ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className={`whitespace-pre-wrap break-words leading-7 ${message.role === "user" ? "text-[15px] text-text" : "text-[15px] text-text"}`}>{message.text}</p>}
      {message.role === "assistant" && message.status !== "outcome_unknown" && !proseEnabled && message.queryEvidenceLinks?.some(link => isQueryEvidenceHref(link.href)) ? <nav aria-label="查询证据" className="mt-3 flex flex-wrap gap-2 text-sm">{message.queryEvidenceLinks.filter(link => isQueryEvidenceHref(link.href)).map(link => <a key={link.href} href={link.href} className="text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{link.label}</a>)}</nav> : null}
      {artifacts[message.id] ? <section className="mt-3 rounded-xl border border-line/80 bg-surface px-4 py-3 shadow-xs shadow-zinc-900/5" aria-label="图解" data-message-artifact={message.id}>
        <p className="mb-2.5 text-xs text-text-2">图解 · {artifacts[message.id]!.reason}（由回答内容整理，原文为准）</p>
        <ArtifactView artifact={artifacts[message.id]!.artifact} registry={openingCapabilities} renderers={openingRenderers} />
      </section> : null}
      {(message.citations ?? []).length > 0 ? <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs"><span className="mr-1 text-text-2">出处：</span>{message.citations.map((citation) => {
        const { href: viewerHref, label: chipLabel } = citationLink(citation, sourceNames);
        const downloadHref = sourceDownloadHref(citation.sourceId, citation.sourceVersion, citation.page);
        const title = sourceViewerCopy({
          requestedVersion: citation.sourceVersion,
          currentVersion: currentVersions[citation.sourceId] ?? citation.sourceVersion,
          versionMismatch: (currentVersions[citation.sourceId] ?? citation.sourceVersion) !== citation.sourceVersion,
          page: citation.page,
        });
        return <span key={`${citation.sourceId}-${citation.chunkId}-${citation.sourceVersion}`} className="inline-flex max-w-full items-center gap-1">
          <a className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-text shadow-xs transition-[color,border-color,box-shadow] duration-150 hover:border-line-strong hover:text-text hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none" href={viewerHref} title={title}><BookOpen size={13} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{chipLabel}</span><span className="shrink-0 text-text-3">{`v${citation.sourceVersion}`}</span></a>
          <a className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-transparent px-1.5 text-text-2 transition-colors hover:border-line hover:bg-surface hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={downloadHref} title="下载原件" aria-label={`下载 ${chipLabel}`}><Download size={12} aria-hidden /><span className="sr-only">下载</span></a>
        </span>;
      })}</div> : showsGeneralMaterialBadge(message) ? <p className="mt-3 text-xs text-text-2">一般说明（未引用材料）</p> : null}
      {message.status === "pending" ? <ThinkingText>{message.text ? "正在回答…" : "正在思考…"}</ThinkingText> : null}
      {message.status === "outcome_unknown" ? <p className="mt-2 text-xs text-warn">原请求不会自动重发，费用仍待确认。</p> : null}
      {message.status === "failed" ? <p className="mt-2 text-xs text-danger">本轮失败，未得到有效回答。</p> : null}
      {message.status === "clarify" ? <p role="note" className="mt-2 text-xs text-warn">{CLARIFY_FOLLOW_UP}</p> : null}
      {lastAssistant || saveAvailability !== "hidden" ? <MessageActions text={message.text} onPrompt={lastAssistant && !disabled ? onPrompt : undefined} onReplyMode={lastAssistant && !disabled && !message.systemQuery ? onReplyMode : undefined} onSave={saveAvailability === "available" && onSaveSnippet ? () => saveSnippet(message) : undefined} onCreateCard={saveAvailability === "available" && onCreateCard ? () => createCard(message) : undefined} missingProvenance={saveAvailability === "missing_provenance"} querySaveUnsupported={saveAvailability === "query_not_supported"} /> : null}
    </li>; })}</ul>}
  </div>{unread ? <button type="button" onClick={showLatest} className="absolute bottom-3 left-1/2 z-10 min-h-10 -translate-x-1/2 rounded-full bg-ink px-4 text-xs font-medium text-on-ink shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">查看最新消息</button> : null}</div>;
});
