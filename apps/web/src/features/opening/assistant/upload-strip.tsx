"use client";

import { useMemo, useState } from "react";
import type { OpeningApi } from "../client/api";
import { resolveUploadPutUrl } from "../client/api";
import { putPrivateBytes } from "../inbox/put-private";
import { createUploadClient } from "../inbox/upload-client";
import { createUploadQueue, type UploadQueueItem } from "../inbox/upload-queue";
import { UploadDropzone } from "../inbox/upload-dropzone";
import { ui } from "../design/ui";

type Props = {
  api: OpeningApi;
  onUploaded: () => void | Promise<void>;
  disabled?: boolean;
};

export function UploadStrip({ api, onUploaded, disabled }: Props) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const client = useMemo(() => createUploadClient({
    begin: (input) => api.beginUpload(input),
    complete: (id) => api.completeUpload(id),
    put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, (loaded) => onProgress(loaded)),
    resolvePutUrl: resolveUploadPutUrl,
  }), [api]);
  const queue = useMemo(() => createUploadQueue((file, onBytes, resume) => client.uploadFile(file, {
    onBytes,
    ...(resume ? { resumeSourceId: resume.sourceId, ticket: resume.ticket } : {}),
  })), [client]);
  const busy = disabled || items.some((item) => item.state === "idle" || item.state === "uploading");

  async function uploadFiles(files: File[]) {
    const localFiles = await Promise.all(files.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    queue.add(localFiles);
    setItems(queue.snapshot());
    await queue.start(setItems);
    await onUploaded();
  }

  async function retry(id: string) {
    await queue.retry(id, setItems);
    await onUploaded();
  }

  function dismiss(id: string) {
    queue.dismiss(id, setItems);
  }

  return (
    <div className="space-y-2 border-b border-zinc-200 px-3 py-3">
      <UploadDropzone disabled={busy} onFiles={(files) => void uploadFiles(files)} />
      {items.length ? (
        <ul className="space-y-1.5" aria-label="助手上传队列">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 break-words text-zinc-700">{item.file.name}</span>
              <span className="text-zinc-500" role="status">
                {item.state === "idle" ? "等待上传" : item.state === "uploading" ? `上传中 ${item.progress}%` : item.state === "saved" ? "已保存，正在解析" : item.message ?? "上传失败"}
              </span>
              {item.state === "failed" ? <>
                <button className={ui.secondary} onClick={() => void retry(item.id)} type="button">重试</button>
                <button className={ui.quiet} onClick={() => dismiss(item.id)} type="button">清除</button>
              </> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
