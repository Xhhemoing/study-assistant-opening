"use client";

import { ArrowUpRight, BookOpen, PanelsTopLeft } from "lucide-react";
import { useRef } from "react";
import { snippetSaveAvailability } from "./save-snippet";
import type { ChatMessageView } from "./message-model";
import { sourceDownloadHref, sourceViewerCopy } from "../inbox/source-viewer";
import { MessageActions } from "./message-actions";

type Props = { messages: ChatMessageView[]; historyTruncated?: boolean; currentVersions?: Readonly<Record<string, number>>; onPrompt?: (text: string) => void; onSaveSnippet?: (message: ChatMessageView, selectedText?: string) => void };
const prompts = [
  { title: "把一个概念讲明白", text: "我想理解一个概念。请先问我已经知道什么，再一步步解释。" },
  { title: "检验自己的理解", text: "我想用自己的话讲一遍，请帮我找出理解中的缺口，先不要直接给答案。" },
  { title: "从一个问题展开", text: "我有一个还没想清楚的问题，请和我一起拆解它，区分事实与假设。" },
];
export function MessageList({ messages, historyTruncated, currentVersions = {}, onPrompt, onSaveSnippet }: Props) {
  const messageElements = useRef<Record<string, HTMLParagraphElement | null>>({});
  function saveSnippet(message: ChatMessageView) {
    const selection = window.getSelection();
    const element = messageElements.current[message.id];
    const selectedText = selection && !selection.isCollapsed && element?.contains(selection.anchorNode) && element.contains(selection.focusNode)
      ? selection.toString() : undefined;
    onSaveSnippet?.(message, selectedText);
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 py-5 sm:px-7" role="log" aria-live="polite" aria-label="学习对话">
    {historyTruncated ? <p className="mb-4 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">更早的对话已截断；当前为服务端组装的有界历史。</p> : null}
    {!messages.length ? <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-8">
      <PanelsTopLeft size={24} className="mb-5 text-zinc-800" aria-hidden />
      <h2 className="text-xl font-semibold tracking-tight text-zinc-900">今天，想弄懂什么？</h2>
      <p className="mt-2 text-sm leading-7 text-zinc-500">还没有消息。自由交流，或选一份材料一起读。</p>
      {onPrompt ? <div className="mt-5 divide-y divide-zinc-200 border-y border-zinc-200">{prompts.map((prompt) => <button key={prompt.title} type="button" onClick={() => onPrompt(prompt.text)} className="group flex min-h-11 w-full items-center justify-between gap-3 px-1 text-left text-xs text-zinc-600 transition-colors duration-150 hover:bg-zinc-50 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none">{prompt.title}<ArrowUpRight size={13} aria-hidden className="text-zinc-500 group-hover:text-zinc-800" /></button>)}</div> : null}
    </div> : <ul className="mx-auto flex w-full max-w-[72ch] flex-col gap-6">{messages.map((message, index) => {
      const saveAvailability = onSaveSnippet ? snippetSaveAvailability(message) : "hidden";
      const lastAssistant = message.role === "assistant" && index === messages.length - 1 && (!message.status || message.status === "complete");
      return <li key={message.id} className={message.role === "user" ? "ml-4 self-end rounded-lg bg-zinc-100 px-4 py-3 text-zinc-800 sm:ml-12" : "w-full min-w-0 text-zinc-800"}>
      <p className="mb-2 flex items-center gap-2 text-[11px] font-medium text-zinc-500">{message.role === "user" ? "你" : <><span className="flex size-5 items-center justify-center rounded bg-zinc-900 text-white"><PanelsTopLeft size={11} aria-hidden /></span>学习助理</>}</p>
      <p ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className="whitespace-pre-wrap break-words text-sm leading-7">{message.text}</p>
      {(message.citations ?? []).length > 0 ? <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]"><span className="mr-1 text-zinc-500">出处：</span>{message.citations.map((citation) => <a key={`${citation.sourceId}-${citation.chunkId}-${citation.sourceVersion}`} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded border border-zinc-200 bg-zinc-50 px-2 text-zinc-600 hover:border-zinc-400 focus-visible:ring-2 focus-visible:ring-emerald-700" href={sourceDownloadHref(citation.sourceId, citation.sourceVersion)} title={sourceViewerCopy({ requestedVersion: citation.sourceVersion, currentVersion: currentVersions[citation.sourceId] ?? citation.sourceVersion, versionMismatch: (currentVersions[citation.sourceId] ?? citation.sourceVersion) !== citation.sourceVersion })}><BookOpen size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{citation.label}</span><span className="shrink-0 text-zinc-500">{`v${citation.sourceVersion}`}</span></a>)}</div> : null}
      {message.status === "pending" ? <p className="mt-2 text-xs text-zinc-500">生成中…</p> : null}
      {message.status === "outcome_unknown" ? <p className="mt-2 text-xs text-amber-800">结果状态未知，请勿重复提交</p> : null}
      {message.status === "failed" ? <p className="mt-2 text-xs text-red-700">本轮失败，未得到有效回答。</p> : null}
      {lastAssistant || saveAvailability !== "hidden" ? <MessageActions text={message.text} onPrompt={lastAssistant ? onPrompt : undefined} onSave={saveAvailability === "available" ? () => saveSnippet(message) : undefined} missingProvenance={saveAvailability === "missing_provenance"} /> : null}
    </li>; })}</ul>}
  </div>;
}
