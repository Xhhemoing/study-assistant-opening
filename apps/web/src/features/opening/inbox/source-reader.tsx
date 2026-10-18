"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { SourceRecord } from "@aistudy/contracts";
import { ui } from "../design/ui";
import { sourcePreviewKind } from "../sources/preview-mime";
import { SourceContent } from "./source-content";
import { sourceReaderInitialPage } from "./source-reader-position";
import { buildSourceDownloadView, SourceViewer } from "./source-viewer";
import { captureReaderReturnPoint, restoreReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";

export function SourceReaderFrame({ title, onClose, returnPoint, children }: {
  title: string;
  onClose: () => void;
  returnPoint?: ReaderReturnPoint;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const point = returnPoint ?? captureReaderReturnPoint(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    element.showModal();
    return () => {
      element.close();
      restoreReaderReturnPoint(point);
    };
  }, [returnPoint]);
  return <dialog ref={dialog} aria-labelledby={headingId} data-material-reader="true"
    onCancel={event => { event.preventDefault(); onClose(); }}
    className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto overscroll-contain border-0 bg-white p-0 text-zinc-900 backdrop:bg-zinc-950/40">
    <header className="sticky top-0 z-10 flex min-w-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
      <button type="button" className={`${ui.secondary} shrink-0`} onClick={onClose}><ArrowLeft size={16} aria-hidden="true" />返回</button>
      <h1 id={headingId} className="min-w-0 break-words text-base font-semibold [overflow-wrap:anywhere]">{title}</h1>
    </header>
    <div className="mx-auto w-full max-w-6xl space-y-5 px-4 py-5 sm:px-6">{children}</div>
  </dialog>;
}

export function SourceReader({ record, latestRecord = record, requestedVersion, page, startMs, slideLabel, returnPoint, onClose, onRetry }: {
  record: SourceRecord;
  latestRecord?: SourceRecord;
  requestedVersion: number;
  page?: number;
  startMs?: number;
  slideLabel?: string;
  returnPoint?: ReaderReturnPoint;
  onClose: () => void;
  onRetry?: () => Promise<void>;
}) {
  const [readingPage] = useState(() => sourceReaderInitialPage(record.id, requestedVersion, page));
  const preferExtractedText = sourcePreviewKind(record.mime) == null && latestRecord.parseState === "ready";
  const [showText, setShowText] = useState(preferExtractedText);
  const [textVisited, setTextVisited] = useState(preferExtractedText);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const latest = requestedVersion === latestRecord.version;
  async function retry() {
    if (!onRetry || retrying) return;
    setRetrying(true); setError("");
    try { await onRetry(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重新解析未能完成，请重试。"); }
    finally { setRetrying(false); }
  }
  return <SourceReaderFrame title={latestRecord.name} returnPoint={returnPoint} onClose={onClose}>
    {startMs != null || slideLabel ? <p className="text-sm text-amber-800">引用定位：{slideLabel ? `幻灯片 ${slideLabel}` : ""}{slideLabel && startMs != null ? " · " : ""}{startMs != null ? `${Math.floor(startMs / 60000)}:${String(Math.floor(startMs / 1000) % 60).padStart(2, "0")}` : ""}。此阅读器尚不能同步确认该位置，请在原件中核对。</p> : null}
    <SourceViewer record={record} latestRecord={latestRecord} requestedVersion={requestedVersion}
      download={buildSourceDownloadView(record.id, requestedVersion, latestRecord.version, readingPage)} page={readingPage} hideHeading />
    {latest && latestRecord.parseState === "failed" && latestRecord.error?.retryable !== false && onRetry ? <button type="button" className={ui.secondary} disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重新解析…" : "重新解析"}</button> : null}
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    <div className="space-y-4 border-t border-zinc-200 pt-4">
      <button type="button" className={ui.secondary} aria-expanded={showText} onClick={() => { setTextVisited(true); setShowText(value => !value); }}>{showText ? "收起提取文字 / OCR 核对" : "查看提取文字 / OCR 核对"}</button>
      {textVisited ? <div hidden={!showText}><SourceContent sourceId={record.id} version={requestedVersion} initialPage={readingPage} /></div> : null}
    </div>
  </SourceReaderFrame>;
}
