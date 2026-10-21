"use client";

import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "@aistudy/ui";
import { ArrowLeft } from "lucide-react";
import type { SourceRecord } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { sourcePreviewKind } from "../sources/preview-mime";
import { SourceContent } from "./source-content";
import { sourceReaderInitialPage } from "./source-reader-position";
import { buildSourceDownloadView, SourceViewer } from "./source-viewer";
import { captureReaderReturnPoint, restoreReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";
import { StudyToolsPanel } from "../teaching/study-tools-panel";
import { StudyContextTools } from "../teaching/study-context-tools";
import { studyConversationIdentity } from "../assistant/study-conversation-context";

export function SourceReaderFrame({ title, onClose, onEscapeKeyDown, returnPoint, children }: {
  title: string;
  onClose: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  returnPoint?: ReaderReturnPoint;
  children: ReactNode;
}) {
  const origin = useRef<ReaderReturnPoint | null>(returnPoint ?? null);
  const content = useRef<HTMLDivElement>(null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[60] bg-ink/40" />
    <Dialog.Content ref={content} aria-modal="true" aria-describedby={undefined} data-material-reader="true"
      onEscapeKeyDown={event => {
        const focused = event.target instanceof Element ? event.target.closest<HTMLDialogElement>("dialog[open]") : null;
        // Native tool/save dialogs live inside this reader. Radix receives
        // Escape first; preserve their cancel handlers, including busy guards.
        // Disabling all save controls can blur focus, so retain the innermost
        // open dialog in this reader as the fallback cancellation owner.
        const nested = focused && content.current?.contains(focused) ? focused
          : Array.from(content.current?.querySelectorAll<HTMLDialogElement>("dialog[open]") ?? []).at(-1);
        if (nested) {
          event.preventDefault();
          if (nested.dispatchEvent(new Event("cancel", { cancelable: true }))) nested.close();
        } else onEscapeKeyDown?.(event);
      }}
      onOpenAutoFocus={() => { origin.current ??= captureReaderReturnPoint(document.activeElement instanceof HTMLElement ? document.activeElement : null); }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        // Loading and loaded readers replace one another. An old frame must
        // not pull focus out of the newly opened reader during that handoff.
        if (!document.querySelector("[data-material-reader]") && origin.current) restoreReaderReturnPoint(origin.current);
      }}
      className="fixed inset-0 z-[60] m-0 flex h-dvh max-h-none w-full max-w-none flex-col overflow-hidden overscroll-contain border-0 bg-surface p-0 text-text">
    <header className="flex shrink-0 min-w-0 items-center gap-3 border-b border-line bg-surface px-4 py-2 sm:px-6">
      <button type="button" className={`${ui.secondary} shrink-0`} onClick={onClose}><ArrowLeft size={16} aria-hidden="true" />返回</button>
      <Dialog.Title asChild><h1 className="line-clamp-2 min-w-0 break-words text-base font-semibold [overflow-wrap:anywhere]">{title}</h1></Dialog.Title>
    </header>
    <div className="flex min-h-0 w-full flex-1 flex-col gap-2 px-3 py-2 sm:px-5">{children}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function SourceReader({ record, latestRecord = record, requestedVersion, page, startMs, slideLabel, returnPoint, onClose, onRetry, courseId, questionProtected = false }: {
  record: SourceRecord;
  latestRecord?: SourceRecord;
  requestedVersion: number;
  page?: number;
  startMs?: number;
  slideLabel?: string;
  returnPoint?: ReaderReturnPoint;
  onClose: () => void;
  onRetry?: () => Promise<void>;
  courseId?: string | null;
  questionProtected?: boolean;
}) {
  const [readingPage] = useState(() => sourceReaderInitialPage(record.id, requestedVersion, page));
  const preferExtractedText = sourcePreviewKind(record.mime) == null && latestRecord.parseState === "ready";
  const [tool, setTool] = useState<string | null>(null);
  const [questionPage, setQuestionPage] = useState(readingPage);
  const [initialQuestion, setInitialQuestion] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const latest = requestedVersion === latestRecord.version;
  const context = { courseId: courseId ?? undefined, sourceId: record.id, sourceVersion: requestedVersion,
    page: questionPage, label: latestRecord.name, fragment: excerpt || undefined };
  function explain(selectedPage: number) {
    setQuestionPage(selectedPage); setExcerpt("");
    setInitialQuestion(`请解释这份材料的物理第 ${selectedPage} 页，说明关键关系，并指出需要核对的地方。`);
    setTool("context");
  }
  function selectExcerpt() {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode?.parentElement?.closest("[data-study-reading-text]");
    const focus = selection?.focusNode?.parentElement?.closest("[data-study-reading-text]");
    const text = selection?.toString().trim();
    if (!anchor || anchor !== focus || !body.current?.contains(anchor) || !text) {
      setSelectionNotice("请先在提取正文中选中文字；原件中的选区不会自动传入。"); return;
    }
    if (text.length > 4000) { setSelectionNotice("选中内容较长，请缩小到 4,000 字以内。"); return; }
    const selectedPage = anchor.getAttribute("data-page-kind") === "physical" ? Number(anchor.getAttribute("data-source-page")) : NaN;
    setExcerpt(text); setQuestionPage(Number.isSafeInteger(selectedPage) && selectedPage > 0 ? selectedPage : undefined); setInitialQuestion(""); setSelectionNotice("选中文字已带入提问与笔记，尚未发送。"); setTool("context");
  }
  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true); setError("");
    try { await onRetry(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重新解析未能完成，请重试。"); }
    finally { setRetrying(false); }
  }
  return <SourceReaderFrame title={latestRecord.name} returnPoint={returnPoint} onClose={onClose} onEscapeKeyDown={event => {
    // Radix owns document-capture Escape before the native tool panel can
    // cancel. Close that inner surface first, on both narrow and wide layouts.
    if (tool) { event.preventDefault(); setTool(null); }
  }}>
    {startMs != null || slideLabel ? <p className="text-sm text-warn">引用定位：{slideLabel ? `幻灯片 ${slideLabel}` : ""}{slideLabel && startMs != null ? " · " : ""}{startMs != null ? `${Math.floor(startMs / 60000)}:${String(Math.floor(startMs / 1000) % 60).padStart(2, "0")}` : ""}。此阅读器尚不能同步确认该位置，请在原件中核对。</p> : null}
    <div ref={body} className="flex min-h-0 flex-1 flex-col">
      <StudyToolsPanel fillHeight activePanel={tool} onPanelChange={setTool} panels={[
        { id: "text", label: preferExtractedText ? "原件信息" : "提取文字 / OCR 核对", content: preferExtractedText ? <SourceViewer record={record} latestRecord={latestRecord} requestedVersion={requestedVersion} download={buildSourceDownloadView(record.id, requestedVersion, latestRecord.version, readingPage)} page={readingPage} hideHeading /> : <div className="space-y-3"><SourceContent sourceId={record.id} version={requestedVersion} initialPage={readingPage} onExplain={explain} /><button type="button" className={ui.quiet} onClick={selectExcerpt}>引用选中文字</button></div> },
        { id: "context", label: "提问与笔记", content: <StudyContextTools key={`${studyConversationIdentity(context)}:${initialQuestion}`} context={context} initialQuestion={initialQuestion} questionBlockedReason={questionProtected ? "这是当前练习的参考资料。请返回原题下保存自己的答案，并从原题的提问入口继续，以保留实际获得的帮助记录。" : undefined} /> },
      ]}>
        {preferExtractedText ? <SourceContent sourceId={record.id} version={requestedVersion} initialPage={readingPage} onExplain={explain} /> : <SourceViewer record={record} latestRecord={latestRecord} requestedVersion={requestedVersion}
          download={buildSourceDownloadView(record.id, requestedVersion, latestRecord.version, readingPage)} page={readingPage} hideHeading fillHeight toolsOpen={tool !== null} />}
      </StudyToolsPanel>
      <div className="mt-2 shrink-0 space-y-1">{preferExtractedText ? <button type="button" className={ui.quiet} onClick={selectExcerpt}>引用选中文字</button> : null}{selectionNotice ? <p role="status" className="text-xs leading-6 text-text-2">{selectionNotice}</p> : null}{questionPage ? <p className="text-xs leading-6 text-text-3">提问定位：指定物理第 {questionPage} 页。原件阅读器的当前滚动页不会自动同步。</p> : null}</div>
    </div>
    {latest && latestRecord.parseState === "failed" && latestRecord.error?.retryable !== false && onRetry ? <button type="button" className={ui.secondary} disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重新解析…" : "重新解析"}</button> : null}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </SourceReaderFrame>;
}
