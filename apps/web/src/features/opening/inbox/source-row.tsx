"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { canDeleteSourceShortcut, sourceStatusLabel } from "./upload-state";
import { FileText, FolderInput, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { ui, tone } from "../design/ui";

const dangerQuiet = `${ui.secondary} border-danger/20 text-danger hover:bg-danger/10`;

const formatLabels: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/msword": "DOC",
  "text/plain": "TXT",
  "text/markdown": "MD",
  "text/html": "HTML",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WEBP",
  "audio/mpeg": "MP3",
  "audio/mp4": "M4A",
  "audio/wav": "WAV",
  "video/mp4": "MP4",
  "video/webm": "WEBM",
  "message/rfc822": "EML",
};

export function sourceFormatLabel(record: { name: string; mime?: string }): string {
  const known = record.mime ? formatLabels[record.mime.toLowerCase()] : undefined;
  return known ?? record.name.match(/\.([a-z0-9]{1,6})$/i)?.[1]?.toUpperCase() ?? "文件";
}

function sourceMetadata(record: { mime?: string; bytes?: number; createdAt?: string }): string {
  const size = record.bytes == null ? null : record.bytes >= 1024 * 1024 ? `${(record.bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(record.bytes / 1024))} KB`;
  const date = record.createdAt ? record.createdAt.slice(0, 10) : null;
  return [size, date].filter(Boolean).join(" · ");
}

export function SourceRow({
  record,
  bytePercent,
  notice,
  onOpen,
  onRetry,
  onManage,
  onDelete,
  onAssign,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "error"> & Partial<Pick<SourceRecord, "mime" | "bytes" | "createdAt">>;
  bytePercent?: number | null;
  notice?: string;
  onOpen?: (id: string) => void;
  onRetry?: (id: string) => void;
  onManage?: (id: string) => void;
  onDelete?: (id: string) => void;
  onAssign?: (id: string) => void;
}) {
  const percent = bytePercent == null ? null : Math.min(100, Math.max(0, Math.round(bytePercent)));
  const format = sourceFormatLabel(record);
  const metadata = sourceMetadata(record);
  const failed = record.uploadState === "rejected" || record.parseState === "failed";
  const canDeleteShortcut = canDeleteSourceShortcut(record);
  const stateTone = failed ? tone.danger : record.uploadState === "uploaded" && record.parseState === "ready" ? tone.success : tone.neutral;
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 bg-surface px-2 py-1.5">
      <span className={`flex size-[30px] shrink-0 items-center justify-center rounded-lg ${record.mime?.startsWith("image/") ? "bg-warn-soft text-warn" : record.mime?.startsWith("audio/") || record.mime?.startsWith("video/") ? "bg-ai-2/15 text-text-2" : "bg-accent-soft text-accent"}`}><FileText size={17} aria-hidden="true" /></span><div className="min-w-0 flex-1">
        <h3 title={record.name} className="line-clamp-2 break-words text-sm font-medium text-text [overflow-wrap:anywhere]">
          {onOpen ? (
            <button
              aria-label={`打开资料：${record.name}`}
              className="min-h-6 rounded-sm text-left hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              data-source-open={record.id}
              onClick={() => onOpen(record.id)}
              type="button"
            >{record.name}</button>
          ) : record.name}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {format ? <span className="text-xs text-text-3">{format}</span> : null}
          <span className={`${ui.badge} ${stateTone}`}>{record.uploadState === "rejected" ? "上传被拒绝" : sourceStatusLabel(record)}</span>
        </div>
        {percent != null ? (
          <p className="text-xs tabular-nums text-text-2">已上传 {percent}%</p>
        ) : null}
        {notice ? <p className="text-xs text-warn">{notice}</p> : null}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        {onRetry && record.error?.retryable !== false ? (
          <button className={ui.secondary} onClick={() => onRetry(record.id)} type="button">
            <RefreshCw size={14} aria-hidden="true" />{record.parseState === "failed" ? "重新解析" : "重试上传"}
          </button>
        ) : null}
        {metadata || onAssign || onManage || (canDeleteShortcut && onDelete) ? (
          <details className="max-w-full rounded-lg">
            <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs text-text-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">更多操作</summary>
            <div className="flex max-w-full flex-col items-start gap-2 rounded-lg border border-line bg-surface-2 p-3">
              {metadata ? <p className="text-xs tabular-nums text-text-3">{metadata}</p> : null}
              {onAssign ? <button className={ui.quiet} onClick={() => onAssign(record.id)} type="button"><FolderInput size={14} aria-hidden="true" />归入课程</button> : null}
              {onManage ? <button className={ui.quiet} onClick={() => onManage(record.id)} type="button"><Settings2 size={14} aria-hidden="true" />管理材料</button> : null}
              {canDeleteShortcut && onDelete ? (
                <button className={dangerQuiet} onClick={() => onDelete(record.id)} type="button">
                  <Trash2 size={14} aria-hidden="true" />删除
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}
