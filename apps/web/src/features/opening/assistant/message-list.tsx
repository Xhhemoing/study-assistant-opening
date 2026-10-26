"use client";

import { ArrowUpRight, BookOpen, Download } from "lucide-react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import type { Citation } from "@aistudy/contracts";
import { TUTOR_CANCELLED_MESSAGE } from "@aistudy/domain";
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
import { SenseWeaveAnswer, SenseWeaveDiagnostics } from "./senseweave-answer";
import { prepareSenseWeave } from "./senseweave-host";
import { observeSenseWeave } from "./senseweave-telemetry";
import { isQueryEvidenceHref } from "./query-evidence-links";
import { selectedSourceFor } from "./selection-source";
import { assistantStarters, type AssistantStarter } from "./assistant-starters";
import { useDiagnosticsEnabled } from "../settings/appearance-preferences";
import type { OpeningApi } from "../client/api";
import { prepareSnippetDraft, type SnippetSaveResult } from "./save-snippet";
import { readSnippetSaveReceipt, saveSnippetWithReceipt, subscribeSnippetSave } from "./snippet-save-receipt";
import { secondaryButtonClass } from "../design/ui";
import { libraryNotePath } from "../../editor/library-paths";

/** LAB-U01: a page refusal (turn status `clarify`) is a follow-up question, not a failure. */
export const CLARIFY_FOLLOW_UP = "追问：要讲哪份材料的哪一页？请在「参考资料」里重新选择材料和页码后再问。";

type Props = {
  messages: ChatMessageView[];
  objectHref?: (href: string) => string;
  compact?: boolean;
  historyTruncated?: boolean;
  currentVersions?: Readonly<Record<string, number>>;
  sourceNames?: Readonly<Record<string, string>>;
  onPrompt?: (text: string) => void;
  onReplyMode?: (mode: "hint" | "explain") => void;
  onSaveSnippet?: (message: ChatMessageView, selection?: SelectedExcerpt) => void;
  directSaveApi?: Pick<OpeningApi, "createSnippet">;
  onCreateCard?: (message: ChatMessageView, selection?: SelectedExcerpt) => void;
  /** 图解 under answers that already state a flow or numeric table (jingwei rules planner). Defaults to the server capability. */
  artifactsEnabled?: boolean;
  /** Markdown + math rendering for assistant answers. Defaults to the server capability. */
  proseEnabled?: boolean;
  disabled?: boolean;
  studyMode?: boolean;
  queryAvailable?: boolean;
  onStarter?: (starter: AssistantStarter) => void;
  /** Saved assistant turn that ended without an answer and may be sent again. */
  retryTurnId?: string | null;
  onRetry?: () => void;
  /** Replaces "正在思考…" while a reply has no text yet (e.g. the slow-wait copy). */
  pendingLabel?: string;
};
/** Shared by the 出处 chips and inline `[k]` links so both open the same place. */
function citationLink(citation: Citation, sourceNames: Readonly<Record<string, string>>): CitationLink {
  const locators = { page: citation.page, startMs: citation.startMs, slideLabel: citation.slideLabel };
  return {
    href: sourceViewerHref(citation.sourceId, citation.sourceVersion, locators),
    label: citationChipLabel({ ...locators, label: citation.label, sourceName: sourceNames[citation.sourceId] }),
  };
}

