"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { resolveUploadPutUrl } from "../client/api";
import { CaptureDialog } from "./capture-dialog";
import { putPrivateBytes } from "./put-private";
import { SourceRow } from "./source-row";
import { type SourceViewerTarget } from "./source-viewer";
import { SourceReader } from "./source-reader";
import { captureReaderReturnPoint, type ReaderReturnPoint } from "./reader-return-point";
import { createUploadClient } from "./upload-client";
import { canDeleteSourceShortcut, sourceStatusLabel } from "./upload-state";
import { createUploadQueue, type UploadQueueItem } from "./upload-queue";
import { shouldRefreshSources, startSourceRefresh } from "./source-refresh";
import { EmptyState, ui } from "../design/ui";
import { SourceActionsPanel, sourceActionNotice } from "./source-actions-panel";
import { SourceCleanupPanel } from "./source-cleanup-panel";
import { createMaterialOrganizationClient } from "../library/material-organization-client";
import { LiveTaskCard } from "../library/live-task-card";
import type { LibraryFileBatch } from "../library/library-view";

type Notice = { sourceId?: string; text: string };
type CourseRole = "core" | "optional" | "reference";

export function InboxPanel({
  api,
  sources,
  onChanged,
  filter = "",
  visibleSources,
  selectedIds,
  onToggle,
  selectionDisabled = false,
  renderMetadata,
  onAssign,
  renderBelow,
  expandedSourceId = null,
  courseId = null,
  courseRole = "reference",
  initialOpen = null,
  incomingFiles,
  onIncomingFilesAccepted,
  onUploadBusyChange,
  onUploadRequested,
  hideUploadPicker = false,
  showEmptyState = true,
  liveSources,
}: {
  api: OpeningApi;
  incomingFiles?: LibraryFileBatch | null;
  onIncomingFilesAccepted?: () => void;
  onUploadBusyChange?: (busy: boolean) => void;
  onUploadRequested?: () => void;
  hideUploadPicker?: boolean;
  showEmptyState?: boolean;
  liveSources?: SourceRecord[];
  sources: SourceRecord[];
  onChanged: () => Promise<void>;
  filter?: string;
  visibleSources?: SourceRecord[];
  selectedIds?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  selectionDisabled?: boolean;
  renderMetadata?: (record: SourceRecord) => ReactNode;
  onAssign?: (id: string) => void;
  renderBelow?: (record: SourceRecord) => ReactNode;
  /** Preserve an externally controlled editor across automatic filtering and pagination. */
  expandedSourceId?: string | null;
  /** When set, successful uploads are attached to this course once (Package D). */
  courseId?: string | null;
  courseRole?: CourseRole;
  /** Deep-link from citation chips: open in-app viewer at version/page. */
  initialOpen?: SourceViewerTarget | null;
}) {
  const consumedFileBatch = useRef<LibraryFileBatch | null>(null);
  const [managedId, setManagedId] = useState<string | null>(null);
  const [manageInitialAction, setManageInitialAction] = useState<"exclude" | "delete" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [view, setView] = useState<{ record: SourceRecord; requestedVersion: number; page?: number; startMs?: number; slideLabel?: string; returnPoint?: ReaderReturnPoint } | null>(null);
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([]);
  const [refreshError, setRefreshError] = useState(false);
  const [openedInitialKey, setOpenedInitialKey] = useState<string | null>(null);
  const processing = shouldRefreshSources(sources);
  const displayed = visibleSources ?? sources.filter(record => record.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const processingSources = (liveSources ?? displayed).filter(isProcessingSource);
  const processingIds = new Set(processingSources.map(record => record.id));
  const listedSources = [...processingSources, ...displayed.filter(record => !processingIds.has(record.id))];
  const listedIds = new Set(listedSources.map(record => record.id));
  const retainedSources = sources.filter(record => !listedIds.has(record.id) && (record.id === managedId || record.id === expandedSourceId));
  const retainedIds = new Set(retainedSources.map(record => record.id));
  const renderedSources = [...listedSources, ...retainedSources];
  const currentViewRecord = view ? sources.find(record => record.id === view.record.id) : undefined;
  useEffect(() => {
    if (!initialOpen) return;
    const key = `${initialOpen.sourceId}:${initialOpen.version}:${initialOpen.page ?? ""}:${initialOpen.startMs ?? ""}:${initialOpen.slideLabel ?? ""}`;
    if (openedInitialKey === key) return;
    const record = sources.find((item) => item.id === initialOpen.sourceId);
    if (!record || record.uploadState !== "uploaded" || initialOpen.version > record.version) {
      setNotice({ sourceId: initialOpen.sourceId, text: !record ? "引用材料已移除或暂时无法访问，请核对资料库。" : record.uploadState !== "uploaded" ? "引用材料尚未上传完成，请重新选择文件。" : "请求的材料版本尚不可用，请刷新后核对；不会改用其他版本。" });
      setOpenedInitialKey(key);
      return;
    }
    setView({
      record,
      requestedVersion: initialOpen.version,
      ...(initialOpen.page != null ? { page: initialOpen.page } : {}),
      ...(initialOpen.startMs != null ? { startMs: initialOpen.startMs } : {}),
      ...(initialOpen.slideLabel ? { slideLabel: initialOpen.slideLabel } : {}),
    });
    setOpenedInitialKey(key);
  }, [initialOpen, sources, openedInitialKey]);
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
    put: (url, body, onProgress, mime) => putPrivateBytes(url, body, mime, (loaded) => onProgress(loaded)),
    resolvePutUrl: resolveUploadPutUrl,
    refreshTicket: (id) => api.refreshUploadTicket(id),
  }), [api]);

  const uploadQueue = useMemo(() => createUploadQueue((file, onBytes, resume) => client.uploadFile(file, {
    onBytes,
    ...(resume ? { resumeSourceId: resume.sourceId, ticket: resume.ticket } : {}),
  })), [client]);
  const uploading = queueItems.some((item) => item.state === "idle" || item.state === "uploading");

  const attachSavedToCourse = useCallback(async (items: UploadQueueItem[]) => {
    if (!courseId) return;
    const ids = items
      .filter((item) => item.state === "saved" && item.source)
      .map((item) => item.source!.id);
    if (!ids.length) return;
    await createMaterialOrganizationClient().addToCourse(courseId, ids, courseRole);
  }, [courseId, courseRole]);

  const uploadFiles = useCallback(async (files: File[]) => {
    onUploadBusyChange?.(true);
    try {
      const localFiles = await Promise.all(files.map(async (file) => ({
        name: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      const added = uploadQueue.add(localFiles);
      const addedIds = new Set(added.map((item) => item.id));
      setQueueItems(uploadQueue.snapshot());
      await uploadQueue.start(setQueueItems);
      const snapshot = uploadQueue.snapshot();
      const newlySaved = snapshot.filter((item) => addedIds.has(item.id) && item.state === "saved");
      if (newlySaved.length) {
        await onChanged();
        await attachSavedToCourse(newlySaved);
        if (courseId) await onChanged();
      }
    } finally { onUploadBusyChange?.(false); }
  }, [attachSavedToCourse, courseId, onChanged, onUploadBusyChange, uploadQueue]);

  useEffect(() => {
    if (!incomingFiles || consumedFileBatch.current === incomingFiles) return;
    consumedFileBatch.current = incomingFiles;
    onIncomingFilesAccepted?.();
    void uploadFiles(incomingFiles.files).catch(reason => {
      setNotice({ text: reason instanceof Error ? reason.message : "文件添加未完成，请重新选择文件。" });
    });
  }, [incomingFiles, onIncomingFilesAccepted, uploadFiles]);

  async function retryQueuedUpload(id: string) {
    onUploadBusyChange?.(true);
    try {
      await uploadQueue.retry(id, setQueueItems);
      const item = uploadQueue.snapshot().find((row) => row.id === id);
      if (item?.state === "saved") {
        await onChanged();
        await attachSavedToCourse([item]);
        if (courseId) await onChanged();
      }
    } finally { onUploadBusyChange?.(false); }
  }

  function showOperationFailure(reason: unknown) {
    setNotice({ text: reason instanceof Error ? reason.message : "操作未能完成，请核对材料状态后重试。" });
  }

  function dismissQueuedUpload(id: string) {
    uploadQueue.dismiss(id, setQueueItems);
  }

  function openManage(id: string, initialAction: "exclude" | "delete" | null = null) {
    setManagedId(id);
    setManageInitialAction(initialAction);
  }

  function closeManage() {
    setManagedId(null);
    setManageInitialAction(null);
  }

  function openOriginal(record: SourceRecord, version = record.version, page?: number) {
    // Same-origin binary link — do not fetch JSON then open MinIO.
    setView({
      record,
      requestedVersion: version,
      returnPoint: captureReaderReturnPoint(document.querySelector<HTMLElement>(`[data-source-open="${record.id}"]`) ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)),
      ...(page != null ? { page } : {}),
    });
  }

  async function retrySource(record: SourceRecord) {
    try {
      if (record.uploadState === "pending") await retryPendingSource(record);
      else { await api.retryParse(record.id); await onChanged(); }
    } catch (reason) {
      setNotice({ sourceId: record.id, text: reason instanceof Error ? reason.message : "重试未能完成，请稍后重试。" });
    }
  }

  function localQueueItemForSource(sourceId: string): UploadQueueItem | undefined {
    return queueItems.find(
      (item) =>
        item.ticket?.source.id === sourceId
        && item.file.bytes.byteLength > 0
        && (item.state === "failed" || item.state === "idle"),
    );
  }

  async function retryPendingSource(record: SourceRecord) {
    const local = localQueueItemForSource(record.id);
    if (local) {
      await retryQueuedUpload(local.id);
      return;
    }
    setNotice({ sourceId: record.id, text: "请重新选择文件" });
  }

  function sourceTools(record: SourceRecord) {
    return <>
      {managedId === record.id ? <SourceActionsPanel record={record} initialAction={manageInitialAction} onClose={closeManage} onChanged={onChanged} onResult={result => {
        setNotice({ text: sourceActionNotice(result) });
        if (result.deleted) setView(value => value?.record.id === record.id ? null : value);
      }} /> : null}
      {renderBelow?.(record)}
    </>;
  }

  return (
    <section className="space-y-3">
      {!hideUploadPicker && (sources.length > 0 || !showEmptyState) ? <CaptureDialog compact disabled={uploading} courseId={courseId} courseRole={courseRole} onFiles={(files) => void uploadFiles(files).catch(showOperationFailure)} /> : null}
      {refreshError ? <p className="text-sm text-warn" role="status">材料状态暂时无法更新，已保留现有信息；正在重试读取。</p> : null}
      {notice ? <p className="text-sm text-warn" role="status">{notice.text}</p> : null}
      {queueItems.some(item => item.state !== "saved") ? (
        <ul className="space-y-3" aria-label="上传队列">
          {queueItems.filter(item => item.state !== "saved").map(item => <li key={item.id}><LiveTaskCard title={item.file.name} failed={item.state === "failed"} phase={item.state === "idle" ? "等待上传" : item.state === "uploading" ? item.progress === 100 ? "文件已传输，正在确认" : "正在上传文件" : item.message ?? "上传失败"} byteProgress={item.state === "uploading" ? item.progress : undefined}>
            {item.state === "failed" ? <><button className={ui.secondary} onClick={() => void retryQueuedUpload(item.id).catch(showOperationFailure)} type="button">重试</button><button className={ui.quiet} onClick={() => dismissQueuedUpload(item.id)} type="button">清除</button></> : <button className={ui.quiet} onClick={() => dismissQueuedUpload(item.id)} type="button">取消</button>}
          </LiveTaskCard></li>)}
        </ul>
      ) : null}
      {queueItems.some(item => item.state === "saved") ? <details className="rounded-lg border border-line p-3 text-xs text-text-2">
        <summary className="cursor-pointer">已上传 {queueItems.filter(item => item.state === "saved").length} 份材料</summary>
        <ul aria-label="已上传任务" className="mt-3 space-y-2">{queueItems.filter(item => item.state === "saved").map(item => {
          const current = sources.find(source => source.id === item.source?.id) ?? item.source;
          return <li key={item.id} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-words">{item.file.name}</span>
            <span role="status">{current ? sourceStatusLabel(current) : "原件已保存"}</span>
            <button type="button" className={ui.quiet} onClick={() => dismissQueuedUpload(item.id)}>清除任务</button></li>;
        })}</ul>
      </details> : null}
      <SourceCleanupPanel revision={sources} />
      <ul className="divide-y divide-line border-y border-line">
        {renderedSources.map((record) => (
          <li key={record.id}>
            <div className="flex items-start gap-2 px-2 py-1">
              {onToggle ? <input aria-label={`选择材料 ${record.name}`} type="checkbox" checked={selectedIds?.has(record.id) ?? false} disabled={selectionDisabled} onChange={() => onToggle(record.id)} className="mt-3 size-6 shrink-0 accent-accent" /> : null}
            <div className="min-w-0 flex-1">{processingIds.has(record.id) ? <div role="group" aria-label="材料处理任务"><LiveTaskCard title={record.name} phase={sourceStatusLabel(record)}>
              <button type="button" className={ui.quiet} data-source-open={record.id} onClick={() => openOriginal(record)}>阅读已保存原件</button>
              <button type="button" className={ui.quiet} onClick={() => managedId === record.id ? closeManage() : openManage(record.id)}>管理材料</button>
              {onAssign ? <button type="button" className={ui.quiet} onClick={() => onAssign(record.id)}>归入课程</button> : null}
              {canDeleteSourceShortcut(record) ? <button type="button" className={`${ui.quiet} text-danger`} onClick={() => openManage(record.id, "delete")}>删除</button> : null}
              {notice?.sourceId === record.id ? <p className="w-full text-xs text-warn">{notice.text}</p> : null}
            </LiveTaskCard></div> : <SourceRow
              notice={notice?.sourceId === record.id ? notice.text : undefined}
              onOpen={record.uploadState === "uploaded" ? () => openOriginal(record) : undefined}
              onRetry={record.uploadState === "pending" || (record.uploadState === "uploaded" && record.parseState === "failed" && record.error?.retryable !== false) ? () => void retrySource(record) : undefined}
              record={record}
              onManage={() => {
                if (managedId === record.id) closeManage();
                else openManage(record.id, null);
              }}
              onDelete={() => openManage(record.id, "delete")}
              onAssign={onAssign}
            />}{renderMetadata?.(record)}</div></div>
            {retainedIds.has(record.id) ? <p role="status" className="px-4 py-2 text-xs text-text-2">正在编辑的材料暂时保留在此处；关闭表单后将按当前筛选显示。</p> : null}
            {sourceTools(record)}
            <p className="sr-only">{sourceStatusLabel(record)}</p>
          </li>
        ))}
      </ul>
      {!sources.length && showEmptyState ? <EmptyState title="还没有材料" description="添加第一份材料，上传后的处理状态会显示在这里。" action={hideUploadPicker ? onUploadRequested ? <button type="button" className={ui.primary} disabled={uploading} onClick={onUploadRequested}>上传材料</button> : undefined : <CaptureDialog disabled={uploading} courseId={courseId} courseRole={courseRole} onFiles={(files) => void uploadFiles(files).catch(showOperationFailure)} />} /> : sources.length > 0 && !renderedSources.length ? <p className="py-4 text-sm text-text-3">没有匹配的材料。</p> : null}
      {view && currentViewRecord ? <SourceReader key={`${view.record.id}:${view.requestedVersion}:${view.page ?? ""}`}
        record={view.record} latestRecord={currentViewRecord} requestedVersion={view.requestedVersion} page={view.page} startMs={view.startMs} slideLabel={view.slideLabel} courseId={courseId}
        returnPoint={view.returnPoint} onClose={() => setView(null)} onRetry={async () => { await api.retryParse(view.record.id); await onChanged(); }} /> : null}
    </section>
  );
}

function isProcessingSource(record: SourceRecord): boolean {
  return record.uploadState === "uploaded" && record.error?.code !== "PRIVACY_EXCLUDED" && ["queued", "running", "not_started"].includes(record.parseState);
}
