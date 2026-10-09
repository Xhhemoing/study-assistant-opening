"use client";

import { ArrowUpRight, BookOpen, PanelsTopLeft } from "lucide-react";
import { useRef } from "react";
import { snippetSaveAvailability } from "./save-snippet";
import type { ChatMessageView } from "./message-model";
import { sourceDownloadHref, sourceViewerCopy } from "../inbox/source-viewer";
import { MessageActions } from "./message-actions";

type Props = { messages: ChatMessageView[]; historyTruncated?: boolean; currentVersions?: Readonly<Record<string, number>>; onPrompt?: (text: string) => void; onSaveSnippet?: (message: ChatMessageView, selectedText?: string) => void; onCreateCard?: (message: ChatMessageView, selectedText?: string) => void };
const prompts = [
  { title: "把一个概念讲明白", text: "我想理解一个概念。请先问我已经知道什么，再一步步解释。" },
  { title: "检验自己的理解", text: "我想用自己的话讲一遍，请帮我找出理解中的缺口，先不要直接给答案。" },
  { title: "从一个问题展开", text: "我有一个还没想清楚的问题，请和我一起拆解它，区分事实与假设。" },
];
export function MessageList({ messages, historyTruncated, currentVersions = {}, onPrompt, onSaveSnippet, onCreateCard }: Props) {
  const messageElements = useRef<Record<string, HTMLParagraphElement | null>>({});
  function selectedTextFor(message: ChatMessageView) {
    const selection = window.getSelection();
    const element = messageElements.current[message.id];
    return selection && !selection.isCollapsed && element?.contains(selection.anchorNode) && element.contains(selection.focusNode)
      ? selection.toString() : undefined;
  }
  function saveSnippet(message: ChatMessageView) {
    onSaveSnippet?.(message, selectedTextFor(message));
  }
  function createCard(message: ChatMessageView) {
    onCreateCard?.(message, selectedTextFor(message));
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-gradient-to-b from-zinc-50/30 to-white px-5 py-6 sm:px-7" role="log" aria-live="polite" aria-label="学习对话">
    {historyTruncated ? <p className="mb-5 rounded-lg bg-amber-50 px-3.5 py-2.5 text-xs leading-6 text-amber-900 ring-1 ring-amber-600/20">更早的对话已截断；当前为服务端组装的有界历史。</p> : null}
    {!messages.length ? <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-12 motion-safe:animate-enter">
      <span className="mb-5 inline-flex size-14 items-center justify-center self-start rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 text-white shadow-lg shadow-zinc-900/20 ring-1 ring-white/10" aria-hidden="true"><PanelsTopLeft size={24} strokeWidth={1.75} /></span>
      <h2 className="text-xl font-semibold tracking-tight text-zinc-950">今天，想弄懂什么？</h2>
      <p className="mt-2 text-[15px] leading-7 text-zinc-500">还没有消息。自由交流，或选一份材料一起读。</p>
      {onPrompt ? <div className="mt-6 divide-y divide-zinc-200/80 overflow-hidden rounded-xl border border-zinc-200/80 shadow-xs shadow-zinc-900/5">{prompts.map((prompt) => <button key={prompt.title} type="button" onClick={() => onPrompt(prompt.text)} className="group flex min-h-12 w-full items-center justify-between gap-3 bg-white px-4 text-left text-sm text-zinc-700 transition-[color,background-color] duration-150 hover:bg-zinc-50 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600/50 motion-reduce:transition-none"><span className="font-medium">{prompt.title}</span><ArrowUpRight size={14} aria-hidden className="text-zinc-400 transition-colors group-hover:text-zinc-600" /></button>)}</div> : null}
    </div> : <ul className="mx-auto flex w-full max-w-[72ch] flex-col gap-6">{messages.map((message, index) => {
      const saveAvailability = (onSaveSnippet || onCreateCard) ? snippetSaveAvailability(message) : "hidden";
      const lastAssistant = message.role === "assistant" && index === messages.length - 1 && (!message.status || message.status === "complete");
      return <li key={message.id} className={message.role === "user" ? "ml-4 self-end rounded-xl bg-zinc-900 px-4 py-3 text-white shadow-sm shadow-zinc-900/10 sm:ml-12" : "w-full min-w-0 motion-safe:animate-enter"}>
      <p className="mb-2 flex items-center gap-2 text-xs font-medium text-zinc-500">{message.role === "user" ? "你" : <><span className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-900 to-zinc-800 text-white shadow-sm"><PanelsTopLeft size={12} aria-hidden /></span>学习助理</>}</p>
      <p ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className={`whitespace-pre-wrap break-words leading-7 ${message.role === "user" ? "text-[15px] text-white/95" : "text-[15px] text-zinc-800"}`}>{message.text}</p>
      {(message.citations ?? []).length > 0 ? <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs"><span className="mr-1 text-zinc-500">出处：</span>{message.citations.map((citation) => <a key={`${citation.sourceId}-${citation.chunkId}-${citation.sourceVersion}`} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-zinc-700 shadow-xs transition-[color,border-color,box-shadow] duration-150 hover:border-zinc-300 hover:text-zinc-900 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 motion-reduce:transition-none" href={sourceDownloadHref(citation.sourceId, citation.sourceVersion)} title={sourceViewerCopy({ requestedVersion: citation.sourceVersion, currentVersion: currentVersions[citation.sourceId] ?? citation.sourceVersion, versionMismatch: (currentVersions[citation.sourceId] ?? citation.sourceVersion) !== citation.sourceVersion })}><BookOpen size={13} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{citation.label}</span><span className="shrink-0 text-zinc-400">{`v${citation.sourceVersion}`}</span></a>)}</div> : null}
      {message.status === "pending" ? <p className="mt-2 text-xs text-zinc-500">生成中…</p> : null}
      {message.status === "outcome_unknown" ? <p className="mt-2 text-xs text-amber-800">结果状态未知，请勿重复提交</p> : null}
      {message.status === "failed" ? <p className="mt-2 text-xs text-red-700">本轮失败，未得到有效回答。</p> : null}
      {lastAssistant || saveAvailability !== "hidden" ? <MessageActions text={message.text} onPrompt={lastAssistant ? onPrompt : undefined} onSave={saveAvailability === "available" && onSaveSnippet ? () => saveSnippet(message) : undefined} onCreateCard={saveAvailability === "available" && onCreateCard ? () => createCard(message) : undefined} missingProvenance={saveAvailability === "missing_provenance"} /> : null}
    </li>; })}</ul>}
  </div>;
}
