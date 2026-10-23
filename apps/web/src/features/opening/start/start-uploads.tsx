"use client";

import { Camera, Paperclip, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import { resolveUploadPutUrl, type OpeningApi } from "../client/api";
import { putPrivateBytes } from "../inbox/put-private";
import { createUploadClient } from "../inbox/upload-client";
import { openingUploadAccept } from "../inbox/upload-preflight";
import { UploadUserError, uploadErrorMessage } from "../inbox/upload-error";
import { createUploadQueue, type UploadQueueItem } from "../inbox/upload-queue";
import { uploadStripItemStatus } from "../assistant/upload-strip";
import { createMaterialOrganizationClient } from "../library/material-organization-client";

type Props = {
  objectHref?: (href: string) => string;
  api: OpeningApi; sources: SourceRecord[]; courseId: string | null; disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onUploaded: (ids: string[], sources: SourceRecord[]) => Promise<void>;
};

/** Uses the same resumable private upload queue as the material picker. Photos are question context. */
export function StartUploads({ api, sources, courseId, disabled, onBusyChange, onUploaded, objectHref = href => href }: Props) {
  const camera = useRef<HTMLInputElement>(null), files = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [error, setError] = useState("");
  const [rejection, setRejection] = useState("");
  const client = useMemo(() => createUploadClient({
    begin: input => api.beginUpload(input), complete: id => api.completeUpload(id),
    put: (url, body, progress, mime) => putPrivateBytes(url, body, mime, loaded => progress(loaded)),
    resolvePutUrl: resolveUploadPutUrl, refreshTicket: id => api.refreshUploadTicket(id),
  }), [api]);
  const queue = useMemo(() => createUploadQueue((file, onBytes, resume) => client.uploadFile(file, {
    onBytes, ...(resume ? { resumeSourceId: resume.sourceId, ticket: resume.ticket, completionPending: resume.completionPending } : {}),
  })), [client]);
  const published = useRef(new Set<string>());

  async function publishSaved() {
    const saved = queue.snapshot().filter(item => item.source && !published.current.has(item.id));
    const records = saved.flatMap(item => item.source ? [item.source] : []);
    if (!records.length) return;
    if (courseId) {
      const result = await createMaterialOrganizationClient().addToCourse(courseId, records.map(source => source.id), "reference");
      if (result.failed.length) throw new UploadUserError("原件已保存，但归入课程未完成，请重试；无需重新上传。");
    }
    await onUploaded(records.map(source => source.id), records);
    saved.forEach(item => published.current.add(item.id));
  }
  async function run(operation: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); onBusyChange(true); setError("");
    let failed = false;
    try { await operation(); await publishSaved(); }
    catch (reason) { failed = true; setError(uploadErrorMessage(reason, "上传未完成，文件和输入都还在，请重试。")); }
    finally { locked.current = false; setBusy(false); onBusyChange(failed || queue.snapshot().some(item => item.state !== "saved")); }
  }
  async function add(selected: File[]) {
    if (!selected.length || locked.current || disabled) return;
    try { queue.addFiles(selected); }
    catch (reason) { setRejection(uploadErrorMessage(reason, "文件添加未完成，请重新选择文件。")); return; }
    setRejection(""); setItems(queue.snapshot());
    await run(() => queue.start(setItems));
  }
  const blocked = busy || disabled;
  const action = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-text-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50";
  return <div className="min-w-0 flex-1">
    <div className="flex flex-wrap items-center gap-1">
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void add(selected); }} />
      <input ref={files} type="file" accept={openingUploadAccept} multiple hidden onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void add(selected); }} />
      <button type="button" className={action} disabled={blocked} onClick={() => camera.current?.click()}><Camera size={16} aria-hidden="true" />拍题</button>
      <button type="button" className={action} disabled={blocked} onClick={() => files.current?.click()}><Paperclip size={16} aria-hidden="true" />上传</button>
    </div>
    {rejection ? <p role="alert" className="px-2 text-xs text-danger">{rejection}</p> : null}
    {items.length ? <ul aria-label="提问附件" className="space-y-1 pb-1">
      {items.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2 px-2 text-xs text-text-2">
        <span className="min-w-0 flex-1 break-words">{item.file.name}</span><span role="status">{uploadStripItemStatus(item, sources)}</span>
        {item.state === "saved" && item.source?.mime.startsWith("image/") ? <Link href={objectHref(`/opening/practice?sourceId=${encodeURIComponent(item.source.id)}`)} className={action}>开始作答</Link> : null}
        {item.state === "failed" ? <button type="button" className={action} disabled={blocked} onClick={() => void run(() => queue.retry(item.id, setItems))}>重试</button> : null}
        <button type="button" aria-label={`移除上传记录 ${item.file.name}`} className="grid size-8 place-items-center rounded hover:bg-surface-2 disabled:opacity-50" disabled={blocked} onClick={() => { queue.dismiss(item.id, setItems); onBusyChange(queue.snapshot().some(row => row.state !== "saved")); }}><X size={14} aria-hidden="true" /></button>
      </li>)}
    </ul> : null}
    {items.length ? <p className="px-2 pb-1 text-xs text-text-3">附件作为题目或参考资料。可直接发送来读题；你的解答在作答区另行提交。</p> : null}
    {error ? <p role="alert" className="px-2 text-xs text-danger">{error}<button type="button" className={action} disabled={blocked} onClick={() => void run(async () => undefined)}>重试</button></p> : null}
  </div>;
}
