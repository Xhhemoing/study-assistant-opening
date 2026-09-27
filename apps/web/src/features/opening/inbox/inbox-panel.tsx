"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { CaptureDialog } from "./capture-dialog";
import { putPrivateBytes } from "./put-private";
import { SourceRow } from "./source-row";
import { SourceViewer, type SourceDownloadView } from "./source-viewer";
import { createUploadClient, type UploadRejected } from "./upload-client";
import { sourceStatusLabel } from "./upload-state";
import { shouldRefreshSources, startSourceRefresh } from "./source-refresh";

type Notice = { sourceId?: string; text: string; ticket?: UploadRejected["ticket"] };

function percent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((loaded / total) * 100);
}

export function InboxPanel({ api, sources, onChanged }: {
  api: OpeningApi;
  sources: SourceRecord[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [bytes, setBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [view, setView] = useState<{ record: SourceRecord; download: SourceDownloadView; requestedVersion: number } | null>(null);
  const fileRef = useRef<File | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const processing = shouldRefreshSources(sources);
  useEffect(() => {
    if (!processing) return;
    let mounted = true;
    const stop = startSourceRefresh({
      refresh: async () => { await onChanged(); if (mounted) setRefreshError(false); },
      onError: () => setRefreshError(true),
    });
    return () => { mounted = false; stop(); };
  }, [processing, onChanged]);
  const client = useMemo(() => createUploadClient({
    begin: (input) => api.beginUpload(input),
    complete: (id) => api.completeUpload(id),
    put: async (url, body, onProgress, mime) => {
      await putPrivateBytes(url, body, mime, (loaded, total) => {
        setBytes(percent(loaded, total));
        onProgress(loaded);
      });
    },
  }), [api]);

  async function upload(file: File, resume?: Notice) {
    fileRef.current = file;
    setBusy(true);
    setBytes(0);
    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = await client.uploadFile(
      { name: file.name, type: file.type, bytes: buffer },
      resume?.ticket && resume.sourceId
        ? { resumeSourceId: resume.sourceId, ticket: resume.ticket }
        : {},
    );
    setBusy(false);
    if ("phase" in result) {
      setNotice({ sourceId: result.sourceId, text: result.message, ticket: result.ticket });
      return;
    }
    setNotice(null);
    setBytes(null);
    await onChanged();
  }

  async function openOriginal(record: SourceRecord, version = record.version) {
    const download = await api.getSourceDownload(record.id, version);
    setView({ record, download, requestedVersion: version });
  }

  return (
    <section className="space-y-3 border-b border-zinc-200 px-3 py-3">
      <CaptureDialog disabled={busy} onFile={(file) => void upload(file)} />
      {refreshError ? <p className="text-sm text-amber-800" role="status">材料状态暂时无法更新，已保留现有信息；正在重试读取。</p> : null}
      {notice?.ticket && fileRef.current ? (
        <button
          className="min-h-11 rounded-md border border-zinc-300 px-3 text-sm"
          onClick={() => {
            const file = fileRef.current;
            if (file && notice.ticket && notice.sourceId) {
              void upload(file, notice);
            }
          }}
          type="button"
        >
          用同一材料重试
        </button>
      ) : null}
      {bytes != null ? <p className="text-xs tabular-nums text-zinc-700">已上传 {bytes}%</p> : null}
      {notice ? <p className="text-sm text-amber-800" role="status">{notice.text}</p> : null}
      <ul className="space-y-2">
        {sources.map((record) => (
          <li key={record.id}>
            <SourceRow
              notice={notice?.sourceId === record.id ? notice.text : undefined}
              onOpen={record.uploadState === "uploaded" ? () => void openOriginal(record) : undefined}
              onRetry={record.uploadState === "pending" ? async () => {
                await client.retryComplete(record.id);
                await onChanged();
              } : undefined}
              record={record}
            />
            <p className="sr-only">{sourceStatusLabel(record)}</p>
          </li>
        ))}
      </ul>
      {view ? (
        <SourceViewer
          download={view.download}
          record={view.record}
          requestedVersion={view.requestedVersion}
        />
      ) : null}
    </section>
  );
}