export const MessageList = memo(function MessageList({ messages, objectHref = href => href, compact = false, historyTruncated, currentVersions = {}, sourceNames = {}, onPrompt, onReplyMode, onSaveSnippet, directSaveApi, onCreateCard, disabled = false, studyMode = false, queryAvailable = false, onStarter, retryTurnId = null, onRetry, pendingLabel, artifactsEnabled: artifactsEnabledProp, proseEnabled: proseEnabledProp }: Props) {
  const { chatArtifacts, chatProse, chatSenseWeave, senseWeaveGates } = useOpeningCapabilities();
  const diagnostics = useDiagnosticsEnabled();
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
  const senseWeaveMode = proseEnabled ? chatSenseWeave : "off";
  /** Decided once per finished answer (the adapter caches by id and text). */
  const senseWeave = useMemo(() => {
    const prepared: Record<string, ReturnType<typeof prepareSenseWeave>> = {};
    if (senseWeaveMode === "off") return prepared;
    let question: string | undefined;
    for (const message of messages) {
      if (message.role === "user") { question = message.text; continue; }
      if (message.status && message.status !== "complete" || !message.text) continue;
      prepared[message.id] = prepareSenseWeave(message, question, senseWeaveGates, studyMode);
    }
    return prepared;
  }, [senseWeaveMode, messages, senseWeaveGates, studyMode]);
  useEffect(() => {
    if (senseWeaveMode === "off") return;
    for (const message of messages) {
      const prepared = senseWeave[message.id];
      if (prepared) observeSenseWeave(prepared, message.text.length, senseWeaveGates.version, senseWeaveMode === "on", message.id);
    }
  }, [messages, senseWeave, senseWeaveMode, senseWeaveGates]);
  const artifacts = useMemo(() => {
    if (!artifactsEnabled) return {};
    const planned = artifactsForMessages(messages);
    // The same content is shown once: a SenseWeave component replaces the rules-planner 图解.
    if (senseWeaveMode === "on") for (const id of Object.keys(planned)) if (senseWeave[id]?.enhanced) delete planned[id];
    return planned;
  }, [artifactsEnabled, messages, senseWeaveMode, senseWeave]);
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
    {historyTruncated ? <p className="mb-5 rounded-lg bg-warn-soft px-3.5 py-2.5 text-xs leading-6 text-warn ring-1 ring-warn/20">更早的对话已折叠，这里只显示最近的部分。</p> : null}
    {!messages.length ? <div className={`mx-auto flex w-full max-w-lg flex-1 flex-col justify-center motion-safe:animate-enter ${compact ? "py-4" : "py-12"}`}>
      <span className="mb-4 inline-flex self-start" aria-hidden="true"><AiSpark size={compact ? 28 : 36} /></span>
      <h2 className="font-serif text-xl font-medium leading-7 text-text">想弄懂什么？</h2>
      <p className="mt-2 text-sm leading-6 text-text">{studyMode ? "围绕当前这一步提问，帮助会关联本次学习。" : "自由交流，或选一份材料一起读。"}</p>
      {onStarter || onPrompt ? <div className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line">{assistantStarters(studyMode, queryAvailable).map(starter => <button key={starter.label} type="button" disabled={disabled} onClick={() => onStarter ? onStarter(starter) : onPrompt?.(starter.text)} className="group flex min-h-11 w-full items-center justify-between gap-3 bg-surface px-4 text-left text-sm text-text transition-colors duration-150 hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent motion-reduce:transition-none"><span>{starter.label}</span><ArrowUpRight size={14} aria-hidden="true" className="text-text-3" /></button>)}</div> : null}
    </div> : <ul className="mx-auto flex w-full max-w-[72ch] flex-col gap-6">{messages.map((message, index) => {
      const stopped = message.status === "failed" && message.text === TUTOR_CANCELLED_MESSAGE;
      const saveAvailability = (onSaveSnippet || directSaveApi || onCreateCard) ? snippetSaveAvailability(message) : "hidden";
      const lastAssistant = message.role === "assistant" && index === messages.length - 1 && (!message.status || message.status === "complete");
      return <li key={message.id} className={message.role === "user" ? "ml-4 self-end rounded-xl bg-surface-2 px-4 py-3 text-text sm:ml-12" : "w-full min-w-0 motion-safe:animate-enter"}>
      <p className={`mb-2 flex items-center gap-2 text-xs font-medium text-text-2`}>{message.role === "user" ? "你" : <><AiSpark size={20} />学习助理</>}</p>
      {message.role === "assistant" && message.querySteps?.length ? <details className="mb-2 text-xs text-text-2" data-query-steps>
        <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-pill px-2 hover:bg-text/5 [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />先查了 {message.querySteps.map(step => step.label).join("、")}
        </summary>
        <ol aria-label="助理查询步骤" className="mt-1 space-y-0.5 border-l border-line pl-3">
          {message.querySteps.map((step, stepIndex) => <li key={`${step.name}-${stepIndex}`} className="flex items-center gap-2"><span className={step.ok ? "text-text" : "text-warn"}>{step.label}</span><span className="text-text-3">· {step.outcome}</span></li>)}
        </ol>
      </details> : null}
      {message.role === "assistant" && message.status === "failed" ? null : message.status === "outcome_unknown" ? <p className="text-sm leading-7 text-text">这次回答未能确认是否生成成功。</p> : message.role === "assistant" && proseEnabled
        ? <ReplyCard><StreamText busy={message.status === "pending"} reveal={message.status === "complete" && pendingReplies.current.has(message.id) && !message.streamed && !streamedReplies.current.has(message.id)}><div ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className="text-text">{message.text ? (senseWeaveMode === "on" && senseWeave[message.id]?.enhanced ? <SenseWeaveAnswer prepared={senseWeave[message.id]!} objectHref={objectHref} text={message.text} citationLinks={(message.citations ?? []).map(citation => { const link = citationLink(citation, sourceNames); return { ...link, href: objectHref(link.href) }; })} queryEvidenceLinks={message.queryEvidenceLinks} /> : <LearningProse objectHref={objectHref} text={message.text} citationLinks={(message.citations ?? []).map(citation => { const link = citationLink(citation, sourceNames); return { ...link, href: objectHref(link.href) }; })} queryEvidenceLinks={message.queryEvidenceLinks} />) : null}{diagnostics && senseWeave[message.id] && senseWeaveMode !== "off" ? <SenseWeaveDiagnostics mode={senseWeaveMode} prepared={senseWeave[message.id]!} /> : null}</div></StreamText></ReplyCard>
        : <p ref={(element) => { if (element) messageElements.current[message.id] = element; else delete messageElements.current[message.id]; }} className={`whitespace-pre-wrap break-words leading-7 ${message.role === "user" ? "text-[15px] text-text" : "text-[15px] text-text"}`}>{message.text}</p>}
      {message.role === "assistant" && message.status !== "outcome_unknown" && !proseEnabled && message.queryEvidenceLinks?.some(link => isQueryEvidenceHref(link.href)) ? <nav aria-label="查询证据" className="mt-3 flex flex-wrap gap-2 text-sm">{message.queryEvidenceLinks.filter(link => isQueryEvidenceHref(link.href)).map(link => <Link key={link.href} href={objectHref(link.href)} className="text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{link.label}</Link>)}</nav> : null}
      {artifacts[message.id] ? <section className="mt-3 rounded-xl border border-line/80 bg-surface px-4 py-3 shadow-xs " aria-label="图解" data-message-artifact={message.id}>
        <p className="mb-2.5 text-xs text-text-2">图解 · {artifacts[message.id]!.reason}（由回答内容整理，原文为准）</p>
        <ArtifactView artifact={artifacts[message.id]!.artifact} registry={openingCapabilities} renderers={openingRenderers} />
      </section> : null}
      {(message.citations ?? []).length > 0 ? <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs"><span className="mr-1 text-text-2">出处：</span>{message.citations.map((citation) => {
        const { href: viewerHref, label: chipLabel } = citationLink(citation, sourceNames);
        const downloadHref = sourceDownloadHref(citation.sourceId, citation.sourceVersion, citation.page);
        const currentVersion = currentVersions[citation.sourceId] ?? citation.sourceVersion;
        const versionMismatch = currentVersion !== citation.sourceVersion;
        const title = sourceViewerCopy({
          requestedVersion: citation.sourceVersion,
          currentVersion,
          versionMismatch,
          page: citation.page,
        });
        return <span key={`${citation.sourceId}-${citation.chunkId}-${citation.sourceVersion}`} className="inline-flex max-w-full items-center gap-1">
          <a className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-text shadow-xs transition-[color,border-color,box-shadow] duration-150 hover:border-line-strong hover:text-text hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none" href={objectHref(viewerHref)} title={title}><BookOpen size={13} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{chipLabel}</span>{versionMismatch ? <span className="shrink-0 text-warn">当前材料已更新</span> : null}{diagnostics ? <span className="shrink-0 text-text-3">{`v${citation.sourceVersion}`}</span> : null}</a>
          <a className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-transparent px-1.5 text-text-2 transition-colors hover:border-line hover:bg-surface hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={downloadHref} title="下载原件" aria-label={`下载 ${chipLabel}`}><Download size={12} aria-hidden /><span className="sr-only">下载</span></a>
        </span>;
      })}</div> : showsGeneralMaterialBadge(message) ? <p className="mt-3 text-xs text-text-2">一般说明（未引用材料）</p> : null}
      {message.status === "pending" ? <ThinkingText>{message.text ? "正在回答…" : pendingLabel ?? "正在思考…"}</ThinkingText> : null}
      {message.status === "outcome_unknown" ? <p className="mt-2 text-xs text-warn">不会自动再问一次，这次的用量还在确认。</p> : null}
      {message.status === "failed" ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><p className={stopped ? "text-text-2" : "text-danger"}>{stopped ? "已停止。" : "这次没有得到回答。"}</p>{onRetry && retryTurnId === message.id ? <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={onRetry}>{stopped ? "重新回答" : "重试"}</button> : null}</div> : null}
      {message.status === "clarify" ? <p role="note" className="mt-2 text-xs text-warn">{CLARIFY_FOLLOW_UP}</p> : null}
      {lastAssistant || saveAvailability !== "hidden" ? <MessageActions text={message.text} onPrompt={lastAssistant && !disabled ? onPrompt : undefined} onReplyMode={lastAssistant && !disabled && !message.systemQuery ? onReplyMode : undefined} onSave={!directSaveApi && saveAvailability === "available" && onSaveSnippet ? () => saveSnippet(message) : undefined} onCreateCard={saveAvailability === "available" && onCreateCard ? () => createCard(message) : undefined} missingProvenance={saveAvailability === "missing_provenance"} querySaveUnsupported={saveAvailability === "query_not_supported"} /> : null}
      {directSaveApi && saveAvailability === "available" ? <DirectSnippetSave message={message} api={directSaveApi} objectHref={objectHref} selection={() => selectedTextFor(message)} /> : null}
    </li>; })}</ul>}
  </div>{unread ? <button type="button" onClick={showLatest} className="absolute bottom-3 left-1/2 z-10 min-h-10 -translate-x-1/2 rounded-full bg-ink px-4 text-xs font-medium text-on-ink shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2">查看最新消息</button> : null}</div>;
});

/** A contextual answer is saved by this explicit action; no second confirmation or automatic retry. */
function DirectSnippetSave({ message, api, objectHref, selection }: { message: ChatMessageView; api: Pick<OpeningApi, "createSnippet">; objectHref: (href: string) => string; selection: () => SelectedExcerpt | undefined }) {
  const identity = `direct:${message.origin}:${message.savedTurnId ?? message.provenanceId}:${message.id}`;
  const [status, setStatus] = useState<"idle" | "pending" | "unknown" | "saved" | "unavailable">("idle");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const update = () => {
      try {
        const receipt = readSnippetSaveReceipt(identity);
        setStatus(receipt?.status ?? "idle");
        setDocumentId(receipt?.status === "saved" ? receipt.documentId : null);
      } catch { setStatus("unavailable"); }
    };
    const unsubscribe = subscribeSnippetSave(identity, update); update(); return unsubscribe;
  }, [identity]);
  async function save() {
    if (status !== "idle") return;
    const draft = prepareSnippetDraft(message, selection());
    if (!draft) return;
    setStatus("pending"); setNotice(draft.notice ?? "");
    try {
      const result: SnippetSaveResult = await saveSnippetWithReceipt(identity, draft.input, input => api.createSnippet(input));
      if (result.kind === "failed") { setStatus("idle"); setNotice(`保存未完成：${result.message}`); }
      else { setStatus(result.kind); if (result.kind === "saved") setDocumentId(result.documentId); }
    } catch { setStatus("unavailable"); }
  }
  return <div className="mt-2 space-y-2 text-xs leading-6">
    <button type="button" className={secondaryButtonClass} disabled={status !== "idle"} onPointerDown={event => event.preventDefault()} onClick={() => void save()}>{status === "pending" ? "正在保存笔记…" : status === "saved" ? "已存为笔记" : "存为笔记"}</button>
    {notice ? <p role="status" className="text-text-2">{notice}</p> : null}
    {status === "unknown" ? <p role="alert" className="text-warn">还不确定是否已经存好，可能已经保存。请先看一下笔记列表，这里不会再存第二份。</p> : null}
    {status === "unavailable" ? <p role="alert" className="text-warn">暂时无法确认是否已保存，先不重复保存。请到笔记列表看一下。</p> : null}
    {status === "saved" && documentId ? <Link href={objectHref(libraryNotePath("/opening/library", documentId))} className={secondaryButtonClass}>打开笔记</Link> : status === "unknown" || status === "unavailable" ? <Link href={objectHref("/opening/library?tab=notes")} className={secondaryButtonClass}>检查笔记列表</Link> : null}
  </div>;
}
