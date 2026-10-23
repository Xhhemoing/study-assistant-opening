import type { SourceRecord, UploadInput, UploadTicket } from "@aistudy/contracts";
import { resolveUploadMime, unsupportedUploadMessage } from "./upload-state";
import { uploadErrorMessage } from "./upload-error";

export type LocalUploadFile = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type UploadByteProgress = {
  uploadId?: string;
  onBytes?: (loaded: number, total: number) => void;
  resumeSourceId?: string;
  ticket?: UploadTicket;
  completionPending?: boolean;
};

export type UploadRejected = {
  phase: "unsupported" | "interrupted";
  sourceId?: string;
  ticket?: UploadTicket;
  keptLocal: true;
  completionPending?: boolean;
  message: string;
};

type PutFn = (
  url: string,
  body: Uint8Array,
  onProgress: (loaded: number) => void,
  mime: string,
) => Promise<void>;

export type UploadClientDeps = {
  begin: (input: UploadInput) => Promise<UploadTicket>;
  complete: (sourceId: string) => Promise<SourceRecord>;
  put: PutFn;
  resolvePutUrl?: (ticket: UploadTicket) => string;
  /** Reissue lease for pending source; required for retry (never reuse expired uploadUrl). */
  refreshTicket?: (sourceId: string) => Promise<UploadTicket>;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectionDetail(error: unknown): string {
  const message = uploadErrorMessage(error, "");
  return message ? `（${message}）` : "";
}

/** begin → private PUT → complete. Byte callbacks are upload progress only. */
export function createUploadClient(deps: UploadClientDeps) {
  // Direct callers also retain the identity after an unknown begin response.
  // Queue callers provide an explicit id so separate selections stay distinct.
  const pendingBegins = new WeakMap<LocalUploadFile, string>();
  return {
    async uploadFile(
      file: LocalUploadFile,
      progress: UploadByteProgress = {},
    ): Promise<SourceRecord | UploadRejected> {
      if (progress.resumeSourceId && progress.completionPending) {
        try {
          const result = await deps.complete(progress.resumeSourceId);
          pendingBegins.delete(file);
          return result;
        }
        catch (error) {
          return { phase: "interrupted", sourceId: progress.resumeSourceId, ticket: progress.ticket,
            completionPending: true, keptLocal: true,
            message: `上传已暂存，但保存确认失败，仍可重试。${rejectionDetail(error)}` };
        }
      }
      const mime = resolveUploadMime({ name: file.name, type: file.type });
      if (!mime) {
        return {
          phase: "unsupported",
          keptLocal: true,
          message: unsupportedUploadMessage({ name: file.name, type: file.type }),
        };
      }
      let ticket: UploadTicket | undefined;
      try {
        if (progress.resumeSourceId) {
          // Retry: refresh ticket (same source id) — never reuse expired uploadUrl; never begin a new row.
          ticket = deps.refreshTicket
            ? await deps.refreshTicket(progress.resumeSourceId)
            : progress.ticket;
        } else {
          const uploadId = progress.uploadId ?? pendingBegins.get(file) ?? globalThis.crypto.randomUUID();
          pendingBegins.set(file, uploadId);
          ticket = await deps.begin({
            name: file.name.slice(0, 180),
            mime,
            bytes: file.bytes.byteLength,
            sha256: await sha256Hex(file.bytes),
            uploadId,
          });
        }
      } catch (error) {
        const detail = rejectionDetail(error);
        return {
          phase: "interrupted",
          sourceId: progress.resumeSourceId,
          keptLocal: true,
          message: progress.resumeSourceId
            ? `上传票据刷新失败，原件仍在本地。未创建第二份材料。${detail}`
            : `上传准备失败，原件仍在本地。${detail}`,
        };
      }
      if (!ticket || (progress.resumeSourceId && ticket.source.id !== progress.resumeSourceId)) {
        return {
          phase: "interrupted",
          sourceId: progress.resumeSourceId,
          keptLocal: true,
          message: "没有可重试的上传票据，未创建第二份材料。",
        };
      }
      try {
        await deps.put(deps.resolvePutUrl?.(ticket) ?? ticket.uploadUrl, file.bytes, (loaded) => {
          progress.onBytes?.(loaded, file.bytes.byteLength);
        }, mime);
      } catch (error) {
        const detail = rejectionDetail(error);
        return {
          phase: "interrupted",
          sourceId: ticket.source.id,
          ticket,
          keptLocal: true,
          message: `上传中断，原件仍在本地。未标记为已上传。${detail}`,
        };
      }
      try {
        const result = await deps.complete(ticket.source.id);
        pendingBegins.delete(file);
        return result;
      } catch (error) {
        return {
          phase: "interrupted",
          sourceId: ticket.source.id,
          ticket,
          keptLocal: true,
          completionPending: true,
          message: `上传已暂存，但保存确认失败，仍可重试。${rejectionDetail(error)}`,
        };
      }
    },
    retryComplete(sourceId: string): Promise<SourceRecord> {
      return deps.complete(sourceId);
    },
  };
}
