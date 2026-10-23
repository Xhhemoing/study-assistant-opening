"use client";

import { useMemo, useRef, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import { sourceStatusLabel } from "../inbox/upload-state";
import type { OpeningApi } from "../client/api";
import { resolveUploadPutUrl } from "../client/api";
import { putPrivateBytes } from "../inbox/put-private";
import { createUploadClient } from "../inbox/upload-client";
import { UploadUserError, uploadErrorMessage } from "../inbox/upload-error";
import { createUploadQueue, type UploadQueueItem } from "../inbox/upload-queue";
import { UploadDropzone } from "../inbox/upload-dropzone";
import { ui } from "../design/ui";
import { createMaterialOrganizationClient } from "../library/material-organization-client";

type CourseRole = "core" | "optional" | "reference";

type Props = {
  api: OpeningApi;
  /** Called after upload/retry; receives newly saved source ids for auto-select (Package B). */
  onUploaded: (savedSourceIds?: string[], sources?: SourceRecord[]) => void | Promise<void>;
  sources?: readonly SourceRecord[];
  disabled?: boolean;
  /** When set, successful uploads are attached to this course once (Package D). */
  courseId?: string | null;
  courseRole?: CourseRole;
};

function savedSourceIds(rows: UploadQueueItem[]): string[] {
  return rows.filter((item) => item.state === "saved" && item.source).map((item) => item.source!.id);
}

export function uploadStripItemStatus(item: UploadQueueItem, sources: readonly SourceRecord[]): string {
  if (item.state === "idle") return "等待上传";
  if (item.state === "uploading") return `上传中 ${item.progress}%`;
  if (item.state === "failed") return item.message ?? "上传失败";
  const current = sources.find(source => source.id === item.source?.id);
  return current ? sourceStatusLabel(current) : "原件已保存，处理状态待核实";
}

export function UploadStrip({ api, onUploaded, sources = [], disabled, courseId = null, courseRole = "reference" }: Props) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const locked = useRef(false);
  const pendingPublication = useRef(new Map<string, UploadQueueItem>());
  const client = useMemo(() => createUploadClient({
    begin: (input) => api.beginUpload(input),
    complete: (id) => api.completeUpload(id),
    put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, (loaded) => onProgress(loaded)),
    resolvePutUrl: resolveUploadPutUrl,
    refreshTicket: (id) => api.refreshUploadTicket(id),
  }), [api]);
  const queue = useMemo(() => createUploadQueue((file, onBytes, resume, operation) => client.uploadFile(file, {
    uploadId: operation?.uploadId,
    onBytes,
    ...(resume ? { resumeSourceId: resume.sourceId, ticket: resume.ticket, completionPending: resume.completionPending } : {}),
  })), [client]);
  const busy = disabled || working || items.some((item) => item.state === "idle" || item.state === "uploading");

  async function attachSaved(rows: UploadQueueItem[]) {
    if (!courseId) return;
    const ids = savedSourceIds(rows);
    if (!ids.length) return;
    const result = await createMaterialOrganizationClient().addToCourse(courseId, ids, courseRole);
    if (result.failed.length) throw new UploadUserError("原件已保存，但归入课程未完成，请重试；无需重新上传。");
  }

  async function publishSaved() {
    const rows = [...pendingPublication.current.values()];
    if (!rows.length) return;
    await attachSaved(rows);
    await onUploaded(savedSourceIds(rows), rows.flatMap(item => item.source ? [item.source] : []));
    rows.forEach(item => pendingPublication.current.delete(item.id));
  }

  async function run(operation: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setWorking(true); setNotice("");
    try { await operation(); await publishSaved(); }
    catch (reason) { setNotice(uploadErrorMessage(reason, "文件添加未完成，已上传的材料仍保留，请重试。")); }
    finally { locked.current = false; setWorking(false); }
  }

  async function uploadFiles(files: File[]) {
    await run(async () => {
      const added = queue.addFiles(files);
      const addedIds = new Set(added.map(item => item.id));
      setItems(queue.snapshot());
      await queue.start(setItems);
      const saved = queue.snapshot().filter(item => addedIds.has(item.id) && item.state === "saved");
      saved.forEach(item => pendingPublication.current.set(item.id, item));
      if (!saved.length) await onUploaded([], []);
    });
  }

  async function retry(id: string) {
    await run(async () => {
      await queue.retry(id, setItems);
      const item = queue.snapshot().find(row => row.id === id);
      if (item?.state === "saved") pendingPublication.current.set(item.id, item);
      else await onUploaded([], []);
    });
  }

  function dismiss(id: string) {
    pendingPublication.current.delete(id);
    queue.dismiss(id, setItems);
  }

  return (
    <div className="space-y-2 border-b border-line px-3 py-3">
      {notice ? <p role="alert" className="text-xs text-danger">{notice}{pendingPublication.current.size ? <button type="button" disabled={busy} className={ui.secondary} onClick={() => void run(async () => undefined)}>重试保存材料信息</button> : null}</p> : null}
      <UploadDropzone disabled={busy} onFiles={(files) => void uploadFiles(files)} />
      {items.length ? (
        <ul className="space-y-1.5" aria-label="助手上传队列">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 break-words text-text-2">{item.file.name}</span>
              <span className="text-text-3" role="status">
                {uploadStripItemStatus(item, sources)}
              </span>
              {item.state === "failed" ? <>
                <button className={ui.secondary} disabled={busy} onClick={() => void retry(item.id)} type="button">重试</button>
                <button className={ui.quiet} onClick={() => dismiss(item.id)} type="button">清除</button>
              </> : item.state === "idle" || item.state === "uploading" ? (
                <button className={ui.quiet} onClick={() => dismiss(item.id)} type="button">取消</button>
              ) : item.state === "saved" ? <button className={ui.quiet} onClick={() => dismiss(item.id)} type="button">清除任务</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
