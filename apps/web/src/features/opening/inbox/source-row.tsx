"use client";

import type { SourceRecord } from "@aistudy/contracts";
import { sourceStatusLabel } from "./upload-state";

export function SourceRow({
  record,
  bytePercent,
  notice,
  onOpen,
  onRetry,
}: {
  record: Pick<SourceRecord, "id" | "name" | "uploadState" | "parseState">;
  bytePercent?: number | null;
  notice?: string;
  onOpen?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  const percent = bytePercent == null ? null : Math.min(100, Math.max(0, Math.round(bytePercent)));
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2">
      <div className="min-w-0">
        <h3 className="truncate text-sm font-medium text-zinc-950">{record.name}</h3>
        <p className="text-xs text-zinc-600">{sourceStatusLabel(record)}</p>
        {percent != null ? (
          <p className="text-xs tabular-nums text-zinc-700">已上传 {percent}%</p>
        ) : null}
        {notice ? <p className="text-xs text-amber-800">{notice}</p> : null}
      </div>
      <div className="flex gap-2">
        {onOpen ? (
          <button className="min-h-11 rounded-md border border-zinc-300 px-3 text-sm" onClick={() => onOpen(record.id)} type="button">
            查看原件
          </button>
        ) : null}
        {onRetry ? (
          <button className="min-h-11 rounded-md border border-zinc-300 px-3 text-sm" onClick={() => onRetry(record.id)} type="button">
            重试完成
          </button>
        ) : null}
      </div>
    </article>
  );
}
