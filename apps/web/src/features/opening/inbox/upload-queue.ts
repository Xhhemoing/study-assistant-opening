import { isSessionExpired } from "../../auth/session-expiry";
import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import type { LocalUploadFile, UploadByteProgress, UploadRejected } from "./upload-client";
import { uploadBatchRejection, uploadFileRejection } from "./upload-preflight";
import { UploadUserError, uploadErrorMessage } from "./upload-error";

export type UploadQueueState = "idle" | "uploading" | "saved" | "failed";

export type UploadQueueItem = {
  id: string;
  file: LocalUploadFile;
  state: UploadQueueState;
  source?: SourceRecord;
  ticket?: UploadTicket;
  completionPending?: boolean;
  message?: string;
  progress: number;
};

export type UploadQueueClient = {
  uploadFile: (file: LocalUploadFile, progress?: UploadByteProgress) => Promise<SourceRecord | UploadRejected>;
};

type LegacyUpload = (
  file: LocalUploadFile,
  onBytes?: (loaded: number, total: number) => void,
  resume?: { sourceId: string; ticket: UploadTicket; completionPending?: boolean },
) => Promise<SourceRecord | UploadRejected>;

type UploadOperation = UploadQueueClient | LegacyUpload;
export type UploadQueueUpdate = (items: UploadQueueItem[]) => void;

const DISMISSIBLE: ReadonlySet<UploadQueueState> = new Set(["idle", "uploading", "saved", "failed"]);

let nextQueueItemId = 0;

function isClient(client: UploadOperation): client is UploadQueueClient {
  return typeof client !== "function";
}

export function createUploadQueue(client: UploadOperation, initialFiles: LocalUploadFile[] = []) {
  const items: UploadQueueItem[] = [];
  // Keep browser File references until their turn; only the active file is read.
  const unreadFiles = new Map<string, File>();
  let draining: Promise<void> | null = null;

  const assertRoom = (files: readonly Pick<File, "size">[]) => {
    const pending = items.filter(item => item.state !== "saved");
    const rejection = uploadBatchRejection(files, {
      count: pending.length,
      bytes: pending.reduce((total, item) => total + (unreadFiles.get(item.id)?.size ?? item.file.bytes.byteLength), 0),
    });
    if (rejection) throw new UploadUserError(rejection);
  };
  /** Item ids removed while idle/uploading — ignore late process/progress completions. */
  const cancelled = new Set<string>();

  const add = (files: LocalUploadFile[]): UploadQueueItem[] => {
    assertRoom(files.map(file => ({ size: file.bytes.byteLength })));
    const added = files.map((file) => ({
      id: `upload-${++nextQueueItemId}`,
      file,
      state: "idle" as const,
      progress: 0,
    }));
    items.push(...added);
    return added;
  };

  const addFiles = (files: File[]): UploadQueueItem[] => {
    assertRoom(files);
    const rejection = files.map(file => uploadFileRejection(file)).find(Boolean);
    if (rejection) throw new UploadUserError(rejection);
    const added = add(files.map(file => ({ name: file.name, type: file.type, bytes: new Uint8Array() })));
    added.forEach((item, index) => unreadFiles.set(item.id, files[index]!));
    return added;
  };

  const snapshot = (): UploadQueueItem[] => items.map((item) => ({ ...item }));

  const stillActive = (id: string): boolean => !cancelled.has(id) && items.some((row) => row.id === id);

  const process = async (item: UploadQueueItem, update?: UploadQueueUpdate): Promise<void> => {
    if (!stillActive(item.id) || item.state !== "idle") return;
    if (isSessionExpired()) {
      item.state = "failed";
      item.message = "登录已过期，原件仍在本地。验证原账户后重试。";
      update?.(snapshot());
      return;
    }
    item.state = "uploading";
    item.message = undefined;
    update?.(snapshot());
    const onBytes = (loaded: number, total: number) => {
      if (!stillActive(item.id)) return;
      const ratio = Number.isFinite(loaded) && Number.isFinite(total) && total > 0 ? loaded / total : 0;
      item.progress = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      update?.(snapshot());
    };
    let result: SourceRecord | UploadRejected;
    try {
      const unread = unreadFiles.get(item.id);
      if (unread) {
        let bytes: Uint8Array;
        try { bytes = new Uint8Array(await unread.arrayBuffer()); }
        catch { throw new UploadUserError(`无法读取文件「${unread.name}」，原文件仍在，请重试或重新选择。`); }
        if (!stillActive(item.id)) return;
        item.file = { name: unread.name, type: unread.type, bytes };
        unreadFiles.delete(item.id);
      }
      if (isClient(client)) {
        result = await client.uploadFile(item.file, item.ticket ? {
          resumeSourceId: item.ticket.source.id,
          ticket: item.ticket,
          completionPending: item.completionPending,
          onBytes,
        } : { onBytes });
      } else {
        result = await client(item.file, onBytes, item.ticket ? {
          sourceId: item.ticket.source.id,
          ticket: item.ticket,
          completionPending: item.completionPending,
        } : undefined);
      }
    } catch (error) {
      if (!stillActive(item.id)) return;
      item.state = "failed";
      item.message = uploadErrorMessage(error, "上传未完成，原件仍在本地，请重试。");
      update?.(snapshot());
      return;
    }
    if (!stillActive(item.id)) return;
    if ("phase" in result) {
      item.state = "failed";
      item.message = result.message;
      item.ticket = result.ticket ?? item.ticket;
      item.completionPending = result.completionPending;
      update?.(snapshot());
      return;
    }
    item.state = "saved";
    item.source = result;
    // Saved rows only need metadata. Keep failed buffers intact for same-source retry.
    item.file = { name: item.file.name, type: item.file.type, bytes: new Uint8Array() };
    item.ticket = undefined;
    item.completionPending = undefined;
    item.progress = 100;
    update?.(snapshot());
  };

  const start = (update?: UploadQueueUpdate): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      // New batches join the same drain; concurrent callers never read/upload in parallel.
      for (;;) {
        const item = items.find(candidate => candidate.state === "idle");
        if (!item) return;
        await process(item, update);
      }
    })().finally(() => {
      draining = null;
      // A batch can arrive between the last idle check and this microtask.
      if (items.some(item => item.state === "idle")) return start(update);
    });
    return draining;
  };

  const retry = async (id: string, update?: UploadQueueUpdate): Promise<void> => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.state !== "failed" || isSessionExpired()) return;
    cancelled.delete(id);
    item.state = "idle";
    await start(update);
  };

  const dismiss = (id: string, update?: UploadQueueUpdate): void => {
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const item = items[index];
    if (!item || !DISMISSIBLE.has(item.state)) return;
    cancelled.add(id);
    unreadFiles.delete(id);
    items.splice(index, 1);
    update?.(snapshot());
  };

  add(initialFiles);
  return { items, add, addFiles, start, retry, dismiss, snapshot };
}
