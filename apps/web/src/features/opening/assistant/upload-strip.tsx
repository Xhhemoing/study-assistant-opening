"use client";

import { useMemo, useState } from "react";
import type { OpeningApi } from "../client/api";
import { resolveUploadPutUrl } from "../client/api";
import { putPrivateBytes } from "../inbox/put-private";
import { createUploadClient } from "../inbox/upload-client";
import { createUploadQueue, type UploadQueueItem } from "../inbox/upload-queue";
import { UploadDropzone } from "../inbox/upload-dropzone";
import { ui } from "../design/ui";
import { createMaterialOrganizationClient } from "../library/material-organization-client";

type CourseRole = "core" | "optional" | "reference";

type Props = {
  api: OpeningApi;
  /** Called after upload/retry; receives newly saved source ids for auto-select (Package B). */
  onUploaded: (savedSourceIds?: string[]) => void | Promise<void>;
  disabled?: boolean;
  /** When set, successful uploads are attached to this course once (Package D). */
  courseId?: string | null;
  courseRole?: CourseRole;
};

function savedSourceIds(rows: UploadQueueItem[]): string[] {
  return rows.filter((item) => item.state === "saved" && item.source).map((item) => item.source!.id);
}

export function UploadStrip({ api, onUploaded, disabled, courseId = null, courseRole = "reference" }: Props) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const client = useMemo(() => createUploadClient({
    begin: (input) => api.beginUpload(input),
    complete: (id) => api.completeUpload(id),
    put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, (loaded) => onProgress(loaded)),
    resolvePutUrl: resolveUploadPutUrl,
    refreshTicket: (id) => api.refreshUploadTicket(id),
  }), [api]);
  const queue = useMemo(() => createUploadQueue((file, onBytes, resume) => client.uploadFile(file, {
    onBytes,
    ...(resume ? { resumeSourceId: resume.sourceId, ticket: resume.ticket } : {}),
  })), [client]);
  const busy = disabled || items.some((item) => item.state === "idle" || item.state === "uploading");

  async function attachSaved(rows: UploadQueueItem[]) {
    if (!courseId) return;
    const ids = savedSourceIds(rows);
    if (!ids.length) return;
    await createMaterialOrganizationClient().addToCourse(courseId, ids, courseRole);
  }

  async function uploadFiles(files: File[]) {
    const localFiles = await Promise.all(files.map(async (file) => ({
      name: file.name,
      type: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    const added = queue.add(localFiles);
    const addedIds = new Set(added.map((item) => item.id));
    setItems(queue.snapshot());
    await queue.start(setItems);
    const newlySaved = queue.snapshot().filter((item) => addedIds.has(item.id) && item.state === "saved");
    const ids = savedSourceIds(newlySaved);
    await onUploaded(ids);
    await attachSaved(newlySaved);
    if (courseId && newlySaved.length) await onUploaded(ids);
  }

  async function retry(id: string) {
    await queue.retry(id, setItems);
    const item = queue.snapshot().find((row) => row.id === id);
    const ids = item?.state === "saved" && item.source ? [item.source.id] : [];
    await onUploaded(ids);
    if (item?.state === "saved") {
      await attachSaved([item]);
      if (courseId) await onUploaded(ids);
    }
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
