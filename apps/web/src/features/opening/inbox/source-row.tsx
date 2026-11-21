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
  onReindex,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "error"> & Partial<Pick<SourceRecord, "mime" | "bytes" | "createdAt">>;
  bytePercent?: number | null;
  notice?: string;
  onOpen?: (id: string) => void;
  onRetry?: (id: string) => void;
  onManage?: (id: string) => void;
  onDelete?: (id: string) => void;
  onAssign?: (id: string) => void;
  onReindex?: (id: string) => void;
}) {
  const percent = bytePercent == null ? null : Math.min(100, Math.max(0, Math.round(bytePercent)));
  const format = sourceFormatLabel(record);
  const metadata = sourceMetadata(record);
  const failed = record.uploadState === "rejected" || record.parseState === "failed";
  const canDeleteShortcut = canDeleteSourceShortcut(record);
  const stateTone = failed ? tone.danger : record.uploadState === "uploaded" && record.parseState === "ready" ? tone.success : tone.neutral;
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 bg-surface px-3.5 py-2.5 transition-colors duration-150 hover:bg-surface-2/40 motion-reduce:transition-none">
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${record.mime?.startsWith("image/") ? "bg-warn-soft text-warn" : record.mime?.startsWith("audio/") || record.mime?.startsWith("video/") ? "bg-ai-2/15 text-text-2" : "bg-accent-soft text-accent"}`}><FileText size={16} aria-hidden="true" /></span><div className="min-w-0 flex-1">
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
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {format ? <span className="text-xs font-medium text-text-3">{format}</span> : null}
          <span className={`${ui.badge} ${stateTone}`}>{record.uploadState === "rejected" ? "上传被拒绝" : sourceStatusLabel(record)}</span>
        </div>
        {percent != null ? (
          <p className="text-xs tabular-nums text-text-2">已上传 {percent}%</p>
        ) : null}
        {notice ? <p className="text-xs text-warn">{notice}</p> : null}
        {record.error?.code === "PARSE_PARTIAL" ? <p className="text-xs text-warn">{record.error.message}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && record.error?.retryable !== false ? (
          <button className={ui.secondary} onClick={() => onRetry(record.id)} type="button">
            <RefreshCw size={14} aria-hidden="true" />{record.uploadState === "pending" ? "重试上传" : "重新解析"}
          </button>
        ) : null}
        {metadata || onAssign || onManage || onReindex || (canDeleteShortcut && onDelete) ? (
          <details className="relative max-w-full rounded-lg">
            <summary className="cursor-pointer list-none rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">更多操作</summary>
            <div className="absolute right-0 top-full z-20 mt-1.5 flex w-52 max-w-[85vw] flex-col items-start gap-1.5 rounded-xl border border-line bg-surface p-2.5 shadow-float">
              {metadata ? <p className="px-2 pb-1 text-xs tabular-nums text-text-3">{metadata}</p> : null}
              {onAssign ? <button className={`${ui.quiet} w-full justify-start`} onClick={() => onAssign(record.id)} type="button"><FolderInput size={14} aria-hidden="true" />归入课程</button> : null}
              {onManage ? <button className={`${ui.quiet} w-full justify-start`} onClick={() => onManage(record.id)} type="button"><Settings2 size={14} aria-hidden="true" />管理材料</button> : null}
              {onReindex && record.parseState === "ready" ? <button className={`${ui.quiet} w-full justify-start`} onClick={() => onReindex(record.id)} type="button"><RefreshCw size={14} aria-hidden="true" />更新材料搜索</button> : null}
              {canDeleteShortcut && onDelete ? (
                <button className={`${dangerQuiet} w-full justify-start`} onClick={() => onDelete(record.id)} type="button">
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
