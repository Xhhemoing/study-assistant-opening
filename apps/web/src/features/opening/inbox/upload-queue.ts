import type { SourceRecord, UploadTicket } from "@aistudy/contracts";
import type { LocalUploadFile, UploadByteProgress, UploadRejected } from "./upload-client";

export type UploadQueueState = "idle" | "uploading" | "saved" | "failed";

export type UploadQueueItem = {
  id: string;
  file: LocalUploadFile;
  state: UploadQueueState;
  source?: SourceRecord;
  ticket?: UploadTicket;
  message?: string;
  progress: number;
};

export type UploadQueueClient = {
  uploadFile: (file: LocalUploadFile, progress?: UploadByteProgress) => Promise<SourceRecord | UploadRejected>;
};

type LegacyUpload = (
  file: LocalUploadFile,
  onBytes?: (loaded: number, total: number) => void,
  resume?: { sourceId: string; ticket: UploadTicket },
) => Promise<SourceRecord | UploadRejected>;

type UploadOperation = UploadQueueClient | LegacyUpload;
export type UploadQueueUpdate = (items: UploadQueueItem[]) => void;

const DISMISSIBLE: ReadonlySet<UploadQueueState> = new Set(["idle", "uploading", "failed"]);

let nextQueueItemId = 0;

function isClient(client: UploadOperation): client is UploadQueueClient {
  return typeof client !== "function";
}

export function createUploadQueue(client: UploadOperation, initialFiles: LocalUploadFile[] = []) {
  const items: UploadQueueItem[] = [];
  /** Item ids removed while idle/uploading — ignore late process/progress completions. */
  const cancelled = new Set<string>();

  const add = (files: LocalUploadFile[]): UploadQueueItem[] => {
    const added = files.map((file) => ({
      id: `upload-${++nextQueueItemId}`,
      file,
      state: "idle" as const,
      progress: 0,
    }));
    items.push(...added);
    return added;
  };

  const snapshot = (): UploadQueueItem[] => items.map((item) => ({ ...item }));

  const stillActive = (id: string): boolean => !cancelled.has(id) && items.some((row) => row.id === id);

  const process = async (item: UploadQueueItem, update?: UploadQueueUpdate): Promise<void> => {
    if (!stillActive(item.id) || item.state !== "idle") return;
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
      if (isClient(client)) {
        result = await client.uploadFile(item.file, item.ticket ? {
          resumeSourceId: item.ticket.source.id,
          ticket: item.ticket,
          onBytes,
        } : { onBytes });
      } else {
        result = await client(item.file, onBytes, item.ticket ? {
          sourceId: item.ticket.source.id,
          ticket: item.ticket,
        } : undefined);
      }
    } catch (error) {
      if (!stillActive(item.id)) return;
      item.state = "failed";
      item.message = error instanceof Error ? error.message : "上传失败";
      update?.(snapshot());
      return;
    }
    if (!stillActive(item.id)) return;
    if ("phase" in result) {
      item.state = "failed";
      item.message = result.message;
      item.ticket = result.ticket ?? item.ticket;
      update?.(snapshot());
      return;
    }
    item.state = "saved";
    item.source = result;
    item.ticket = undefined;
    item.progress = 100;
    update?.(snapshot());
  };

  const start = async (update?: UploadQueueUpdate): Promise<void> => {
    // Snapshot idle ids up front so dismiss during the loop does not skip siblings.
    const idleIds = items.filter((item) => item.state === "idle").map((item) => item.id);
    for (const id of idleIds) {
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.state !== "idle" || cancelled.has(id)) continue;
      await process(item, update);
    }
  };

  const retry = async (id: string, update?: UploadQueueUpdate): Promise<void> => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.state !== "failed") return;
    cancelled.delete(id);
    item.state = "idle";
    await process(item, update);
  };

  const dismiss = (id: string, update?: UploadQueueUpdate): void => {
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return;
    const item = items[index];
    if (!item || !DISMISSIBLE.has(item.state)) return;
    cancelled.add(id);
    items.splice(index, 1);
    update?.(snapshot());
  };

  add(initialFiles);
  return { items, add, start, retry, dismiss, snapshot };
}
