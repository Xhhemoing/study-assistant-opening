"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@aistudy/ui";
import { ArrowLeft } from "lucide-react";
import type { SourceRecord } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { sourcePreviewKind } from "../sources/preview-mime";
import { SourceContent } from "./source-content";
import { sourceReaderInitialPage } from "./source-reader-position";
import {
  createMediaAnchorPlaybackController,
  formatMediaAnchorRange,
  mediaKindFromMime,
  validateMediaAnchorRange,
  type MediaAnchorPlaybackSnapshot,
} from "./source-reader-media-anchor";
import { buildSourceDownloadView, sourcePreviewHref, SourceViewer } from "./source-viewer";
import { captureReaderReturnPoint, restoreReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";
import { selectedReaderExcerpt, type ReaderSelection } from "./source-reader-selection";
import { StudyToolsPanel } from "../teaching/study-tools-panel";
import { StudyContextTools } from "../teaching/study-context-tools";
import { OriginalConversationSlot } from "../assistant/conversation-companion";
import { studyConversationIdentity } from "../assistant/study-conversation-context";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { AssetLearningLinks } from "../learning-links/asset-learning-links";

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

function SourceReaderContent({ record, latestRecord = record, requestedVersion, page, startMs, endMs, keyframeChunkId, slideLabel, returnPoint, onClose, onRetry, courseId, originalConversationId, questionProtected = false }: {
  record: SourceRecord;
  latestRecord?: SourceRecord;
  requestedVersion: number;
  page?: number;
  startMs?: number;
  endMs?: number;
  keyframeChunkId?: string;
  slideLabel?: string;
  returnPoint?: ReaderReturnPoint;
  onClose: () => void;
  onRetry?: () => Promise<void>;
  courseId?: string | null;
  originalConversationId?: string;
  questionProtected?: boolean;
}) {
  const [readingPage] = useState(() => sourceReaderInitialPage(record.id, requestedVersion, page));
  const mediaKind = mediaKindFromMime(record.mime ?? latestRecord.mime);
  const mediaAnchor = useMemo(
    () => validateMediaAnchorRange({ startMs, endMs, keyframeChunkId }),
    [startMs, endMs, keyframeChunkId],
  );
  const hasInvalidMediaRange = mediaKind !== null && (startMs != null || endMs != null) && mediaAnchor == null;
  const mediaSrc = mediaKind !== null ? sourcePreviewHref(record.id, requestedVersion) : null;
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [mediaPlayback, setMediaPlayback] = useState<MediaAnchorPlaybackSnapshot>(() => ({
    anchor: mediaAnchor,
    phase: mediaAnchor ? "pending_metadata" : "idle",
    boundActive: mediaAnchor?.bounded ?? false,
    autoPausedAtEnd: false,
    userReleasedBound: false,
    rangeHighlightActive: mediaAnchor !== null,
  }));
  const mediaController = useMemo(
    () => createMediaAnchorPlaybackController(mediaAnchor, setMediaPlayback),
    [mediaAnchor],
  );
  useEffect(() => {
    setMediaPlayback(mediaController.snapshot());
    if (mediaKind !== null && mediaAnchor) {
      mediaController.activate(mediaRef.current);
    }
  }, [mediaAnchor, mediaController, mediaKind, mediaSrc]);
  const preferExtractedText = sourcePreviewKind(record.mime) == null && latestRecord.parseState === "ready";
  const [tool, setTool] = useState<string | null>(originalConversationId ? "conversation" : null);
  const [questionPage, setQuestionPage] = useState(readingPage);
  const [initialQuestion, setInitialQuestion] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const selectionAnchor = useRef<Element | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const latest = requestedVersion === latestRecord.version;
  const partialWarning = latest && latestRecord.parseState === "ready" && latestRecord.error?.code === "PARSE_PARTIAL"
    ? latestRecord.error.message
    : "";
  const canRetryParse = latest && Boolean(onRetry) && (
    (latestRecord.parseState === "failed" && latestRecord.error?.retryable !== false)
    || (latestRecord.parseState === "ready" && latestRecord.error?.code === "PARSE_PARTIAL" && latestRecord.error.retryable === true)
  );
  const context = { courseId: courseId ?? undefined, sourceId: record.id, sourceVersion: requestedVersion,
    page: questionPage, label: latestRecord.name, fragment: excerpt || undefined };
  function explain(selectedPage: number) {
    setQuestionPage(selectedPage); setExcerpt("");
    setInitialQuestion(`请解释这份材料的物理第 ${selectedPage} 页，说明关键关系，并指出需要核对的地方。`);
    setTool("context");
  }
  useEffect(() => {
    const update = () => {
      if (!body.current) return;
      const next = selectedReaderExcerpt(body.current, record.id, requestedVersion, window.getSelection());
      selectionAnchor.current?.classList.remove("[anchor-name:--reader-selection]");
      const node = window.getSelection()?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      selectionAnchor.current = next ? element ?? null : null;
      selectionAnchor.current?.classList.add("[anchor-name:--reader-selection]");
      setSelection(next);
    };
    setSelection(null); setExcerpt(""); setSelectionNotice("");
    document.addEventListener("selectionchange", update);
    return () => { document.removeEventListener("selectionchange", update); selectionAnchor.current?.classList.remove("[anchor-name:--reader-selection]"); };
  }, [record.id, requestedVersion]);
  function selectExcerpt() {
    const selected = selection;
    if (!selected || selected.sourceId !== record.id || selected.version !== requestedVersion) {
      setSelectionNotice("选区已失效，请在当前材料中重新选择文字。"); return;
    }
    if (selected.text.length > 4000) { setSelectionNotice("选中内容较长，请缩小到 4,000 字以内。"); return; }
    // Retain the captured source revision and physical page even when opening
    // the companion changes focus and clears the browser's native selection.
    setExcerpt(selected.text); setQuestionPage(selected.page); setInitialQuestion("");
    setSelectionNotice(`已带入选中文字 · v${selected.version}${selected.page ? ` · 第 ${selected.page} 页` : ""}，尚未发送。`);
    setTool("context");
  }
  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true); setError("");
    try { await onRetry(); }
    catch (reason) { setError(userFacingMessage(reason, "重新解析未能完成，请重试。")); }
    finally { setRetrying(false); }
  }
  return <SourceReaderFrame title={latestRecord.name} returnPoint={returnPoint} onClose={onClose} onEscapeKeyDown={event => {
    // Radix owns document-capture Escape before the native tool panel can
    // cancel. Close that inner surface first, on both narrow and wide layouts.
    if (tool) { event.preventDefault(); setTool(null); }
  }}>
    {mediaKind !== null && mediaSrc ? (
      <section
        className="shrink-0 space-y-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 shadow-card"
        aria-label="媒体播放"
        data-media-anchor-player="true"
        data-media-anchor-start-ms={mediaAnchor ? String(mediaAnchor.startMs) : undefined}
        data-media-anchor-end-ms={mediaAnchor ? String(mediaAnchor.endMs) : undefined}
        data-media-anchor-keyframe-id={mediaAnchor?.keyframeChunkId}
        data-media-anchor-phase={mediaPlayback.phase}
        data-media-anchor-highlight={mediaAnchor ? (mediaPlayback.rangeHighlightActive ? "active" : "inactive") : undefined}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-2">
          <div className="flex flex-wrap items-center gap-2">
            {mediaAnchor ? (
              <span className={`inline-flex items-center rounded-pill px-2.5 py-1 text-xs font-medium tabular-nums ${mediaPlayback.rangeHighlightActive ? "bg-accent-soft text-accent ring-1 ring-accent/30" : "bg-line/40 text-text-2"}`}>
                引用片段：{formatMediaAnchorRange(mediaAnchor)}
              </span>
            ) : null}
            {mediaAnchor ? (
              <p role="status" className="text-xs text-text-3">
                {mediaPlayback.phase === "paused_at_end"
                  ? "已播放到引用片段末尾；点击继续播放可查看后续内容。"
                  : mediaPlayback.phase === "continued_past_end"
                    ? "已继续播放后续内容。"
                    : mediaAnchor.bounded
                      ? "已定位到引用片段，播放至末尾会自动暂停。"
                      : "已定位到引用时间点。"}
              </p>
            ) : hasInvalidMediaRange ? (
              <p role="status" className="text-xs text-warn">引用时间范围无效，请从头查看原件。</p>
            ) : null}
          </div>
          {mediaAnchor ? (
            <button
              type="button"
              className={ui.secondary}
              onClick={() => mediaController.replay(mediaRef.current)}
            >
              {mediaAnchor.bounded ? "重播片段" : "跳到起点"}
            </button>
          ) : null}
        </div>
        {mediaKind === "video" ? (
          <video
            ref={node => { mediaRef.current = node; }}
            controls
            preload="metadata"
            src={mediaSrc}
            aria-label={`${latestRecord.name} 媒体播放`}
            className="max-h-72 w-full rounded-lg bg-ink"
            onLoadedMetadata={event => mediaController.handleLoadedMetadata(event.currentTarget)}
            onTimeUpdate={event => mediaController.handleTimeUpdate(event.currentTarget)}
            onPlay={event => mediaController.handlePlay(event.currentTarget)}
            onSeeked={event => mediaController.handleSeeked(event.currentTarget)}
          />
        ) : (
          <audio
            ref={node => { mediaRef.current = node; }}
            controls
            preload="metadata"
            src={mediaSrc}
            aria-label={`${latestRecord.name} 媒体播放`}
            className="w-full"
            onLoadedMetadata={event => mediaController.handleLoadedMetadata(event.currentTarget)}
            onTimeUpdate={event => mediaController.handleTimeUpdate(event.currentTarget)}
            onPlay={event => mediaController.handlePlay(event.currentTarget)}
            onSeeked={event => mediaController.handleSeeked(event.currentTarget)}
          />
        )}
      </section>
    ) : null}
    {mediaKind === null && (startMs != null || slideLabel) ? <p className="text-sm text-warn">引用定位：{slideLabel ? `幻灯片 ${slideLabel}` : ""}{slideLabel && startMs != null ? " · " : ""}{startMs != null ? `${Math.floor(startMs / 60000)}:${String(Math.floor(startMs / 1000) % 60).padStart(2, "0")}` : ""}。此阅读器尚不能同步确认该位置，请在原件中核对。</p> : null}
    {mediaKind !== null && slideLabel ? <p className="text-sm text-warn">引用定位：幻灯片 {slideLabel}。此阅读器尚不能同步确认该位置，请在原件中核对。</p> : null}
    <div ref={body} className="flex min-h-0 flex-1 flex-col">
      <StudyToolsPanel fillHeight preferContentOnNarrowEntry={Boolean(originalConversationId)} activePanel={tool} onPanelChange={setTool} panels={[
        { id: "text", label: preferExtractedText ? "原件信息" : "提取文字 / OCR 核对", content: preferExtractedText ? <SourceViewer record={record} latestRecord={latestRecord} requestedVersion={requestedVersion} download={buildSourceDownloadView(record.id, requestedVersion, latestRecord.version, readingPage)} page={readingPage} hideHeading /> : <div className="space-y-3"><SourceContent sourceId={record.id} version={requestedVersion} initialPage={readingPage} onExplain={explain} /></div> },
        ...(originalConversationId ? [{ id: "conversation", label: "原对话", content: <OriginalConversationSlot conversationId={originalConversationId} className="min-h-0 min-w-0 flex-1" /> }] : []),
        { id: "context", label: originalConversationId ? "本材料提问与笔记" : "提问与笔记", content: <StudyContextTools key={`${studyConversationIdentity(context)}:${initialQuestion}`} context={context} initialQuestion={initialQuestion} questionBlockedReason={questionProtected ? "这是当前练习的参考资料。请返回原题下保存自己的答案，并从原题的提问入口继续，以保留实际获得的帮助记录。" : undefined} /> },
        { id: "learning-links", label: "学习关联", content: <AssetLearningLinks assetType="source" assetId={record.id} assetVersion={requestedVersion} origin={{ purpose: "material_read", sourceId: record.id, sourceVersion: requestedVersion, page: questionPage ?? null, ...(courseId ? { courseId } : {}) }} /> },
      ]}>
        {preferExtractedText ? <SourceContent sourceId={record.id} version={requestedVersion} initialPage={readingPage} onExplain={explain} /> : <SourceViewer record={record} latestRecord={latestRecord} requestedVersion={requestedVersion}
          download={buildSourceDownloadView(record.id, requestedVersion, latestRecord.version, readingPage)} page={readingPage} hideHeading fillHeight toolsOpen={tool !== null} onExplain={explain} />}
      </StudyToolsPanel>
      {selection ? <div className="glass sticky bottom-2 z-[70] flex shrink-0 flex-wrap items-center gap-2.5 rounded-xl border border-line px-3 py-2 text-xs text-text-2 shadow-float [@media(pointer:fine)]:[@supports(anchor-name:--reader-selection)]:fixed [@media(pointer:fine)]:[@supports(anchor-name:--reader-selection)]:[position-anchor:--reader-selection] [@media(pointer:fine)]:[@supports(anchor-name:--reader-selection)]:[position-area:block-end] [@media(pointer:fine)]:[@supports(anchor-name:--reader-selection)]:[position-try-fallbacks:flip-block,flip-inline] [@media(pointer:fine)]:[@supports(anchor-name:--reader-selection)]:bottom-auto" data-reader-selection-actions="true">
        <button type="button" className={ui.secondary} onPointerDown={event => event.preventDefault()} onClick={selectExcerpt}>问选中内容</button>
        <span className="tabular-nums">v{selection.version}{selection.page ? ` · 第 ${selection.page} 页` : ""} · {selection.text.length} 字</span>
      </div> : null}
      <div className="mt-2 shrink-0 space-y-1">{selectionNotice ? <p role="status" className="text-xs leading-6 tabular-nums text-text-2">{selectionNotice}</p> : null}{questionPage ? <p className="text-xs leading-6 tabular-nums text-text-3">提问定位：物理第 {questionPage} 页 · v{requestedVersion}。</p> : null}</div>
    </div>
    {partialWarning ? <p role="status" className="text-xs text-warn">{partialWarning}</p> : null}
    {canRetryParse ? <button type="button" className={ui.secondary} disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重新解析…" : "重新解析"}</button> : null}
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
  </SourceReaderFrame>;
}

/** A different material, revision, or explicit locator starts a new reader binding. */
export function SourceReader(props: Parameters<typeof SourceReaderContent>[0]) {
  return <SourceReaderContent key={`${props.record.id}:${props.requestedVersion}:${props.page ?? ""}:${props.originalConversationId ?? ""}`} {...props} />;
}
