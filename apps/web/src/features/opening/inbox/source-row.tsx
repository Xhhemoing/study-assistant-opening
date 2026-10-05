"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { sourceStatusLabel } from "./upload-state";
import { ExternalLink, FileText, RefreshCw, Settings2 } from "lucide-react";
import { ui, tone } from "../design/ui";

function sourceMetadata(record: { mime?: string; bytes?: number; createdAt?: string }): string {
  const format = record.mime === "application/pdf" ? "PDF" : record.mime?.split("/").pop()?.replace("vnd.openxmlformats-officedocument.presentationml.presentation", "PPTX").replace("vnd.ms-powerpoint", "PPT").toUpperCase();
  const size = record.bytes == null ? null : record.bytes >= 1024 * 1024 ? `${(record.bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(record.bytes / 1024))} KB`;
  const date = record.createdAt ? record.createdAt.slice(0, 10) : null;
  return [format, size, date].filter(Boolean).join(" · ");
}

export function SourceRow({
  record,
  bytePercent,
  notice,
  onOpen,
  onRetry,
  onManage,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState" | "error"> & Partial<Pick<SourceRecord, "mime" | "bytes" | "createdAt">>;
  bytePercent?: number | null;
  notice?: string;
  onOpen?: (id: string) => void;
  onRetry?: (id: string) => void;
  onManage?: (id: string) => void;
}) {
  const percent = bytePercent == null ? null : Math.min(100, Math.max(0, Math.round(bytePercent)));
  const metadata = sourceMetadata(record);
  const stateTone = record.uploadState === "rejected" || record.parseState === "failed" ? tone.danger : record.uploadState === "uploaded" && record.parseState === "ready" ? tone.success : tone.neutral;
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 bg-white px-2 py-3">
      <FileText size={15} aria-hidden="true" className="shrink-0 text-zinc-500" /><div className="min-w-0 flex-1">
        <h3 title={record.name} className="break-words text-sm font-medium text-zinc-950 [overflow-wrap:anywhere]">{record.name}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`${ui.badge} ${stateTone}`}>{record.uploadState === "rejected" ? "上传被拒绝" : sourceStatusLabel(record)}</span>
          {metadata ? <span className="text-xs tabular-nums text-zinc-500">{metadata}</span> : null}
        </div>
        {percent != null ? (
          <p className="text-xs tabular-nums text-zinc-700">已上传 {percent}%</p>
        ) : null}
        {notice ? <p className="text-xs text-amber-800">{notice}</p> : null}
      </div>
      <div className="flex gap-2">
        {onManage ? <button className={ui.quiet} onClick={() => onManage(record.id)} type="button"><Settings2 size={14} aria-hidden="true" />管理材料</button> : null}
        {onOpen ? (
          <button className={ui.quiet} onClick={() => onOpen(record.id)} type="button">
            <ExternalLink size={14} aria-hidden="true" />查看原件
          </button>
        ) : null}
        {onRetry && record.error?.code !== "PRIVACY_EXCLUDED" ? (
          <button className={ui.secondary} onClick={() => onRetry(record.id)} type="button">
            <RefreshCw size={14} aria-hidden="true" />{record.parseState === "failed" ? "重新解析" : "重试上传"}
          </button>
        ) : null}
      </div>
    </article>
  );
}
